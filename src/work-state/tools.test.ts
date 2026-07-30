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
// off) and its telemetry counter increments; work_list returns SUMMARY rows
// (no spec body, a correct spec_length, a bounded payload on a >100k-char
// board) and pages by keyset cursor without ever changing an item's
// `claimable` — including the parent-with-pending-child case where the child
// falls on a different page. The two bounds are pinned SEPARATELY and both
// on boards big enough to reach them: the DEFAULT page size (a board larger
// than DEFAULT_LIST_LIMIT — a smaller one leaves the default unfalsifiable)
// and the PAYLOAD budget (a page shortened below `limit`, plus the liveness
// case of one item bigger than the whole budget).
//
// All tools are exercised over a real in-process MCP session (InMemoryTransport
// + Client). All filesystem work happens in mkdtemp dirs — the real
// .ideate-work/ is never touched.

import { Buffer } from 'node:buffer';
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
import { DEFAULT_LIST_LIMIT, LIST_PAYLOAD_BUDGET_CHARS, MAX_LIST_LIMIT } from './store.js';
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

describe('work_list summary projection + keyset pagination', () => {
  /** 10k characters of opaque spec — twelve of these is a >100k-char board,
   *  the payload shape that used to blow the tool-result token cap. */
  const BIG_SPEC = 'x'.repeat(10_000);

  /**
   * Seed `count` items over the MCP surface, one minute apart on the fixture
   * clock, so `created_at` is DISTINCT per item and the board's
   * (created_at DESC, id DESC) order is unambiguous. Returns the ids
   * NEWEST-FIRST — exactly the order work_list emits.
   *
   * The instant is derived by ARITHMETIC on the base epoch, not by formatting
   * the index into a field of the ISO string: encoding the index as a minute
   * (`12:${i}`) silently caps a board at 59 items, which is BELOW the default
   * page size and would leave the paging default itself untestable — the
   * defect this helper shape exists to prevent.
   */
  async function seedBoard(fixture: Fixture, client: Client, count: number, spec: string, titleOf = (i: number) => `item ${String(i)}`): Promise<string[]> {
    const base = Date.parse(FIXED_ISO);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      fixture.setNow(new Date(base + i * 60_000).toISOString());
      const created = await call(client, 'work_create', { title: titleOf(i), spec, spec_format: 'text/plain', actor_human: 'dan' });
      expect(created.isError).toBe(false);
      ids.push((created.body.item as Record<string, unknown>).id as string);
    }
    return ids.reverse();
  }

  /** Walk work_list from the first page to a null cursor, returning every id
   *  seen in order plus the per-page row counts. */
  async function walkAll(client: Client, args: Record<string, unknown>): Promise<{ ids: string[]; pageSizes: number[] }> {
    const ids: string[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    do {
      const page: { isError: boolean; body: Record<string, unknown> } = await call(client, 'work_list', {
        ...args,
        ...(cursor === null ? {} : { cursor }),
      });
      expect(page.isError).toBe(false);
      const items = page.body.items as Array<Record<string, unknown>>;
      // Liveness: a page that reports "more to come" must have moved the walk
      // forward, or this loop would never terminate.
      expect(items.length).toBeGreaterThan(0);
      pageSizes.push(items.length);
      ids.push(...items.map((i) => i.id as string));
      cursor = page.body.next_cursor as string | null;
    } while (cursor !== null);
    return { ids, pageSizes };
  }

  it('returns summary rows by default: no spec key, a correct spec_length, and a bounded payload on a >100k-char board', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const ids = await seedBoard(fixture, client, 12, BIG_SPEC);
    // The board really does hold >100k characters of spec.
    expect(ids.length * BIG_SPEC.length).toBeGreaterThan(100_000);

    const listed = await call(client, 'work_list', {});
    expect(listed.isError).toBe(false);
    const items = listed.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(12);
    for (const item of items) {
      expect(Object.keys(item)).not.toContain('spec');
      expect(item.spec_length).toBe(BIG_SPEC.length);
      // The short triage hint stays; so do the derived views.
      expect(item.spec_format).toBe('text/plain');
      expect(item.claimable).toBe(true);
      expect(item.referenced_by).toEqual([]);
    }
    // A whole page of a >100k-char board now serializes to a small fraction
    // of the spec bytes it used to carry.
    expect(JSON.stringify(listed.body).length).toBeLessThan(10_000);
    expect(listed.body.next_cursor).toBeNull();
  });

  it('include_spec: true restores the spec on every returned item, with spec_length still present', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    await seedBoard(fixture, client, 3, BIG_SPEC);

    const listed = await call(client, 'work_list', { include_spec: true });
    const items = listed.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.spec).toBe(BIG_SPEC);
      expect(item.spec_length).toBe(BIG_SPEC.length);
    }
  });

  it('walking next_cursor with limit < board size yields every id exactly once, in created_at DESC order, ending on a null cursor', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const newestFirst = await seedBoard(fixture, client, 7, 'spec body');

    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { isError: boolean; body: Record<string, unknown> } = await call(client, 'work_list', {
        limit: 3,
        ...(cursor === null ? {} : { cursor }),
      });
      expect(page.isError).toBe(false);
      const items = page.body.items as Array<Record<string, unknown>>;
      expect(items.length).toBeLessThanOrEqual(3);
      walked.push(...items.map((i) => i.id as string));
      cursor = page.body.next_cursor as string | null;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(3); // 3 + 3 + 1
    expect(walked).toEqual(newestFirst); // every id exactly once, newest-first
    expect(new Set(walked).size).toBe(newestFirst.length);
  });

  it('a page walk under a filter sees only the filtered rows, and the cursor composes with that filter', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const newestFirst = await seedBoard(fixture, client, 4, 'spec body');
    // Cancel the two newest so the `open` selection is exactly the two oldest.
    await call(client, 'work_cancel', { id: newestFirst[0] as string, actor_human: 'dan' });
    await call(client, 'work_cancel', { id: newestFirst[1] as string, actor_human: 'dan' });

    const first = await call(client, 'work_list', { status: 'open', limit: 1 });
    const firstIds = (first.body.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(firstIds).toEqual([newestFirst[2]]);
    const second = await call(client, 'work_list', { status: 'open', limit: 1, cursor: first.body.next_cursor as string });
    const secondIds = (second.body.items as Array<Record<string, unknown>>).map((i) => i.id);
    expect(secondIds).toEqual([newestFirst[3]]);
    expect(second.body.next_cursor).toBeNull();
  });

  it('limit is CLAMPED, never rejected: 0 and a negative both yield exactly one row', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    await seedBoard(fixture, client, 3, 'spec body');

    for (const limit of [0, -5]) {
      const page = await call(client, 'work_list', { limit });
      expect(page.isError).toBe(false);
      expect(page.body.items as unknown[]).toHaveLength(1);
      expect(page.body.next_cursor).toBeTypeOf('string');
    }
  });

  it('a malformed cursor is a typed SCHEMA error payload — never a silent empty page', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    await seedBoard(fixture, client, 2, 'spec body');

    for (const cursor of ['not-a-cursor!!', 'e30=', Buffer.from('{}', 'utf8').toString('base64url')]) {
      const result = await call(client, 'work_list', { cursor });
      expect(result.isError).toBe(true);
      expect(result.body.ok).toBe(false);
      expect(result.body.code).toBe('SCHEMA');
      expect(result.body.message).toContain('cursor');
      expect(result.body.items).toBeUndefined();
    }
  });

  it('claimable is identical on a one-item page and in an unpaginated read — including a parent whose pending child is on a DIFFERENT page', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();

    // Oldest → newest: parent, filler, filler, child-of-parent. Newest-first
    // paging therefore puts the pending CHILD on page 1 and its PARENT on the
    // last page.
    fixture.setNow('2026-07-11T12:00:00.000Z');
    const parent = await call(client, 'work_create', { title: 'parent', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    const parentId = (parent.body.item as Record<string, unknown>).id as string;
    fixture.setNow('2026-07-11T12:01:00.000Z');
    await call(client, 'work_create', { title: 'filler a', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    fixture.setNow('2026-07-11T12:02:00.000Z');
    await call(client, 'work_create', { title: 'filler b', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    fixture.setNow('2026-07-11T12:03:00.000Z');
    const child = await call(client, 'work_create', {
      title: 'pending child',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      parent_id: parentId,
    });
    const childId = (child.body.item as Record<string, unknown>).id as string;

    const unpaged = await call(client, 'work_list', { limit: 500 });
    const unpagedClaimable = new Map(
      (unpaged.body.items as Array<Record<string, unknown>>).map((i) => [i.id as string, i.claimable as boolean]),
    );
    // The property under test only means something if the parent is in fact
    // gated by its pending child.
    expect(unpagedClaimable.get(parentId)).toBe(false);
    expect(unpagedClaimable.get(childId)).toBe(true);

    const pagedClaimable = new Map<string, boolean>();
    let cursor: string | null = null;
    do {
      const page: { body: Record<string, unknown> } = await call(client, 'work_list', {
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      for (const item of page.body.items as Array<Record<string, unknown>>) {
        pagedClaimable.set(item.id as string, item.claimable as boolean);
      }
      cursor = page.body.next_cursor as string | null;
    } while (cursor !== null);

    expect(pagedClaimable).toEqual(unpagedClaimable);
  });

  it('an item created BETWEEN page fetches neither duplicates nor skips the older rows still to come', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const newestFirst = await seedBoard(fixture, client, 6, 'spec body');

    const first = await call(client, 'work_list', { limit: 3 });
    const firstIds = (first.body.items as Array<Record<string, unknown>>).map((i) => i.id as string);
    expect(firstIds).toEqual(newestFirst.slice(0, 3));

    // A brand-new (therefore NEWER) item lands mid-walk. Keyset paging is
    // anchored to the last row's (created_at, id) — not to an OFFSET — so it
    // cannot shift the window.
    fixture.setNow('2026-07-11T13:00:00.000Z');
    const inserted = await call(client, 'work_create', { title: 'inserted', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    const insertedId = (inserted.body.item as Record<string, unknown>).id as string;

    const second = await call(client, 'work_list', { limit: 3, cursor: first.body.next_cursor as string });
    const secondIds = (second.body.items as Array<Record<string, unknown>>).map((i) => i.id as string);
    expect(secondIds).toEqual(newestFirst.slice(3));
    expect(secondIds).not.toContain(insertedId);
    expect(second.body.next_cursor).toBeNull();
    // Union: the six pre-existing ids, each exactly once.
    expect([...firstIds, ...secondIds].sort()).toEqual([...newestFirst].sort());
  });

  it('applies the DEFAULT page size when no limit is given: exactly DEFAULT_LIST_LIMIT rows, a non-null cursor, and a walk that covers every id exactly once', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    // MORE items than the default page size, deliberately: the default is
    // UNOBSERVABLE on a board that fits in one page, so a smaller fixture
    // would stay green even with the transport default deleted.
    const newestFirst = await seedBoard(fixture, client, DEFAULT_LIST_LIMIT + 5, 'spec body', (i) => `i${String(i)}`);
    expect(newestFirst).toHaveLength(DEFAULT_LIST_LIMIT + 5);

    const first = await call(client, 'work_list', {});
    expect(first.isError).toBe(false);
    const items = first.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(DEFAULT_LIST_LIMIT);
    expect(first.body.next_cursor).toBeTypeOf('string');
    expect(items.map((i) => i.id)).toEqual(newestFirst.slice(0, DEFAULT_LIST_LIMIT));
    // Short titles and short specs keep a full page well inside the payload
    // budget, so what closed this page is the COUNT default — the thing under
    // test — and not the byte budget tested below.
    expect(items.reduce((total, item) => total + JSON.stringify(item).length, 0)).toBeLessThan(LIST_PAYLOAD_BUDGET_CHARS);

    const walk = await walkAll(client, {});
    expect(walk.pageSizes).toEqual([DEFAULT_LIST_LIMIT, 5]);
    expect(walk.ids).toEqual(newestFirst);
    expect(new Set(walk.ids).size).toBe(newestFirst.length);
  });

  it('bounds the PAYLOAD, not just the item count: a page whose items exceed the budget closes early with fewer than `limit` rows and a cursor', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    // include_spec is the advertised parameter that reaches the budget
    // fastest — 20 x 5k specs is >100k characters, larger than the payload
    // that blew the client's token cap in the first place.
    const newestFirst = await seedBoard(fixture, client, 20, 'x'.repeat(5_000));

    const page = await call(client, 'work_list', { limit: 20, include_spec: true });
    expect(page.isError).toBe(false);
    const items = page.body.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(1);
    expect(items.length).toBeLessThan(20); // the BUDGET closed this page, not the limit
    expect(items.reduce((total, item) => total + JSON.stringify(item).length, 0)).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    // …and the caller is told to come back, even though `limit` was not reached.
    expect(page.body.next_cursor).toBeTypeOf('string');

    // A budget-closed sequence still walks the whole board exactly once.
    const walk = await walkAll(client, { limit: 20, include_spec: true });
    expect(walk.ids).toEqual(newestFirst);
    expect(new Set(walk.ids).size).toBe(newestFirst.length);
    expect(walk.pageSizes.every((size) => size < 20)).toBe(true);
  });

  it('LIVENESS: an item larger than the whole budget is returned ALONE with a cursor — never an empty page that stalls the walk', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const base = Date.parse(FIXED_ISO);
    const oversizedSpec = 'x'.repeat(LIST_PAYLOAD_BUDGET_CHARS * 2);
    fixture.setNow(new Date(base).toISOString());
    const small = await call(client, 'work_create', { title: 'small', spec: 'tiny', spec_format: 'text/plain', actor_human: 'dan' });
    const smallId = (small.body.item as Record<string, unknown>).id as string;
    fixture.setNow(new Date(base + 60_000).toISOString());
    const huge = await call(client, 'work_create', { title: 'huge', spec: oversizedSpec, spec_format: 'text/plain', actor_human: 'dan' });
    const hugeId = (huge.body.item as Record<string, unknown>).id as string;

    const page = await call(client, 'work_list', { limit: 10, include_spec: true });
    const items = page.body.items as Array<Record<string, unknown>>;
    // One row that cannot fit is still SENT — dropping it would leave the
    // caller looping on an empty page forever.
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(hugeId);
    expect(items[0]?.spec).toBe(oversizedSpec);
    expect(JSON.stringify(items).length).toBeGreaterThan(LIST_PAYLOAD_BUDGET_CHARS);
    expect(page.body.next_cursor).toBeTypeOf('string');

    // …and the walk makes progress and terminates.
    const walk = await walkAll(client, { limit: 10, include_spec: true });
    expect(walk.pageSizes).toEqual([1, 1]);
    expect(walk.ids).toEqual([hugeId, smallId]);
  });

  it('a non-integer limit is rejected by the tool schema itself — the rejection this transport actually ships (P-50)', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    await seedBoard(fixture, client, 2, 'spec body');

    const result = await client.callTool({ name: 'work_list', arguments: { limit: 1.5 } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    // The SHIPPED rejection is the SDK's own input validation (JSON-RPC
    // -32602), raised by `zNumber.int()` before the handler runs — so
    // store.ts's clampListLimit non-integer guard is unreachable over MCP and
    // its message is NOT what a caller sees. Pinning that message here instead
    // would test a path this transport cannot take (P-50).
    expect(text).toContain('-32602');
    expect(text).toContain('work_list');
    expect(text).toContain('"limit"');
    expect(text).toContain('expected int');
    expect(text).not.toContain('must be an integer');
  });

  it('the work_list tool description states the contract it actually ships (P-52)', async () => {
    const fixture = makeFixture();
    const client = await fixture.connect();
    const { tools } = await client.listTools();
    const listTool = tools.find((t) => t.name === 'work_list');
    const description = listTool?.description ?? '';
    // Summary default + the opt-in + the paging vocabulary + the two caveats.
    for (const phrase of ['spec_length', 'include_spec', 'work_get', 'limit', 'next_cursor', 'cursor', 'OPAQUE', 'invalidates']) {
      expect(description).toContain(phrase);
    }
    expect(description).toContain(`default ${String(DEFAULT_LIST_LIMIT)}`);
    expect(description).toContain(`1..${String(MAX_LIST_LIMIT)}`);
    // …the page may be SHORTER than `limit`, and the caller is told to follow
    // next_cursor rather than infer exhaustion from a short page.
    expect(description).toContain('SHORTENED');
    expect(description).toContain(String(LIST_PAYLOAD_BUDGET_CHARS));
    expect(description).toContain('follow next_cursor');
    // …and the parameters the prose enumerates really exist on the schema.
    const props = (listTool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['include_spec', 'limit', 'cursor']));
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
