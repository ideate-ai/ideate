// plugin/src/work-state/verbs.ts — the seven non-claim board verbs.
//
// Covers cycle rejection, the status model + transitions, and the verb
// surface (eleven verbs total; this file owns the seven that are NOT
// claim/renew/release/complete): `create`, `get`, `list(filter)`,
// `update_meta(version)`, `cancel`, `reopen`, `events(item)`. Claim-lifecycle
// verbs (claim/renew/release/complete) are claims.ts's scope, built in a
// sibling file — this file never touches them.
//
// Built on top of the store.ts storage primitives: insertItem, getItem,
// listItems, updateMeta (metadata only — status/claim untouched), appendEvent.
//
// TWO shapes of the SAME `list` verb (one selection, one claimability rule):
// `list(filter)` returns every matching item at full fidelity (spec bodies
// included) and is what internal TypeScript callers use; `listSummaries(filter,
// page)` returns the projected, keyset-paged view the agent-facing transports
// call. Neither is a different SELECTION and neither ranks anything (GP-27) —
// and both compute `claimable` through the one gate below, so a page boundary
// can never change an item's claimability.
// Two things store.ts deliberately does NOT provide, which this file supplies
// itself:
//
//   1. depends_on cycle/dangling-reference rejection (dag.ts) — a write-time
//      DFS run before create/update_meta ever reach the store. Its sibling:
//      the dangling-supersedes guard (existence only, no cycle check) over
//      the typed `references` forward edge, also dag.ts, also pre-write.
//   2. status transitions for cancel/reopen. store.ts's `updateMeta` is
//      metadata-only by contract (see its own doc comment: "status/claim
//      transitions are NOT metadata edits"), and it has no companion
//      status-transition primitive. cancel/reopen therefore talk to the
//      `items` table's `status` and `claim_*` columns directly through
//      schema.ts's exported `openForWrite` — the same columns store.ts owns,
//      opened the same way store.ts opens them. This is NOT a layering
//      violation of the sibling boundary: claims.ts and expiry.ts are never
//      imported here, and this file never reaches into THEIR code — only into
//      the shared `items` table columns (coordinate ONLY through the store's
//      columns, not the sibling's files).
//
// THE LAZY-EXPIRY SEAM: every verb that touches one item is, per the full
// contract, supposed to first evaluate whether that item's active claim has
// expired and, if so, atomically reclaim it (transition to `open`, void the
// token, append the orphan-recovery event) before the verb's own logic runs.
// That check's real implementation lives in claims.ts + expiry.ts. This
// module does not implement or import it. Instead, every verb below that
// operates on a single item id accepts an injectable `ExpiryCheck` hook,
// called FIRST, before any other logic — defaulting to `noopExpiryCheck`, a
// true no-op. The hook wiring supplies the real expiry check as this
// parameter. `create` and `list` have no single-item `ExpiryCheck` call:
// `create` operates on an item that does not exist yet, and `list` is a
// many-item selection view (see its own doc comment for why it does not sweep
// expiry itself — and for the DIFFERENT, board-wide sweep its transports now
// run instead, decision 01KYX9BGM9N9FGXQDMESN94FX1).
//
// Opacity: no code path in this file parses, masks,
// or transforms `spec` — every verb here that touches metadata inspects only
// `depends_on` (structured contract data, not the opaque payload) and passes
// `spec`/`spec_format` straight through to the store untouched.

import type { Clock } from '../record/id.js';
import { openForWrite } from './schema.js';
import { appendEventRowOn } from './store.js';
import type {
  ListItemsFilter,
  ListItemsPage,
  ListPageOptions,
  WorkItemSummaryView,
  WorkItemView,
  WorkStateStore,
} from './store.js';
import { withWriteTransaction } from './tx.js';
import { WorkStateError, WorkStateModuleError } from './types.js';
import type { ActorRef, UpdateMetaInput, WorkItem, WorkItemReference, WorkItemStatus, WorkStateEvent } from './types.js';
import { assertDependenciesExist, assertNoCycle, assertNoParentCycle, assertParentExists, assertSupersedesTargetsExist } from './dag.js';
import type { UnresolvedId } from '../transport/id-lint.js';
import type { DependsOnLookup, ParentLookup } from './dag.js';

/**
 * The lazy-expiry seam. `itemId` is the item about to be touched; the hook
 * runs BEFORE the verb's own read/write logic. The real implementation
 * (claims.ts + expiry.ts) evaluates the item's active claim's `lease_expires`
 * and,
 * if expired, atomically reclaims it. The default here is a genuine no-op —
 * this file is fully usable and independently testable before that wiring
 * lands.
 */
export type ExpiryCheck = (itemId: string) => void;

/** The default, real no-op `ExpiryCheck` — does nothing. */
export const noopExpiryCheck: ExpiryCheck = () => {
  // Intentional no-op — see the file header's "lazy-expiry seam" note.
};

/** Typed failure codes raised by this module's own transition guards
 *  (distinct from `WorkStateErrorCode`, which is store.ts's persistence-
 *  layer contract). `NOT_FOUND`
 *  and `VERSION_CONFLICT` failures from the store layer propagate as
 *  `WorkStateError` unchanged — this type only covers failures this file
 *  itself detects. */
export type VerbErrorCode = 'INVALID_TRANSITION';

/** Typed, loud verb-layer failure — thrown, never silently swallowed.
 *  Extends `WorkStateModuleError` so callers can catch any
 *  work-state failure with one `instanceof` check; its own `name` and its
 *  own narrow `code` union are unchanged. */
export class VerbError extends WorkStateModuleError {
  override readonly name = 'VerbError';
  override readonly code: VerbErrorCode;

  constructor(code: VerbErrorCode, message: string) {
    super(code, message);
    this.code = code;
  }
}

/**
 * A listed work item with the DERIVED claimability view attached.
 * `claimable` is never stored (see types.ts/schema.ts: there is no column
 * and no status-enum member for the concept this field names) — it is
 * computed fresh on every `list()` call from live `depends_on` statuses, so
 * it can never drift out of sync with the graph. `referenced_by` is likewise
 * derived, never stored: the reverse of the typed forward-reference edge
 * (supersedes primary), attached by store.ts's listItemViews so a superseded
 * item surfaces its replacement on every list read.
 */
export interface ListedWorkItem extends WorkItem {
  /** True iff `status === 'open'` AND every id in `depends_on` currently has
   *  status `'done'` AND the item has no PENDING containment child (see
   *  below). The depends_on half is DIRECT-ONLY — checking one level of
   *  `depends_on` — deliberately matching `claim()`'s own CAS gate in
   *  claims.ts (`NOT EXISTS (... WHERE dep.status != 'done')`, also
   *  direct-only). It is NOT "transitivity for free": the tempting
   *  claim that a dependency's own `done` status could only have been reached
   *  after ITS dependencies were satisfied is FALSE under `reopen` — the
   *  status model lets a `done` item go back to `open` at any
   *  time, which can silently invalidate a grandparent's satisfied-frontier
   *  assumption without ever touching the grandparent's own `depends_on`
   *  list). Both surfaces stay consistent with each other, and with what
   *  `reopen` can do to the graph, by both being direct-only rather than by
   *  one of them papering over the gap with a walk the other doesn't do.
   *
   *  The CONTAINMENT half is a second, orthogonal gate: a parent is a
   *  roll-up, not a work unit, so an item with ANY direct child (an item
   *  whose `parent_id` is this item's id) whose status is `open` or
   *  `in_progress` is NOT claimable — it becomes claimable once every child
   *  is resolved. A `done` OR `cancelled` child is resolved and does not
   *  block. NOTE the deliberate divergence from the depends_on convention,
   *  where only `'done'` resolves the edge (a cancelled dependency still
   *  blocks): a cancelled dependency is an unmet prerequisite the item
   *  cannot proceed without, while a cancelled child is deliberately-dropped
   *  scope — the roll-up is complete without it. Containment blocking is
   *  likewise DIRECT-ONLY (children, not descendants) and derived fresh on
   *  every call, never stored. Items in any other status report `false` —
   *  they are simply not in the one state where this concept applies. */
  claimable: boolean;
  /** The DERIVED reverse edges: `referenced_by[i]` means "item `id` points
   *  at this one with `rel`" — a `supersedes` forward edge surfaces here as
   *  the backlink announcing this item's replacement. */
  referenced_by: WorkItemReference[];
}

/**
 * The SUMMARY twin of {@link ListedWorkItem}: the same two derived views
 * (`claimable`, `referenced_by`) attached to a projected row — every current
 * item field EXCEPT the opaque `spec` body, plus `spec_length` (store.ts).
 * `spec` reappears only when the caller opts in.
 *
 * `claimable` here is IDENTICAL to the value the unpaginated
 * {@link WorkStateVerbs.list} would report for the same item, by construction:
 * both go through this file's ONE claimability gate, which consults the FULL
 * board — not the page — for both halves. A page boundary is a selection
 * window, never a semantic one.
 */
export interface ListedWorkItemSummary extends WorkItemSummaryView {
  claimable: boolean;
}

/** A synthetic id that can never collide with a real ULID (ULIDs are 26
 *  uppercase Crockford-base32 characters — see record/id.ts): `#` and the
 *  lowercase letters are all outside that alphabet. The delimiters must
 *  stay printable non-NUL bytes — an earlier `\x00`-delimited version made
 *  git/grep treat this whole file as binary. Stands in for
 *  a not-yet-assigned id when running the cycle guard against a `create`
 *  payload. See `create()`'s own doc comment for why the check still runs
 *  even though a brand-new item cannot structurally be part of an existing
 *  cycle. */
const CREATE_CYCLE_SENTINEL = '#create-sentinel#';

/** Best-effort extraction of a `depends_on` array from an otherwise-`unknown`
 *  create/update_meta payload, for this file's OWN pre-write DAG checks
 *  only. Returns `undefined` whenever the shape is not a clean string array
 *  — in that case this file's checks are simply skipped, and the store's own
 *  (authoritative) field validation raises the appropriate typed error when
 *  the payload reaches it. This function never inspects `spec` or any other
 *  field. */
function peekDependsOn(input: unknown): string[] | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = (input as Record<string, unknown>)['depends_on'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return undefined;
  return raw as string[];
}

/** Best-effort extraction of a TRI-STATE `parent_id` from an otherwise-
 *  `unknown` create/update_meta payload, for this file's OWN pre-write parent
 *  guards only. Distinguishes "key absent" (`present: false` — leave
 *  unchanged / create as root, no guard) from "key present" (`present: true`,
 *  with `value` being the parent id, or `null` for clear-to-root). A malformed
 *  value (present but neither string nor null) is reported as absent so the
 *  store's own authoritative validation raises the typed error when the
 *  payload reaches it — this function never inspects `spec` or `depends_on`. */
function peekParentId(input: unknown): { present: boolean; value: string | null } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { present: false, value: null };
  const raw = input as Record<string, unknown>;
  if (!('parent_id' in raw)) return { present: false, value: null };
  const v = raw['parent_id'];
  if (v === undefined) return { present: false, value: null };
  if (v === null) return { present: true, value: null };
  if (typeof v === 'string') return { present: true, value: v };
  return { present: false, value: null };
}

/** Best-effort extraction of a `references` edge list from an otherwise-
 *  `unknown` create/update_meta payload, for this file's OWN pre-write
 *  dangling-supersedes guard only. Returns `undefined` whenever the key is
 *  absent (no edge edit — no guard) OR the shape is not a clean `{rel, id}`
 *  list — in that case this file's check is simply skipped, and the store's
 *  own (authoritative) field validation raises the appropriate typed error
 *  when the payload reaches it. Mirrors `peekDependsOn`'s contract exactly;
 *  never inspects `spec`. */
function peekReferences(input: unknown): WorkItemReference[] | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = (input as Record<string, unknown>)['references'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const refs: WorkItemReference[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const ref = item as Record<string, unknown>;
    if (typeof ref['rel'] !== 'string' || typeof ref['id'] !== 'string') return undefined;
    refs.push({ rel: ref['rel'], id: ref['id'] });
  }
  return refs;
}

/** Result of a direct status transition against the `items` table. */
interface TransitionResult {
  ok: boolean;
  /** The item's status at the moment of the attempt, or `null` if no item
   *  with that id exists. Populated on both success and failure. */
  observedStatus: WorkItemStatus | null;
  /** The claim token that was active immediately before this transition, if
   *  any — populated only when `voidClaim` was requested and a claim was in
   *  fact cleared. */
  voidedClaimToken: number | null;
}

function toClaimTokenNumber(value: number | bigint | null): number | null {
  if (value === null) return null;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** Builds the audit-event payload for a successful transition, given the
 *  claim token that was just voided (if any). Passed to `appendEventRowOn`
 *  unchanged — validated there, same as every other event append. */
type TransitionEventBuilder = (voidedClaimToken: number | null) => unknown;

/**
 * Attempt an atomic `status` transition on one item: `UPDATE ... WHERE id = ?
 * AND status IN (allowedFrom)`. This is the compare-and-set this file needs
 * that store.ts's `updateMeta` does not provide (metadata-only by contract —
 * see this file's header). When `voidClaim` is true, the five `claim_*`
 * columns are cleared in the SAME statement — this is how `cancel` voids an
 * active claim on an `in_progress` item: one atomic write,
 * touching only the shared `items` table columns store.ts itself owns, never
 * anything from the sibling claims.ts/expiry.ts files.
 *
 * `buildEvent` is called (and its event appended via `appendEventRowOn`,
 * store.ts) INSIDE this same `BEGIN IMMEDIATE ... COMMIT` unit, only on the
 * success path, before the commit: the transition and its audit event commit
 * as one atomic write, or neither does. Otherwise `cancel`/`reopen` would call
 * `store.appendEvent` on a SEPARATE connection after this function had already
 * committed and closed — a crash in that window would leave a transition with
 * no event, violating the "every transition appends an immutable event"
 * invariant.
 */
function transitionStatus(
  dbPath: string,
  id: string,
  allowedFrom: readonly WorkItemStatus[],
  to: WorkItemStatus,
  now: string,
  voidClaim: boolean,
  buildEvent: TransitionEventBuilder,
): TransitionResult {
  const db = openForWrite(dbPath);
  let result: TransitionResult = { ok: false, observedStatus: null, voidedClaimToken: null };
  try {
    // A naive SELECT-check-then-UPDATE shape would be a TOCTOU race — it can
    // let cancel() clobber a concurrent legitimate complete(), forcing an
    // illegal done→cancelled transition. Two properties are needed atomically:
    // (a) the transition only happens from an allowed status, and (b) the
    // PRE-image claim_token is captured for the audit event
    // (UPDATE...RETURNING yields the post-image, so a single statement cannot
    // both void the token and report it). BEGIN IMMEDIATE takes the write lock
    // up front, making the read+write pair a single atomic unit against every
    // other connection; the status predicate stays in the UPDATE's WHERE
    // clause as well, so even a same-connection interleaving bug could not
    // write from a disallowed state. The BEGIN IMMEDIATE/COMMIT/ROLLBACK
    // boilerplate lives in tx.ts's `withWriteTransaction`, which also re-types
    // an exhausted busy_timeout as `WorkStateError('BUSY', ...)` instead of
    // letting a raw node:sqlite lock error escape.
    withWriteTransaction(db, (db) => {
      const before = db.prepare('SELECT status, claim_token FROM items WHERE id = ?').get(id) as
        | { status: string; claim_token: number | bigint | null }
        | undefined;
      if (before === undefined) {
        result = { ok: false, observedStatus: null, voidedClaimToken: null };
        return;
      }
      const observedStatus = before.status as WorkItemStatus;
      if (!allowedFrom.includes(observedStatus)) {
        result = { ok: false, observedStatus, voidedClaimToken: null };
        return;
      }
      const voidedClaimToken = voidClaim ? toClaimTokenNumber(before.claim_token) : null;
      const placeholders = allowedFrom.map(() => '?').join(', ');
      const claimCols = voidClaim
        ? `, claim_holder_human = NULL, claim_holder_agent = NULL,
             claim_token = NULL, claim_acquired_at = NULL, claim_lease_expires = NULL`
        : '';
      const updateResult = db
        .prepare(
          `UPDATE items SET status = ?, updated_at = ?${claimCols}
           WHERE id = ? AND status IN (${placeholders})`,
        )
        .run(to, now, id, ...allowedFrom);
      if (updateResult.changes !== 1) {
        // Unreachable while the write lock is held — kept as a loud guard.
        result = { ok: false, observedStatus, voidedClaimToken: null };
        return;
      }
      // Same transaction, same connection — commits with the transition above
      // or not at all.
      appendEventRowOn(db, buildEvent(voidedClaimToken), () => now);
      result = { ok: true, observedStatus, voidedClaimToken };
    });
    return result;
  } finally {
    db.close();
  }
}

/**
 * The board's seven non-claim verbs, built on one `WorkStateStore`.
 * One instance per (session, database) — mirrors `WorkStateStore` itself;
 * construct with the SAME clock instance a co-located `WorkStateStore` (and,
 * eventually, the sibling claim verbs) use, so timestamps stay coherent
 * across the whole board.
 */
export class WorkStateVerbs {
  readonly #store: WorkStateStore;
  readonly #clock: Clock;

  constructor(store: WorkStateStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  #lookup(): DependsOnLookup {
    return (id: string) => this.#store.getItem(id)?.depends_on;
  }

  /** The `parent_id` resolver backing the containment guards: a
   *  missing item maps to `undefined`, a present item's `parent_id`
   *  (`string | null`) passes straight through. Kept SEPARATE from
   *  {@link #lookup} — the two guards walk two orthogonal edges. */
  #parentLookup(): ParentLookup {
    return (id: string) => {
      const item = this.#store.getItem(id);
      return item === null ? undefined : item.parent_id;
    };
  }

  /**
   * Create a new work item. Rejects (typed, `DagError`) a `depends_on` list
   * that references a nonexistent item, or one whose depends_on graph would
   * be cyclic. A brand-new item's id is server-issued by the store AFTER
   * this check runs, so nothing in the CURRENT graph can already reference
   * it — a genuine cycle is structurally impossible at create time. The
   * cycle guard still runs here (against `CREATE_CYCLE_SENTINEL` standing in
   * for the not-yet-assigned id) for two reasons: symmetry with
   * `updateMeta` (one code path, one behavior, easier to reason about and to
   * test), and genuine defense-in-depth — `assertNoCycle`'s DFS is general
   * (see its own doc comment), so it still catches and names a pre-existing
   * cycle among the REFERENCED items, should that invariant ever be broken
   * upstream, even though `itemId` itself can never be part of it here.
   *
   * `onUnresolvedIds` (optional, correction 01KYV387QKRP3V330WAS6DX95K
   * FINDING 1): threaded straight through to `store.insertItem`'s own
   * callback of the same name — see that method's doc comment. The return
   * type here stays `WorkItem`, unchanged, so every existing caller keeps
   * compiling.
   */
  create(input: unknown, onUnresolvedIds?: (ids: readonly UnresolvedId[]) => void): WorkItem {
    const dependsOn = peekDependsOn(input) ?? [];
    if (dependsOn.length > 0) {
      const lookup = this.#lookup();
      assertDependenciesExist(dependsOn, lookup);
      assertNoCycle(CREATE_CYCLE_SENTINEL, dependsOn, lookup);
    }
    // Containment guards, symmetric with the depends_on path above and
    // fully orthogonal to it — this branch never reads `depends_on`, and the
    // one above never reads `parent_id`. A present-and-non-null parent is
    // existence-checked, then cycle-checked against the sentinel id (a
    // brand-new item cannot yet be referenced, so a genuine self-cycle is
    // structurally impossible here — the check runs for symmetry with
    // updateMeta and for defense-in-depth against a pre-existing corrupt
    // ancestor chain, exactly as the depends_on path does). A present-null
    // parent (create-as-root) needs no guard.
    const parent = peekParentId(input);
    if (parent.present && parent.value !== null) {
      const parentLookup = this.#parentLookup();
      assertParentExists(parent.value, parentLookup);
      assertNoParentCycle(CREATE_CYCLE_SENTINEL, parent.value, parentLookup);
    }
    // Forward-reference guard (supersedes primary): existence only, never a
    // cycle check — a replacement edge is not a sequencing DAG (dag.ts). A
    // dangling edge would mislead a reader into following a replacement that
    // does not exist, so it is rejected before the store is touched.
    const references = peekReferences(input) ?? [];
    if (references.length > 0) {
      assertSupersedesTargetsExist(references, this.#lookup());
    }
    return this.#store.insertItem(input, onUnresolvedIds);
  }

  /** Fetch one work item by id, or `null` if it does not exist. Runs the
   *  lazy-expiry seam first. Returns the VIEW (store.ts's `WorkItemView`):
   *  the item plus its derived `referenced_by` backlinks, so a superseded
   *  item announces its replacement on every read. */
  get(id: string, expiryCheck: ExpiryCheck = noopExpiryCheck): WorkItemView | null {
    expiryCheck(id);
    return this.#store.getItemView(id);
  }

  /**
   * List work items, with the derived claimability view attached to
   * each (see `ListedWorkItem`). Does NOT run the lazy-expiry seam per item,
   * and does NOT run a board-wide sweep either: `list` is a many-item
   * selection view, and running a reclaim side effect INSIDE this layer
   * (whether per-item or once per call) would put a write behind a call this
   * file documents as a read, AND would require importing expiry.ts here —
   * both declined; this file stays decoupled from claims.ts/expiry.ts by its
   * own header's boundary. That is a design decision beyond this layer's
   * scope, not an oversight — noted here rather than silently assumed.
   *
   * DECISION 01KYX9BGM9N9FGXQDMESN94FX1 (established, not a deferral): the
   * session-boundary sweep (hooks/session-start.mjs, hooks/session-end.mjs)
   * does NOT by itself bound how long a lapsed claim stays invisible through
   * this method — a long-running single session (the autopilot case:
   * skills/autopilot/SKILL.md runs one continuous context across every cycle;
   * its subagents fire SubagentStart/SubagentStop, which never sweep) can span
   * the mechanism's entire compensating window with zero sweeps. So the
   * transports that serve `claimable` to an agent — work-state/tools.ts's
   * `work_list`, cli/ideate-work.ts's `list` — each run ONE `sweepBoard` call
   * of their own, at the transport boundary, before calling {@link
   * listSummaries} (see either file's own header for the full analysis and
   * measured cost). `list` itself is called by ONE internal, non-transport
   * consumer (context/assemble-prototype.ts, sweeping the board to render
   * `spec` bodies for reverse edges — never a claimability decision), which
   * does not get that pre-sweep: its read does not act on `claimable`, so the
   * gap this decision closes does not apply to it.
   *
   * FULL FIDELITY, ALWAYS: every matching item, each with its opaque `spec`
   * body, no page limit. This is the read internal TypeScript callers use
   * (context/assemble-prototype.ts sweeps it for reverse edges and RENDERS the
   * specs it finds), so it must never quietly become a page — see
   * {@link listSummaries} for the projected, paged transport read.
   */
  list(filter?: ListItemsFilter): ListedWorkItem[] {
    const items = this.#store.listItemViews(filter);
    const isClaimable = this.#claimabilityGate();
    return items.map((item) => ({ ...item, claimable: isClaimable(item) }));
  }

  /**
   * The SUMMARY, keyset-paged twin of {@link list} — the read the agent-facing
   * transports (work-state/tools.ts's `work_list`, cli/ideate-work.ts's
   * `list --json`) actually call. Same selection, same order, same two derived
   * views; what changes is the PAYLOAD (no opaque `spec` body unless
   * `page.include_spec` asks for it — `spec_length` instead) and the
   * ROW COUNT (one page at a time when `page.limit` is given, with an opaque
   * `next_cursor` to resume from).
   *
   * `list` is NOT reimplemented in terms of this method, and this method does
   * not impose a default page size: an internal caller that needs the whole
   * board with spec bodies (context/assemble-prototype.ts's reverse-edge
   * sweep) keeps calling {@link list} and keeps getting every item. Truncation
   * is only ever something a transport asks for explicitly.
   *
   * Like {@link list}, this does not run the lazy-expiry seam per item, and
   * does not sweep the board itself either — see {@link list}'s own note
   * (decision 01KYX9BGM9N9FGXQDMESN94FX1): its two transports (`work_list`,
   * `ideate-work list`) each sweep once, at their own boundary, before
   * calling this method.
   */
  listSummaries(filter?: ListItemsFilter, page?: ListPageOptions): ListItemsPage<ListedWorkItemSummary> {
    const result = this.#store.listItemSummaryViews(filter, page);
    const isClaimable = this.#claimabilityGate();
    return {
      items: result.items.map((item) => ({ ...item, claimable: isClaimable(item) })),
      next_cursor: result.next_cursor,
    };
  }

  /**
   * Build the derived-claimability predicate shared by {@link list} and
   * {@link listSummaries} — ONE definition of `claimable`, so the paged read
   * and the full read can never drift (and neither can drift from
   * `ListedWorkItem.claimable`'s documented contract).
   *
   * Both halves of the gate consult the FULL board, never just the rows being
   * returned — that is what makes the answer independent of the filter AND of
   * where a page boundary happens to fall. BOTH are answered from ONE
   * unfiltered, SPEC-FREE full-board scan (store.ts's `listContainmentRows`,
   * which reads `(id, parent_id, status)` and nothing else):
   *
   *   - depends_on frontier: an item is gated until every direct dependency is
   *     `done`. The status of EVERY id on the board is in the map that scan
   *     produces, so a dependency excluded by the filter or sitting on another
   *     page resolves from the SAME scan — no per-id read. That matters under
   *     paging: seeding the map from the returned page instead would turn a
   *     cross-page dependency into a per-dependency `getItem`, i.e. an N+1 of
   *     open/close cycles EACH loading a full row including the opaque `spec`
   *     body — the exact payload the projected read exists to avoid. An id
   *     that is absent from the map is an id that is not on the board: its
   *     status is `undefined`, which is not `done`, so the dependent stays
   *     non-claimable (identical to the per-id read's answer for a missing
   *     item).
   *   - containment: the set of parent ids with at least one PENDING child
   *     (`open` or `in_progress`), so a parent stays non-claimable even when
   *     its pending child is excluded by the filter (e.g. a roots-only
   *     `list({ parent_id: null })`) or simply landed on a later page. This is
   *     store.ts's buildReferrerMap completeness posture exactly: one scan of
   *     a small board table, no new index (GP-24). A `done` or `cancelled`
   *     child is resolved and never lands its parent in this set.
   */
  #claimabilityGate(): (item: { id: string; status: WorkItemStatus; depends_on: readonly string[] }) => boolean {
    const statuses = new Map<string, WorkItemStatus>();
    const parentsWithPendingChildren = new Set<string>();
    for (const candidate of this.#store.listContainmentRows()) {
      statuses.set(candidate.id, candidate.status);
      if (candidate.parent_id !== null && (candidate.status === 'open' || candidate.status === 'in_progress')) {
        parentsWithPendingChildren.add(candidate.parent_id);
      }
    }
    return (item) =>
      item.status === 'open' &&
      item.depends_on.every((depId) => statuses.get(depId) === 'done') &&
      !parentsWithPendingChildren.has(item.id);
  }

  /**
   * Update metadata (title/spec/spec_format/depends_on/parent_id/references)
   * via optimistic CAS
   * on `version` (store.ts's `updateMeta` primitive). When `depends_on` is
   * present in `patch`, rejects (typed, `DagError`) a dangling reference or
   * a cycle-introducing edit BEFORE the store is touched — recovery is calling
   * `update_meta` again with a corrected list. A present `references` list
   * (which replaces the edge list wholesale) is likewise rejected when any
   * target dangles — existence only, never a cycle check (a replacement edge
   * is not a sequencing DAG).
   * A stale `expectedVersion` surfaces as the store's own typed
   * `WorkStateError('VERSION_CONFLICT', …)`, unchanged. Runs the lazy-expiry
   * seam first.
   *
   * `onUnresolvedIds` (optional, correction 01KYV387QKRP3V330WAS6DX95K
   * FINDING 1): threaded straight through to `store.updateMeta`'s own
   * callback of the same name — see that method's doc comment, including its
   * "fired with `[]`, never skipped, even when this patch doesn't touch
   * `title`" contract.
   */
  updateMeta(
    id: string,
    expectedVersion: number,
    patch: UpdateMetaInput,
    expiryCheck: ExpiryCheck = noopExpiryCheck,
    onUnresolvedIds?: (ids: readonly UnresolvedId[]) => void,
  ): WorkItem {
    expiryCheck(id);
    const dependsOn = peekDependsOn(patch);
    if (dependsOn !== undefined) {
      const lookup = this.#lookup();
      assertDependenciesExist(dependsOn, lookup);
      assertNoCycle(id, dependsOn, lookup);
    }
    // Containment guards, orthogonal to the depends_on path above:
    // setting/moving `parent_id` never reads or mutates `depends_on`, and vice
    // versa. Only a present-and-non-null parent is guarded — present-null
    // (clear to root) can neither dangle nor introduce a cycle, and an absent
    // key leaves the parent unchanged. Recovery from a rejected edit is the
    // same as depends_on's: call update_meta again with a corrected parent_id.
    const parent = peekParentId(patch);
    if (parent.present && parent.value !== null) {
      const parentLookup = this.#parentLookup();
      assertParentExists(parent.value, parentLookup);
      assertNoParentCycle(id, parent.value, parentLookup);
    }
    // Forward-reference guard, orthogonal to both paths above: a present
    // `references` list replaces the edge list wholesale, so every target is
    // existence-checked (no cycle check — see create()). `[]` (clear all
    // edges) needs no guard; an absent key leaves the edges untouched.
    const references = peekReferences(patch);
    if (references !== undefined && references.length > 0) {
      assertSupersedesTargetsExist(references, this.#lookup());
    }
    return this.#store.updateMeta(id, expectedVersion, patch, onUnresolvedIds);
  }

  /**
   * Cancel an item from `open` or `in_progress` (any tenant member; audited).
   * When the item was `in_progress`, its active claim is voided
   * in the SAME atomic write — the item leaves the claimable
   * pool, and the voided token is recorded on the appended `cancel` event.
   * `NOT_FOUND` (no such item) and `INVALID_TRANSITION` (item is `done` or
   * already `cancelled`) are both typed and thrown before any write.
   * Runs the lazy-expiry seam first.
   */
  cancel(id: string, actor: ActorRef, expiryCheck: ExpiryCheck = noopExpiryCheck): WorkItem {
    expiryCheck(id);
    const now = this.#clock().toISOString();
    const result = transitionStatus(
      this.#store.dbPath,
      id,
      ['open', 'in_progress'],
      'cancelled',
      now,
      true,
      (voidedClaimToken) => ({
        item_id: id,
        actor,
        transition: 'cancel',
        ...(voidedClaimToken === null ? {} : { claim_token: voidedClaimToken }),
        at: now,
      }),
    );
    if (!result.ok) {
      if (result.observedStatus === null) {
        throw new WorkStateError('NOT_FOUND', `work-state verbs: no item with id ${JSON.stringify(id)}`);
      }
      throw new VerbError(
        'INVALID_TRANSITION',
        `work-state verbs: cancel requires status open or in_progress, item ${id} is ${result.observedStatus}`,
      );
    }
    const after = this.#store.getItem(id);
    if (after === null) {
      throw new WorkStateError('SCHEMA', `work-state verbs: cancel did not persist for item ${id}`);
    }
    return after;
  }

  /**
   * Reopen an item from `done` back to `open` (any tenant member; audited).
   * `done` items carry no active claim (claims are cleared on `complete` —
   * claims.ts's scope), so there is nothing to void here.
   * `NOT_FOUND` and `INVALID_TRANSITION` (item is not `done`, e.g.
   * reopen-on-open) are both typed and thrown before any write. Runs the
   * lazy-expiry seam first.
   */
  reopen(id: string, actor: ActorRef, expiryCheck: ExpiryCheck = noopExpiryCheck): WorkItem {
    expiryCheck(id);
    const now = this.#clock().toISOString();
    const result = transitionStatus(this.#store.dbPath, id, ['done'], 'open', now, false, () => ({
      item_id: id,
      actor,
      transition: 'reopen',
      at: now,
    }));
    if (!result.ok) {
      if (result.observedStatus === null) {
        throw new WorkStateError('NOT_FOUND', `work-state verbs: no item with id ${JSON.stringify(id)}`);
      }
      throw new VerbError(
        'INVALID_TRANSITION',
        `work-state verbs: reopen requires status done, item ${id} is ${result.observedStatus}`,
      );
    }
    const after = this.#store.getItem(id);
    if (after === null) {
      throw new WorkStateError('SCHEMA', `work-state verbs: reopen did not persist for item ${id}`);
    }
    return after;
  }

  /** All events for one item, oldest first. Runs the lazy-expiry seam first. */
  events(id: string, expiryCheck: ExpiryCheck = noopExpiryCheck): WorkStateEvent[] {
    expiryCheck(id);
    return this.#store.events(id);
  }
}
