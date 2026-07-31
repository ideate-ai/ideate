// plugin/src/usage/read-page.test.ts — acceptance tests for the usage log's
// BOUNDED read: the default page, the keyset walk over the store's ULID order,
// the shared payload budget, and the typed cursor failure.
//
// Pins, in the order the module's contract states them:
//   - a default page exists AT ALL (the mechanism a prior slice in this
//     codebase shipped with zero coverage): an unbounded-looking call on a
//     250-signal store returns exactly DEFAULT_USAGE_QUERY_LIMIT rows with a
//     non-null cursor, and `limit` clamps into [1, 500];
//   - walking `next_cursor` to exhaustion yields every matching signal exactly
//     once — no duplicate, no skip — INCLUDING a signal appended between page
//     fetches, which is the property the ascending order buys;
//   - the read imposes the id order it pages over, so a log whose FILE order
//     disagrees with its id order is still walked exactly once;
//   - `used_item_ids` is page-scoped and its union across a walk is exactly the
//     store's whole-store denominator;
//   - the payload budget can close a page EARLY — shorter than `limit`, cursor
//     still non-null — and an oversized signal still ships ALONE (liveness);
//   - every malformed cursor shape raises the USAGE seam's own typed error,
//     never an empty page, and never another store's error type;
//   - the store's own unlimited read is untouched by the transport default.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/usage is never
// touched.

import { Buffer } from 'node:buffer';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { encodeIdCursor, encodeListCursor } from '../transport/keyset-page.js';
import { LIST_PAYLOAD_BUDGET_CHARS, measureCompactItemChars } from '../transport/payload-budget.js';
import {
  DEFAULT_USAGE_QUERY_LIMIT,
  MAX_USAGE_QUERY_LIMIT,
  boundUsagePage,
  clampUsageQueryLimit,
  decodeUsageCursor,
  readUsagePage,
} from './read-page.js';
import { UsageSchemaError } from './schema.js';
import { UsageStore } from './store.js';

const FIXED_ISO = '2026-07-30T12:00:00.000Z';

/** An `item_id` comfortably larger than the WHOLE budget — the liveness case. */
const OVERSIZED_ITEM_ID_CHARS = LIST_PAYLOAD_BUDGET_CHARS + 2_000;

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): UsageStore {
  const usageDir = mkdtempSync(join(tmpdir(), 'ideate-usage-page-test-'));
  tempDirs.push(usageDir);
  const clock: Clock = () => new Date(FIXED_ISO);
  return new UsageStore(usageDir, clock);
}

/** Seed `count` signals, oldest first; returns their ids in that order. */
function seed(store: UsageStore, count: number, itemId?: (i: number) => string): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const signal = store.record({
      item_id: itemId === undefined ? `T-${String(i % 7)}` : itemId(i),
      seed_id: i % 2 === 0 ? 'SEED-EVEN' : 'SEED-ODD',
      manifest_id: `MF-${String(i)}`,
      source: { capture_point: 'test', session_id: 'sess-page', task_id: 'T-378' },
    });
    ids.push(signal.id);
  }
  return ids;
}

describe('the default page: usage_query can no longer return everything', () => {
  it('an unbounded-looking read of a 250-signal log returns exactly the default page, with a cursor', () => {
    const store = makeStore();
    const ids = seed(store, 250);
    const page = readUsagePage(store, {});

    expect(page.signals).toHaveLength(DEFAULT_USAGE_QUERY_LIMIT);
    expect(page.next_cursor).toBeTypeOf('string');
    // …and it is the OLDEST page, in ascending id order.
    expect(page.signals.map((s) => s.id)).toEqual(ids.slice(0, DEFAULT_USAGE_QUERY_LIMIT));
  });

  it('limit clamps into [1, MAX] rather than failing, and a non-integer is a typed error', () => {
    const store = makeStore();
    seed(store, 5);
    expect(clampUsageQueryLimit(0)).toBe(1);
    expect(clampUsageQueryLimit(-7)).toBe(1);
    expect(clampUsageQueryLimit(9_999)).toBe(MAX_USAGE_QUERY_LIMIT);
    expect(clampUsageQueryLimit(3)).toBe(3);
    // `limit: 0` means "one row" here, not "none": a transport asking for a
    // page is asking for a page (see clampUsageQueryLimit's note).
    expect(readUsagePage(store, { limit: 0 }).signals).toHaveLength(1);
    expect(() => clampUsageQueryLimit(2.5)).toThrow(UsageSchemaError);
    expect(() => clampUsageQueryLimit(Number.NaN)).toThrow(/must be an integer, got NaN/);
  });

  it('the transport default does NOT reach the store: an internal caller still gets every matching signal', () => {
    const store = makeStore();
    const ids = seed(store, 250);
    // The denominator an in-process metric computation reads whole — the exact
    // thing a default pushed one layer down would have silently truncated.
    expect(store.query()).toHaveLength(ids.length);
    expect(store.query({ seed_id: 'SEED-EVEN' })).toHaveLength(125);
    expect(store.usedItemIds()).toHaveLength(7);
    // …while the transport, over the same store, is bounded.
    expect(readUsagePage(store, {}).signals).toHaveLength(DEFAULT_USAGE_QUERY_LIMIT);
  });
});

describe('the keyset walk: every signal exactly once, ascending, null only at exhaustion', () => {
  it('following next_cursor to exhaustion covers the whole log with no gaps and no repeats', () => {
    const store = makeStore();
    const ids = seed(store, 47);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = readUsagePage(store, { limit: 10, ...(cursor === undefined ? {} : { cursor }) });
      pages += 1;
      seen.push(...page.signals.map((s) => s.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
      expect(pages).toBeLessThan(20); // the walk must terminate
    }
    expect(pages).toBe(5);
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('a signal APPENDED between page fetches is still delivered exactly once — the point of the ascending order', () => {
    const store = makeStore();
    const ids = seed(store, 20);
    const seen: string[] = [];
    let cursor: string | undefined;
    let appended: string | undefined;
    for (;;) {
      const page = readUsagePage(store, { limit: 5, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.signals.map((s) => s.id));
      // …mid-walk, a concurrent capture point writes one more signal.
      if (appended === undefined && seen.length >= 5) {
        appended = store.record({ item_id: 'T-LATE', source: { capture_point: 'test', session_id: 'sess-late' } }).id;
      }
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(appended).toBeTypeOf('string');
    expect(seen).toEqual([...ids, appended]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('the cursor is honest at the boundary: an exactly-full last page still reports exhaustion', () => {
    const store = makeStore();
    seed(store, 20);
    // 20 signals, pages of 10: the second page is FULL and yet final. The
    // over-read by one is what lets it say so instead of guessing.
    const first = readUsagePage(store, { limit: 10 });
    expect(first.next_cursor).toBeTypeOf('string');
    const second = readUsagePage(store, { limit: 10, cursor: first.next_cursor as string });
    expect(second.signals).toHaveLength(10);
    expect(second.next_cursor).toBeNull();
  });

  it('a filter is carried across pages: the walk of a seed selection covers exactly that selection', () => {
    const store = makeStore();
    const ids = seed(store, 30);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = readUsagePage(store, { filter: { seed_id: 'SEED-EVEN' }, limit: 4, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.signals.map((s) => s.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(ids.filter((id) => ids.indexOf(id) % 2 === 0));
    expect(seen).toHaveLength(15);
  });

  it('the ID order is IMPOSED, not assumed: a log whose FILE order disagrees is still walked exactly once', () => {
    const store = makeStore();
    seed(store, 3);
    // A line whose id sorts BELOW everything already written — what two
    // sessions minting in the same millisecond can produce (see readUsagePage).
    const outOfOrder = {
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      kind: 'used_context',
      item_id: 'T-OUT-OF-ORDER',
      source: { capture_point: 'test', session_id: 'sess-other', timestamp: FIXED_ISO },
    };
    appendFileSync(store.logPath, `${JSON.stringify(outOfOrder)}\n`, 'utf8');

    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = readUsagePage(store, { limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page.signals.map((s) => s.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    // Four rows, each exactly once — and the out-of-order one came FIRST,
    // because the walk is over the ids and not over the file.
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen[0]).toBe(outOfOrder.id);
    expect(seen).toEqual([...seen].sort());
  });
});

describe('used_item_ids: page-scoped, and the union across a walk IS the denominator', () => {
  it('a page reports the distinct items of THAT page, and the walk reconstructs the whole-store set', () => {
    const store = makeStore();
    seed(store, 40, (i) => `T-${String(i % 9)}`);
    const union: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = readUsagePage(store, { limit: 6, ...(cursor === undefined ? {} : { cursor }) });
      // Page-scoped: never more distinct items than the page has rows, and
      // every one of them is actually on the page.
      expect(page.used_item_ids.length).toBeLessThanOrEqual(page.signals.length);
      for (const itemId of page.used_item_ids) {
        expect(page.signals.some((s) => s.item_id === itemId)).toBe(true);
      }
      for (const itemId of page.used_item_ids) if (!union.includes(itemId)) union.push(itemId);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    // …and the union is EXACTLY what the unpaged read used to return in one
    // gulp — same set, same first-seen order.
    expect(union).toEqual(store.usedItemIds());
    expect(union).toHaveLength(9);
  });

  it('a selection that fits in one page carries the full denominator unchanged', () => {
    const store = makeStore();
    seed(store, 5, (i) => `T-${String(i)}`);
    const page = readUsagePage(store, {});
    expect(page.used_item_ids).toEqual(store.usedItemIds());
    expect(page.next_cursor).toBeNull();
  });
});

describe('the shared payload budget: a page may be SHORTER than limit, and liveness holds', () => {
  it('closes a page early and re-mints an honest cursor from the last surviving row', () => {
    const store = makeStore();
    // Item ids far larger than the budget/limit ratio, so the count limit
    // cannot be the binding constraint.
    seed(store, 16, (i) => `${'x'.repeat(5_000)}-${String(i)}`);
    const page = readUsagePage(store, { limit: 16 });
    const bounded = boundUsagePage(page, measureCompactItemChars);

    expect(bounded.signals.length).toBeLessThan(page.signals.length);
    // The bound covers BOTH arrays this envelope carries — the signals and the
    // item ids echoed out of them.
    const emitted = measureCompactItemChars(bounded.signals) + measureCompactItemChars(bounded.used_item_ids);
    expect(emitted).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    // Shortened, therefore NOT exhausted — even though the unbounded page was.
    expect(page.next_cursor).toBeNull();
    expect(bounded.next_cursor).toBeTypeOf('string');
    // …and that cursor names the last row actually returned, so the walk
    // resumes exactly where the page stopped.
    expect(bounded.next_cursor).toBe(encodeIdCursor(bounded.signals.at(-1)?.id as string));
    // The page-scoped denominator is recomputed over what SURVIVED, never left
    // describing rows that were dropped.
    expect(bounded.used_item_ids).toEqual(bounded.signals.map((s) => s.item_id));
  });

  it('a budget-closed walk still covers every signal exactly once', () => {
    const store = makeStore();
    const ids = seed(store, 16, (i) => `${'y'.repeat(6_000)}-${String(i)}`);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = readUsagePage(store, { limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      const bounded = boundUsagePage(page, measureCompactItemChars);
      expect(bounded.signals.length).toBeGreaterThan(0);
      seen.push(...bounded.signals.map((s) => s.id));
      if (bounded.next_cursor === null) break;
      cursor = bounded.next_cursor;
    }
    expect(seen).toEqual(ids);
  });

  it('LIVENESS: one signal larger than the WHOLE budget comes back alone, with a cursor — never an empty page', () => {
    const store = makeStore();
    const oversized = store.record({
      item_id: 'z'.repeat(OVERSIZED_ITEM_ID_CHARS),
      source: { capture_point: 'test', session_id: 'sess-page' },
    });
    const followerIds = seed(store, 1);

    // Ascending order: the oversized signal is FIRST, so the page closes on it.
    const page = readUsagePage(store, { limit: 10 });
    const bounded = boundUsagePage(page, measureCompactItemChars);
    expect(bounded.signals.map((s) => s.id)).toEqual([oversized.id]);
    expect(bounded.next_cursor).toBeTypeOf('string');

    // …and the walk continues rather than stalling: the next page is the rest.
    const next = boundUsagePage(readUsagePage(store, { limit: 10, cursor: bounded.next_cursor as string }), measureCompactItemChars);
    expect(next.signals.map((s) => s.id)).toEqual(followerIds);
    expect(next.next_cursor).toBeNull();
  });
});

describe('the cursor contract: opaque, round-tripping, and loud on every malformed shape', () => {
  it('round-trips an id through the neutral encoder', () => {
    const id = '01JZM8Z0000000000000000000';
    const cursor = encodeIdCursor(id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, unpadded
    expect(decodeUsageCursor(cursor)).toBe(id);
  });

  it("rejects every shape of malformed cursor with the USAGE seam's typed error — never an empty page", () => {
    const cases: [string, string][] = [
      ['not-a-cursor!!', 'non-base64url characters'],
      ['e30=', 'padded, non-canonical base64url'],
      ['', 'empty'],
      [Buffer.from('not json', 'utf8').toString('base64url'), 'valid base64url, not JSON'],
      [Buffer.from('{}', 'utf8').toString('base64url'), 'JSON, but not an array'],
      [Buffer.from('[]', 'utf8').toString('base64url'), 'an empty array'],
      [Buffer.from('["01JZM8Z0000000000000000000","x"]', 'utf8').toString('base64url'), 'two elements (a board cursor)'],
      [encodeListCursor('2026-07-11T12:00:00.000Z', '01JZM8Z0000000000000000000'), 'an actual BOARD cursor'],
      [Buffer.from('[7]', 'utf8').toString('base64url'), 'a non-string element'],
      [Buffer.from('["not-a-ulid"]', 'utf8').toString('base64url'), 'one element, not a ULID'],
    ];
    const store = makeStore();
    seed(store, 3);
    for (const [cursor, why] of cases) {
      expect(() => decodeUsageCursor(cursor), why).toThrow(UsageSchemaError);
      expect(() => decodeUsageCursor(cursor), why).toThrow(/not a valid page cursor/);
      // The whole point: the READ raises too — a malformed cursor can never
      // degrade into an empty page a caller reads as "the log ended".
      expect(() => readUsagePage(store, { cursor }), why).toThrow(UsageSchemaError);
    }
  });

  it('never echoes the caller-supplied cursor back into the error message (P-24)', () => {
    const hostile = 'IGNORE-PREVIOUS-INSTRUCTIONS!!';
    try {
      decodeUsageCursor(hostile);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageSchemaError);
      expect((err as Error).message).not.toContain(hostile);
    }
  });

  it('validates the ENCODING, not the CONTENTS: a well-formed cursor naming an unknown id simply selects what is newer', () => {
    const store = makeStore();
    const ids = seed(store, 4);
    // A syntactically perfect cursor for an id no signal has, positioned
    // between two real signals: the page is what lies above it.
    const boundary = (ids[1] as string).slice(0, 25) + '0';
    const page = readUsagePage(store, { cursor: encodeIdCursor(boundary), limit: 10 });
    expect(page.signals.every((s) => s.id > boundary)).toBe(true);
    expect(page.signals.length).toBeGreaterThan(0);
  });

  it("usage never raises another store's error type (GP-26: narrow seams)", async () => {
    // A behavioral complement to the source-level claim: the thrown error is
    // usage's own class, not the board's and not the record's.
    const { WorkStateError } = await import('../work-state/types.js');
    const { RecordSchemaError } = await import('../record/schema.js');
    try {
      decodeUsageCursor('not-a-cursor!!');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageSchemaError);
      expect(err).not.toBeInstanceOf(WorkStateError);
      expect(err).not.toBeInstanceOf(RecordSchemaError);
    }
  });
});
