// plugin/src/record/store.test.ts — WI-271 acceptance tests for the record
// store core.
//
// Pins: round-trip serialization; four-contract-fields-always-present
// enforcement (boundary contract §6.2); date-sharded config-resolved paths
// with ULID filename stems (architecture §2.1); gate-before-persist with a
// PLANTED SECRET asserted masked in the raw on-disk bytes; the telemetry
// wiring (capture_fired / capture_write_failed, and — WI-281 — every
// redaction routed to the dedicated sixth counter); typed no-throw failure on
// an unwritable directory; newest-first scope-filtered limited reads with no
// index; and the append-only API surface (no update/delete/rank anywhere).
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION, recordPath } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { reportFromDir } from '../telemetry/report.js';
import type { Clock } from './id.js';
import { parseRecord, serializeRecord } from './schema.js';
import type { ProcessRecord } from './schema.js';
import { RecordStore } from './store.js';
import type { RecordInput } from './store.js';

const FIXED_ISO = '2026-07-09T12:00:00.000Z';

const tempDirs: string[] = [];
const permRestores: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (permRestores.length > 0) {
    const dir = permRestores.pop();
    if (dir !== undefined) chmodSync(dir, 0o755);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  store: RecordStore;
  projectRoot: string;
  recordDir: string;
  telemetryDir: string;
  setNow: (iso: string) => void;
}

function makeFixture(): Fixture {
  const projectRoot = makeTempDir('ideate-record-store-test-');
  const telemetryDir = makeTempDir('ideate-record-telemetry-test-');
  const config: IdeateConfigV3 = {
    schema_version: V3_SCHEMA_VERSION,
    record: { path: DEFAULT_RECORD_PATH }, // the literal lives in config only
    backend: 'local',
  };
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const telemetry = new TelemetryCounters(telemetryDir, clock);
  const store = new RecordStore(config, projectRoot, telemetry, clock);
  return {
    store,
    projectRoot,
    recordDir: recordPath(config, projectRoot),
    telemetryDir,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

function input(overrides?: Partial<RecordInput>): RecordInput {
  return {
    kind: 'finding',
    claim: 'The vitest fork pool must stay capped at 4 to avoid OOM.',
    verification_anchor: 'vitest.config.ts',
    scope: 'test infrastructure changes',
    source: { capture_point: 'session_end', session_id: 'sess-1', task_id: 'WI-271' },
    content: 'Raising maxForks above 4 crashed a 32GB box during v2; the cap is load-bearing.',
    ...overrides,
  };
}

describe('round-trip serialization', () => {
  it('parse(serialize(record)) is identity, including hostile content', () => {
    const record: ProcessRecord = {
      id: '01JZM8Z0000000000000000000',
      kind: 'decision',
      claim: 'contains: colons, "quotes", and\nan embedded newline',
      verification_anchor: 'cmd: pnpm test -- --grep "x: y"',
      scope: '',
      source: {
        capture_point: 'commit_boundary',
        session_id: 'sess-42',
        task_id: 'WI-271',
        timestamp: FIXED_ISO,
      },
      content: '\nLeading newline, an embedded fence:\n---\nid: "fake"\n---\nand a trailing newline\n',
    };
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it('round-trips a record with no task_id and empty fields', () => {
    const record: ProcessRecord = {
      id: '01JZM8Z0000000000000000001',
      kind: 'session-outcome',
      claim: '',
      verification_anchor: '',
      scope: '',
      source: { capture_point: 'session_end', session_id: 's', timestamp: FIXED_ISO },
      content: '',
    };
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it('appended records read back identical through the store', () => {
    const { store } = makeFixture();
    const result = store.append(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [read] = store.read();
    expect(read).toEqual(result.record);
  });
});

describe('four contract fields always present (boundary contract §6.2)', () => {
  it('accepts empty strings — emptiness is a valid record, not a failure', () => {
    const { store } = makeFixture();
    const result = store.append(
      input({ claim: '', verification_anchor: '', scope: '', content: '' }),
    );
    expect(result.ok).toBe(true);
  });

  it.each(['claim', 'verification_anchor', 'scope', 'content', 'kind'] as const)(
    'rejects an input with %s ABSENT as a typed SCHEMA failure',
    (field) => {
      const { store, recordDir } = makeFixture();
      const bad = input() as unknown as Record<string, unknown>;
      delete bad[field];
      const result = store.append(bad as unknown as RecordInput);
      expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
      if (result.ok) return;
      expect(result.reason).toContain(field);
      // Nothing was persisted — the record tree was never even created.
      expect(existsSync(recordDir)).toBe(false);
    },
  );

  it('rejects a source missing its required members', () => {
    const { store } = makeFixture();
    const result = store.append(
      input({ source: { session_id: 'sess-1' } as unknown as RecordInput['source'] }),
    );
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
  });

  it('rejects a provided id that is not a well-formed ULID', () => {
    const { store } = makeFixture();
    const result = store.append(input({ id: 'not-a-ulid' }));
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
  });

  it('a parsed file missing a contract field is a schema error', () => {
    const missingClaim = [
      '---',
      'id: "01JZM8Z0000000000000000000"',
      'kind: "finding"',
      'verification_anchor: ""',
      'scope: ""',
      'source:',
      '  capture_point: "session_end"',
      '  session_id: "s"',
      '  timestamp: "2026-07-09T12:00:00.000Z"',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    expect(() => parseRecord(missingClaim)).toThrow(/claim/);
  });
});

describe('date-sharded config-resolved paths (architecture §2.1)', () => {
  it('writes to record.path/YYYY/MM/{ulid}.md derived from the injected clock', () => {
    const { store, recordDir } = makeFixture();
    const result = store.append(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Fixed clock: 2026-07-09T12:00Z → shard 2026/07; filename stem = ULID.
    expect(result.path).toBe(join(recordDir, '2026', '07', `${result.record.id}.md`));
    expect(readFileSync(result.path, 'utf8')).toContain(`id: ${JSON.stringify(result.record.id)}`);
  });

  it('honors a custom configured record.path via the config resolver', () => {
    const projectRoot = makeTempDir('ideate-record-custompath-test-');
    const telemetryDir = makeTempDir('ideate-record-telemetry-test-');
    const clock: Clock = () => new Date(FIXED_ISO);
    const config: IdeateConfigV3 = {
      schema_version: V3_SCHEMA_VERSION,
      record: { path: 'notes/record/' },
      backend: 'local',
    };
    const store = new RecordStore(config, projectRoot, new TelemetryCounters(telemetryDir, clock), clock);
    const result = store.append(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(projectRoot, 'notes', 'record', '2026', '07', `${result.record.id}.md`));
  });
});

describe('gate before persist (secret gate wired ahead of any write)', () => {
  it('masks a planted secret in claim and body — the raw file never carries it', () => {
    const { store } = makeFixture();
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const ghToken = `ghp_${'A1b2C3d4'.repeat(5)}`; // ghp_ + 40 alnum chars
    const result = store.append(
      input({
        claim: `Deploy fails unless ${awsKey} is set in the env.`,
        content: `Reproduced with token ${ghToken} against the staging API.`,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = readFileSync(result.path, 'utf8');
    expect(raw).not.toContain(awsKey);
    expect(raw).not.toContain(ghToken);
    expect(raw).toContain('[REDACTED:aws-access-key-id]');
    expect(raw).toContain('[REDACTED:github-token]');
    // Surrounding prose is preserved — masking is in place, not destructive.
    expect(result.record.claim).toBe('Deploy fails unless [REDACTED:aws-access-key-id] is set in the env.');
    // The redaction tally is surfaced on the result (see routing note in store.ts).
    expect(result.redactions).toEqual(
      expect.arrayContaining([
        { pattern: 'aws-access-key-id', count: 1 },
        { pattern: 'github-token', count: 1 },
      ]),
    );
  });

  it('routes every redaction to the sixth telemetry counter (per pattern, per session)', () => {
    const { store, telemetryDir } = makeFixture();
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const ghToken = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const result = store.append(
      input({
        claim: `Deploy fails unless ${awsKey} is set in the env.`,
        content: `Reproduced with token ${ghToken} against the staging API.`,
      }),
    );
    expect(result.ok).toBe(true);

    // The dashboard read observes the redactions — cycle-7 S1 closed.
    const { report } = reportFromDir(telemetryDir);
    expect(report.redactions.total).toBe(2);
    expect(report.redactions.events).toBe(2);
    expect(report.redactions.byPattern).toEqual({ 'aws-access-key-id': 1, 'github-token': 1 });
    expect(report.redactions.bySession).toEqual({ 'sess-1': 2 });
    // A redaction is a successful gate action — it never pollutes the
    // capture counters.
    expect(report.captureFired.total).toBe(1);
    expect(report.captureWriteFailed.total).toBe(0);
  });

  it('a clean append (no secrets) fires no redaction telemetry', () => {
    const { store, telemetryDir } = makeFixture();
    expect(store.append(input()).ok).toBe(true);
    const { report } = reportFromDir(telemetryDir);
    expect(report.redactions.total).toBe(0);
    expect(report.redactions.events).toBe(0);
  });
});

describe('telemetry wiring', () => {
  it('captureFired increments per successful write, keyed by point and session', () => {
    const { store, telemetryDir } = makeFixture();
    expect(store.append(input()).ok).toBe(true);
    expect(store.append(input()).ok).toBe(true);

    const { report } = reportFromDir(telemetryDir);
    expect(report.captureFired.total).toBe(2);
    expect(report.captureFired.byPoint).toEqual({ session_end: 2 });
    expect(report.captureFired.bySession).toEqual({ 'sess-1': 2 });
    expect(report.captureWriteFailed.total).toBe(0);
  });

  it('an unwritable directory yields a typed WRITE failure, increments captureWriteFailed, and does not throw', () => {
    const { store, recordDir, telemetryDir } = makeFixture();
    mkdirSync(recordDir, { recursive: true });
    chmodSync(recordDir, 0o500); // read+execute only: mkdir of the shard fails
    permRestores.push(recordDir);

    let result: ReturnType<RecordStore['append']> | undefined;
    expect(() => {
      result = store.append(input());
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, code: 'WRITE' });

    const { report } = reportFromDir(telemetryDir);
    expect(report.captureWriteFailed.total).toBe(1);
    expect(report.captureWriteFailed.byPoint).toEqual({ session_end: 1 });
    expect(report.captureFired.total).toBe(0);
  });

  it('a schema failure also lands in captureWriteFailed — no capture loss is silent', () => {
    const { store, telemetryDir } = makeFixture();
    const bad = input() as unknown as Record<string, unknown>;
    delete bad['claim'];
    expect(store.append(bad as unknown as RecordInput).ok).toBe(false);
    const { report } = reportFromDir(telemetryDir);
    expect(report.captureWriteFailed.total).toBe(1);
  });
});

describe('read: straight off the files, newest first, selection only', () => {
  function seedThree(fx: Fixture): { first: string; second: string; third: string } {
    fx.setNow('2026-05-01T00:00:00.000Z');
    const first = fx.store.append(input({ kind: 'decision', scope: 'auth flow' }));
    fx.setNow('2026-06-15T00:00:00.000Z');
    const second = fx.store.append(input({ kind: 'finding', scope: 'record store internals' }));
    fx.setNow('2026-07-09T00:00:00.000Z');
    const third = fx.store.append(input({ kind: 'task-completion', scope: 'auth flow hardening' }));
    if (!first.ok || !second.ok || !third.ok) throw new Error('seed failed');
    return { first: first.record.id, second: second.record.id, third: third.record.id };
  }

  it('returns records newest-first across month shards', () => {
    const fx = makeFixture();
    const ids = seedThree(fx);
    expect(fx.store.read().map((r) => r.id)).toEqual([ids.third, ids.second, ids.first]);
  });

  it('applies the scope filter as substring selection over scope/kind/source', () => {
    const fx = makeFixture();
    const ids = seedThree(fx);
    // Matches scope text (two records) — selection, in file order, unranked.
    expect(fx.store.read({ scope: 'auth flow' }).map((r) => r.id)).toEqual([ids.third, ids.first]);
    // Matches kind.
    expect(fx.store.read({ scope: 'finding' }).map((r) => r.id)).toEqual([ids.second]);
    // Matches source.task_id.
    expect(fx.store.read({ scope: 'wi-271' })).toHaveLength(3);
    // No match.
    expect(fx.store.read({ scope: 'nonexistent-vocabulary' })).toEqual([]);
  });

  it('caps results with limit, still newest-first', () => {
    const fx = makeFixture();
    const ids = seedThree(fx);
    expect(fx.store.read({ limit: 2 }).map((r) => r.id)).toEqual([ids.third, ids.second]);
    expect(fx.store.read({ limit: 0 })).toEqual([]);
  });

  it('reads an empty or absent record tree as an empty list', () => {
    const { store } = makeFixture();
    expect(store.read()).toEqual([]);
  });
});

describe('append-only API surface (boundary contract §4.2)', () => {
  it('the record modules export no update/delete/rank/score verb', async () => {
    for (const mod of [await import('./store.js'), await import('./schema.js'), await import('./id.js')]) {
      for (const name of Object.keys(mod)) {
        expect(name).not.toMatch(/update|delete|remove|rank|score|redact/i);
      }
    }
  });

  it('RecordStore instances expose only append/read — no mutation or ranking method', () => {
    const { store } = makeFixture();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object).filter(
      (n) => n !== 'constructor',
    );
    for (const name of methods) {
      expect(name).not.toMatch(/update|delete|remove|rank|score/i);
    }
    expect(methods).toContain('append');
    expect(methods).toContain('read');
  });

  it('the medium enforces append-only: re-appending an existing id fails, file untouched', () => {
    const { store } = makeFixture();
    const first = store.append(input());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = readFileSync(first.path, 'utf8');

    const overwrite = store.append(input({ id: first.record.id, claim: 'rewritten history' }));
    expect(overwrite).toMatchObject({ ok: false, code: 'WRITE' });
    expect(readFileSync(first.path, 'utf8')).toBe(before);
  });
});
