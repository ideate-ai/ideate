// plugin/src/work-state/tools.test.ts — acceptance tests for the
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

describe('supersedes / typed forward references over the MCP surface', () => {
  /** Create a plain item; returns its wire shape. */
  async function createPlain(client: Client, title: string): Promise<Record<string, unknown>> {
    const created = await call(client, 'work_create', {
      title,
      spec: 'plain prompt',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    expect(created.isError).toBe(false);
    return created.body.item as Record<string, unknown>;
  }

  it('work_create with supersedes authors the forward edge; work_get/work_list expose the derived superseded_by backlink on the target', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const old = await createPlain(client, 'the old plan');

    const created = await call(client, 'work_create', {
      title: 'the new plan',
      spec: 'plain prompt',
      spec_format: 'text/plain',
      actor_human: 'dan',
      supersedes: old.id as string,
    });
    expect(created.isError).toBe(false);
    const replacement = created.body.item as Record<string, unknown>;
    expect(replacement.references).toEqual([{ rel: 'supersedes', id: old.id }]);

    // The superseded item announces its replacement on work_get.
    const gotOld = await call(client, 'work_get', { id: old.id as string });
    const oldView = gotOld.body.item as Record<string, unknown>;
    expect(oldView.referenced_by).toEqual([{ rel: 'supersedes', id: replacement.id }]);
    expect(oldView.references).toEqual([]);

    // …and on work_list.
    const listed = await call(client, 'work_list', {});
    const listedOld = (listed.body.items as Record<string, unknown>[]).find((i) => i.id === old.id);
    expect(listedOld?.referenced_by).toEqual([{ rel: 'supersedes', id: replacement.id }]);
  });

  it('work_create accepts a references JSON array of typed edges', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const a = await createPlain(client, 'a');
    const b = await createPlain(client, 'b');

    const created = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      references: JSON.stringify([
        { rel: 'supersedes', id: a.id as string },
        { rel: 'relates-to', id: b.id as string },
      ]),
    });
    expect(created.isError).toBe(false);
    expect((created.body.item as Record<string, unknown>).references).toEqual([
      { rel: 'supersedes', id: a.id },
      { rel: 'relates-to', id: b.id },
    ]);
  });

  it('rejects a malformed (non-ULID) supersedes id with a typed SCHEMA error payload', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const result = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      supersedes: 'not-a-ulid',
    });
    expect(result.isError).toBe(true);
    expect(result.body.ok).toBe(false);
    expect(result.body.code).toBe('SCHEMA');
    expect(result.body.message as string).toMatch(/not a well-formed ULID/);
  });

  it('rejects a malformed references arg (bad JSON, non-ULID id) with a typed SCHEMA error payload', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const badJson = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      references: '{not json',
    });
    expect(badJson.isError).toBe(true);
    expect(badJson.body.code).toBe('SCHEMA');

    const badId = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      references: JSON.stringify([{ rel: 'supersedes', id: 'not-a-ulid' }]),
    });
    expect(badId.isError).toBe(true);
    expect(badId.body.code).toBe('SCHEMA');
    expect(badId.body.message as string).toMatch(/not a well-formed ULID/);
  });

  it('rejects a dangling supersedes target as a typed DANGLING_SUPERSEDES payload (create and update_meta)', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const created = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      supersedes: '01JZM8Z0000000000000000000',
    });
    expect(created.isError).toBe(true);
    expect(created.body.code).toBe('DANGLING_SUPERSEDES');

    const item = await createPlain(client, 'y');
    const updated = await call(client, 'work_update_meta', {
      id: item.id as string,
      expected_version: item.version as number,
      supersedes: '01JZM8Z0000000000000000000',
    });
    expect(updated.isError).toBe(true);
    expect(updated.body.code).toBe('DANGLING_SUPERSEDES');
  });

  it('work_update_meta sets, replaces, and clears the supersedes edge', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const a = await createPlain(client, 'a');
    const b = await createPlain(client, 'b');
    const item = await createPlain(client, 'x');

    // Set via the ergonomic supersedes arg.
    const set = await call(client, 'work_update_meta', {
      id: item.id as string,
      expected_version: item.version as number,
      supersedes: a.id as string,
    });
    expect(set.isError).toBe(false);
    expect((set.body.item as Record<string, unknown>).references).toEqual([{ rel: 'supersedes', id: a.id }]);
    const gotA = await call(client, 'work_get', { id: a.id as string });
    expect((gotA.body.item as Record<string, unknown>).referenced_by).toEqual([{ rel: 'supersedes', id: item.id }]);

    // Replace via the references JSON arg.
    const replaced = await call(client, 'work_update_meta', {
      id: item.id as string,
      expected_version: (set.body.item as Record<string, unknown>).version as number,
      references: JSON.stringify([{ rel: 'supersedes', id: b.id as string }]),
    });
    expect(replaced.isError).toBe(false);
    expect((replaced.body.item as Record<string, unknown>).references).toEqual([{ rel: 'supersedes', id: b.id }]);
    const gotAAfter = await call(client, 'work_get', { id: a.id as string });
    expect((gotAAfter.body.item as Record<string, unknown>).referenced_by).toEqual([]);

    // Clear with an empty edge list.
    const cleared = await call(client, 'work_update_meta', {
      id: item.id as string,
      expected_version: (replaced.body.item as Record<string, unknown>).version as number,
      references: '[]',
    });
    expect(cleared.isError).toBe(false);
    expect((cleared.body.item as Record<string, unknown>).references).toEqual([]);
    const gotBAfter = await call(client, 'work_get', { id: b.id as string });
    expect((gotBAfter.body.item as Record<string, unknown>).referenced_by).toEqual([]);
  });
});

describe('parent_id containment over the MCP surface', () => {
  it('work_create accepts a parent_id and round-trips it', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const parent = await call(client, 'work_create', {
      title: 'parent',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    const parentId = (parent.body.item as Record<string, unknown>).id as string;

    const child = await call(client, 'work_create', {
      title: 'child',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      parent_id: parentId,
    });
    expect(child.isError).toBe(false);
    expect((child.body.item as Record<string, unknown>).parent_id).toBe(parentId);

    // A create without parent_id is a root.
    expect((parent.body.item as Record<string, unknown>).parent_id).toBeNull();
  });

  it('work_create rejects a dangling parent_id as a typed DANGLING_PARENT payload', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const result = await call(client, 'work_create', {
      title: 'x',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      parent_id: 'no-such-item',
    });
    expect(result.isError).toBe(true);
    expect(result.body.code).toBe('DANGLING_PARENT');
  });

  it('work_update_meta sets and clears parent_id (tri-state)', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const parent = await call(client, 'work_create', { title: 'p', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    const parentId = (parent.body.item as Record<string, unknown>).id as string;
    const created = await call(client, 'work_create', { title: 'x', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    const item = created.body.item as Record<string, unknown>;

    // Set the parent.
    const set = await call(client, 'work_update_meta', { id: item.id as string, expected_version: item.version as number, parent_id: parentId });
    expect(set.isError).toBe(false);
    const setItem = set.body.item as Record<string, unknown>;
    expect(setItem.parent_id).toBe(parentId);

    // Clear it back to root with an explicit null.
    const cleared = await call(client, 'work_update_meta', { id: item.id as string, expected_version: setItem.version as number, parent_id: null });
    expect(cleared.isError).toBe(false);
    expect((cleared.body.item as Record<string, unknown>).parent_id).toBeNull();
  });

  it('work_list filters children-of a parent and roots-only (parent_id: null)', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    const parent = await call(client, 'work_create', { title: 'parent', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    const parentId = (parent.body.item as Record<string, unknown>).id as string;
    const childA = await call(client, 'work_create', { title: 'a', spec: 's', spec_format: 'text/plain', actor_human: 'dan', parent_id: parentId });
    const childAId = (childA.body.item as Record<string, unknown>).id as string;
    await call(client, 'work_create', { title: 'otherRoot', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });

    const children = await call(client, 'work_list', { parent_id: parentId });
    const childIds = (children.body.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(childIds).toEqual([childAId]);

    const roots = await call(client, 'work_list', { parent_id: null });
    const rootIds = (roots.body.items as Array<Record<string, unknown>>).map((i) => i.id);
    // parent + otherRoot are roots; the child is not.
    expect(rootIds).toHaveLength(2);
    expect(rootIds).not.toContain(childAId);
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

describe('the real expiry check is wired (criterion 2 — closes the expiry seam)', () => {
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
