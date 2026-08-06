// plugin/src/work-state/migration-signal.test.ts — the DURABLE half of the
// migration signal (board 01KYXHZP8P): when a write migrates a board, the
// crossing lands in the project's own process record, so a later "why does
// the older plugin refuse this board?" investigation finds the moment the
// one-way door closed (the conway incident, record 01KYXG8RA5, had nothing
// pointing back).
//
// Three layers, matching how the mechanism ships:
//   1. createMigrationListener wired to setMigrationListener (the seam the
//      composition roots use) — a real migration appends a real record.
//   2. The record path failing must NOT break the write: the migration
//      commits, the failure is loud on stderr (P-45, best-effort by
//      construction).
//   3. The SHIPPED CLI path end to end (P-50): the real bin/ideate-work
//      against a real v2 board announces the migration on stderr AND lands
//      the board-migration record — the exact composition that bricked
//      conway, now self-announcing.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { reportFromDir } from '../telemetry/report.js';

import { createDegradedOpenListener, createMigrationListener } from './migration-signal.js';
import { BOARD_SCHEMA_VERSION, openForRead, openForWrite, resetFloorAcceptWarning, setDegradedOpenListener, setMigrationListener } from './schema.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-work');

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setMigrationListener(undefined);
  setDegradedOpenListener(undefined);
  resetFloorAcceptWarning();
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const FIXED_CLOCK: Clock = () => new Date('2026-08-03T12:00:00.000Z');

function testConfig(): IdeateConfigV3 {
  return { schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' };
}

/** The v2 items DDL — WITH parent_id, WITHOUT "references" (mirrors
 *  schema.test.ts's fixture; duplicated so this file stands alone). */
const V2_ITEMS_TABLE_DDL = `
CREATE TABLE items (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  spec                  TEXT NOT NULL,
  spec_format           TEXT NOT NULL,
  status                TEXT NOT NULL,
  depends_on            TEXT NOT NULL,
  parent_id             TEXT,
  created_by_human      TEXT NOT NULL,
  created_by_agent      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL,
  claim_token_counter   INTEGER NOT NULL DEFAULT 0,
  claim_holder_human    TEXT,
  claim_holder_agent    TEXT,
  claim_token           INTEGER,
  claim_acquired_at     TEXT,
  claim_lease_expires   TEXT
)`;

/** Hand-build a real, stamped-v2 legacy board at `dbPath`. */
function seedLegacyV2Board(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true });
  const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec(V2_ITEMS_TABLE_DDL);
  db.prepare(
    `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, parent_id, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('legacy', 't', 'L', 's', 'f', 'open', '[]', NULL, 'dan', NULL, 'now', 'now', 1)`,
  ).run();
  db.exec('PRAGMA user_version = 2');
  db.close();
}

function boardMigrationRecords(projectRoot: string): { kind: string; claim: string; scope: string; verification_anchor: string; source: { capture_point: string } }[] {
  const records = new RecordStore(testConfig(), projectRoot, new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK), FIXED_CLOCK);
  return records
    .readViews()
    .filter((r) => r.kind === 'board-migration');
}

function boardDegradedOpenRecords(projectRoot: string): { kind: string; claim: string; scope: string; verification_anchor: string; source: { capture_point: string } }[] {
  const records = new RecordStore(testConfig(), projectRoot, new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK), FIXED_CLOCK);
  return records
    .readViews()
    .filter((r) => r.kind === 'board-degraded-open');
}

/** The occurrence tally — counter 8, `board_degraded_opens` — read back from
 *  the same `.ideate-telemetry` dir the composition root writes to. */
function boardDegradedOpenCount(projectRoot: string): number {
  return reportFromDir(join(projectRoot, '.ideate-telemetry')).report.boardDegradedOpens.total;
}

/** Force `PRAGMA user_version` to an arbitrary value — fixture fabrication,
 *  mirrors schema.test.ts's helper of the same name (duplicated so this
 *  file stands alone). */
function forceUserVersion(dbPath: string, version: number): void {
  const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${String(version)}`);
  db.close();
}

/** Force `PRAGMA application_id` (the compatibility-floor stamp) — mirrors
 *  schema.test.ts's helper of the same name. */
function forceApplicationId(dbPath: string, floor: number): void {
  const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec(`PRAGMA application_id = ${String(floor)}`);
  db.close();
}

describe('createMigrationListener — the durable half of the migration signal', () => {
  it('a real v2->v3 migration appends a board-migration record naming from/to/floor, the board path, and the listening transport', () => {
    const projectRoot = makeTempDir('ideate-migration-signal-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    seedLegacyV2Board(dbPath);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    setMigrationListener(
      createMigrationListener({
        config: testConfig(),
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:migration-signal',
        sessionId: 'test-session',
      }),
    );

    openForWrite(dbPath).close();

    const found = boardMigrationRecords(projectRoot);
    expect(found).toHaveLength(1);
    const record = found[0];
    if (record === undefined) throw new Error('board-migration record missing');
    expect(record.scope).toBe('board-migration');
    expect(record.claim).toContain('v2 to v3');
    expect(record.claim).toContain('floor stamped at v2');
    expect(record.claim).toContain('test:migration-signal');
    expect(record.verification_anchor).toBe(dbPath);
    expect(record.source.capture_point).toBe('test:migration-signal');
  });

  it('a failing record path does NOT break the write — the migration commits and the failure is loud on stderr', () => {
    const projectRoot = makeTempDir('ideate-migration-signal-fail-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    seedLegacyV2Board(dbPath);
    // Block the record path: a FILE where the record directory must go.
    const blockedConfig = { ...testConfig(), record: { path: '.blocked-record' } };
    writeFileSync(join(projectRoot, '.blocked-record'), 'not a directory');

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    setMigrationListener(
      createMigrationListener({
        config: blockedConfig,
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:migration-signal',
        sessionId: 'test-session',
      }),
    );

    const db = openForWrite(dbPath); // must not throw
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    db.close();
    expect(version.user_version).toBe(3); // the migration itself committed

    const errText = stderr.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errText).toContain('board-migration');
  });
});

// The mirror-image crossing: an OLDER binary opens a NEWER, floor-accepted
// board. This bridge makes it durable — but, per the AMENDED P-45 (governing
// decision 01KZCPXJK1WX9BK51W8BQX4DFK), durability is per CONDITION (board
// path + board version + floor), not per call: a degraded open is the
// steady state, not a rare crossing, so the record fires on the first
// observation of a distinct condition and re-fires only when the tuple
// changes. The occurrence count beyond the first is carried by the
// `board_degraded_opens` telemetry counter, which increments on every call.
describe('createDegradedOpenListener — the durable half of the degraded-open signal', () => {
  it('a degraded open appends a board-degraded-open record naming the binary version, board version, floor, and board path', () => {
    const projectRoot = makeTempDir('ideate-degraded-open-signal-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    openForWrite(dbPath).close();
    forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 1);
    forceApplicationId(dbPath, BOARD_SCHEMA_VERSION);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    setDegradedOpenListener(
      createDegradedOpenListener({
        config: testConfig(),
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:degraded-open-signal',
        sessionId: 'test-session',
      }),
    );

    openForRead(dbPath)?.close();

    const found = boardDegradedOpenRecords(projectRoot);
    expect(found).toHaveLength(1);
    const record = found[0];
    if (record === undefined) throw new Error('board-degraded-open record missing');
    expect(record.scope).toBe('board-degraded-open');
    expect(record.claim).toContain(`v${String(BOARD_SCHEMA_VERSION)}`); // this binary's version
    expect(record.claim).toContain(`v${String(BOARD_SCHEMA_VERSION + 1)}`); // the board's version
    expect(record.claim).toContain('test:degraded-open-signal');
    expect(record.verification_anchor).toBe(dbPath);
    expect(record.source.capture_point).toBe('test:degraded-open-signal');
    // The counter tallies this one occurrence.
    expect(boardDegradedOpenCount(projectRoot)).toBe(1);
  });

  it('re-observing the SAME condition in the same process appends no further record — but the counter still increments on every occurrence, and the console line stays suppressed to once per process', () => {
    const projectRoot = makeTempDir('ideate-degraded-open-repeat-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    openForWrite(dbPath).close();
    forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 1);
    forceApplicationId(dbPath, BOARD_SCHEMA_VERSION);

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDegradedOpenListener(
      createDegradedOpenListener({
        config: testConfig(),
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:degraded-open-signal',
        sessionId: 'test-session',
      }),
    );

    openForRead(dbPath)?.close();
    openForRead(dbPath)?.close();
    openForRead(dbPath)?.close();

    // Same (dbPath, boardVersion, floor) tuple all three times — ONE record.
    expect(boardDegradedOpenRecords(projectRoot)).toHaveLength(1);
    // The counter tallies all THREE occurrences, including the two the
    // durable record suppressed.
    expect(boardDegradedOpenCount(projectRoot)).toBe(3);
    // The console warning still fires exactly once for the process.
    const warnings = stderr.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('opening DEGRADED'));
    expect(warnings).toHaveLength(1);
  });

  it('a changed board VERSION on the same path appends a NEW record — the tuple changed', () => {
    const projectRoot = makeTempDir('ideate-degraded-open-version-change-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    openForWrite(dbPath).close();
    forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 1);
    forceApplicationId(dbPath, BOARD_SCHEMA_VERSION);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    setDegradedOpenListener(
      createDegradedOpenListener({
        config: testConfig(),
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:degraded-open-signal',
        sessionId: 'test-session',
      }),
    );

    openForRead(dbPath)?.close();
    expect(boardDegradedOpenRecords(projectRoot)).toHaveLength(1);

    // The board gets migrated further by some other (newer still) binary —
    // simulated here by re-stamping the same file to one version higher.
    forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 2);
    openForRead(dbPath)?.close();

    const found = boardDegradedOpenRecords(projectRoot);
    expect(found).toHaveLength(2);
    // FIXED_CLOCK means both records share a timestamp, so their relative
    // order in readViews() is not guaranteed — assert on the SET, not a
    // position.
    expect(found.some((r) => r.claim.includes(`v${String(BOARD_SCHEMA_VERSION + 2)}`))).toBe(true);
    expect(boardDegradedOpenCount(projectRoot)).toBe(2);
  });

  it('a changed compatibility FLOOR on the same path and version appends a NEW record — the tuple changed', () => {
    const projectRoot = makeTempDir('ideate-degraded-open-floor-change-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    openForWrite(dbPath).close();
    forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 1);
    forceApplicationId(dbPath, BOARD_SCHEMA_VERSION);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    setDegradedOpenListener(
      createDegradedOpenListener({
        config: testConfig(),
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:degraded-open-signal',
        sessionId: 'test-session',
      }),
    );

    openForRead(dbPath)?.close();
    expect(boardDegradedOpenRecords(projectRoot)).toHaveLength(1);

    // Same board, same version, but a DIFFERENT stamped floor (still <=
    // this binary's version, so still an accepted degraded open).
    forceApplicationId(dbPath, BOARD_SCHEMA_VERSION - 1);
    openForRead(dbPath)?.close();

    expect(boardDegradedOpenRecords(projectRoot)).toHaveLength(2);
    expect(boardDegradedOpenCount(projectRoot)).toBe(2);
  });

  it('a DIFFERENT board path, same version and floor, appends a NEW record — the tuple changed', () => {
    const projectRoot = makeTempDir('ideate-degraded-open-path-change-');
    const dbPathA = join(projectRoot, 'board-a.db');
    const dbPathB = join(projectRoot, 'board-b.db');
    for (const dbPath of [dbPathA, dbPathB]) {
      openForWrite(dbPath).close();
      forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 1);
      forceApplicationId(dbPath, BOARD_SCHEMA_VERSION);
    }

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const listener = createDegradedOpenListener({
      config: testConfig(),
      projectRoot,
      telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
      clock: FIXED_CLOCK,
      capturePoint: 'test:degraded-open-signal',
      sessionId: 'test-session',
    });
    setDegradedOpenListener(listener);

    openForRead(dbPathA)?.close();
    openForRead(dbPathA)?.close(); // repeat of A — suppressed
    openForRead(dbPathB)?.close(); // a genuinely different board — new record

    const found = boardDegradedOpenRecords(projectRoot);
    expect(found).toHaveLength(2);
    expect(found.map((r) => r.verification_anchor).sort()).toEqual([dbPathA, dbPathB].sort());
    expect(boardDegradedOpenCount(projectRoot)).toBe(3);
  });

  it('a failing record path does NOT break the open — it succeeds and the failure is loud on stderr', () => {
    const projectRoot = makeTempDir('ideate-degraded-open-signal-fail-');
    const dbPath = join(projectRoot, '.ideate-work', 'board.db');
    openForWrite(dbPath).close();
    forceUserVersion(dbPath, BOARD_SCHEMA_VERSION + 1);
    forceApplicationId(dbPath, BOARD_SCHEMA_VERSION);
    // Block the record path: a FILE where the record directory must go.
    const blockedConfig = { ...testConfig(), record: { path: '.blocked-record' } };
    writeFileSync(join(projectRoot, '.blocked-record'), 'not a directory');

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDegradedOpenListener(
      createDegradedOpenListener({
        config: blockedConfig,
        projectRoot,
        telemetry: new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), FIXED_CLOCK),
        clock: FIXED_CLOCK,
        capturePoint: 'test:degraded-open-signal',
        sessionId: 'test-session',
      }),
    );

    const db = openForRead(dbPath); // must not throw
    expect(db).not.toBeNull();
    db?.close();

    const errText = stderr.mock.calls.map((c) => String(c[0])).join('\n');
    expect(errText).toContain('board-degraded-open');
  });
});

describe('the shipped CLI path (P-50): bin/ideate-work against a real v2 board', () => {
  beforeAll(() => {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }, 120_000);

  it('the first write migrates, announces on stderr, and lands the board-migration record — the conway composition, now self-announcing', () => {
    const projectRoot = makeTempDir('ideate-migration-cli-');
    // The config shape a real project carries (work_state block absent ->
    // the default .ideate-work/ applies). The record path matches
    // DEFAULT_RECORD_PATH so the assertion reader below looks where the
    // CLI's listener wrote.
    writeFileSync(
      join(projectRoot, '.ideate.json'),
      JSON.stringify({ schema_version: 9, backend: 'local', record: { path: DEFAULT_RECORD_PATH } }),
    );
    seedLegacyV2Board(join(projectRoot, '.ideate-work', 'board.db'));

    let stderr = '';
    try {
      execFileSync(process.execPath, [BIN_PATH, 'create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      stderr = (err as { stderr?: string }).stderr ?? '';
      throw new Error(`CLI create failed: ${stderr}`);
    }

    const found = boardMigrationRecords(projectRoot);
    expect(found).toHaveLength(1);
    const record = found[0];
    if (record === undefined) throw new Error('board-migration record missing');
    expect(record.claim).toContain('v2 to v3');
    expect(record.source.capture_point).toBe('cli:ideate-work');
  });
});
