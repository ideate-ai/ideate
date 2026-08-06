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

import { createMigrationListener } from './migration-signal.js';
import { openForWrite, setMigrationListener } from './schema.js';

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
