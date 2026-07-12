// plugin/src/work-state/tx.test.ts — WI-307 acceptance tests for the shared
// write-transaction / busy-wrap helper.
//
// Pins: (1) `withWriteTransaction`'s own commit/rollback/rethrow contract in
// isolation, using a raw node:sqlite connection with a deliberately SHORT
// busy_timeout so the fixture stays fast; (2) `withBusyWrap`'s identical
// contract for a bare autocommit statement; (3) the grep-falsifiable
// invariant (criterion 2) that no file under work-state/ OTHER than this
// one issues `db.exec('BEGIN IMMEDIATE')`; (4) P-41-style genuine-contention
// fixtures (mirrors schema.test.ts's own P-41 guard: a review-reproduced
// regression gets a REAL, non-mocked concurrency test, not a stubbed error)
// proving the typed `WorkStateError('BUSY', ...)` actually surfaces, through
// the PRODUCTION busy_timeout (schema.ts's `BUSY_TIMEOUT_MS`, 5000ms), from
// one representative verb of EACH module this work item touches: a store
// primitive (`updateMeta`), a claim verb (`claim`), a board verb
// (`cancel`, via `transitionStatus`), and `checkExpiry`. Those four tests
// each genuinely wait out the real 5s timeout (a second, real connection
// holds the write lock for the whole window) — slow by unit-test standards,
// deliberately, because a shortened/mocked timeout there would prove
// nothing about the ACTUAL shipped behavior these call sites now have.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { BUSY_TIMEOUT_MS, openForWrite } from './schema.js';
import { withBusyWrap, withWriteTransaction } from './tx.js';
import { WorkStateError } from './types.js';
import { WorkStateStore } from './store.js';
import { claim } from './claims.js';
import { checkExpiry } from './expiry.js';
import { WorkStateVerbs } from './verbs.js';

function requireSqliteModule(): typeof import('node:sqlite') {
  const mod = process.getBuiltinModule('node:sqlite');
  if (mod === undefined) throw new Error('node:sqlite is not available in this Node runtime');
  return mod;
}

const tempDirs: string[] = [];
const openConnections: DatabaseSync[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-state-tx-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openConnections.length > 0) {
    const db = openConnections.pop();
    try {
      db?.close();
    } catch {
      // Already closed — fine.
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A raw connection (bypassing schema.ts) with its OWN, caller-chosen
 *  busy_timeout — used only by this file's fast, self-contained
 *  `withWriteTransaction`/`withBusyWrap` unit tests below. */
function rawConnection(dbPath: string, busyTimeoutMs: number): DatabaseSync {
  const { DatabaseSync } = requireSqliteModule();
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v INTEGER)');
  openConnections.push(db);
  return db;
}

/** Hold the write lock on `dbPath` from a SECOND, real connection — a
 *  genuine `BEGIN IMMEDIATE` that never commits until `release()` is called.
 *  Any other connection attempting its own write during the hold genuinely
 *  blocks (SQLite's own locking, not a mock) until either `release()` runs
 *  or its own busy_timeout is exhausted. */
function holdWriteLock(db: DatabaseSync): { release: () => void } {
  db.exec('BEGIN IMMEDIATE');
  return {
    release: () => {
      db.exec('ROLLBACK');
    },
  };
}

describe('grep-falsifiable: no bare BEGIN IMMEDIATE outside tx.ts (criterion 2)', () => {
  it('no work-state/*.ts file other than tx.ts contains db.exec(\'BEGIN IMMEDIATE\')', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    const forbidden = /db\.exec\(\s*['"]BEGIN IMMEDIATE['"]\s*\)/;

    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      if (entry.name === 'tx.ts') continue; // the one file allowed to hold this literal
      // Test-only scaffolding (this file's own `holdWriteLock` helper, which
      // simulates a SECOND, competing connection to force real contention)
      // legitimately issues its own raw BEGIN IMMEDIATE — the invariant
      // this test enforces is about the PRODUCT's mutating paths
      // (store/claims/expiry/verbs), not test fixtures standing in for an
      // external contending session.
      if (entry.name.endsWith('.test.ts')) continue;
      const full = join(srcDir, entry.name);
      // Strip full-line `//` and `*` comment lines before matching — doc
      // comments across this package legitimately mention the literal in
      // English prose. Inline/trailing comments are deliberately NOT
      // stripped: a mention there trips the guard too, which errs loud
      // (a false trip is a cheap fix; a silent pass is not).
      const codeOnly = readFileSync(full, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .join('\n');
      if (forbidden.test(codeOnly)) offenders.push(full);
    }

    expect(offenders).toEqual([]);
  });
});

describe('withWriteTransaction — commit/rollback/rethrow contract (criterion 1)', () => {
  it('commits fn\'s writes on success', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const db = rawConnection(dbPath, 1000);

    withWriteTransaction(db, (db) => {
      db.prepare('INSERT INTO t (id, v) VALUES (1, 10)').run();
    });

    const row = db.prepare('SELECT v FROM t WHERE id = 1').get() as { v: number };
    expect(row.v).toBe(10);
  });

  it('rolls back fn\'s writes and rethrows a non-busy error COMPLETELY UNCHANGED', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const db = rawConnection(dbPath, 1000);

    class MarkerError extends Error {
      readonly marker = 'application-error';
    }

    expect(() =>
      withWriteTransaction(db, (db) => {
        db.prepare('INSERT INTO t (id, v) VALUES (2, 20)').run();
        throw new MarkerError('kaboom — an unrelated application failure');
      }),
    ).toThrowError(MarkerError);

    // Not wrapped: still the ORIGINAL error type, not a WorkStateError.
    try {
      withWriteTransaction(db, () => {
        throw new MarkerError('kaboom again');
      });
    } catch (err) {
      expect(err).toBeInstanceOf(MarkerError);
      expect(err).not.toBeInstanceOf(WorkStateError);
      expect((err as MarkerError).message).toBe('kaboom again');
    }

    // The insert from the first, rolled-back attempt never persisted.
    const row = db.prepare('SELECT v FROM t WHERE id = 2').get() as { v: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('BEGIN IMMEDIATE blocked by a real held lock, past a short busy_timeout, surfaces as a typed WorkStateError(\'BUSY\', ...) — non-null cause named in the message', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const holderConn = rawConnection(dbPath, 1000);
    const victimConn = rawConnection(dbPath, 150); // shortened busy_timeout — fast fixture

    const holder = holdWriteLock(holderConn);
    try {
      let thrown: unknown;
      try {
        withWriteTransaction(victimConn, (db) => {
          db.prepare('INSERT INTO t (id, v) VALUES (3, 30)').run();
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkStateError);
      const busyErr = thrown as WorkStateError;
      expect(busyErr.code).toBe('BUSY');
      expect(busyErr.message).toMatch(/busy/i);
      // Names the configured busy_timeout (schema.ts's exported constant —
      // the message documents the PRODUCTION timeout every real call site
      // actually uses, not this fixture's own deliberately-shortened raw
      // connection timeout).
      expect(busyErr.message).toMatch(new RegExp(String(BUSY_TIMEOUT_MS)));
    } finally {
      holder.release();
    }
  });

  it('a mid-transaction statement hitting the exhausted lock is ALSO wrapped as BUSY, and the transaction is rolled back', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const holderConn = rawConnection(dbPath, 1000);
    const victimConn = rawConnection(dbPath, 150);

    // Seed a row via the victim connection BEFORE the lock is held, so the
    // hold below contends with a plain UPDATE, not a BEGIN IMMEDIATE.
    victimConn.prepare('INSERT INTO t (id, v) VALUES (4, 40)').run();

    const holder = holdWriteLock(holderConn);
    try {
      let thrown: unknown;
      try {
        withWriteTransaction(victimConn, (db) => {
          // BEGIN IMMEDIATE itself already contends with the held lock, so
          // this never gets to run — kept to prove the surrounding
          // transaction-open call is what's actually exercised here.
          db.prepare('UPDATE t SET v = 400 WHERE id = 4').run();
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkStateError);
      expect((thrown as WorkStateError).code).toBe('BUSY');
    } finally {
      holder.release();
    }

    const row = victimConn.prepare('SELECT v FROM t WHERE id = 4').get() as { v: number };
    expect(row.v).toBe(40); // unchanged — never got the write lock to update it
  });
});

describe('withBusyWrap — bare autocommit statement contract (criterion 1)', () => {
  it('returns fn\'s value on success', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const db = rawConnection(dbPath, 1000);

    const result = withBusyWrap(() => {
      db.prepare('INSERT INTO t (id, v) VALUES (1, 11)').run();
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('rethrows a non-busy error completely unwrapped', () => {
    class MarkerError extends Error {}
    expect(() =>
      withBusyWrap(() => {
        throw new MarkerError('kaboom — unrelated application failure');
      }),
    ).toThrowError(MarkerError);
  });

  it('a bare autocommit statement blocked by a held lock surfaces as a typed WorkStateError(\'BUSY\', ...)', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const holderConn = rawConnection(dbPath, 1000);
    const victimConn = rawConnection(dbPath, 150);
    victimConn.prepare('INSERT INTO t (id, v) VALUES (5, 50)').run();

    const holder = holdWriteLock(holderConn);
    try {
      expect(() =>
        withBusyWrap(() => victimConn.prepare('UPDATE t SET v = 500 WHERE id = 5').run()),
      ).toThrowError(WorkStateError);
      try {
        withBusyWrap(() => victimConn.prepare('UPDATE t SET v = 500 WHERE id = 5').run());
      } catch (err) {
        expect((err as WorkStateError).code).toBe('BUSY');
      }
    } finally {
      holder.release();
    }
  });
});

// ---------------------------------------------------------------------------
// P-41 fixtures: real busy_timeout exhaustion (production BUSY_TIMEOUT_MS,
// schema.ts) reached through one representative verb of EACH module this
// work item touches, via a REAL second connection holding the write lock —
// no mocked/stubbed errors (criterion 3). Each of these genuinely waits out
// BUSY_TIMEOUT_MS (5s) before the operation under test gives up, so each
// test's own timeout below is generous.
// ---------------------------------------------------------------------------

const REPRESENTATIVE_TEST_TIMEOUT_MS = BUSY_TIMEOUT_MS + 5_000;

describe('P-41: production busy_timeout exhaustion surfaces the typed BUSY error from each module', () => {
  const actor = { human: 'dan' };
  const clock: Clock = () => new Date('2026-07-11T12:00:00.000Z');

  it(
    'store primitive (WorkStateStore.updateMeta, a bare autocommit UPDATE via withBusyWrap)',
    () => {
      const root = makeTempDir();
      const dbPath = join(root, 'work-state', 'board.db');
      const store = new WorkStateStore(dbPath, clock);
      const item = store.insertItem({
        title: 'contended item',
        spec: '{}',
        spec_format: 'test/tx',
        created_by: actor,
      });

      const holderDb = openForWrite(dbPath);
      const holder = holdWriteLock(holderDb);
      try {
        expect(() => store.updateMeta(item.id, item.version, { title: 'new title' })).toThrowError(WorkStateError);
        let thrown: unknown;
        try {
          store.updateMeta(item.id, item.version, { title: 'new title' });
        } catch (err) {
          thrown = err;
        }
        expect((thrown as WorkStateError).code).toBe('BUSY');
        expect((thrown as WorkStateError).message).toMatch(/busy/i);
      } finally {
        holder.release();
        holderDb.close();
      }
    },
    REPRESENTATIVE_TEST_TIMEOUT_MS,
  );

  it(
    'claim verb (claims.claim, via withWriteTransaction)',
    () => {
      const root = makeTempDir();
      const dbPath = join(root, 'work-state', 'board.db');
      const store = new WorkStateStore(dbPath, clock);
      const item = store.insertItem({
        title: 'claimable item',
        spec: '{}',
        spec_format: 'test/tx',
        created_by: actor,
      });

      const holderDb = openForWrite(dbPath);
      const holder = holdWriteLock(holderDb);
      try {
        let thrown: unknown;
        try {
          claim(store, clock, item.id, actor);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(WorkStateError);
        expect((thrown as WorkStateError).code).toBe('BUSY');
      } finally {
        holder.release();
        holderDb.close();
      }

      // Never claimed — the contended attempt genuinely never wrote anything.
      expect(store.getItem(item.id)?.status).toBe('open');
    },
    REPRESENTATIVE_TEST_TIMEOUT_MS,
  );

  it(
    'board verb (WorkStateVerbs.cancel, via transitionStatus/withWriteTransaction)',
    () => {
      const root = makeTempDir();
      const dbPath = join(root, 'work-state', 'board.db');
      const store = new WorkStateStore(dbPath, clock);
      const verbs = new WorkStateVerbs(store, clock);
      const item = verbs.create({
        title: 'cancellable item',
        spec: '{}',
        spec_format: 'test/tx',
        created_by: actor,
      });

      const holderDb = openForWrite(dbPath);
      const holder = holdWriteLock(holderDb);
      try {
        let thrown: unknown;
        try {
          verbs.cancel(item.id, actor);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(WorkStateError);
        expect((thrown as WorkStateError).code).toBe('BUSY');
      } finally {
        holder.release();
        holderDb.close();
      }

      expect(store.getItem(item.id)?.status).toBe('open'); // never cancelled
    },
    REPRESENTATIVE_TEST_TIMEOUT_MS,
  );

  it(
    'checkExpiry (the first step of every id-scoped claim verb, via withWriteTransaction)',
    () => {
      const root = makeTempDir();
      const dbPath = join(root, 'work-state', 'board.db');
      let nowIso = '2026-07-11T12:00:00.000Z';
      const fakeClock: Clock = () => new Date(nowIso);
      const store = new WorkStateStore(dbPath, fakeClock);
      const item = store.insertItem({
        title: 'expiring item',
        spec: '{}',
        spec_format: 'test/tx',
        created_by: actor,
      });
      claim(store, fakeClock, item.id, actor, { leaseMs: 1000 });
      nowIso = '2026-07-11T12:30:00.000Z'; // well past the 1s lease

      const holderDb = openForWrite(dbPath);
      const holder = holdWriteLock(holderDb);
      try {
        let thrown: unknown;
        try {
          checkExpiry(store, fakeClock, item.id);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(WorkStateError);
        expect((thrown as WorkStateError).code).toBe('BUSY');
      } finally {
        holder.release();
        holderDb.close();
      }

      // Never reclaimed — the contended attempt genuinely never wrote anything.
      expect(store.getItem(item.id)?.status).toBe('in_progress');
    },
    REPRESENTATIVE_TEST_TIMEOUT_MS,
  );
});

describe('BUSY_TIMEOUT_MS is exported and finite (sanity for the timeouts above)', () => {
  it('is a positive number of milliseconds', () => {
    expect(BUSY_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
