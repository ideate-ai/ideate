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

import { openForRead, openForWrite } from './schema.js';

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
