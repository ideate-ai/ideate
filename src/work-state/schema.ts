// plugin/src/work-state/schema.ts — SQLite DDL and open/init for the
// work-state store (WI-300).
//
// Spec: docs/spikes/v3-work-delegation.md §4 (local-mode equivalence: SQLite
// on the IC's machine, WAL mode with a busy-timeout — "two simultaneous
// sessions on one machine writing the same board... is ordinary, not
// exceptional"). Runtime floor: `node:sqlite` (node's built-in SQLite binding)
// requires Node >=22.5.0 — verified against the Node.js docs at the 22.5.0
// and 22.4.1 tags; plugin/package.json's `engines` field is tightened to
// match (was >=22.0.0).
//
// This module owns exactly two things:
// - The DDL for the two tables (`items`, `events`).
// - Opening a connection with WAL + busy_timeout set BY CONSTRUCTION — every
//   caller gets these pragmas; there is no code path that opens a work-state
//   connection without them.
//
// Lazy-init discipline (mirrors record/store.ts): nothing under the
// work-state directory is created until the first WRITE. `openForRead`
// returns `null` without touching the filesystem when the database file does
// not yet exist; `openForWrite` is the only function that creates the parent
// directory and the database file.
//
// The `events` table is APPEND-ONLY BY CONSTRUCTION: this module defines no
// UPDATE or DELETE statement against it anywhere, and store.ts (the only
// other file that touches SQL) must preserve that — grep-falsifiable: no
// `UPDATE events` / `DELETE FROM events` string exists in this package.

import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { WorkStateError } from './types.js';

// `DatabaseSync` is resolved via `process.getBuiltinModule` rather than a
// static `import ... from 'node:sqlite'`. This is a deliberate workaround,
// not a style choice: this repo's pinned Vite/vitest toolchain (5.4.x)
// externalizes node builtins from a hardcoded snapshot of
// `node:module`'s `builtinModules` that predates `node:sqlite`'s addition,
// and mis-resolves the bare specifier during test runs. `process.getBuiltinModule`
// (stable since Node 22.3.0, i.e. within this module's own >=22.5.0 floor) is
// a runtime lookup, not an import specifier, so it never goes through that
// resolution path. The type import above is compile-time only and erased —
// it carries no runtime specifier for the bundler to mis-resolve.
function requireSqliteModule(): typeof import('node:sqlite') {
  const mod = process.getBuiltinModule('node:sqlite');
  if (mod === undefined) {
    throw new Error(
      'work-state schema: node:sqlite is not available in this Node runtime (requires >=22.5.0 — see plugin/package.json engines)',
    );
  }
  return mod;
}

/**
 * Busy-timeout applied to every write connection (milliseconds).
 *
 * Compounded worst-case wait (WI-307): every id-scoped claim verb
 * (claim/renew/complete/release, claims.ts) runs `checkExpiry` (expiry.ts)
 * FIRST, as its own separate `BEGIN IMMEDIATE ... COMMIT` unit
 * (tx.ts's `withWriteTransaction`), and then the verb's own CAS as a SECOND,
 * separate transaction on a fresh connection. Each of those two
 * transactions independently retries for up to `BUSY_TIMEOUT_MS` before
 * giving up — so a single logical call into one of those verbs can, in the
 * genuinely worst case (contention present for BOTH steps), take up to
 * ~2 × `BUSY_TIMEOUT_MS` (≈10s at the current 5000ms setting) before either
 * succeeding or surfacing the typed `WorkStateError('BUSY', ...)` (tx.ts).
 * This is a LATENCY note, not a correctness one: each half is independently
 * atomic and safe to retry-from-scratch (tx.ts's file header), so the
 * compounding only affects how long a caller might wait, never what ends up
 * persisted.
 */
export const BUSY_TIMEOUT_MS = 5000;

/**
 * The board.db schema version, stamped into SQLite's own `PRAGMA
 * user_version` (an integer the engine persists in the file header for
 * free — no extra table, no extra row to keep in sync). Mirrors
 * `V3_SCHEMA_VERSION` in `config/ideate-config.ts` in spirit: a single
 * source-of-truth integer this module checks on every open, and a wording
 * style ("newer than this ideate understands") copied from that module's
 * `IdeateConfigError` message so the two honest-failure surfaces read the
 * same way to a human. Bump this when `ITEMS_TABLE_DDL` / `EVENTS_TABLE_DDL`
 * change in a way old code cannot read; see {@link checkSchemaVersion} for
 * what happens on a mismatch.
 */
export const BOARD_SCHEMA_VERSION = 1;

/**
 * `items`: one row per work item. `depends_on` is stored as a JSON array of
 * ULID strings (store.ts owns the (de)serialization — this module is DDL
 * only). `claim_token_counter` is the fencing-token monotonicity source: a
 * counter column on the item row, NOT a derivation from `events`, so it
 * survives claim deletion/reclamation (spec §4). The five `claim_*` columns
 * mirror the {@link "./types.js".Claim} shape; all NULL together means
 * `claim: null`.
 */
const ITEMS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS items (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  spec                  TEXT NOT NULL,
  spec_format           TEXT NOT NULL,
  status                TEXT NOT NULL,
  depends_on            TEXT NOT NULL,
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

/**
 * `events`: append-only transition log. `seq` is a surrogate autoincrement
 * key for stable ordering — it carries no contract meaning of its own.
 * NO code path may UPDATE or DELETE a row in this table (see file header).
 */
const EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      TEXT NOT NULL,
  actor_human  TEXT NOT NULL,
  actor_agent  TEXT,
  transition   TEXT NOT NULL,
  claim_token  INTEGER,
  note         TEXT,
  at           TEXT NOT NULL
)`;

const ITEMS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_items_tenant_status ON items (tenant_id, status)`;
const EVENTS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_events_item_id ON events (item_id, seq)`;

/**
 * Set the busy-timeout and WAL mode on a freshly opened connection.
 *
 * ORDER MATTERS (F-300-001 C1): a new connection defaults to
 * busy_timeout = 0, so the timeout must be set FIRST — otherwise the
 * `journal_mode = WAL` statement itself has no retry budget and throws a
 * raw "database is locked" under a genuinely concurrent writer.
 */
function applyPragmas(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  db.exec('PRAGMA journal_mode = WAL');
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(ITEMS_TABLE_DDL);
  db.exec(EVENTS_TABLE_DDL);
  db.exec(ITEMS_INDEX_DDL);
  db.exec(EVENTS_INDEX_DDL);
}

/** Read the file's current `PRAGMA user_version` (0 on a brand-new file). */
function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * Enforce the one rule this schema version understands: v1 accepts a file
 * stamped `user_version` 0 (unversioned — see {@link openForWrite}'s
 * handling below) or exactly {@link BOARD_SCHEMA_VERSION}. Anything else is
 * a typed, loud failure — never a silent misread:
 *
 * - `user_version` > {@link BOARD_SCHEMA_VERSION}: the file was written by a
 *   NEWER plugin than this one. Mirrors `ideate-config.ts`'s
 *   `schema_version` check almost verbatim ("newer than this ideate
 *   understands") — same honest-failure posture, same wording style.
 * - `user_version` < {@link BOARD_SCHEMA_VERSION} and non-zero: the file was
 *   written by an OLDER plugin than this one, on a schema version this
 *   plugin no longer accepts as-is. There is no migration ladder yet — v1
 *   is the first stamped version, so this branch cannot fire against a
 *   real board today, but it is written now (rather than left as a TODO)
 *   so that the FIRST future version bump gets this check for free. When
 *   that ladder exists, this is where it will be invoked; until then, the
 *   error says so plainly rather than guessing at a migration.
 *
 * Called on EVERY open (read and write) — this is the "a newer board file
 * against an older plugin is silently misread" half of the gap this module
 * closes; {@link openForWrite}'s post-check stamping closes the other half
 * (an older plugin's un-stamped DDL silently no-op'ing against a future
 * plugin's expectations).
 */
function checkSchemaVersion(userVersion: number): void {
  if (userVersion > BOARD_SCHEMA_VERSION) {
    throw new WorkStateError('SCHEMA_VERSION',
      `board.db has user_version ${String(userVersion)}, newer than this ideate understands (${String(BOARD_SCHEMA_VERSION)})`,
    );
  }
  if (userVersion !== 0 && userVersion < BOARD_SCHEMA_VERSION) {
    throw new WorkStateError('SCHEMA_VERSION',
      `board.db has user_version ${String(userVersion)}, older than this ideate understands (${String(BOARD_SCHEMA_VERSION)}); there is no migration ladder yet — that is future work, not a bug, and this file cannot be opened until one exists`,
    );
  }
  // userVersion === 0 (unstamped) or === BOARD_SCHEMA_VERSION: fine.
}

/**
 * Open a WRITE connection to the work-state database at `dbPath`, creating
 * the parent directory and the database file if this is the first write
 * (lazy init — see file header). WAL mode and the busy-timeout are set on
 * every call, unconditionally; the schema is (re-)ensured via
 * `CREATE TABLE IF NOT EXISTS`, which is a no-op once the tables exist.
 *
 * Callers are responsible for calling `.close()` when done — this module
 * opens one connection per call rather than holding a pool, matching the
 * SQLite-is-cheap-to-open posture and keeping lazy-init easy to reason about.
 *
 * Schema versioning (WI-308, closing GAP-2 / gap 3): the pragmas are applied
 * FIRST — busy_timeout before anything else, per F-300-001's ordering lesson
 * (a fresh connection's busy_timeout defaults to 0, so any statement run
 * before it is set, including reading `user_version`, has no retry budget
 * under contention) — THEN `user_version` is checked
 * ({@link checkSchemaVersion}, shared with {@link openForRead}), THEN the DDL
 * runs. A `user_version` of 0 means one of two things, handled identically:
 * a genuinely brand-new file (just created above, nothing to preserve), or
 * a pre-versioning board written by a PH-044-era plugin build that predates
 * this check (real data, never stamped). Either way this is a one-time
 * grace: the very next `openForWrite` stamps it to
 * {@link BOARD_SCHEMA_VERSION} and every subsequent open is checked
 * normally. There is no separate migration step because v1 IS the
 * pre-versioning shape — stamping is the whole migration.
 */
export function openForWrite(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync } = requireSqliteModule();
  const db = new DatabaseSync(dbPath);
  applyPragmas(db);
  const userVersion = readUserVersion(db);
  checkSchemaVersion(userVersion);
  ensureSchema(db);
  if (userVersion === 0) {
    db.exec(`PRAGMA user_version = ${String(BOARD_SCHEMA_VERSION)}`);
  }
  return db;
}

/**
 * Open a READ connection to the work-state database at `dbPath`. Returns
 * `null` WITHOUT touching the filesystem when the file does not exist yet —
 * this is the lazy-init guarantee for reads (a `get`/`list`/`events` call
 * before any write must not create the directory or the database file).
 *
 * When the file does exist, it is opened read-only; WAL mode is a property
 * of the database file itself (persisted in its header), so a read-only
 * connection transparently reads through WAL without re-applying that
 * pragma. busy_timeout, however, is PER-CONNECTION and defaults to 0 —
 * without it, reads under write contention fail with raw "database is
 * locked" errors instead of waiting (F-300-001 C2: reproduced at a
 * 30-50% failure rate with concurrent writers before this line existed).
 *
 * Schema versioning (WI-308): busy_timeout is still set FIRST, then
 * `user_version` is checked ({@link checkSchemaVersion}, shared with
 * {@link openForWrite}) — same ordering rule, same reason. A `user_version`
 * of 0 (unstamped) is accepted here too: a read must not fail just because
 * no write has happened yet to run the one-time stamp described on
 * {@link openForWrite}.
 */
export function openForRead(dbPath: string): DatabaseSync | null {
  if (!existsSync(dbPath)) return null;
  const { DatabaseSync } = requireSqliteModule();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)}`);
  checkSchemaVersion(readUserVersion(db));
  return db;
}
