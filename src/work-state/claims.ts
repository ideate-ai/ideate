// plugin/src/work-state/claims.ts — the claim engine: atomic CAS
// claim/renew/complete/release with fencing tokens (WI-301).
//
// Spec: docs/spikes/v3-work-delegation.md §3.2 ("Claim semantics — the heart
// of the contract"), AS AMENDED 2026-07-09 (cycle-6 findings C1/Q-34,
// S3/Q-36) AND F-301-001 (post-ship review: actor misattribution, fencing
// test gaps, unified error base, transition+event atomicity — see the fix
// notes on each function below). This module builds directly on the storage
// primitives WI-300 left OUT OF SCOPE on purpose (store.ts's own header):
// "Claim acquisition/renewal/completion semantics (compare-and-set, lease
// expiry, cycle detection) are OUT OF SCOPE — that is WI-301 (claim
// logic)... built on top of these primitives."
//
// Every entry point below follows the same three-step shape, in this exact
// order, ALL THREE now inside one `BEGIN IMMEDIATE ... COMMIT` unit on one
// connection (F-301-001 S3 — previously step 3 committed on a SEPARATE
// connection after step 2 had already committed and closed, so a crash
// between the two could leave a transition with no event):
//   1. `checkExpiry` (expiry.ts) — the lazy check, evaluated FIRST (§3.2
//      rule 2 amendment: "every verb touching an item first evaluates
//      expiry"). Safe to call unconditionally, even for an id that turns out
//      not to exist. Runs BEFORE the transaction below (it is its own
//      atomic unit, in expiry.ts).
//   2. The verb's own atomic compare-and-set — a SINGLE `UPDATE ... WHERE
//      ...` statement per verb, engine-level, never read-then-write in JS.
//      Each verb's WHERE clause is quoted in its doc comment below,
//      cross-referenced to the spec rule it implements.
//   3. `appendEventRowOn` (store.ts) — the immutable transition event (§3.3:
//      "every transition appends an immutable event"), attributed to the
//      claim's OWN holder (never a caller-supplied `actor` argument for
//      `complete`/`release` — F-301-001 C1, see their own doc comments),
//      appended and committed in the SAME transaction as step 2, only on
//      success. A thrown `ClaimEngineError` means the whole transaction
//      rolled back — the CAS itself did not happen, so there is nothing to
//      record (§3.2 rule 6 of this module's own contract: every failure mode
//      is typed and loud, never silent).
//
// Why direct SQL here rather than a new store.ts primitive: rule 1 requires
// the acquire CAS to be verifiably engine-level ("prove atomicity is
// engine-level, not JS-level"). `store.nextClaimToken` opens its own
// connection and commits before returning — composing it with a second
// `UPDATE ... SET status = ...` call would be exactly the read-then-write
// race this rule forbids. Every CAS here instead increments
// `claim_token_counter` and sets `claim_token` to the SAME new value inside
// ONE statement, using the identical counter column store.ts defined
// (schema.ts's `items.claim_token_counter`) — "the store's counter" per the
// acceptance criterion, just incremented via one round trip instead of two.
//
// Depends_on gating (rule 1, "succeeds iff... all depends_on are done"): the
// dependency check is embedded IN the claim CAS's own WHERE clause via a
// correlated `NOT EXISTS (SELECT ... FROM json_each(items.depends_on) ...)`
// subquery — no JS-side dependency walk, no separate read. `depends_on` is
// stored as a JSON array (schema.ts), and SQLite's JSON1 functions
// (`json_each`) are compiled into node:sqlite's bundled SQLite by default —
// verified directly against this runtime, not assumed.
//
// Fencing (rule 3, the Kleppmann delayed-writer test): `complete` and
// `release`'s WHERE clauses both require `claim_token = ?` in addition to
// `status = 'in_progress'`. A worker whose lease expired and was reclaimed
// holds a token that no longer matches the item's current `claim_token`
// (reclaiming always mints a strictly larger token via the same counter), so
// the UPDATE matches zero rows and the stale caller is rejected — the
// rejection is a structural consequence of the CAS, not a separate check.

import { openForWrite } from './schema.js';
import { checkExpiry, DEFAULT_LEASE_MS } from './expiry.js';
import type { Clock } from '../record/id.js';
import { runCompletionRecordHook } from './completion-record.js';
import type { CompletionRecordConfig } from './completion-record.js';
import { appendEventRowOn } from './store.js';
import type { WorkStateStore } from './store.js';
import { withWriteTransaction } from './tx.js';
import { WorkStateModuleError } from './types.js';
import type { ActorRef, WorkItem } from './types.js';

/** Typed failure classes for the claim engine (parallels types.ts's
 *  `WorkStateError` convention, but scoped to this module — WI-301's file
 *  scope does not extend to types.ts, so claim-specific failure modes that
 *  have no analogue in the store's own `WorkStateErrorCode` union get their
 *  own typed error family here rather than an unsafe cast into that union). */
export type ClaimEngineErrorCode =
  /** No item exists with the given id. */
  | 'NOT_FOUND'
  /** `claim`/`renew`: the lease_ms override is not a positive integer within
   *  the 30-day ceiling (F-CAPSTONE-10 S1/S2). */
  | 'INVALID_LEASE'
  /** `claim`: the item is not `open`, or not every `depends_on` item is
   *  `done` (§3.2 rule 1). */
  | 'NOT_CLAIMABLE'
  /** `renew`/`complete`/`release`: the item is not `in_progress`, or the
   *  supplied `claim_token` does not match the item's current token — the
   *  single rejection surface that covers BOTH a stale (reclaimed) token
   *  (§3.2 rule 3) and a renew arriving after expiry (§3.2 rule 2 amendment:
   *  the lazy check already flipped the item back to `open` by the time this
   *  verb's own CAS runs, so "not in_progress" and "post-expiry" are the
   *  same rejection). */
  | 'INVALID_CLAIM';

/** Typed, loud claim-engine failure — thrown, never silently swallowed
 *  (this module's own acceptance criterion: "every failure mode is a typed
 *  ...Error, never silent"). Extends `WorkStateModuleError` (F-301-001 S1)
 *  so callers can catch any work-state failure with one `instanceof` check;
 *  its own `name` and its own narrow `code` union are unchanged. */
export class ClaimEngineError extends WorkStateModuleError {
  override readonly name = 'ClaimEngineError';
  override readonly code: ClaimEngineErrorCode;

  constructor(code: ClaimEngineErrorCode, message: string) {
    super(code, message);
    this.code = code;
  }
}

/** Per-call lease override (defaults to `DEFAULT_LEASE_MS` from expiry.ts). */
export interface LeaseOptions {
  leaseMs?: number;
}

function requireItem(store: WorkStateStore, id: string, verb: string): WorkItem {
  const item = store.getItem(id);
  if (item === null) {
    throw new ClaimEngineError('NOT_FOUND', `work-state claim engine: ${verb}: no item with id ${JSON.stringify(id)}`);
  }
  return item;
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/** Upper bound for a lease override: 30 days. Anything longer is a caller
 *  bug (the contract's posture is 'hours, not seconds' — §3.2 rule 2 — and a
 *  month-long lease defeats orphan recovery entirely). F-CAPSTONE-10 S1/S2:
 *  an UNvalidated leaseMs crashed claim/renew with an untyped RangeError
 *  when oversized, and a non-positive value produced a claim born already
 *  expired whose own holder was then rejected with a misleading
 *  'reclaimed by another actor' diagnostic. */
export const MAX_LEASE_MS = 30 * 24 * 60 * 60 * 1000;

function validateLeaseMs(leaseMs: number): number {
  if (!Number.isInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
    throw new ClaimEngineError(
      'INVALID_LEASE',
      `lease_ms must be a positive integer of milliseconds no greater than ${String(MAX_LEASE_MS)} (30 days); got ${String(leaseMs)}`,
    );
  }
  return leaseMs;
}

/**
 * `claim(id, actor)` — §3.2 rule 1. Server-side compare-and-set: succeeds
 * iff `status == 'open'` AND every `depends_on` item is `done`. At most one
 * active claim per item, ever; `claim_token` is strictly monotonic per item
 * (the `claim_token_counter` column, incremented in the SAME statement as
 * the status transition — see file header).
 *
 * `checkExpiry` runs first (§3.2 rule 2 amendment) so that an item whose
 * prior lease has silently expired — but whose `status` column has not yet
 * been lazily flipped by any other caller — is revived to `open` before this
 * verb's own CAS is attempted, exactly as an untouched-but-expired claim
 * should be reclaimable.
 */
export function claim(
  store: WorkStateStore,
  clock: Clock,
  itemId: string,
  actor: ActorRef,
  opts?: LeaseOptions,
): WorkItem {
  checkExpiry(store, clock, itemId); // lazy check, evaluated FIRST — rule 2
  requireItem(store, itemId, 'claim'); // NOT_FOUND before attempting the CAS

  const leaseMs = opts?.leaseMs === undefined ? DEFAULT_LEASE_MS : validateLeaseMs(opts.leaseMs);
  const now = clock(); // single sample — acquired_at and lease_expires derive from the SAME instant
  const nowIso = now.toISOString();
  const leaseExpiresIso = new Date(now.getTime() + leaseMs).toISOString();

  const db = openForWrite(store.dbPath);
  let claimedToken: number | undefined;
  try {
    // F-301-001 S3: the CAS and its `claim` audit event now commit as ONE
    // atomic unit — a crash between "claim acquired" and "event appended"
    // can no longer leave a transition without its event (§3.3). WI-307:
    // the BEGIN IMMEDIATE/COMMIT/ROLLBACK boilerplate now lives in tx.ts's
    // `withWriteTransaction`, which also re-types an exhausted busy_timeout
    // as `WorkStateError('BUSY', ...)` — the CAS's own SQL text (and its
    // byte-for-byte structural test, claims.test.ts) is UNCHANGED.
    withWriteTransaction(db, (db) => {
      // The single atomic CAS (rule 1): status='open' AND the depends_on
      // frontier check are BOTH conditions of the same WHERE clause; the
      // counter increment and the status transition are the same statement.
      const row = db
        .prepare(
          // NOTE: this SQL literal's own internal indentation is preserved
          // BYTE-FOR-BYTE from before WI-307's refactor (not re-flowed to
          // the closure's new JS nesting depth) — claims.test.ts's own
          // structural test asserts on this exact text, clause by clause.
          `UPDATE items
         SET status = 'in_progress',
             claim_token_counter = claim_token_counter + 1,
             claim_token = claim_token_counter + 1,
             claim_holder_human = ?,
             claim_holder_agent = ?,
             claim_acquired_at = ?,
             claim_lease_expires = ?
         WHERE id = ?
           AND status = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM json_each(items.depends_on) je
             JOIN items dep ON dep.id = je.value
             WHERE dep.status != 'done'
           )
         RETURNING claim_token`,
        )
        .get(actor.human, actor.agent ?? null, nowIso, leaseExpiresIso, itemId) as
        | { claim_token: number | bigint }
        | undefined;
      if (row !== undefined) {
        claimedToken = toNumber(row.claim_token);
        appendEventRowOn(db, { item_id: itemId, actor, transition: 'claim', claim_token: claimedToken, at: nowIso }, () => nowIso);
      }
    });
  } finally {
    db.close();
  }

  if (claimedToken === undefined) {
    // Re-read for a precise, diagnostic-friendly message — never part of
    // the guard itself, which already ran (and failed) atomically above.
    // The write lock this attempt held is already released (rolled back),
    // so this is a fresh, independent read, not part of the CAS.
    // F-301-001 minor: no "item no longer exists" branch here — `requireItem`
    // already proved the row exists before this CAS ran, and nothing in this
    // module (or any sibling) ever deletes an `items` row, so that branch was
    // unreachable dead code, removed rather than kept as false defense.
    const current = requireItem(store, itemId, 'claim');
    const reason =
      current.status !== 'open' ? `status is ${JSON.stringify(current.status)}, not "open"` : 'not every depends_on item is "done"';
    throw new ClaimEngineError(
      'NOT_CLAIMABLE',
      `work-state claim engine: claim: item ${JSON.stringify(itemId)} is not claimable — ${reason} (§3.2 rule 1)`,
    );
  }

  return requireItem(store, itemId, 'claim');
}

/**
 * `renew(id, claim_token)` — §3.2 rule 2 amendment. Itself a compare-and-set:
 * succeeds iff `status == 'in_progress'` AND `claim_token` matches the
 * item's current token AND `now() < lease_expires`. A renew arriving after
 * expiry fails with the typed `INVALID_CLAIM` error — the claim is gone;
 * re-claim if the item is still open.
 */
export function renew(
  store: WorkStateStore,
  clock: Clock,
  itemId: string,
  claimToken: number,
  opts?: LeaseOptions,
): WorkItem {
  checkExpiry(store, clock, itemId); // lazy check, evaluated FIRST — rule 2
  requireItem(store, itemId, 'renew');

  const leaseMs = opts?.leaseMs === undefined ? DEFAULT_LEASE_MS : validateLeaseMs(opts.leaseMs);
  const now = clock(); // single sample — the renewal's timestamp and its new lease_expires derive from the SAME instant
  const nowIso = now.toISOString();
  const leaseExpiresIso = new Date(now.getTime() + leaseMs).toISOString();

  const db = openForWrite(store.dbPath);
  let renewedHolder: ActorRef | undefined;
  try {
    // F-301-001 S3 (atomicity) + C1 (actor derivation, mirrored from this
    // function's own pre-existing convention): the CAS and its `renew`
    // audit event now commit as ONE atomic unit; the event's actor is read
    // back off the SAME row the CAS just matched — `claim_holder_*` is
    // untouched by this UPDATE (only `claim_lease_expires` changes), so its
    // `RETURNING` value is exactly the current holder, read within this same
    // locked transaction. `renew(id, claim_token)` carries no actor
    // parameter in the contract's own signature (§3.5) — the token already
    // proves the caller is the current holder. WI-307: the transaction
    // boilerplate now lives in tx.ts's `withWriteTransaction`.
    withWriteTransaction(db, (db) => {
      const row = db
        .prepare(
          `UPDATE items
           SET claim_lease_expires = ?
           WHERE id = ?
             AND status = 'in_progress'
             AND claim_token = ?
             AND claim_lease_expires > ?
           RETURNING claim_token, claim_holder_human, claim_holder_agent`,
        )
        .get(leaseExpiresIso, itemId, claimToken, nowIso) as
        | { claim_token: number | bigint; claim_holder_human: string; claim_holder_agent: string | null }
        | undefined;
      if (row !== undefined) {
        renewedHolder =
          row.claim_holder_agent === null
            ? { human: row.claim_holder_human }
            : { human: row.claim_holder_human, agent: row.claim_holder_agent };
        appendEventRowOn(
          db,
          { item_id: itemId, actor: renewedHolder, transition: 'renew', claim_token: claimToken, at: nowIso },
          () => nowIso,
        );
      }
    });
  } finally {
    db.close();
  }

  if (renewedHolder === undefined) {
    throw new ClaimEngineError(
      'INVALID_CLAIM',
      `work-state claim engine: renew: item ${JSON.stringify(itemId)} is not held under token ${String(claimToken)} (expired, stale, or item not in_progress) — the claim is gone; re-claim if the item is still open (§3.2 rule 2)`,
    );
  }
  return requireItem(store, itemId, 'renew');
}

/**
 * `complete(id, claim_token, note?)` — §3.2 rule 3, amended 2026-07-09
 * (C1/Q-34). Succeeds only with the CURRENT token — a worker whose lease
 * expired and was reclaimed by someone else holds a stale token and is
 * rejected (the Kleppmann delayed-writer test): fencing falls out of the
 * CAS's own `claim_token = ?` condition, not a separate check.
 *
 * NO `actor` parameter (F-301-001 C1, fixed): the completion is always
 * attributed to the claim's OWN holder — read within the SAME locked
 * transaction as the CAS itself, never a caller-supplied argument. Before
 * this fix, any token holder (including a stale one, since this parameter
 * was accepted independently of the fencing check) could misattribute the
 * audit event to an arbitrary actor; accountability must resolve to the
 * actual holder (§3.1), not to whatever the caller claims. Because the
 * completing UPDATE itself clears `claim_holder_*` (so `RETURNING` would
 * yield the POST-image, i.e. already-NULL, holder), the holder is read via
 * a preliminary `SELECT` gated by the identical `status`/`claim_token`
 * predicate, inside the same `BEGIN IMMEDIATE` unit as the UPDATE — not a
 * separate, unguarded read.
 *
 * `note` is an optional free-text completion summary; when absent, the
 * event still records the transition (the structural fallback — extraction
 * from title/metadata is a caller-side concern, not this module's).
 *
 * `completionRecord` (WI-306, optional): when a transport supplies it, this
 * function's own post-commit hook (completion-record.ts's
 * `runCompletionRecordHook`) fires AFTER the CAS + event above have already
 * committed — GP-21's ordering requirement (board = state authority, record
 * = capture). A record-write failure of any kind never un-completes the
 * claim and never escapes this function: it is loud (stderr) and counted
 * (`capture_write_failed`, point 'work-completion'), never re-thrown. Absent
 * `completionRecord` (most of this module's own unit tests, and any other
 * direct caller with no transport context to inject), no record is
 * attempted — there is no project root to resolve one from.
 */
export function complete(
  store: WorkStateStore,
  clock: Clock,
  itemId: string,
  claimToken: number,
  note?: string,
  completionRecord?: CompletionRecordConfig,
): WorkItem {
  checkExpiry(store, clock, itemId); // lazy check, evaluated FIRST — rule 2
  requireItem(store, itemId, 'complete');

  const nowIso = clock().toISOString();
  const db = openForWrite(store.dbPath);
  let completedBy: ActorRef | undefined;
  try {
    // F-301-001 S3: the CAS and its `complete` audit event commit as ONE
    // atomic unit. WI-307: the transaction boilerplate now lives in tx.ts's
    // `withWriteTransaction` — see this function's own doc comment for why
    // the WI-306 completion-record hook below still fires strictly AFTER
    // this call returns (i.e. after commit), unchanged.
    withWriteTransaction(db, (db) => {
      const pre = db
        .prepare(
          `SELECT claim_holder_human, claim_holder_agent FROM items
           WHERE id = ? AND status = 'in_progress' AND claim_token = ?`,
        )
        .get(itemId, claimToken) as { claim_holder_human: string; claim_holder_agent: string | null } | undefined;
      if (pre === undefined) {
        return;
      }
      const holder: ActorRef =
        pre.claim_holder_agent === null ? { human: pre.claim_holder_human } : { human: pre.claim_holder_human, agent: pre.claim_holder_agent };
      const row = db
        .prepare(
          `UPDATE items
           SET status = 'done',
               claim_holder_human = NULL,
               claim_holder_agent = NULL,
               claim_token = NULL,
               claim_acquired_at = NULL,
               claim_lease_expires = NULL
           WHERE id = ?
             AND status = 'in_progress'
             AND claim_token = ?
           RETURNING id`,
        )
        .get(itemId, claimToken) as { id: string } | undefined;
      if (row === undefined) {
        // Unreachable while the write lock held by this same transaction
        // covers both the pre-read and this UPDATE — kept as a loud guard,
        // not assumed.
        return;
      }
      completedBy = holder;
      appendEventRowOn(
        db,
        {
          item_id: itemId,
          actor: holder,
          transition: 'complete',
          claim_token: claimToken,
          ...(note === undefined ? {} : { note }),
          at: nowIso,
        },
        () => nowIso,
      );
    });
  } finally {
    db.close();
  }

  if (completedBy === undefined) {
    throw new ClaimEngineError(
      'INVALID_CLAIM',
      `work-state claim engine: complete: item ${JSON.stringify(itemId)} is not held under token ${String(claimToken)} (stale token — reclaimed by another actor, or item not in_progress) (§3.2 rule 3)`,
    );
  }
  const completedItem = requireItem(store, itemId, 'complete');

  // WI-306: the completion-record post-commit hook — strictly AFTER the CAS
  // + event above have already committed (this line runs after the `db`
  // opened for this call was closed, and after a fresh, independent read of
  // the now-`done` item). See this function's own doc comment and
  // completion-record.ts's file header for the full ordering/failure
  // contract. Fires only when a transport supplied its dependencies.
  if (completionRecord !== undefined) {
    runCompletionRecordHook(
      {
        item: completedItem,
        note,
        completedBy,
        claimToken,
        completedAt: nowIso,
        sessionId: completionRecord.sessionId,
      },
      completionRecord,
      clock,
    );
  }

  return completedItem;
}

/**
 * `release(id, claim_token, note?)` — §3.2 rule 4. Token-checked; returns
 * the item to `open` with a free-text handoff note appended to the event
 * log. `note` is optional (mirroring `complete`'s C1/Q-34 amendment) — the
 * spec's "with a free-text handoff note appended" describes the common case,
 * not a hard requirement; an absent note still records the transition.
 *
 * NO `actor` parameter (F-301-001 C1, fixed — mirrors `complete`'s own fix):
 * the release is always attributed to the claim's OWN holder, read within
 * the SAME locked transaction as the CAS, never a caller-supplied argument —
 * the same misattribution risk `complete` had (any token holder could
 * otherwise name an arbitrary actor) applies identically here.
 */
export function release(store: WorkStateStore, clock: Clock, itemId: string, claimToken: number, note?: string): WorkItem {
  checkExpiry(store, clock, itemId); // lazy check, evaluated FIRST — rule 2
  requireItem(store, itemId, 'release');

  const nowIso = clock().toISOString();
  const db = openForWrite(store.dbPath);
  let releasedBy: ActorRef | undefined;
  try {
    // F-301-001 S3: the CAS and its `release` audit event commit as ONE
    // atomic unit. WI-307: the transaction boilerplate now lives in tx.ts's
    // `withWriteTransaction`.
    withWriteTransaction(db, (db) => {
      const pre = db
        .prepare(
          `SELECT claim_holder_human, claim_holder_agent FROM items
           WHERE id = ? AND status = 'in_progress' AND claim_token = ?`,
        )
        .get(itemId, claimToken) as { claim_holder_human: string; claim_holder_agent: string | null } | undefined;
      if (pre === undefined) {
        return;
      }
      const holder: ActorRef =
        pre.claim_holder_agent === null ? { human: pre.claim_holder_human } : { human: pre.claim_holder_human, agent: pre.claim_holder_agent };
      const row = db
        .prepare(
          `UPDATE items
           SET status = 'open',
               claim_holder_human = NULL,
               claim_holder_agent = NULL,
               claim_token = NULL,
               claim_acquired_at = NULL,
               claim_lease_expires = NULL
           WHERE id = ?
             AND status = 'in_progress'
             AND claim_token = ?
           RETURNING id`,
        )
        .get(itemId, claimToken) as { id: string } | undefined;
      if (row === undefined) {
        // Unreachable while the write lock held by this same transaction
        // covers both the pre-read and this UPDATE — kept as a loud guard,
        // not assumed.
        return;
      }
      releasedBy = holder;
      appendEventRowOn(
        db,
        {
          item_id: itemId,
          actor: holder,
          transition: 'release',
          claim_token: claimToken,
          ...(note === undefined ? {} : { note }),
          at: nowIso,
        },
        () => nowIso,
      );
    });
  } finally {
    db.close();
  }

  if (releasedBy === undefined) {
    throw new ClaimEngineError(
      'INVALID_CLAIM',
      `work-state claim engine: release: item ${JSON.stringify(itemId)} is not held under token ${String(claimToken)} (stale token, or item not in_progress) (§3.2 rule 4)`,
    );
  }
  return requireItem(store, itemId, 'release');
}

// `DEFAULT_LEASE_MS` is defined in expiry.ts (the module that owns the
// hybrid-expiry mechanism, §3.2 rule 2) — re-exported here so callers of
// this module's `LeaseOptions` have one source of truth for the default
// lease length, "hours not seconds" (§3.2), without importing expiry.ts
// directly.
export { DEFAULT_LEASE_MS } from './expiry.js';
