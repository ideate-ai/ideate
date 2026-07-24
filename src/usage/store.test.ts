// plugin/src/usage/store.test.ts — acceptance tests for the append-only
// usage store: a signal is WRITTEN on record and is queryable as the
// effectiveness DENOMINATOR (usedItemIds per seed); append-only across
// instances; exact-match filtering; unparseable lines skipped.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { UsageStore } from './store.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): { store: UsageStore; usageDir: string; setNow: (iso: string) => void } {
  const usageDir = mkdtempSync(join(tmpdir(), 'ideate-usage-store-test-'));
  tempDirs.push(usageDir);
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  return { store: new UsageStore(usageDir, clock), usageDir, setNow: (iso) => { nowIso = iso; } };
}

describe('record — writes an append-only signal', () => {
  it('assigns id + timestamp and persists one NDJSON line', () => {
    const { store } = makeStore();
    const signal = store.record({
      item_id: 'T-381',
      seed_id: 'T-378',
      source: { capture_point: 'eval-replay', session_id: 'sess-1', task_id: 'T-378' },
    });
    expect(signal.item_id).toBe('T-381');
    expect(signal.kind).toBe('used_context'); // default
    expect(signal.source.timestamp).toBe(FIXED_ISO);
    expect(signal.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    const raw = readFileSync(store.logPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('rejects an empty item_id BEFORE writing (no partial log)', () => {
    const { store } = makeStore();
    expect(() => store.record({ item_id: '', source: { capture_point: 'x', session_id: 's' } })).toThrow();
    // No file created / nothing appended.
    expect(store.query()).toEqual([]);
  });

  it('is append-only across store instances (a new instance sees prior signals)', () => {
    const { store, usageDir } = makeStore();
    store.record({ item_id: 'T-1', source: { capture_point: 'p', session_id: 's' } });
    const reopened = new UsageStore(usageDir, () => new Date(FIXED_ISO));
    reopened.record({ item_id: 'T-2', source: { capture_point: 'p', session_id: 's' } });
    expect(reopened.query().map((s) => s.item_id)).toEqual(['T-1', 'T-2']);
  });
});

describe('query / usedItemIds — the effectiveness denominator', () => {
  it('groups the USED set per seed (recall denominator)', () => {
    const { store } = makeStore();
    store.record({ item_id: 'T-10', seed_id: 'T-A', source: { capture_point: 'p', session_id: 's' } });
    store.record({ item_id: 'T-11', seed_id: 'T-A', source: { capture_point: 'p', session_id: 's' } });
    store.record({ item_id: 'T-10', seed_id: 'T-A', source: { capture_point: 'p', session_id: 's' } }); // dup
    store.record({ item_id: 'T-99', seed_id: 'T-B', source: { capture_point: 'p', session_id: 's' } });

    expect(store.usedItemIds({ seed_id: 'T-A' })).toEqual(['T-10', 'T-11']);
    expect(store.usedItemIds({ seed_id: 'T-B' })).toEqual(['T-99']);
    expect(store.usedItemIds()).toEqual(['T-10', 'T-11', 'T-99']);
  });

  it('filters by manifest / session / kind (exact-match AND)', () => {
    const { store } = makeStore();
    store.record({ item_id: 'T-1', manifest_id: 'MF-1', kind: 'cites', source: { capture_point: 'p', session_id: 's1' } });
    store.record({ item_id: 'T-2', manifest_id: 'MF-2', source: { capture_point: 'p', session_id: 's2' } });

    expect(store.query({ manifest_id: 'MF-1' }).map((s) => s.item_id)).toEqual(['T-1']);
    expect(store.query({ session_id: 's2' }).map((s) => s.item_id)).toEqual(['T-2']);
    expect(store.query({ kind: 'cites' }).map((s) => s.item_id)).toEqual(['T-1']);
    expect(store.query({ manifest_id: 'MF-1', session_id: 's2' })).toEqual([]); // AND
  });

  it('returns [] when the log does not exist yet', () => {
    const { store } = makeStore();
    expect(store.query()).toEqual([]);
    expect(store.usedItemIds()).toEqual([]);
  });

  it('skips an unparseable line and keeps the valid ones', () => {
    const { store } = makeStore();
    store.record({ item_id: 'T-1', source: { capture_point: 'p', session_id: 's' } });
    appendFileSync(store.logPath, 'this is not json\n', 'utf8');
    store.record({ item_id: 'T-2', source: { capture_point: 'p', session_id: 's' } });
    expect(store.query().map((s) => s.item_id)).toEqual(['T-1', 'T-2']);
  });
});

describe('append-only API surface', () => {
  it('exposes no update / delete / rank method', () => {
    const proto = UsageStore.prototype as unknown as Record<string, unknown>;
    for (const banned of ['update', 'delete', 'remove', 'rank', 'score', 'promote']) {
      expect(typeof proto[banned]).not.toBe('function');
    }
  });
});
