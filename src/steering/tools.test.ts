// plugin/src/steering/tools.test.ts — acceptance tests for the two
// steering MCP verbs.
//
// Pins: exactly two tools registered (no hard-delete verb); side-effect-free
// registration (building AND calling the registrar touches no filesystem); the
// GP-23 gate — with steering.enabled absent/false both verbs return a GATED
// marker and write NOTHING; with steering.enabled=true a put/read round-trips
// through the store over a real MCP session (so the argument schemas and
// tools/list surface are the protocol truth); and CROSS-item supersession
// through the verbs — the `supersedes`/`references` args validated at the tool
// layer (typed SCHEMA on a malformed id/JSON), the dangling target surfaced as
// typed DANGLING_SUPERSEDES from the store, and the DERIVED `referenced_by`
// backlink on steering_read.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { STEERING_TOOL_NAMES, createSteeringToolsRegistrar, readSteeringEnabledFlag } from './tools.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  while (clients.length > 0) {
    await clients.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  projectRoot: string;
  server: McpServer;
  connect: () => Promise<Client>;
}

function makeFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-steering-tools-test-'));
  tempDirs.push(projectRoot);
  const clock: Clock = () => new Date(FIXED_ISO);
  const registrar = createSteeringToolsRegistrar({ projectRoot, clock });
  const server = new McpServer({ name: 'ideate-test', version: '0.0.0' });
  registrar(server);
  return {
    projectRoot,
    server,
    connect: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'tools-test-client', version: '0.0.0' });
      clients.push(client);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    },
  };
}

function enableSteering(projectRoot: string): void {
  writeFileSync(join(projectRoot, '.ideate.json'), JSON.stringify({ steering: { enabled: true } }), 'utf8');
}

function registeredNames(server: McpServer): string[] {
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(registry).sort();
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('registration', () => {
  it('registers exactly the two steering verbs', () => {
    const { server } = makeFixture();
    expect(registeredNames(server)).toEqual([...STEERING_TOOL_NAMES].sort());
  });

  it('building and calling the registrar touches no filesystem', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-steering-noeffect-test-'));
    tempDirs.push(projectRoot);
    const before = readdirSync(projectRoot);
    const registrar = createSteeringToolsRegistrar({ projectRoot, clock: () => new Date(FIXED_ISO) });
    const server = new McpServer({ name: 'ideate-test', version: '0.0.0' });
    registrar(server);
    // No .ideate.json, no .ideate/ — construction and registration wrote nothing.
    expect(readdirSync(projectRoot)).toEqual(before);
    expect(existsSync(join(projectRoot, '.ideate.json'))).toBe(false);
    expect(existsSync(join(projectRoot, '.ideate'))).toBe(false);
  });
});

describe('GP-23 gate (steering.enabled)', () => {
  it('the flag reader defaults to false with no config / no steering block', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-steering-flag-test-'));
    tempDirs.push(projectRoot);
    expect(readSteeringEnabledFlag(projectRoot)).toBe(false);
    writeFileSync(join(projectRoot, '.ideate.json'), JSON.stringify({ backend: 'local' }), 'utf8');
    expect(readSteeringEnabledFlag(projectRoot)).toBe(false);
    writeFileSync(join(projectRoot, '.ideate.json'), JSON.stringify({ steering: { enabled: false } }), 'utf8');
    expect(readSteeringEnabledFlag(projectRoot)).toBe(false);
    writeFileSync(join(projectRoot, '.ideate.json'), JSON.stringify({ steering: { enabled: true } }), 'utf8');
    expect(readSteeringEnabledFlag(projectRoot)).toBe(true);
  });

  it('gated OFF: both verbs return a GATED marker and write nothing', async () => {
    const { projectRoot, connect } = makeFixture();
    const client = await connect();

    const put = payload(await client.callTool({ name: 'steering_put', arguments: { id: 'GP-1', kind: 'guiding-principle', statement: 'x' } }));
    expect(put).toMatchObject({ ok: false, code: 'GATED' });
    const read = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    expect(read).toMatchObject({ ok: false, code: 'GATED' });

    // Nothing was created — the steering dir never came into being.
    expect(existsSync(join(projectRoot, '.ideate'))).toBe(false);
  });

  it('gated ON: steering_put then steering_read round-trips through the store', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();

    const put = payload(
      await client.callTool({ name: 'steering_put', arguments: { id: 'POL-auth-1', kind: 'policy', statement: 'Rotate tokens.', domain: 'auth' } }),
    );
    expect(put).toMatchObject({ ok: true, id: 'POL-auth-1', status: 'active', amended: false });

    // The real file landed under the resolved steering dir.
    const file = join(projectRoot, '.ideate', 'steering', 'POL-auth-1.md');
    expect(readFileSync(file, 'utf8')).toContain('Rotate tokens.');

    const read = payload(await client.callTool({ name: 'steering_read', arguments: { domain: 'auth' } }));
    expect(read).toMatchObject({ ok: true, count: 1 });
    const items = read['items'] as Array<Record<string, unknown>>;
    expect(items[0]).toMatchObject({ id: 'POL-auth-1', kind: 'policy', domain: 'auth', statement: 'Rotate tokens.' });

    // A non-matching domain filter selects nothing (selection works through the verb).
    const none = payload(await client.callTool({ name: 'steering_read', arguments: { domain: 'billing' } }));
    expect(none).toMatchObject({ ok: true, count: 0 });
  });
});

describe('cross-item supersession through the verbs', () => {
  it('steering_put with supersedes records the forward edge; steering_read derives the backlink on the target', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();

    expect(
      payload(await client.callTool({ name: 'steering_put', arguments: { id: 'GP-old', kind: 'guiding-principle', statement: 'Old rule.' } })),
    ).toMatchObject({ ok: true, id: 'GP-old' });
    expect(
      payload(
        await client.callTool({
          name: 'steering_put',
          arguments: { id: 'GP-new', kind: 'guiding-principle', statement: 'New rule.', supersedes: 'GP-old' },
        }),
      ),
    ).toMatchObject({ ok: true, id: 'GP-new' });

    const read = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    expect(read).toMatchObject({ ok: true, count: 2 });
    const items = read['items'] as Array<Record<string, unknown>>;
    const oldItem = items.find((i) => i['id'] === 'GP-old');
    const newItem = items.find((i) => i['id'] === 'GP-new');
    // Forward edge on the replacement; DERIVED backlink on the replaced.
    expect(newItem?.['references']).toEqual([{ rel: 'supersedes', id: 'GP-old' }]);
    expect(newItem?.['referenced_by']).toEqual([]);
    expect(oldItem?.['references']).toEqual([]);
    expect(oldItem?.['referenced_by']).toEqual([{ rel: 'supersedes', id: 'GP-new' }]);
  });

  it('steering_put with a general references JSON array records typed edges', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();

    expect(payload(await client.callTool({ name: 'steering_put', arguments: { id: 'GP-1', kind: 'guiding-principle', statement: 'x' } }))).toMatchObject({ ok: true });
    expect(
      payload(
        await client.callTool({
          name: 'steering_put',
          arguments: { id: 'POL-1', kind: 'policy', statement: 'y', references: JSON.stringify([{ rel: 'clarifies', id: 'GP-1' }]) },
        }),
      ),
    ).toMatchObject({ ok: true, id: 'POL-1' });

    const read = payload(await client.callTool({ name: 'steering_read', arguments: { kind: 'guiding-principle' } }));
    const items = read['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['referenced_by']).toEqual([{ rel: 'clarifies', id: 'POL-1' }]);
  });

  it('rejects a malformed supersedes id as a typed SCHEMA failure — nothing persists', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();
    const put = payload(
      await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'x', supersedes: '../escape' } }),
    );
    expect(put).toMatchObject({ ok: false, code: 'SCHEMA' });
    const read = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    expect(read).toMatchObject({ ok: true, count: 0 });
  });

  it('rejects a dangling supersedes target as a typed DANGLING_SUPERSEDES failure — nothing persists', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();
    const put = payload(
      await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'x', supersedes: 'POL-nope' } }),
    );
    expect(put).toMatchObject({ ok: false, code: 'DANGLING_SUPERSEDES' });
    const read = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    expect(read).toMatchObject({ ok: true, count: 0 });
  });

  it('rejects malformed references JSON as a typed SCHEMA failure', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();
    for (const bad of ['not json', '{"rel":"x"}', JSON.stringify([{ rel: 'supersedes', id: 'bad id' }]), JSON.stringify([{ rel: '', id: 'GP-1' }])]) {
      const put = payload(
        await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'x', references: bad } }),
      );
      expect(put).toMatchObject({ ok: false, code: 'SCHEMA' });
    }
    const read = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    expect(read).toMatchObject({ ok: true, count: 0 });
  });

  it('amend without edge args carries prior edges (absent args do not clear)', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();
    expect(payload(await client.callTool({ name: 'steering_put', arguments: { id: 'GP-1', kind: 'guiding-principle', statement: 'x' } }))).toMatchObject({ ok: true });
    expect(
      payload(await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'v1', supersedes: 'GP-1' } })),
    ).toMatchObject({ ok: true });
    // Amend with no edge args — the prior supersedes edge must survive.
    expect(payload(await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'v2' } }))).toMatchObject({
      ok: true,
      amended: true,
    });
    const read = payload(await client.callTool({ name: 'steering_read', arguments: { kind: 'guiding-principle' } }));
    const items = read['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['referenced_by']).toEqual([{ rel: 'supersedes', id: 'POL-1' }]);
  });

  it('amend with an EMPTY-string edge arg carries prior edges (empty string = absent, does not clear)', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();
    expect(payload(await client.callTool({ name: 'steering_put', arguments: { id: 'GP-1', kind: 'guiding-principle', statement: 'x' } }))).toMatchObject({ ok: true });
    expect(
      payload(await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'v1', supersedes: 'GP-1' } })),
    ).toMatchObject({ ok: true });
    // Amend with an empty-string supersedes — a common LLM serialization of an
    // unset optional. It must be treated as ABSENT (carry-prior), NOT as a
    // supplied empty edge list that clears the prior edge.
    expect(
      payload(await client.callTool({ name: 'steering_put', arguments: { id: 'POL-1', kind: 'policy', statement: 'v2', supersedes: '' } })),
    ).toMatchObject({ ok: true, amended: true });
    const read = payload(await client.callTool({ name: 'steering_read', arguments: { kind: 'guiding-principle' } }));
    const items = read['items'] as Array<Record<string, unknown>>;
    expect(items[0]?.['referenced_by']).toEqual([{ rel: 'supersedes', id: 'POL-1' }]);
  });
});
