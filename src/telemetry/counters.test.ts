// plugin/src/telemetry/counters.test.ts — WI-262 acceptance tests.
//
// Asserts the §3.5 contract: exactly six counters (sixth — redactions —
// added 2026-07-09, WI-281, cycle-9 amendment); on by default (no opt-in
// flag anywhere); append-only NDJSON persistence that survives process
// restarts and interleaved concurrent writers; the folded report shape; and
// a CLI smoke test via child_process against a temp state dir.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { COUNTER_NAMES, TELEMETRY_FILE, TelemetryCounters, createTelemetry } from './counters.js';
import type { Clock } from './counters.js';
import { reportFromDir } from './report.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-telemetry');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'telemetry', 'cli.js');

const FIXED_ISO = '2026-07-09T12:00:00.000Z';
const fixedClock: Clock = () => new Date(FIXED_ISO);

const tempDirs: string[] = [];
function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-telemetry-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('closed counter set', () => {
  it('exposes exactly the seven named counters of §3.5 + WI-303', () => {
    expect([...COUNTER_NAMES]).toEqual([
      'capture_fired',
      'priming',
      'kg_unreachable',
      'frontier_size',
      'capture_write_failed',
      'redactions',
      'work_claims',
    ]);
    expect(COUNTER_NAMES).toHaveLength(7);
  });

  it('the report has exactly one top-level key per counter', () => {
    const { report } = reportFromDir(makeStateDir());
    expect(Object.keys(report).sort()).toEqual([
      'captureFired',
      'captureWriteFailed',
      'frontierSize',
      'kgUnreachable',
      'priming',
      'redactions',
      'workClaims',
    ]);
  });
});

describe('on by default', () => {
  it('a fresh instance records immediately, with no opt-in flag in the API', () => {
    const dir = makeStateDir();
    // Construction takes only (stateDir, clock) — there is no enable flag to pass.
    const telemetry = new TelemetryCounters(dir, fixedClock);
    telemetry.captureFired('session_end', 'sess-1');

    const file = join(dir, TELEMETRY_FILE);
    expect(existsSync(file)).toBe(true);
    const { report } = reportFromDir(dir);
    expect(report.captureFired.total).toBe(1);
    expect(report.captureFired.byPoint).toEqual({ session_end: 1 });
    expect(report.captureFired.bySession).toEqual({ 'sess-1': 1 });
  });

  it('timestamps come from the injected clock, not the wall clock', () => {
    const dir = makeStateDir();
    createTelemetry(dir, fixedClock).kgUnreachable('sess-1');
    const line = readFileSync(join(dir, TELEMETRY_FILE), 'utf8').trim();
    expect(JSON.parse(line)).toEqual({
      counter: 'kg_unreachable',
      sessionId: 'sess-1',
      at: FIXED_ISO,
    });
  });
});

describe('persistence across process restarts', () => {
  it('a second instance over the same state dir folds both lifetimes', () => {
    const dir = makeStateDir();

    const first = createTelemetry(dir, fixedClock);
    first.captureFired('decision', 'sess-1');
    first.primingRequested('claim', 'sess-1');

    // Simulated restart: a brand-new instance, same directory.
    const second = createTelemetry(dir, fixedClock);
    second.captureFired('decision', 'sess-2');
    second.captureWriteFailed('review_finding', 'sess-2', 'EACCES');

    const { report } = reportFromDir(dir);
    expect(report.captureFired.total).toBe(2);
    expect(report.captureFired.byPoint).toEqual({ decision: 2 });
    expect(report.priming.requested.total).toBe(1);
    expect(report.captureWriteFailed.total).toBe(1);
    expect(report.captureWriteFailed.byReason).toEqual({ EACCES: 1 });
  });

  it('redaction events persist across restarts and fold across both lifetimes', () => {
    const dir = makeStateDir();

    const first = createTelemetry(dir, fixedClock);
    first.redactionApplied('aws-access-key-id', 2, 'sess-1');

    // Simulated restart: a brand-new instance, same directory.
    const second = createTelemetry(dir, fixedClock);
    second.redactionApplied('github-token', 1, 'sess-2');
    second.redactionApplied('aws-access-key-id', 1, 'sess-2');

    const { report } = reportFromDir(dir);
    expect(report.redactions.total).toBe(4); // sums the per-event match counts
    expect(report.redactions.events).toBe(3);
    expect(report.redactions.byPattern).toEqual({ 'aws-access-key-id': 3, 'github-token': 1 });
    expect(report.redactions.bySession).toEqual({ 'sess-1': 2, 'sess-2': 2 });
  });
});

describe('append-only concurrent safety', () => {
  it('two writers interleaved over one state dir: the fold sees every event', () => {
    const dir = makeStateDir();
    const writerA = createTelemetry(dir, fixedClock);
    const writerB = createTelemetry(dir, fixedClock);

    const n = 50;
    for (let i = 0; i < n; i += 1) {
      writerA.captureFired('work_item_completion', 'sess-A');
      writerB.captureFired('cycle_convergence', 'sess-B');
      writerA.frontierSize(i, 'sess-A');
      writerB.kgUnreachable('sess-B');
    }

    const { report, skippedLines } = reportFromDir(dir);
    expect(skippedLines).toBe(0);
    expect(report.captureFired.total).toBe(2 * n);
    expect(report.captureFired.bySession).toEqual({ 'sess-A': n, 'sess-B': n });
    expect(report.frontierSize.overall.samples).toBe(n);
    expect(report.kgUnreachable.total).toBe(n);

    // Every line in the state file is a complete, parseable event.
    const lines = readFileSync(join(dir, TELEMETRY_FILE), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4 * n);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('a torn final line is skipped and counted, never corrupting the fold', () => {
    const dir = makeStateDir();
    createTelemetry(dir, fixedClock).captureFired('andon', 'sess-1');
    appendFileSync(join(dir, TELEMETRY_FILE), '{"counter":"capture_fi', 'utf8');

    const { report, skippedLines } = reportFromDir(dir);
    expect(report.captureFired.total).toBe(1);
    expect(skippedLines).toBe(1);
  });
});

describe('report shape', () => {
  it('folds totals plus per-point/per-session/per-source breakdowns for all seven', () => {
    const dir = makeStateDir();
    const t = createTelemetry(dir, fixedClock);

    t.captureFired('session_end', 'sess-1');
    t.captureFired('session_end', 'sess-2');
    t.captureFired('decision', 'sess-1');
    t.primingRequested('claim', 'sess-1');
    t.primingRequested('session_start', 'sess-2');
    t.primingUsefulness('sess-1', { used: true, note: 'opaque, stored verbatim' });
    t.kgUnreachable('sess-2');
    t.frontierSize(3, 'sess-1');
    t.frontierSize(9, 'sess-1');
    t.frontierSize(6, 'sess-2');
    t.captureWriteFailed('session_end', 'sess-2', 'disk full');
    t.captureWriteFailed('decision', 'sess-2');
    t.redactionApplied('aws-access-key-id', 2, 'sess-1');
    t.redactionApplied('github-token', 1, 'sess-2');
    t.workClaimed('item-1', 'sess-1');
    t.workClaimed('item-1', 'sess-2');
    t.workClaimed('item-2', 'sess-1');

    const { report } = reportFromDir(dir);

    expect(report.captureFired).toEqual({
      total: 3,
      byPoint: { session_end: 2, decision: 1 },
      bySession: { 'sess-1': 2, 'sess-2': 1 },
      byPointBySession: {
        session_end: { 'sess-1': 1, 'sess-2': 1 },
        decision: { 'sess-1': 1 },
      },
    });

    expect(report.priming.requested).toEqual({
      total: 2,
      bySource: { claim: 1, session_start: 1 },
      bySession: { 'sess-1': 1, 'sess-2': 1 },
    });
    expect(report.priming.usefulness.recorded).toBe(1);
    expect(report.priming.usefulness.signals).toEqual([
      {
        sessionId: 'sess-1',
        signal: { used: true, note: 'opaque, stored verbatim' },
        at: FIXED_ISO,
      },
    ]);

    expect(report.kgUnreachable).toEqual({ total: 1, bySession: { 'sess-2': 1 } });

    expect(report.frontierSize.overall).toEqual({
      samples: 3,
      min: 3,
      max: 9,
      mean: 6,
      last: 6,
    });
    expect(report.frontierSize.bySession['sess-1']).toEqual({
      samples: 2,
      min: 3,
      max: 9,
      mean: 6,
      last: 9,
    });

    expect(report.captureWriteFailed).toEqual({
      total: 2,
      byPoint: { session_end: 1, decision: 1 },
      bySession: { 'sess-2': 2 },
      byReason: { 'disk full': 1, '(unspecified)': 1 },
    });

    expect(report.redactions).toEqual({
      total: 3,
      events: 2,
      byPattern: { 'aws-access-key-id': 2, 'github-token': 1 },
      bySession: { 'sess-1': 2, 'sess-2': 1 },
    });

    expect(report.workClaims).toEqual({
      total: 3,
      byItem: { 'item-1': 2, 'item-2': 1 },
      bySession: { 'sess-1': 2, 'sess-2': 1 },
    });
  });

  it('an empty state dir folds to a valid all-zero report', () => {
    const { report, skippedLines } = reportFromDir(makeStateDir());
    expect(skippedLines).toBe(0);
    expect(report.captureFired.total).toBe(0);
    expect(report.priming.requested.total).toBe(0);
    expect(report.priming.usefulness.recorded).toBe(0);
    expect(report.kgUnreachable.total).toBe(0);
    expect(report.frontierSize.overall.samples).toBe(0);
    expect(report.captureWriteFailed.total).toBe(0);
    expect(report.redactions.total).toBe(0);
    expect(report.redactions.events).toBe(0);
    expect(report.workClaims.total).toBe(0);
  });

  it('frontierSize is a size-sample recorder and rejects invalid sizes loudly', () => {
    const t = createTelemetry(makeStateDir(), fixedClock);
    expect(() => t.frontierSize(-1, 'sess-1')).toThrow(RangeError);
    expect(() => t.frontierSize(2.5, 'sess-1')).toThrow(RangeError);
    expect(() => t.frontierSize(Number.NaN, 'sess-1')).toThrow(RangeError);
  });

  it('redactionApplied persists the gate callback shape verbatim and rejects invalid counts', () => {
    const dir = makeStateDir();
    const t = createTelemetry(dir, fixedClock);
    t.redactionApplied('github-token', 2, 'sess-1');
    const line = readFileSync(join(dir, TELEMETRY_FILE), 'utf8').trim();
    expect(JSON.parse(line)).toEqual({
      counter: 'redactions',
      pattern: 'github-token',
      count: 2,
      sessionId: 'sess-1',
      at: FIXED_ISO,
    });
    // The gate only ever fires onRedaction with count >= 1 (scan.ts); the
    // counter holds that line loudly rather than recording nonsense.
    expect(() => t.redactionApplied('github-token', 0, 'sess-1')).toThrow(RangeError);
    expect(() => t.redactionApplied('github-token', -1, 'sess-1')).toThrow(RangeError);
    expect(() => t.redactionApplied('github-token', 1.5, 'sess-1')).toThrow(RangeError);
  });
});

describe('CLI smoke (bin/ideate-telemetry)', () => {
  beforeAll(() => {
    // The CLI runs against compiled output. Build incrementally if needed
    // (documented order is `pnpm build` then `pnpm test`; this keeps the
    // smoke test self-sufficient when run in isolation).
    if (!existsSync(DIST_CLI)) {
      execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], {
        cwd: PLUGIN_DIR,
        stdio: 'pipe',
      });
    }
  }, 120_000);

  it('prints the counter table and exits 0', () => {
    const dir = makeStateDir();
    const t = createTelemetry(dir, fixedClock);
    t.captureFired('session_end', 'sess-1');
    t.primingRequested('claim', 'sess-1');
    t.frontierSize(4, 'sess-1');

    // execFileSync throws on nonzero exit, so success here *is* exit 0.
    const stdout = execFileSync(process.execPath, [BIN_PATH, '--dir', dir], {
      encoding: 'utf8',
    });

    expect(stdout).toContain('ideate telemetry report');
    expect(stdout).toContain('capture_fired');
    expect(stdout).toContain('priming.requested');
    expect(stdout).toContain('priming.usefulness');
    expect(stdout).toContain('kg_unreachable');
    expect(stdout).toContain('frontier_size');
    expect(stdout).toContain('capture_write_failed');
    expect(stdout).toContain('session_end');
  });

  it('exits 0 on a fresh (empty) state dir', () => {
    const stdout = execFileSync(process.execPath, [BIN_PATH, '--dir', makeStateDir()], {
      encoding: 'utf8',
    });
    expect(stdout).toContain('capture_write_failed');
  });
});
