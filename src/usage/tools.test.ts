// plugin/src/usage/tools.test.ts — acceptance tests for the two usage
// MCP verbs, exercised over a real in-process MCP session (InMemoryTransport +
// Client) so argument schemas and the tools/list surface are protocol truth.
//
// Pins: exactly two verbs registered (no update/delete); side-effect-free
// registration with first-CALL lazy init; usage_capture writes a signal for a
// cited delivered id and none for an uncited one; usage_query returns the
// used-item denominator — BOUNDED: a default page, an opaque cursor, a typed
// SCHEMA failure on a malformed one, and a description that states that
// contract accurately (P-52). All filesystem work happens in mkdtemp dirs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { LIST_PAYLOAD_BUDGET_CHARS } from '../transport/payload-budget.js';
import { DEFAULT_USAGE_QUERY_LIMIT, MAX_USAGE_QUERY_LIMIT } from './read-page.js';
import type { UsageSignal } from './schema.js';
import { UsageStore } from './store.js';
import { USAGE_TOOL_NAMES, createUsageToolsRegistrar } from './tools.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';
const SESSION_ID = 'sess-usage-tools';

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

function makeFixture(): { server: McpServer; usageDir: string; connect: () => Promise<Client> } {
  const usageDir = mkdtempSync(join(tmpdir(), 'ideate-usage-tools-test-'));
  tempDirs.push(usageDir);
  const clock: Clock = () => new Date(FIXED_ISO);
  const registrar = createUsageToolsRegistrar({ usageDir, clock, sessionId: SESSION_ID });
  const server = new McpServer({ name: 'ideate-test', version: '0.0.0' });
  registrar(server);
  return {
    server,
    usageDir,
    connect: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'usage-tools-test-client', version: '0.0.0' });
      clients.push(client);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    },
  };
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

/** The `signals` array of a usage_query payload, typed. */
function signalsOf(body: Record<string, unknown>): UsageSignal[] {
  return body['signals'] as UsageSignal[];
}

describe('usage tool registration', () => {
  it('registers exactly the two usage verbs (no update/delete)', () => {
    const { server } = makeFixture();
    expect(registeredNames(server)).toEqual([...USAGE_TOOL_NAMES].sort());
  });
});

describe('usage_capture + usage_query over a real MCP session', () => {
  it('captures a cited delivered item and reads it back as the denominator', async () => {
    const { connect } = makeFixture();
    const client = await connect();

    const captured = payload(
      await client.callTool({
        name: 'usage_capture',
        arguments: {
          text: 'I used T-381 and T-250 to build this; the third delivery was irrelevant.',
          delivered: ['T-381', 'T-250', 'T-999'],
          seed_id: 'T-378',
          manifest_id: 'MF-7',
          task_id: 'T-378',
        },
      }),
    );
    expect(captured['ok']).toBe(true);
    expect(captured['captured']).toBe(2);
    expect(captured['item_ids']).toEqual(['T-381', 'T-250']);

    const queried = payload(await client.callTool({ name: 'usage_query', arguments: { seed_id: 'T-378' } }));
    expect(queried['ok']).toBe(true);
    expect(signalsOf(queried)).toHaveLength(2);
    expect(queried['used_item_ids']).toEqual(['T-381', 'T-250']);
    // A selection that fits in one page is exhausted, and says so.
    expect(queried['next_cursor']).toBeNull();
    // NO `count`: under paging it could only mean "how many on this page",
    // which signals.length already says (the other three read surfaces all
    // dropped it for the same reason).
    expect('count' in queried).toBe(false);
  });

  it('captures nothing when no delivered item was cited', async () => {
    const { connect } = makeFixture();
    const client = await connect();
    const captured = payload(
      await client.callTool({
        name: 'usage_capture',
        arguments: { text: 'nothing relevant here', delivered: ['T-1', 'T-2'] },
      }),
    );
    expect(captured['captured']).toBe(0);
    expect(captured['item_ids']).toEqual([]);

    const queried = payload(await client.callTool({ name: 'usage_query', arguments: {} }));
    expect(signalsOf(queried)).toEqual([]);
    expect(queried['used_item_ids']).toEqual([]);
    expect(queried['next_cursor']).toBeNull();
  });

  it('stamps the registrar session id as provenance', async () => {
    const { connect } = makeFixture();
    const client = await connect();
    await client.callTool({
      name: 'usage_capture',
      arguments: { text: 'cites T-5', delivered: ['T-5'] },
    });
    const queried = payload(await client.callTool({ name: 'usage_query', arguments: { session_id: SESSION_ID } }));
    const signals = signalsOf(queried);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.source.session_id).toBe(SESSION_ID);
    expect(signals[0]?.source.capture_point).toBe('mcp:usage_capture');
  });
});

describe('usage_query is BOUNDED over the wire (the fourth read surface)', () => {
  /** ONE writer per log, reused across seeding calls. A second UsageStore over
   *  the same directory would mint from its own fresh entropy, and at a frozen
   *  clock two instances' ids interleave arbitrarily within that millisecond —
   *  real behavior (see readUsagePage's caveat), but not what these tests are
   *  pinning. */
  const seeders = new Map<string, UsageStore>();

  /** Seed the SAME log the registrar reads, without paying an MCP round trip
   *  per signal — the store is the tool's own door, one layer down. */
  function seedLog(usageDir: string, count: number, itemId?: (i: number) => string): string[] {
    let store = seeders.get(usageDir);
    if (store === undefined) {
      store = new UsageStore(usageDir, () => new Date(FIXED_ISO));
      seeders.set(usageDir, store);
    }
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      ids.push(
        store.record({
          item_id: itemId === undefined ? `T-${String(i % 5)}` : itemId(i),
          seed_id: 'SEED-1',
          source: { capture_point: 'eval-replay', session_id: 'sess-seed' },
        }).id,
      );
    }
    return ids;
  }

  it('a filter matching far more signals than a page returns a BOUNDED page plus a non-null cursor', async () => {
    const { usageDir, connect } = makeFixture();
    seedLog(usageDir, DEFAULT_USAGE_QUERY_LIMIT * 3);
    const client = await connect();

    const first = payload(await client.callTool({ name: 'usage_query', arguments: { seed_id: 'SEED-1' } }));
    expect(signalsOf(first)).toHaveLength(DEFAULT_USAGE_QUERY_LIMIT);
    expect(first['next_cursor']).toBeTypeOf('string');
    // …and the whole serialized result is bounded, which is the failure this
    // slice exists to prevent (a result that exceeds a client's cap hard-fails
    // the call). The envelope is small next to the two arrays it carries.
    const wire = JSON.stringify(first);
    expect(wire.length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS + 1_000);
  });

  it('walking next_cursor over the wire yields every matching signal exactly once, INCLUDING one appended mid-walk', async () => {
    const { usageDir, connect } = makeFixture();
    const ids = seedLog(usageDir, 25);
    const client = await connect();

    const seen: string[] = [];
    let cursor: string | undefined;
    let appended: string | undefined;
    for (;;) {
      const page = payload(
        await client.callTool({ name: 'usage_query', arguments: { seed_id: 'SEED-1', limit: 7, ...(cursor === undefined ? {} : { cursor }) } }),
      );
      seen.push(...signalsOf(page).map((s) => s.id));
      if (appended === undefined && seen.length >= 7) appended = seedLog(usageDir, 1, () => 'T-LATE')[0];
      const next = page['next_cursor'];
      if (next === null) break;
      cursor = next as string;
      expect(seen.length).toBeLessThanOrEqual(ids.length + 1);
    }
    expect(seen).toEqual([...ids, appended]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a malformed cursor is a typed SCHEMA error, never a silent empty page', async () => {
    const { usageDir, connect } = makeFixture();
    seedLog(usageDir, 5);
    const client = await connect();

    const result = (await client.callTool({ name: 'usage_query', arguments: { cursor: 'not-a-cursor!!' } })) as CallToolResult;
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body['ok']).toBe(false);
    expect(body['code']).toBe('SCHEMA');
    expect(String(body['reason'])).toMatch(/not a valid page cursor/);
    // P-24: the caller-supplied value is never echoed back out.
    expect(String(body['reason'])).not.toContain('not-a-cursor!!');
    // …and it is a FAILURE, not an empty page a caller reads as "the log ended".
    expect('signals' in body).toBe(false);
  });

  it('LIVENESS over the wire: one oversized signal comes back ALONE with a cursor, and the walk continues', async () => {
    const { usageDir, connect } = makeFixture();
    const oversized = seedLog(usageDir, 1, () => 'z'.repeat(LIST_PAYLOAD_BUDGET_CHARS + 2_000));
    const rest = seedLog(usageDir, 3);
    const client = await connect();

    const first = payload(await client.callTool({ name: 'usage_query', arguments: { seed_id: 'SEED-1' } }));
    expect(signalsOf(first).map((s) => s.id)).toEqual(oversized);
    expect(first['next_cursor']).toBeTypeOf('string');

    const second = payload(
      await client.callTool({ name: 'usage_query', arguments: { seed_id: 'SEED-1', cursor: first['next_cursor'] as string } }),
    );
    expect(signalsOf(second).map((s) => s.id)).toEqual(rest);
    expect(second['next_cursor']).toBeNull();
  });

  it('the tool description states the SHIPPED contract — the numbers and the cursor rule (P-52)', () => {
    const { server } = makeFixture();
    const registry = (server as unknown as { _registeredTools: Record<string, { description: string; inputSchema: unknown }> })._registeredTools;
    const tool = registry['usage_query'];
    if (tool === undefined) throw new Error('usage_query is not registered');

    // Every number a caller can observe is the one actually enforced.
    expect(tool.description).toContain(String(DEFAULT_USAGE_QUERY_LIMIT));
    expect(tool.description).toContain(String(MAX_USAGE_QUERY_LIMIT));
    expect(tool.description).toContain(String(LIST_PAYLOAD_BUDGET_CHARS));
    expect(tool.description).toContain('next_cursor');
    expect(tool.description).toMatch(/null ONLY at true exhaustion/);
    expect(tool.description).toMatch(/OPAQUE/);
    // …and the parameters it describes are the ones the schema accepts.
    const shape = (tool.inputSchema as { shape?: Record<string, unknown> } | undefined)?.shape ?? {};
    expect(Object.keys(shape)).toContain('limit');
    expect(Object.keys(shape)).toContain('cursor');
    // The dropped field is not advertised either.
    expect(tool.description).not.toMatch(/\bcount\b/);
  });
});
