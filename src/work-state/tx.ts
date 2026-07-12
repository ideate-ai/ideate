// plugin/src/work-state/tx.ts — the shared write-transaction / busy-wrap
// helper for the whole work-state module (WI-307, closing capstone S3 /
// F-304-001 S1).
//
// Why this file exists: types.ts's file header claims "typed, loud failure
// raised anywhere under work-state/" (F-301-001 S1) — but before this fix
// that was FALSE for exactly one failure mode: an exhausted `busy_timeout`
// (schema.ts's `BUSY_TIMEOUT_MS`). Every mutating call site in store.ts,
// claims.ts, expiry.ts, and verbs.ts opened its own `BEGIN IMMEDIATE ...
// COMMIT`/`ROLLBACK` unit by hand, so a genuinely exhausted busy-timeout
// (all engine-level retry budget spent, the write lock still held by another
// connection) surfaced as a raw node:sqlite `Error` ("database is locked",
// `code: 'ERR_SQLITE_ERROR'`, `errcode: 5`) escaping straight past every
// typed-error contract this package documents. This module is the ONE place
// that shape is caught and re-thrown as a typed `WorkStateError('BUSY', ...)`
// — every other call site routes through one of the two helpers below rather
// than issuing its own `BEGIN IMMEDIATE`.
//
// Design (pre-made — see this work item's own brief, not re-litigated here):
// wrap-only, NO product-side retry loop. `PRAGMA busy_timeout` (schema.ts) IS
// the retry mechanism — node:sqlite's engine already blocks and retries
// internally for up to `BUSY_TIMEOUT_MS` before giving up. A retry ON TOP of
// that exhausted budget is client policy, not this module's job (the
// capstone review's §4 reading) — see tests/contention/two-session-wal.
// test.ts's own `withBusyRetry`, which lives at the test-client layer for
// exactly that reason and is explicitly OUT of this file's scope.
//
// Detection: both node:sqlite's own numeric SQLite result codes (`errcode`
// 5 = SQLITE_BUSY, 6 = SQLITE_LOCKED — the two codes a busy_timeout
// exhaustion can surface as) AND a message-pattern fallback (`/locked|busy/i`)
// are checked, so this still works against a differently-shaped error (a
// future node:sqlite version, or a message-only mock in a test) as long as
// it reads like a lock/busy failure in plain English.
//
// Grep-falsifiable invariant (criterion 2): no OTHER file under work-state/
// may contain the literal `db.exec('BEGIN IMMEDIATE')` (or the
// double-quoted equivalent) — see tx.test.ts's own grep test, which excludes
// only this file.

import type { DatabaseSync } from 'node:sqlite';

import { BUSY_TIMEOUT_MS } from './schema.js';
import { WorkStateError } from './types.js';

/** SQLite's own numeric result code for "the database file is locked by
 *  another connection and busy_timeout's retry budget is exhausted". */
const SQLITE_BUSY = 5;
/** SQLite's own numeric result code for "a table is locked" — grouped with
 *  SQLITE_BUSY here because, from this module's caller's point of view, both
 *  mean the same thing: someone else holds a lock this connection needed and
 *  waiting for it did not pay off within the timeout. */
const SQLITE_LOCKED = 6;

function sqliteErrcode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const errcode = (err as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' ? errcode : undefined;
}

/** True iff `err` looks like an exhausted-busy-timeout / lock-contention
 *  failure from node:sqlite — checked by BOTH the engine's own numeric
 *  result code and a message-pattern fallback (see file header). */
function isBusyError(err: unknown): boolean {
  const code = sqliteErrcode(err);
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : undefined;
  return message !== undefined && /locked|busy/i.test(message);
}

/**
 * Re-throw `err` as a typed `WorkStateError('BUSY', ...)` if it looks like an
 * exhausted busy-timeout / lock-contention failure; otherwise re-throw it
 * completely unchanged (criterion 1: "non-busy errors pass through
 * unwrapped"). Never returns — callers use this exclusively from a `catch`
 * block, as the block's final statement.
 */
function rethrowBusy(err: unknown): never {
  if (isBusyError(err)) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new WorkStateError(
      'BUSY',
      `work-state: a write could not proceed — another connection held board.db's write lock past the ${String(BUSY_TIMEOUT_MS)}ms busy_timeout (schema.ts), most likely a concurrent session holding the lock for longer than the timeout allows (SQLite: ${detail})`,
    );
  }
  throw err;
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE ... COMMIT` on `db`, rolling back on any
 * thrown error. This is the ONLY place in the package that issues
 * `BEGIN IMMEDIATE` (criterion 2) — every multi-statement atomic unit in
 * store.ts/claims.ts/expiry.ts/verbs.ts calls this instead of managing its
 * own transaction boilerplate.
 *
 * `fn` may run zero or more statements against `db` and return any value; it
 * may also simply do nothing and return, in which case an empty transaction
 * commits — harmless, and simpler than requiring every caller to distinguish
 * "nothing changed, so roll back instead of committing" from "something
 * changed, so commit", a distinction with no observable difference for an
 * empty transaction.
 *
 * `BEGIN IMMEDIATE` itself failing (the write lock could not be acquired at
 * all) is handled before any application logic ever runs — there is nothing
 * to roll back in that case, since nothing was ever begun.
 */
export function withWriteTransaction<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    rethrowBusy(err);
  }
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The rollback itself failing (e.g. the connection is already broken)
      // is not the interesting error here — the original `err` is what the
      // caller needs to see, so this secondary failure is swallowed rather
      // than masking it.
    }
    rethrowBusy(err);
  }
}

/**
 * Run `fn` — a single bare, autocommitting statement (or a short read-then-
 * write sequence with no explicit `BEGIN`) — catching and re-typing an
 * exhausted-busy-timeout failure exactly like {@link withWriteTransaction}
 * does, with no transaction boilerplate of its own (there is nothing to
 * begin, commit, or roll back around one autocommitting statement). This is
 * the helper for store.ts's `updateMeta`/`appendEvent`/`nextClaimToken`
 * primitives — call sites that were, and remain, single autocommit
 * statements, just no longer able to leak a raw node:sqlite error past this
 * package's typed-failure contract.
 */
export function withBusyWrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    rethrowBusy(err);
  }
}
