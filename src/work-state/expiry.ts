// plugin/src/work-state/expiry.ts — hybrid lease-expiry mechanism.
//
// Expiry enforcement is a hybrid, specified explicitly: (a) lazy check —
// every verb touching an item first evaluates expiry and, if expired,
// atomically transitions the item to `open`, voids the token, and appends the
// orphan-recovery event. Correct by construction; no daemon. Plus (b)
// opportunistic sweep at session boundaries — the host session-start/end
// hooks may trigger a board-wide expiry pass — which bounds the
// orphan-recovery promise.
//
// This module owns BOTH halves of the hybrid:
// - `checkExpiry` — the lazy check (a). claims.ts's every entry point
//   (claim/renew/complete/release) calls this FIRST, before its own
//   compare-and-set ("evaluated FIRST").
// - `sweepBoard` — the opportunistic sweep (b), the session-boundary entry
//   point the hooks call. It walks every `in_progress` item and applies the
//   SAME lazy check via `checkExpiry` — one mechanism, two call sites (the
//   same lazy check).
//
// `DEFAULT_LEASE_MS`: "hours, not seconds — ICs are humans" (see the
// `Claim.lease_expires` field comment). A constant default, overridable
// per-call (claims.ts threads a `leaseMs` option through to `claim`/`renew`)
// — so tests can use short leases without sleeping (see the injectable-clock
// note below).
//
// Clock discipline (repo convention — record/id.ts, telemetry/counters.ts):
// wall-clock `Date.now()` belongs only at the outermost edge (the CLI/hook
// entry point that constructs a `WorkStateStore`); every function here takes
// an injected `Clock` and never reads the system clock directly. This is
// what lets expiry.test.ts exercise "lease expired" by advancing a fake
// clock rather than sleeping.
//
// Atomicity (mirrors claims.ts's claim-CAS discipline): the state-mutating
// step — flipping `in_progress` -> `open` and voiding the token — is ONE
// `UPDATE ... WHERE ...` statement whose WHERE clause re-validates
// `status = 'in_progress' AND claim_token = ? AND claim_lease_expires <= ?`
// at execution time. A preliminary SELECT reads the about-to-expire claim's
// holder/token purely to enrich the orphan-recovery event; it is not part of
// the guard. Because no verb in this contract ever deletes an item row (the
// state machine only transitions status), and because the claim rule
// guarantees at most one active claim per item ever, re-validating the same
// predicates in the UPDATE's WHERE clause is exactly as safe as a single
// round trip: if the row changed between the SELECT and the UPDATE (renewed
// just in time, or already expired-and-recovered by a concurrent sweep —
// engine-level concurrency is a stated requirement, not an accident), the
// UPDATE simply matches zero rows and this function reports `expired: false`
// — no double-recovery, no stale event.

import { openForWrite } from './schema.js';
import type { Clock } from '../record/id.js';
import { appendEventRowOn } from './store.js';
import type { WorkStateStore } from './store.js';
import { withWriteTransaction } from './tx.js';
import type { ActorRef } from './types.js';

/** Default lease length: 4 hours — "hours, not seconds". Config-
 *  parameterized (the right value needs measurement to tune); every claims.ts
 *  entry point accepts an override for exactly that reason, and so tests never
 *  need to wait out a real lease. */
export const DEFAULT_LEASE_MS = 4 * 60 * 60 * 1000;

/** Result of one `checkExpiry` call. */
export interface ExpiryCheckResult {
  /** Whether this call found and recovered an expired lease. */
  expired: boolean;
  /** The fencing token that was voided — present iff `expired` is true. */
  voidedToken?: number;
  /** The actor whose lease expired — present iff `expired` is true. */
  formerHolder?: ActorRef;
}

interface PreReadRow {
  status: string;
  claim_token: number | bigint | null;
  claim_holder_human: string | null;
  claim_holder_agent: string | null;
  claim_lease_expires: string | null;
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * The lazy expiry check (hybrid part (a)). Evaluated FIRST by
 * every claims.ts entry point, and by `sweepBoard` for every `in_progress`
 * item on the board. A no-op (returns `{ expired: false }`) for an item that
 * does not exist, is not `in_progress`, or whose lease has not yet passed —
 * safe to call unconditionally, on any id, from anywhere.
 *
 * On an actually-expired lease: atomically (single UPDATE, re-validated
 * WHERE clause — see file header) transitions the item to `open`, clears
 * every claim field (voiding the token), and appends the immutable
 * orphan-recovery event via the store's `appendEvent` — attributed to the
 * former holder, since it is THEIR claim that lapsed.
 */
export function checkExpiry(store: WorkStateStore, clock: Clock, itemId: string): ExpiryCheckResult {
  const nowIso = clock().toISOString(); // single sample for this whole call — the guard and the logged event agree on "now"
  const db = openForWrite(store.dbPath);
  let result: ExpiryCheckResult = { expired: false };
  try {
    // The reclaim (UPDATE) and its orphan-recovery event commit as ONE atomic
    // unit — otherwise the event could be appended via `store.appendEvent` on
    // a SEPARATE connection after this one had already committed and closed,
    // so a crash in that window could leave a reclaimed item with no
    // orphan-recovery event, violating the "every transition appends an
    // immutable event" invariant. The write lock also closes the same
    // read-then-write race the file header already documents for the
    // SELECT/UPDATE pair. The BEGIN IMMEDIATE/COMMIT/ROLLBACK boilerplate
    // lives in tx.ts's `withWriteTransaction`, which also re-types an
    // exhausted busy_timeout as `WorkStateError('BUSY', ...)` instead of
    // letting a raw node:sqlite lock error escape — this call is the FIRST
    // thing every claims.ts entry point runs, so it is the most common place
    // that failure would otherwise have surfaced unwrapped.
    withWriteTransaction(db, (db) => {
      const pre = db
        .prepare(
          'SELECT status, claim_token, claim_holder_human, claim_holder_agent, claim_lease_expires FROM items WHERE id = ?',
        )
        .get(itemId) as PreReadRow | undefined;
      if (pre === undefined || pre.status !== 'in_progress' || pre.claim_lease_expires === null) {
        return;
      }
      if (!(pre.claim_lease_expires <= nowIso)) {
        return; // ISO-8601 timestamps compare lexicographically
      }
      const changed = db
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
             AND claim_token IS ?
             AND claim_lease_expires <= ?`,
        )
        .run(itemId, pre.claim_token, nowIso);
      if (changed.changes === 0) {
        // Lost the race to a concurrent recovery/renewal between the SELECT
        // and this UPDATE — not our event to log; whoever won already handled
        // (or extended) this claim.
        return;
      }

      const voidedToken = pre.claim_token === null ? undefined : toNumber(pre.claim_token);
      const formerHolder: ActorRef | undefined =
        pre.claim_holder_human === null
          ? undefined
          : pre.claim_holder_agent === null
            ? { human: pre.claim_holder_human }
            : { human: pre.claim_holder_human, agent: pre.claim_holder_agent };

      if (formerHolder !== undefined) {
        appendEventRowOn(
          db,
          {
            item_id: itemId,
            actor: formerHolder,
            transition: 'orphan-recovery',
            ...(voidedToken === undefined ? {} : { claim_token: voidedToken }),
            note: `lease expired at ${pre.claim_lease_expires ?? ''}; item auto-reopened by the lazy expiry check`,
            at: nowIso,
          },
          () => nowIso,
        );
      }

      result = {
        expired: true,
        ...(voidedToken === undefined ? {} : { voidedToken }),
        ...(formerHolder === undefined ? {} : { formerHolder }),
      };
    });
    return result;
  } finally {
    db.close();
  }
}

/**
 * The opportunistic sweep (hybrid part (b)) — the host session-start/end
 * hooks may trigger a board-wide expiry pass. This is the session-boundary
 * entry point the hooks call; it walks every `in_progress` item and applies
 * the exact same lazy check `checkExpiry` uses per-verb, so there is exactly
 * one expiry-transition implementation in this module, exercised from two
 * call sites.
 *
 * Optionally scoped to one tenant (a hosted-mode board sweep should not
 * touch other tenants' claims — TenantGuard posture).
 */
export function sweepBoard(
  store: WorkStateStore,
  clock: Clock,
  filter?: { tenant_id?: string },
): ExpiryCheckResult[] {
  const inProgress = store.listItems({
    status: 'in_progress',
    ...(filter?.tenant_id === undefined ? {} : { tenant_id: filter.tenant_id }),
  });
  return inProgress.map((item) => checkExpiry(store, clock, item.id));
}
