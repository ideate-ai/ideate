// plugin/src/usage/capture.test.ts — tests for the capture
// orchestration: a delivered item that a worker's text CITES yields a written,
// queryable usage signal; an uncited delivery writes nothing; provenance is
// preserved.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { captureCitedContext } from './capture.js';
import { UsageStore } from './store.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeStore(): UsageStore {
  const usageDir = mkdtempSync(join(tmpdir(), 'ideate-usage-capture-test-'));
  tempDirs.push(usageDir);
  const clock: Clock = () => new Date(FIXED_ISO);
  return new UsageStore(usageDir, clock);
}

describe('captureCitedContext', () => {
  it('writes one queryable signal per delivered id the worker used', () => {
    const store = makeStore();
    const written = captureCitedContext(store, {
      text: 'I built on T-381 and the boundary contract in T-250; ignored the rest.',
      delivered: ['T-381', 'T-250', 'T-999'],
      seed_id: 'T-378',
      manifest_id: 'MF-7',
      source: { capture_point: 'eval-replay', session_id: 'sess-1', task_id: 'T-378' },
    });

    expect(written.map((s) => s.item_id)).toEqual(['T-381', 'T-250']);
    // Queryable as the denominator for the seed.
    expect(store.usedItemIds({ seed_id: 'T-378' })).toEqual(['T-381', 'T-250']);
    // Provenance preserved.
    const first = written[0];
    expect(first?.manifest_id).toBe('MF-7');
    expect(first?.source.capture_point).toBe('eval-replay');
    expect(first?.source.task_id).toBe('T-378');
    expect(first?.source.timestamp).toBe(FIXED_ISO);
  });

  it('writes nothing when the delivered items were not cited', () => {
    const store = makeStore();
    const written = captureCitedContext(store, {
      text: 'a task that referenced nothing delivered',
      delivered: ['T-1', 'T-2'],
      source: { capture_point: 'eval-replay', session_id: 'sess-1' },
    });
    expect(written).toEqual([]);
    expect(store.query()).toEqual([]);
  });

  it('honors an explicit kind (cites)', () => {
    const store = makeStore();
    const written = captureCitedContext(store, {
      text: 'per T-42',
      delivered: ['T-42'],
      kind: 'cites',
      source: { capture_point: 'record_append', session_id: 'sess-2' },
    });
    expect(written[0]?.kind).toBe('cites');
  });
});
