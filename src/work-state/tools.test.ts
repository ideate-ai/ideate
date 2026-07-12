// plugin/src/work-state/tools.test.ts — WI-303 acceptance tests for the
// eleven work-state MCP verbs.
//
// Pins: exactly eleven tools registered; side-effect-free registration with
// first-CALL lazy init (config + store); actor derivation matches the
// engine's own signatures (create/cancel/reopen/claim take an actor, renew/
// release/complete do not — no schema field for it at all); the REAL expiry
// check is wired (an id-scoped touch auto-reclaims an expired lease, not
// just verbs.ts's own noop default); typed MCP error payloads
// ({ ok: false, code, message }) surface via one instanceof
// WorkStateModuleError check; the store's secret gate passes through
// untouched (no double-gating); the claim-time priming hook fires (gated
// off) and its telemetry counter increments.
//
// All tools are exercised over a real in-process MCP session (InMemoryTransport
// + Client). All filesystem work happens in mkdtemp dirs — the real
// .ideate-work/ is never touched.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { reportFromDir } from '../telemetry/report.js';
import { WORK_STATE_TOOL_NAMES, createWorkStateToolsRegistrar } from './tools.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';
const SESSION_ID = 'sess-work-tools-test';

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
  telemetryDir: string;
  server: McpServer;
  setNow: (iso: string) => void;
  connect: () => Promise<Client>;
}

function makeFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-work-tools-test-'));
  tempDirs.push(projectRoot);
  const telemetryDir = join(projectRoot, '.ideate-telemetry');
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const registrar = createWorkStateToolsRegistrar({ projectRoot, telemetryDir, clock, sessionId: SESSION_ID });
  const server = new McpServer({ name: 'ideate-work-test', version: '0.0.0' });
  registrar(server);
  return {
    projectRoot,
    telemetryDir,
    server,
    setNow: (iso) => {
      nowIso = iso;
    },
    connect: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'work-tools-test-client', version: '0.0.0' });
      clients.push(client);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    },
  };
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: payload(result) };
}

describe('registration', () => {
  it('registers exactly the eleven work-state verbs', () => {
    const { server } = makeFixture();
    const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(registry).sort()).toEqual([...WORK_STATE_TOOL_NAMES].sort());
  });
});

describe('work_create / work_get / work_list / work_update_meta', () => {
  it('creates an item and round-trips it through get/list', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const created = await call(client, 'work_create', {
      title: 'do the thing',
      spec: 'plain prompt',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    expect(created.isError).toBe(false);
    const item = created.body.item as Record<string, unknown>;
    expect(item.status).toBe('open');
    expect(item.title).toBe('do the thing');

    const got = await call(client, 'work_get', { id: item.id as string });
    expect((got.body.item as Record<string, unknown>).id).toBe(item.id);

    const listed = await call(client, 'work_list', {});
    expect((listed.body.items as unknown[]).length).toBe(1);
  });

  it('rejects a dangling depends_on reference as a typed DagError payload', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const result = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      depends_on: ['no-such-item'],
    });
    expect(result.isError).toBe(true);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe('DANGLING_DEPENDENCY');
    expect(typeof result.body.message).toBe('string');
  });

  it('update_meta: a stale expected_version surfaces a typed VERSION_CONFLICT payload', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const created = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    const item = created.body.item as Record<string, unknown>;

    const result = await call(client, 'work_update_meta', {
      id: item.id as string,
      expected_version: 99,
      title: 'renamed',
    });
    expect(result.isError).toBe(true);
    expect(result.body.code).toBe('VERSION_CONFLICT');
  });
});

describe('secret gate pass-through (criterion 6 — no double-gating)', () => {
  it('a secret-shaped title comes back masked exactly as the store gates it, once', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const secretTitle = 'rotate AKIAABCDEFGHIJKLMNOP now';
    const created = await call(client, 'work_create', {
      title: secretTitle,
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    expect(created.isError).toBe(false);
    const item = created.body.item as Record<string, unknown>;
    expect(item.title).toBe('rotate [REDACTED:aws-access-key-id] now');
    expect(item.title).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

describe('actor derivation mirrors the engine signatures exactly (criterion 1)', () => {
  it('claim/cancel/reopen/create accept an actor; renew/release/complete carry no actor field at all', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const created = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    const id = (created.body.item as Record<string, unknown>).id as string;

    const claimed = await call(client, 'work_claim', { id, actor_human: 'dan' });
    expect(claimed.isError).toBe(false);
    const claimedItem = claimed.body.item as Record<string, unknown>;
    const claimBlock = claimedItem.claim as Record<string, unknown>;
    expect(claimBlock.claim_token).toBeTypeOf('number');

    // renew: no actor_human/actor_agent field exists on this tool's schema at all.
    const { tools } = await client.listTools();
    const renewTool = tools.find((t) => t.name === 'work_renew');
    const releaseTool = tools.find((t) => t.name === 'work_release');
    const completeTool = tools.find((t) => t.name === 'work_complete');
    for (const tool of [renewTool, releaseTool, completeTool]) {
      const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      expect(Object.keys(props)).not.toContain('actor_human');
      expect(Object.keys(props)).not.toContain('actor_agent');
    }

    const renewed = await call(client, 'work_renew', { id, claim_token: claimBlock.claim_token as number });
    expect(renewed.isError).toBe(false);

    const completed = await call(client, 'work_complete', { id, claim_token: claimBlock.claim_token as number, note: 'done' });
    expect(completed.isError).toBe(false);
    expect((completed.body.item as Record<string, unknown>).status).toBe('done');

    const reopened = await call(client, 'work_reopen', { id, actor_human: 'dan' });
    expect(reopened.isError).toBe(false);
    expect((reopened.body.item as Record<string, unknown>).status).toBe('open');

    const cancelled = await call(client, 'work_cancel', { id, actor_human: 'dan' });
    expect(cancelled.isError).toBe(false);
    expect((cancelled.body.item as Record<string, unknown>).status).toBe('cancelled');
  });
});

describe('the real expiry check is wired (criterion 2 — closes the WI-302 seam)', () => {
  it('work_get on an item whose lease already expired auto-reclaims it to open', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const created = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    const id = (created.body.item as Record<string, unknown>).id as string;

    const claimed = await call(client, 'work_claim', { id, actor_human: 'dan', lease_ms: 1000 });
    expect((claimed.body.item as Record<string, unknown>).status).toBe('in_progress');

    // Advance the fake clock well past the 1-second lease.
    fixture.setNow('2026-07-11T13:00:00.000Z');

    const got = await call(client, 'work_get', { id });
    const gotItem = got.body.item as Record<string, unknown>;
    expect(gotItem.status).toBe('open');
    expect(gotItem.claim).toBeNull();

    const events = await call(client, 'work_events', { id });
    const transitions = (events.body.events as Array<Record<string, unknown>>).map((e) => e.transition);
    expect(transitions).toContain('orphan-recovery');
  });
});

describe('claim-time priming hook wiring (criterion 5)', () => {
  it('work_claim increments the work_claims telemetry counter (gated off by default)', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const created = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    const id = (created.body.item as Record<string, unknown>).id as string;

    await call(client, 'work_claim', { id, actor_human: 'dan' });

    const { report } = reportFromDir(fixture.telemetryDir);
    expect(report.workClaims.total).toBe(1);
  });
});
