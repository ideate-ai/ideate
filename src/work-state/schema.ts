// plugin/src/work-state/schema.ts — SQLite DDL and open/init for the
// work-state store.
//
// Local-mode equivalence: SQLite on the IC's machine, WAL mode with a
// busy-timeout — two simultaneous sessions on one machine writing the same
// board is ordinary, not exceptional. Runtime floor: `node:sqlite` (node's
// built-in SQLite binding) requires Node >=22.5.0 — verified against the
// Node.js docs at the 22.5.0 and 22.4.1 tags; plugin/package.json's `engines`
// field is tightened to match (was >=22.0.0).
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
 * Compounded worst-case wait: every id-scoped claim verb
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
 *
 * v2: adds the nullable `parent_id` containment column to `items`.
 * The bump lights up the FIRST real migration rung — an additive,
 * metadata-only `ALTER TABLE items ADD COLUMN parent_id TEXT` (see
 * {@link openForWrite}). Every pre-migration row lands with `parent_id NULL`
 * (a root), with no data rewrite.
 *
 * v3: adds the `"references"` forward-edge column to `items` (typed
 * supersedes/reference edges — see types.ts's `WorkItemReference`). Same
 * additive, metadata-only shape as v1->v2: `ALTER TABLE items ADD COLUMN
 * "references" TEXT NOT NULL DEFAULT '[]'`; every pre-migration row lands
 * with `'[]'` (no edges), no data rewrite. The name is double-quoted
 * everywhere it appears in SQL because `REFERENCES` is a reserved SQLite
 * keyword (the foreign-key clause) — a bare identifier is a syntax error.
 */
export const BOARD_SCHEMA_VERSION = 3;

/**
 * The compatibility FLOOR: the oldest binary schema version verified safe to
 * BOTH read and write a board at {@link BOARD_SCHEMA_VERSION}. Stamped into
 * SQLite's spare header field `PRAGMA application_id` (a free 4-byte
 * application-defined integer — no table, no rung, preserved by VACUUM and
 * the backup API) so the tolerance claim travels INSIDE the board file and a
 * future older binary can evaluate it without knowing anything about
 * versions after its own.
 *
 * Why a floor, stated plainly: a `user_version` above a binary's
 * BOARD_SCHEMA_VERSION used to be an unconditional hard refusal
 * ({@link checkSchemaVersion}), on the conservative assumption that a newer
 * board is unreadable. Verified against the SHIPPED v2 binary (the installed
 * 3.0.0 build, not from memory): every v2->v3 difference is an additive,
 * metadata-only `ALTER TABLE ... ADD COLUMN`, and the v2 binary's SQL is
 * column-tolerant in all four directions — reads use `SELECT *` but map rows
 * by named property (unknown column ignored), INSERT uses an explicit column
 * list (the new column's DEFAULT fills it), UPDATE uses an explicit SET list
 * (never touches the new column), and the events table is unchanged. So the
 * lockout was a policy choice, not a data necessity, and a floor of 2 is
 * CERTIFIED for a v3 board. (One honest degradation: a floored older binary
 * cannot see the `"references"` forward edges — a superseded item and its
 * replacement both look live to it. Working-but-degraded, versus dead.)
 *
 * THE RULE FOR THE NEXT RUNG (P-40, same change as the rung): whoever adds
 * v(N+1) must re-derive this floor with the SAME verification — read the
 * oldest in-field binary's actual SQL and confirm named-property row
 * mapping, explicit INSERT column lists, and explicit UPDATE SET lists
 * against the new column. If every binary >= the current floor still
 * tolerates the board, the floor STAYS; otherwise it rises to the oldest
 * version that remains correct; if no older version is correct, the floor
 * equals the new version (no window — the hard refusal returns). A rung
 * that moves the floor to the current version is exactly the "non-additive,
 * explicit-upgrade" case: say so loudly in the rung's commit.
 */
export const BOARD_SCHEMA_FLOOR = 2;

/**
 * A migration that actually ran, reported to the registered listener
 * ({@link setMigrationListener}) so a composition root can make it DURABLE —
 * the stderr line {@link openForWrite} always emits is loud but evaporates;
 * the record the composition root appends from this callback is what a later
 * "why does the older plugin refuse this board?" investigation finds.
 */
export interface MigrationInfo {
  dbPath: string;
  fromVersion: number;
  toVersion: number;
  floor: number;
}

export type MigrationListener = (info: MigrationInfo) => void;

/**
 * Process-scoped migration listener, registered ONCE by each composition
 * root (the CLI per invocation, the MCP server per process). Module-level by
 * design: the alternative — threading a callback through every one of the
 * ten `openForWrite` call sites across store/claims/expiry/verbs — is wider
 * plumbing for the same reach, and the transports are exactly process-scoped
 * (one listener per process is never ambiguous). With NO listener registered
 * the migration is still loud on stderr; the listener only adds durability.
 */
let migrationListener: MigrationListener | undefined;

/** Register (or clear, with `undefined`) the process's migration listener. */
export function setMigrationListener(listener: MigrationListener | undefined): void {
  migrationListener = listener;
}

/**
 * A degraded open — an OLDER binary opening a NEWER board whose stamped
 * floor covers it (see {@link checkSchemaVersion}) — reported to the
 * registered listener ({@link setDegradedOpenListener}) so a composition
 * root can make THIS crossing durable too, exactly as {@link MigrationInfo}
 * does for a write-migration. The two crossings are mirror images (an
 * older binary silently working from a partial view is the same "nothing
 * points back at the moment it happened" gap {@link MigrationInfo}'s doc
 * comment names), so this carries the same shape of fact: what this binary
 * understands, what the board is actually stamped at, the floor that let it
 * proceed anyway, and where.
 *
 * Unlike a migration (a one-time, one-way-door event on a single write),
 * a degraded open recurs on EVERY open this binary makes against the board
 * for as long as it keeps running against it — {@link checkSchemaVersion}
 * runs on every `openForRead`/`openForWrite` call, and every read view in
 * store.ts opens a fresh connection per call (no cross-call cache). So this
 * listener, unlike {@link migrationListener}, is invoked on every
 * degraded-accepting call, not gated behind the once-per-process flag that
 * guards the console line ({@link floorAcceptWarned}) — the two dedup
 * decisions are independent BY DESIGN, even though (per P-45's amended
 * durability-per-condition rule) both now land on "once per process" for a
 * fixed board: the log line is deduplicated here, unconditionally, purely to
 * keep it readable; the DURABLE record's dedup is the caller's decision
 * (migration-signal.ts's `createDegradedOpenListener`), keyed on the
 * (dbPath, boardVersion, floor) CONDITION rather than gated on this flag, so
 * a long-lived process that later observes a different board — or the same
 * board at a changed version/floor — still gets a fresh record. This
 * listener is invoked on every call regardless, both so that caller can
 * detect the condition changing and so a telemetry counter can tally every
 * occurrence even where the durable record does not.
 */
export interface DegradedOpenInfo {
  dbPath: string;
  /** This binary's own understanding — {@link BOARD_SCHEMA_VERSION}. */
  binaryVersion: number;
  /** The board's actual stamped `PRAGMA user_version` — newer than `binaryVersion`. */
  boardVersion: number;
  /** The board's stamped compatibility floor (`PRAGMA application_id`) that let this binary open it anyway. */
  floor: number;
}

export type DegradedOpenListener = (info: DegradedOpenInfo) => void;

/**
 * Process-scoped degraded-open listener — same registration shape as
 * {@link migrationListener}, registered once per composition root.
 */
let degradedOpenListener: DegradedOpenListener | undefined;

/** Register (or clear, with `undefined`) the process's degraded-open listener. */
export function setDegradedOpenListener(listener: DegradedOpenListener | undefined): void {
  degradedOpenListener = listener;
}

/**
 * The floor-accept warning fires ONCE per process, not per open: the MCP
 * transport opens a fresh connection per verb, so per-open would spam the
 * server log into noise (and noise is how a loud signal stops being loud).
 * Once per process is exactly once per CLI invocation and once per MCP
 * server lifetime. Reset by tests via {@link resetFloorAcceptWarning}.
 *
 * This gates ONLY the console line — {@link degradedOpenListener} is called
 * on every occurrence regardless (see {@link DegradedOpenInfo}'s doc
 * comment for why the two must not share a gate).
 */
let floorAcceptWarned = false;

/** Test-only: re-arm the once-per-process floor-accept warning. */
export function resetFloorAcceptWarning(): void {
  floorAcceptWarned = false;
}

/**
 * `items`: one row per work item. `depends_on` is stored as a JSON array of
 * ULID strings (store.ts owns the (de)serialization — this module is DDL
 * only). `claim_token_counter` is the fencing-token monotonicity source: a
 * counter column on the item row, NOT a derivation from `events`, so it
 * survives claim deletion/reclamation. The five `claim_*` columns
 * mirror the {@link "./types.js".Claim} shape; all NULL together means
 * `claim: null`.
 *
 * `parent_id` (v2) is the nullable CONTAINMENT edge — the single
 * optional pointer to the item this one belongs to (its "parent"). NULL means
 * the item is a root (a top-level item, or a "phase" itself). It is fully
 * orthogonal to `depends_on` (sequencing): store.ts owns its (de)serialization
 * and dag.ts owns its ancestor-cycle/parent-existence guards — this module is
 * DDL only. A freshly-created v2 board has the column from `CREATE TABLE`; an
 * existing v1 board gets it via the additive migration in {@link openForWrite}.
 *
 * `"references"` (v3) is the typed FORWARD-edge column — a JSON array of
 * `{rel, id}` edges (`supersedes` primary), exactly the record store's
 * `references` field carried onto the board (one mental model across the
 * stores). NOT NULL DEFAULT '[]' so a legacy row reads as "no edges" with no
 * rewrite. The reverse edge (`superseded_by`) is never a column: it is
 * derived on read by store.ts's view reads. Quoted in every SQL statement
 * (reserved keyword — see {@link BOARD_SCHEMA_VERSION}).
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
  parent_id             TEXT,
  "references"          TEXT NOT NULL DEFAULT '[]',
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
 * ORDER MATTERS: a new connection defaults to
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

/** Read the file's compatibility floor (`PRAGMA application_id`; 0 = never
 *  stamped, i.e. the board's writer certified nothing about older readers). */
function readApplicationId(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA application_id').get() as { application_id: number };
  return row.application_id;
}

/**
 * Enforce the one rule this schema version understands: a file stamped
 * `user_version` at or below {@link BOARD_SCHEMA_VERSION} is acceptable; a
 * file stamped ABOVE it is acceptable ONLY through the compatibility floor
 * its writer stamped, and is otherwise a typed, loud failure — never a
 * silent misread:
 *
 * - `user_version` > {@link BOARD_SCHEMA_VERSION}: the file was written by a
 *   NEWER plugin than this one. If its stamped floor ({@link
 *   BOARD_SCHEMA_FLOOR} — the writer's certified "additive-only back to
 *   here") covers this binary's version, open anyway and warn LOUDLY (once
 *   per process): this binary predates the board and runs degraded —
 *   anything the newer schema added (e.g. v3's `"references"` forward
 *   edges) is invisible to it. If the floor is absent (0) or ABOVE this
 *   binary's version, throw HERE, on the older plugin's side — the intended
 *   honest failure, not a silent misread. Mirrors `ideate-config.ts`'s
 *   `schema_version` check ("newer than this ideate understands") — same
 *   honest-failure posture, same wording style.
 * - `user_version` <= {@link BOARD_SCHEMA_VERSION}: acceptable. `0` (unstamped
 *   pre-versioning) and any stamped version below the current one are
 *   migrated FORWARD by {@link openForWrite}'s additive ladder (the rungs are
 *   v1->v2 and v2->v3).
 *
 * Called on EVERY open (read and write) — this is the "a newer board file
 * against an older plugin is silently misread" half of the gap this module
 * closes; {@link openForWrite}'s migration + stamping closes the other half
 * (an older plugin's un-stamped/older DDL silently no-op'ing against a newer
 * plugin's expectations). NOTE: a read connection cannot migrate (it is
 * read-only), so a below-current board is only actually brought to the
 * current shape on the next {@link openForWrite}; the version check here
 * merely refuses to fail loud on a file a write WOULD migrate.
 */
function checkSchemaVersion(db: DatabaseSync, userVersion: number, dbPath: string): void {
  if (userVersion > BOARD_SCHEMA_VERSION) {
    const floor = readApplicationId(db);
    if (floor !== 0 && floor <= BOARD_SCHEMA_VERSION) {
      if (!floorAcceptWarned) {
        floorAcceptWarned = true;
        console.error(
          `work-state: board.db has user_version ${String(userVersion)}, newer than this ideate understands ` +
            `(${String(BOARD_SCHEMA_VERSION)}), but its writer stamped a compatibility floor of ${String(floor)} — ` +
            'opening DEGRADED: anything the newer schema added is invisible to this binary. ' +
            'Update the ideate plugin to see the full board.',
        );
      }
      // Invoked EVERY time, not gated behind floorAcceptWarned — see
      // DegradedOpenInfo's doc comment: the listener needs every occurrence
      // (for its telemetry counter and to detect the condition changing),
      // even though its own durable-record dedup now lands on roughly the
      // same "once per process" cadence as the log line, for a different
      // reason (per-condition, not per-call).
      if (degradedOpenListener !== undefined) {
        try {
          degradedOpenListener({ dbPath, binaryVersion: BOARD_SCHEMA_VERSION, boardVersion: userVersion, floor });
        } catch (err) {
          // Best-effort, same posture as the migration listener below: the
          // open itself must not fail because the durable copy failed.
          console.error(
            `work-state: degraded-open listener failed for ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return;
    }
    throw new WorkStateError('SCHEMA_VERSION',
      `board.db has user_version ${String(userVersion)}, newer than this ideate understands (${String(BOARD_SCHEMA_VERSION)})` +
        (floor === 0
          ? ', and its writer stamped no compatibility floor'
          : `, and its stamped compatibility floor (${String(floor)}) is newer than this binary`),
    );
  }
  // userVersion in [0, BOARD_SCHEMA_VERSION]: fine. Below-current versions are
  // migrated forward by openForWrite; the current version is a no-op.
}

/** True if `table` already has a column named `column`. */
function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * Run the additive schema migrations that bring a below-current board up to
 * {@link BOARD_SCHEMA_VERSION}, in place, on a WRITE connection. Every rung is
 * additive and idempotent-guardable so this is safe to run against a `0`
 * (unstamped) board that ALREADY has the current DDL (a genuinely brand-new
 * file, whose `ensureSchema` just created the column) as well as a real
 * below-current board that predates the column.
 *
 * v1->v2: `parent_id TEXT` (nullable). `ALTER TABLE ... ADD COLUMN`
 * with a nullable column is an O(1) metadata-only operation in SQLite — no row
 * rewrite; every pre-existing row's `parent_id` reads as NULL (a root). Guarded
 * by a `PRAGMA table_info` existence check so it is a no-op when the column is
 * already present (the fresh-create case). Treats `0` and `1` identically —
 * the simplest correct rule.
 *
 * v2->v3: `"references" TEXT NOT NULL DEFAULT '[]'` (quoted — reserved
 * keyword). Same additive, metadata-only shape: ADD COLUMN with a constant
 * DEFAULT fills every pre-existing row with `'[]'` (no edges) without a row
 * rewrite. Same existence-guard idempotence.
 */
function migrateSchema(db: DatabaseSync): void {
  if (!columnExists(db, 'items', 'parent_id')) {
    db.exec('ALTER TABLE items ADD COLUMN parent_id TEXT');
  }
  if (!columnExists(db, 'items', 'references')) {
    db.exec(`ALTER TABLE items ADD COLUMN "references" TEXT NOT NULL DEFAULT '[]'`);
  }
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
 * Schema versioning: the pragmas are applied FIRST — busy_timeout before
 * anything else, per the ordering lesson above
 * (a fresh connection's busy_timeout defaults to 0, so any statement run
 * before it is set, including reading `user_version`, has no retry budget
 * under contention) — THEN `user_version` is checked
 * ({@link checkSchemaVersion}, shared with {@link openForRead}), THEN the DDL
 * runs, THEN any below-current board is migrated forward and re-stamped.
 *
 * A `user_version` BELOW {@link BOARD_SCHEMA_VERSION} (0 = unstamped
 * pre-versioning or a genuinely brand-new file; 1 = a real stamped v1 board)
 * is brought to the current shape here: `ensureSchema` first runs the current
 * `CREATE TABLE IF NOT EXISTS` DDL (a no-op on an existing table — so a real
 * v1 table does NOT gain `parent_id` from this step), then {@link migrateSchema}
 * runs the additive `ALTER TABLE` rungs (idempotent-guarded, so a brand-new
 * file that already has the column is untouched), then the file is stamped to
 * {@link BOARD_SCHEMA_VERSION}. This is a one-time step per version: every
 * subsequent open reads the current version and skips it. The migration is
 * metadata-only (additive nullable column) — no row rewrite, and every legacy
 * row reads `parent_id === null` (a root).
 */
export function openForWrite(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { DatabaseSync } = requireSqliteModule();
  const db = new DatabaseSync(dbPath);
  applyPragmas(db);
  const userVersion = readUserVersion(db);
  checkSchemaVersion(db, userVersion, dbPath);
  ensureSchema(db);
  if (userVersion < BOARD_SCHEMA_VERSION) {
    migrateSchema(db);
    db.exec(`PRAGMA user_version = ${String(BOARD_SCHEMA_VERSION)}`);
    db.exec(`PRAGMA application_id = ${String(BOARD_SCHEMA_FLOOR)}`);
    // LOUD at the moment the one-way door closes (P-45): a migration is
    // triggered incidentally by whichever binary writes first, and the
    // person hurt by it is not the person who triggered it — so the
    // crossing announces itself on stderr here AND, via the registered
    // listener, durably in the project's process record.
    console.error(
      `work-state: migrated board.db from schema v${String(userVersion)} to v${String(BOARD_SCHEMA_VERSION)} ` +
        `(compatibility floor v${String(BOARD_SCHEMA_FLOOR)} stamped — binaries >= v${String(BOARD_SCHEMA_FLOOR)} with the floor check keep working). ` +
        'Binaries older than the floor will refuse this board; update the ideate plugin everywhere that opens it.',
    );
    if (migrationListener !== undefined) {
      try {
        migrationListener({ dbPath, fromVersion: userVersion, toVersion: BOARD_SCHEMA_VERSION, floor: BOARD_SCHEMA_FLOOR });
      } catch (err) {
        // The migration itself is already committed; a listener failure
        // must not break the write that triggered it. Loud fallback.
        console.error(
          `work-state: migration listener failed for ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } else if (userVersion === BOARD_SCHEMA_VERSION && readApplicationId(db) !== BOARD_SCHEMA_FLOOR) {
    // Self-heal: a board written before the floor existed (application_id
    // 0) gets stamped on its next write, so the floor reaches every active
    // board without a sweep. A floor-accepted FOREIGN board (user_version
    // above ours) is deliberately left alone — its stamps belong to its
    // own writer.
    db.exec(`PRAGMA application_id = ${String(BOARD_SCHEMA_FLOOR)}`);
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
 * locked" errors instead of waiting (reproduced at a 30-50% failure rate
 * with concurrent writers before this line existed).
 *
 * Schema versioning: busy_timeout is still set FIRST, then
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
  checkSchemaVersion(db, readUserVersion(db), dbPath);
  return db;
}
