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
// …and the BOUNDED read (the whole point of this door): the projection that
// omits `history` while keeping `history_length`, `include_history` restoring
// it, the by-id retrieval path, the DEFAULT page size applied here and nowhere
// else, a keyset walk that covers every item exactly once — including the
// `updated_at` TIE-BREAK arm, which real data has never triggered — the shared
// payload budget closing a page short of `limit` (and still shipping an
// oversized item ALONE), a malformed cursor as THIS seam's typed SCHEMA error,
// the GP-23 gate still short-circuiting AHEAD of any of that, and the shipped
// tool description actually stating the contract (P-52).
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { LIST_PAYLOAD_BUDGET_CHARS } from '../transport/payload-budget.js';
import { serializeSteeringItem } from './schema.js';
import type { SteeringItem } from './schema.js';
import { MAX_STEERING_READ_LIMIT } from './store.js';
import { DEFAULT_STEERING_READ_LIMIT, STEERING_TOOL_NAMES, createSteeringToolsRegistrar, readSteeringEnabledFlag } from './tools.js';

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
    expect(read).toMatchObject({ ok: true, next_cursor: null });
    const items = read['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'POL-auth-1', kind: 'policy', domain: 'auth', statement: 'Rotate tokens.' });

    // A non-matching domain filter selects nothing (selection works through the verb).
    const none = payload(await client.callTool({ name: 'steering_read', arguments: { domain: 'billing' } }));
    expect(none).toMatchObject({ ok: true, items: [], next_cursor: null });
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
    expect(read).toMatchObject({ ok: true, next_cursor: null });
    const items = read['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
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
    expect(read).toMatchObject({ ok: true, items: [] });
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
    expect(read).toMatchObject({ ok: true, items: [] });
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
    expect(read).toMatchObject({ ok: true, items: [] });
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

// ---------------------------------------------------------------------------
// The BOUNDED read.
// ---------------------------------------------------------------------------

/** Seed items straight onto disk (bypassing steering_put, whose clock is
 *  fixed) so a test can control `updated_at` exactly — including the TIES the
 *  real store has never produced. */
function seedItems(projectRoot: string, seeds: Array<Partial<SteeringItem> & { id: string; updated_at: string }>): void {
  const dir = join(projectRoot, '.ideate', 'steering');
  mkdirSync(dir, { recursive: true });
  for (const seed of seeds) {
    const item: SteeringItem = {
      kind: 'policy',
      domain: '',
      status: 'active',
      statement: `statement for ${seed.id}`,
      history: [],
      references: [],
      ...seed,
    };
    writeFileSync(join(dir, `${item.id}.md`), serializeSteeringItem(item), 'utf8');
  }
}

/** `n` items with strictly DESCENDING `updated_at` by index, so the expected
 *  order is simply `id-0, id-1, …` (newest-updated first). */
function distinctSeeds(n: number, statement = 'a short steering statement'): Array<Partial<SteeringItem> & { id: string; updated_at: string }> {
  const newest = Date.UTC(2026, 6, 16, 12, 0, 0);
  return Array.from({ length: n }, (_, i) => ({
    id: `GP-${String(i).padStart(3, '0')}`,
    // i=0 is the NEWEST: each later index is one minute older, so the expected
    // order is exactly the seed order.
    updated_at: new Date(newest - i * 60_000).toISOString(),
    statement,
  }));
}

function items(read: Record<string, unknown>): Array<Record<string, unknown>> {
  return read['items'] as Array<Record<string, unknown>>;
}

function ids(read: Record<string, unknown>): string[] {
  return items(read).map((i) => i['id'] as string);
}

/** Walk `steering_read` from the first page to a null cursor, returning every
 *  id in the order the pages delivered them. */
async function walkAll(client: Client, args: Record<string, unknown>): Promise<{ ids: string[]; pages: number }> {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const page = payload(await client.callTool({ name: 'steering_read', arguments: { ...args, ...(cursor === null ? {} : { cursor }) } }));
    expect(page['ok']).toBe(true);
    pages += 1;
    seen.push(...ids(page));
    cursor = page['next_cursor'] as string | null;
    if (cursor === null) break;
    // A runaway walk is a test bug, not a hang.
    expect(pages).toBeLessThan(500);
  }
  return { ids: seen, pages };
}

describe('bounded read: projection', () => {
  it('omits `history` by default and reports history_length; include_history restores the trail', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    seedItems(projectRoot, [
      {
        id: 'GP-21',
        updated_at: '2026-07-16T12:00:00.000Z',
        statement: 'Current rule.',
        history: [
          { at: '2026-07-15T12:00:00.000Z', status: 'active', statement: 'Older rule.' },
          { at: '2026-07-14T12:00:00.000Z', status: 'active', statement: 'Oldest rule.' },
        ],
      },
      { id: 'GP-22', updated_at: '2026-07-16T11:00:00.000Z' },
    ]);
    const client = await connect();

    const def = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    const amended = items(def).find((i) => i['id'] === 'GP-21');
    const virgin = items(def).find((i) => i['id'] === 'GP-22');
    // The trail is GONE — not empty, absent — and the count is what tells an
    // amended rule from a never-amended one.
    expect(amended).not.toHaveProperty('history');
    expect(virgin).not.toHaveProperty('history');
    expect(amended?.['history_length']).toBe(2);
    expect(virgin?.['history_length']).toBe(0);
    // Everything else survives the projection, including the derived backlinks.
    expect(amended).toMatchObject({ id: 'GP-21', kind: 'policy', status: 'active', statement: 'Current rule.', referenced_by: [] });

    const full = payload(await client.callTool({ name: 'steering_read', arguments: { include_history: true } }));
    const withHistory = items(full).find((i) => i['id'] === 'GP-21');
    expect(withHistory?.['history']).toEqual([
      { at: '2026-07-15T12:00:00.000Z', status: 'active', statement: 'Older rule.' },
      { at: '2026-07-14T12:00:00.000Z', status: 'active', statement: 'Oldest rule.' },
    ]);
    // history_length is present in BOTH modes — never a field that appears and
    // disappears with a flag.
    expect(withHistory?.['history_length']).toBe(2);
  });

  it('id selects exactly that item — the by-id retrieval path, paired with include_history', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    seedItems(projectRoot, [
      ...distinctSeeds(5),
      { id: 'GP-21', updated_at: '2026-07-16T09:00:00.000Z', statement: 'Process only.', history: [{ at: '2026-07-15T09:00:00.000Z', status: 'active', statement: 'Prior.' }] },
    ]);
    const client = await connect();

    const one = payload(await client.callTool({ name: 'steering_read', arguments: { id: 'GP-21', include_history: true } }));
    expect(ids(one)).toEqual(['GP-21']);
    expect(one['next_cursor']).toBeNull();
    expect(items(one)[0]).toMatchObject({ statement: 'Process only.', history_length: 1 });
    expect(items(one)[0]?.['history']).toEqual([{ at: '2026-07-15T09:00:00.000Z', status: 'active', statement: 'Prior.' }]);

    // An id that matches nothing selects nothing — an empty page, not an error.
    const none = payload(await client.callTool({ name: 'steering_read', arguments: { id: 'GP-nope' } }));
    expect(none).toMatchObject({ ok: true, items: [], next_cursor: null });
  });
});

describe('bounded read: keyset paging', () => {
  it(`applies the DEFAULT page size (${String(DEFAULT_STEERING_READ_LIMIT)}) with no arguments — a real-scale store no longer comes back in one unbounded response`, async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    // 103 items: this project's own steering store, whose unbounded payload
    // measured 55,997 characters — already past the budget.
    seedItems(projectRoot, distinctSeeds(103));
    const client = await connect();

    const first = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    // THE PIN: the default is applied at this door. Remove it and this page
    // comes back with all 103 items and a null cursor.
    expect(items(first)).toHaveLength(DEFAULT_STEERING_READ_LIMIT);
    expect(first['next_cursor']).toBeTypeOf('string');
    expect(JSON.stringify(items(first)).length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
  });

  it('walking next_cursor to exhaustion yields every matching item exactly once, newest-updated first, ending with a null cursor', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const seeds = distinctSeeds(103);
    seedItems(projectRoot, seeds);
    const client = await connect();

    const walk = await walkAll(client, { limit: 10 });
    expect(walk.ids).toEqual(seeds.map((s) => s.id));
    expect(new Set(walk.ids).size).toBe(seeds.length);
    expect(walk.pages).toBe(11);
  });

  it('exercises the TIE-BREAK arm: items sharing an identical updated_at page in id ASCENDING order, reproducing the unpaged order exactly', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const tied = '2026-07-16T12:00:00.000Z';
    seedItems(projectRoot, [
      { id: 'POL-c', updated_at: tied },
      { id: 'POL-a', updated_at: tied },
      { id: 'POL-d', updated_at: tied },
      { id: 'POL-b', updated_at: tied },
      { id: 'GP-newer', updated_at: '2026-07-16T13:00:00.000Z' },
      { id: 'GP-older', updated_at: '2026-07-16T11:00:00.000Z' },
    ]);
    const client = await connect();

    // The unpaged truth, in one page (the max limit still fits these rows).
    const unpaged = payload(await client.callTool({ name: 'steering_read', arguments: { limit: MAX_STEERING_READ_LIMIT } }));
    expect(unpaged['next_cursor']).toBeNull();
    expect(ids(unpaged)).toEqual(['GP-newer', 'POL-a', 'POL-b', 'POL-c', 'POL-d', 'GP-older']);

    // …reproduced exactly by a walk at limit 1, which lands EVERY page boundary
    // inside the tie. A predicate with the id arm pointing the wrong way would
    // either loop on POL-a forever or skip the rest of the tie outright.
    const oneByOne = await walkAll(client, { limit: 1 });
    expect(oneByOne.ids).toEqual(ids(unpaged));
    // Six items, six pages: the LAST page carries the sixth row and a null
    // cursor — the walk never pays for a trailing empty page.
    expect(oneByOne.pages).toBe(6);

    // …and at limit 2, where a boundary falls mid-tie on a different row.
    expect((await walkAll(client, { limit: 2 })).ids).toEqual(ids(unpaged));
  });

  it('an out-of-range limit is CLAMPED, not rejected; a non-integer limit never reaches the store (the schema rejects it first)', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    seedItems(projectRoot, distinctSeeds(3));
    const client = await connect();

    expect(ids(payload(await client.callTool({ name: 'steering_read', arguments: { limit: 0 } })))).toEqual(['GP-000']);
    expect(ids(payload(await client.callTool({ name: 'steering_read', arguments: { limit: -5 } })))).toEqual(['GP-000']);
    expect(items(payload(await client.callTool({ name: 'steering_read', arguments: { limit: 9999 } })))).toHaveLength(3);
    // A non-integer is a SHAPE failure, and the declared `zNumber.int()`
    // argument schema catches it at the protocol boundary — the store's own
    // integer guard (store.test.ts pins it directly) is defense in depth for a
    // transport that does not declare the type.
    const nonInteger = (await client.callTool({ name: 'steering_read', arguments: { limit: 1.5 } })) as CallToolResult;
    expect(nonInteger.isError).toBe(true);
    expect(JSON.stringify(nonInteger.content)).toMatch(/limit/i);
  });
});

describe('bounded read: payload budget', () => {
  it('closes a page SHORT of `limit` when the items would exceed the budget, with an honest cursor the walk resumes from', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    // Six ~15k-character statements: two fit the 40k budget, three do not.
    const seeds = distinctSeeds(6, 'x'.repeat(15_000));
    seedItems(projectRoot, seeds);
    const client = await connect();

    const page = payload(await client.callTool({ name: 'steering_read', arguments: { limit: 6 } }));
    expect(items(page).length).toBeLessThan(6);
    expect(items(page)).toHaveLength(2);
    expect(JSON.stringify(items(page)).length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    expect(page['next_cursor']).toBeTypeOf('string');

    // The short page is not a lost page: the walk still covers everything once.
    const walk = await walkAll(client, { limit: 6 });
    expect(walk.ids).toEqual(seeds.map((s) => s.id));
  });

  it('LIVENESS: an item larger than the WHOLE budget is returned ALONE rather than dropped, and the walk continues past it', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    seedItems(projectRoot, [
      { id: 'GP-huge', updated_at: '2026-07-16T13:00:00.000Z', statement: 'x'.repeat(LIST_PAYLOAD_BUDGET_CHARS * 2) },
      { id: 'GP-small-a', updated_at: '2026-07-16T12:00:00.000Z' },
      { id: 'GP-small-b', updated_at: '2026-07-16T11:00:00.000Z' },
    ]);
    const client = await connect();

    const first = payload(await client.callTool({ name: 'steering_read', arguments: {} }));
    expect(ids(first)).toEqual(['GP-huge']);
    expect(first['next_cursor']).toBeTypeOf('string');
    // An empty page with a cursor would stall the walk forever; this one moves.
    expect((await walkAll(client, {})).ids).toEqual(['GP-huge', 'GP-small-a', 'GP-small-b']);
  });
});

describe('bounded read: malformed cursors and the gate', () => {
  const MALFORMED: Array<[string, string]> = [
    // Every mechanical way `Buffer.from(x, 'base64url')` is LENIENT, plus the
    // seam's own shape check. None may degrade into an empty page.
    ['wrong alphabet', 'not a cursor!!'],
    ['padded', `${Buffer.from(JSON.stringify(['2026-07-16T12:00:00.000Z', 'GP-000']), 'utf8').toString('base64')}`],
    ['short final group', 'AAAAA'],
    ['non-canonical tail', 'QR'],
    ['decodes but is not JSON', Buffer.from('nonsense bytes', 'utf8').toString('base64url')],
    ['JSON, but not the [updated_at, id] boundary', Buffer.from(JSON.stringify(['only-one']), 'utf8').toString('base64url')],
    ['JSON, but not strings', Buffer.from(JSON.stringify([1, 2]), 'utf8').toString('base64url')],
  ];

  it('every malformed cursor is THIS seam’s typed SCHEMA error — never a silent empty page, never an echoed value', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    seedItems(projectRoot, distinctSeeds(3));
    const client = await connect();

    for (const [why, cursor] of MALFORMED) {
      const result = await client.callTool({ name: 'steering_read', arguments: { cursor } });
      const body = payload(result);
      expect(body, why).toMatchObject({ ok: false, code: 'SCHEMA' });
      expect((result as CallToolResult).isError, why).toBe(true);
      expect(body, why).not.toHaveProperty('items');
      const reason = body['reason'] as string;
      expect(reason, why).toMatch(/steering store: "cursor" is not a valid page cursor/);
      // P-24: the attacker-supplied value is never echoed back into a message
      // that flows out through an un-gated error surface.
      expect(reason, why).not.toContain(cursor);
    }
  });

  it('the GP-23 gate short-circuits AHEAD of cursor decoding: a gated project gets GATED even with a malformed cursor, and no store is touched', async () => {
    const { projectRoot, connect } = makeFixture();
    // Deliberately NOT enabled.
    const client = await connect();
    const gated = payload(await client.callTool({ name: 'steering_read', arguments: { cursor: 'not a cursor!!', limit: 0, include_history: true } }));
    expect(gated).toMatchObject({ ok: false, code: 'GATED' });
    // Not SCHEMA: a gated project must not learn even that its cursor was bad.
    expect(gated['code']).not.toBe('SCHEMA');
    expect(existsSync(join(projectRoot, '.ideate'))).toBe(false);
  });
});

describe('bounded read: the shipped contract (P-52 — prose matches the schema)', () => {
  it('the steering_read description states the projection, the id path, paging, the short-page rule and the amend-during-pagination caveat', async () => {
    const { projectRoot, connect } = makeFixture();
    enableSteering(projectRoot);
    const client = await connect();
    const tool = (await client.listTools()).tools.find((t) => t.name === 'steering_read');
    const description = tool?.description ?? '';

    // The projection and its opt-in.
    expect(description).toContain('history_length');
    expect(description).toContain('include_history');
    // The by-id retrieval path.
    expect(description).toMatch(/id \(exact/);
    // Paging, with the numbers the code actually ships.
    expect(description).toContain(`default ${String(DEFAULT_STEERING_READ_LIMIT)}`);
    expect(description).toContain(`1..${String(MAX_STEERING_READ_LIMIT)}`);
    expect(description).toContain('next_cursor');
    expect(description).toContain(String(LIST_PAYLOAD_BUDGET_CHARS));
    // A page may be SHORTER than limit, and exhaustion means following the
    // cursor until it is null.
    expect(description).toMatch(/SHORTER than `limit`/);
    expect(description).toMatch(/until it is\s+null/);
    // …and the honest caveat about the MUTABLE sort key.
    expect(description).toMatch(/CAVEAT \(P-52\)/);
    expect(description).toMatch(/restamps\s+updated_at/);
    expect(description).toMatch(/missed by that walk/);

    // Every parameter the prose names is actually on the shipped schema.
    const properties = Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
    expect(properties.sort()).toEqual(['cursor', 'domain', 'id', 'include_history', 'kind', 'limit', 'status']);
  });
});
