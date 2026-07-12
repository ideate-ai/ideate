// plugin/src/work-state/schema.test.ts — WI-300 acceptance tests for the
// work-state DDL and open/init primitives.
//
// Pins: WAL mode + busy-timeout set BY CONSTRUCTION on every write
// connection (verified with two simultaneous connections, per
// v3-work-delegation.md §4's "two simultaneous sessions... is ordinary, not
// exceptional"); lazy init — a read against a database that was never
// written to touches neither the directory nor the file.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BOARD_SCHEMA_VERSION, openForRead, openForWrite } from './schema.js';
import { WorkStateError } from './types.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-state-schema-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Force `PRAGMA user_version` to an arbitrary value OUTSIDE of
 * `openForWrite`/`openForRead` — used to fabricate fixtures this module's
 * own functions would never produce on their own (a hand-bumped "from the
 * future" version, or a rewound-to-0 stand-in for a PH-044-era unstamped
 * board). Uses the same `process.getBuiltinModule('node:sqlite')` lookup as
 * schema.ts itself (see that module's header comment for why: a static
 * `node:sqlite` import specifier gets mis-resolved by this repo's pinned
 * Vite/vitest toolchain).
 */
function forceUserVersion(dbPath: string, version: number): void {
  const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new sqliteModule.DatabaseSync(dbPath);
  db.exec(`PRAGMA user_version = ${String(version)}`);
  db.close();
}

function readUserVersionRaw(dbPath: string): number {
  const sqliteModule = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const db = new sqliteModule.DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return row.user_version;
}

describe('lazy init', () => {
  it('openForRead returns null without creating the directory or the file', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'nested', 'board.db');

    expect(openForRead(dbPath)).toBeNull();
    expect(existsSync(join(root, 'nested'))).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('openForWrite creates the parent directory and the database file', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'nested', 'board.db');

    const db = openForWrite(dbPath);
    db.close();

    expect(existsSync(join(root, 'nested'))).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('a subsequent openForRead succeeds once the file exists', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    openForWrite(dbPath).close();

    const db = openForRead(dbPath);
    expect(db).not.toBeNull();
    db?.close();
  });
});

describe('WAL mode + busy-timeout, by construction', () => {
  it('a write connection reports journal_mode wal and a non-zero busy_timeout', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');

    const db = openForWrite(dbPath);
    const mode = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const timeout = db.prepare('PRAGMA busy_timeout').get() as { timeout: number };
    expect(mode.journal_mode).toBe('wal');
    expect(timeout.timeout).toBeGreaterThan(0);
    db.close();
  });

  it('two simultaneous connections to the same file both write successfully', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');

    const dbA = openForWrite(dbPath);
    const dbB = openForWrite(dbPath);

    dbA.prepare(
      `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('a', 't', 'A', 's', 'f', 'open', '[]', 'dan', NULL, 'now', 'now', 1)`,
    ).run();
    dbB.prepare(
      `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('b', 't', 'B', 's', 'f', 'open', '[]', 'dan', NULL, 'now', 'now', 1)`,
    ).run();

    const modeA = dbA.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const modeB = dbB.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(modeA.journal_mode).toBe('wal');
    expect(modeB.journal_mode).toBe('wal');

    const rows = dbA.prepare('SELECT id FROM items ORDER BY id').all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);

    dbA.close();
    dbB.close();
  });

  // F-300-001 regression: the sequential two-connection test above never
  // opens a real lock window, so it passed even when pragma order made the
  // first pragma itself crash under contention. This test creates GENUINE
  // concurrency with worker threads hammering the same file — the review's
  // reproduction, kept as a permanent guard (P-41). Reads run concurrently
  // with the writers to cover the read-path busy_timeout (C2).
  it('genuinely concurrent writers and readers: no "database is locked" errors', async () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    // Seed the file + one row so readers have something to hit.
    const seed = openForWrite(dbPath);
    seed
      .prepare(
        `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, created_by_human, created_by_agent, created_at, updated_at, version, claim_token_counter) VALUES ('seed', 't', 'S', 's', 'f', 'open', '[]', 'dan', NULL, 'now', 'now', 1, 0)`,
      )
      .run();
    seed.close();

    const { Worker } = await import('node:worker_threads');
    // Worker threads run plain Node (no vitest transform), so they load the
    // BUILT module — which is also the artifact that actually ships (P-34).
    // Requires `pnpm run build` before the suite; CI builds before testing.
    const schemaUrl = new URL('../../dist/work-state/schema.js', import.meta.url).href;
    const writerScript = `
      const { openForWrite } = await import(${JSON.stringify(schemaUrl)});
      const { workerData, parentPort } = await import('node:worker_threads');
      const db = openForWrite(workerData.dbPath);
      const bump = db.prepare("UPDATE items SET claim_token_counter = claim_token_counter + 1 WHERE id = 'seed' RETURNING claim_token_counter");
      const seen = [];
      for (let i = 0; i < 150; i++) seen.push(bump.get().claim_token_counter);
      db.close();
      parentPort.postMessage({ seen });
    `;
    const readerScript = `
      const { openForRead } = await import(${JSON.stringify(schemaUrl)});
      const { workerData, parentPort } = await import('node:worker_threads');
      let reads = 0;
      for (let i = 0; i < 200; i++) {
        const db = openForRead(workerData.dbPath);
        db.prepare("SELECT count(*) AS n FROM items").get();
        db.close();
        reads++;
      }
      parentPort.postMessage({ reads });
    `;
    const runWorker = (script: string): Promise<{ seen?: number[]; reads?: number }> =>
      new Promise((resolvePromise, rejectPromise) => {
        const w = new Worker(script, { eval: true, workerData: { dbPath } });
        w.once('message', (m) => resolvePromise(m as { seen?: number[]; reads?: number }));
        w.once('error', rejectPromise);
      });

    const results = await Promise.all([
      runWorker(writerScript),
      runWorker(writerScript),
      runWorker(writerScript),
      runWorker(readerScript),
      runWorker(readerScript),
    ]);

    const tokens = results.flatMap((r) => r.seen ?? []);
    expect(tokens).toHaveLength(450); // 3 writers × 150, none crashed
    expect(new Set(tokens).size).toBe(450); // every increment unique
    const reads = results.map((r) => r.reads).filter((n): n is number => n !== undefined);
    expect(reads).toEqual([200, 200]); // no reader ever hit "database is locked"
  }, 30_000);
});

describe('schema idempotence', () => {
  it('re-opening for write does not error and does not lose data (CREATE TABLE IF NOT EXISTS)', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');

    const db1 = openForWrite(dbPath);
    db1.prepare(
      `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('a', 't', 'A', 's', 'f', 'open', '[]', 'dan', NULL, 'now', 'now', 1)`,
    ).run();
    db1.close();

    const db2 = openForWrite(dbPath);
    const rows = db2.prepare('SELECT id FROM items').all() as { id: string }[];
    expect(rows).toEqual([{ id: 'a' }]);
    db2.close();
  });
});

// WI-308 (P-41 fixture tests): board.db schema versioning. Closes capstone
// GAP-2 / gap 3 — `ensureSchema`'s CREATE TABLE IF NOT EXISTS silently
// no-ops on a mismatched board file in either direction; these fixtures
// hand-fabricate both directions and assert the typed, loud failure (or,
// for the grace case, the one-time stamp) instead.
describe('board schema versioning (WI-308)', () => {
  it('a fresh create stamps PRAGMA user_version to BOARD_SCHEMA_VERSION', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');

    const db = openForWrite(dbPath);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(BOARD_SCHEMA_VERSION);
    db.close();
  });

  it('a hand-bumped user_version=99 (newer than understood) throws a typed WorkStateError naming both versions, on both open paths', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    openForWrite(dbPath).close();
    forceUserVersion(dbPath, 99);

    let writeErr: unknown;
    try {
      openForWrite(dbPath);
    } catch (err) {
      writeErr = err;
    }
    expect(writeErr).toBeInstanceOf(WorkStateError);
    expect((writeErr as WorkStateError).code).toBe('SCHEMA_VERSION');
    expect((writeErr as WorkStateError).message).toContain('99');
    expect((writeErr as WorkStateError).message).toContain(String(BOARD_SCHEMA_VERSION));

    let readErr: unknown;
    try {
      openForRead(dbPath);
    } catch (err) {
      readErr = err;
    }
    expect(readErr).toBeInstanceOf(WorkStateError);
    expect((readErr as WorkStateError).code).toBe('SCHEMA_VERSION');
    expect((readErr as WorkStateError).message).toContain('99');
    expect((readErr as WorkStateError).message).toContain(String(BOARD_SCHEMA_VERSION));
  });

  it('a PH-044-era unstamped, non-empty board (user_version=0) is stamped to 1 on first write and reads fine afterward', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');

    // Build a real, non-empty board the normal way, then rewind its
    // user_version to 0 to stand in for a pre-versioning (PH-044-era) file
    // that predates this check entirely.
    const seed = openForWrite(dbPath);
    seed
      .prepare(
        `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('a', 't', 'A', 's', 'f', 'open', '[]', 'dan', NULL, 'now', 'now', 1)`,
      )
      .run();
    seed.close();
    forceUserVersion(dbPath, 0);
    expect(readUserVersionRaw(dbPath)).toBe(0);

    // A read against the unstamped board must not error — the grace applies
    // until the next write, not the next read.
    const preWriteRead = openForRead(dbPath);
    expect(preWriteRead).not.toBeNull();
    preWriteRead?.close();

    // The next openForWrite is the "first write" that stamps it.
    const db = openForWrite(dbPath);
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(version.user_version).toBe(BOARD_SCHEMA_VERSION);
    const rows = db.prepare('SELECT id FROM items').all() as { id: string }[];
    expect(rows).toEqual([{ id: 'a' }]);
    db.close();

    // And it reads fine afterward too.
    const postWriteRead = openForRead(dbPath);
    expect(postWriteRead).not.toBeNull();
    postWriteRead?.close();
  });
});
