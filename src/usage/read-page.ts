// plugin/src/usage/read-page.ts — the usage log's BOUNDED read.
//
// WHY THIS MODULE EXISTS: `usage_query` was the LAST unbounded read surface in
// the package — filters only, no limit, no cursor, over a store that only ever
// grows. Usage signals are append-only measurement data (one signal per cited
// item per capture point), so the payload is monotonic in the project's whole
// history, exactly the profile that made the process record dangerous.
//
// MEASURED, on this repo (2026-07-30), over the 1,853-row append-only NDJSON
// this store's medium mirrors (.ideate-telemetry/telemetry.ndjson, 18 days of
// one contributor's dogfooding — the usage log itself has no production rows
// yet because its mechanical capture point is not wired):
//   - the whole envelope serializes to 637,619 characters (~159k tokens),
//     ~10x the ~66k payload that once exceeded a client's per-tool-result cap
//     and hard-failed the call, and it grows at ~100 rows/day;
//   - a default page under the shared budget is ~37.6k characters.
//
// NO PROJECTION, deliberately. The record projected because `content` was
// 73.9% of its bytes; here the composition is FLAT — the largest single field
// is `manifest_id` at 13.4%, and every field sits between 6.4% and 13.4%. A
// usage signal is nine short ids and a timestamp: rows measured 333/345/354
// characters at min/median/max, so there is no fat field to drop and dropping
// any of them would remove data the recall metric needs. Paging plus the
// payload budget is the honest answer for this shape; projecting for symmetry
// with the record would cost fidelity and buy nothing.
//
// THE TOTAL ORDER IS THE SIGNAL'S OWN `id`: a store-minted ULID (record/id.ts,
// via usage/store.ts's generator), which is IMMUTABLE — the store has no update
// verb at all (append-only by API absence) — and unique. That is the same
// property the process record's cursor rests on, and strictly stronger than
// steering's, which had to key on a MUTABLE `updated_at` and accept a
// missed-row caveat. Nothing here restamps anything, so a boundary once issued
// stays where it was.
//
// ORDER IS ASCENDING (oldest first), unlike the record's newest-first read, and
// that choice is load-bearing rather than cosmetic: the consumer of this
// surface walks a filter TO EXHAUSTION to form a recall denominator, and under
// an ascending walk a signal appended DURING the walk carries a larger id than
// any cursor already issued, so it lands on a later page instead of being
// silently skipped. A newest-first walk over an append-only log would miss
// exactly the rows written while it ran.
//
// WHERE THE DEFAULT LIVES: here, at the transport boundary, never in store.ts.
// `UsageStore.query`/`usedItemIds` still mean "every matching signal" with no
// limit parameter at all, because they ARE the effectiveness denominator an
// in-process metric computation reads whole; a default imposed one layer down
// would silently truncate that denominator and quietly understate recall.
//
// PAGING IS SELECTION, NOT RANKING (GP-27): the walk is the store's own id
// order and a cursor is a POSITION in it. Nothing here scores or reorders.
//
// GP-26: this module imports the neutral transport helpers and its own seam's
// schema error. Its one cross-directory import is record/id.ts — the module
// that DEFINES the id format these signals are minted with (usage/store.ts
// already composes its generator from it), not another store's storage layer.

import { encodeIdCursor, parseListCursorPayload } from '../transport/keyset-page.js';
import { fitToListPayloadBudget } from '../transport/payload-budget.js';
import type { ListItemMeasure } from '../transport/payload-budget.js';
import { isUlid } from '../record/id.js';
import { UsageSchemaError } from './schema.js';
import type { UsageSignal } from './schema.js';
import type { UsageQuery, UsageStore } from './store.js';

/**
 * Default page size when a caller names none. A COUNT CAP, deliberately round:
 * at the measured mean signal (~342 characters, plus its echo in
 * `used_item_ids`) a full page is ~37.6k characters, i.e. just inside the
 * shared payload budget, so a typical default page is count-bound and an
 * atypical one (a long `item_id`) is budget-bound. The guarantee callers depend
 * on is "a page is bounded and next_cursor tells you whether to come back", not
 * any particular size.
 */
export const DEFAULT_USAGE_QUERY_LIMIT = 100;

/** Ceiling on a caller-supplied page size. Out-of-range magnitudes CLAMP (0, a
 *  negative, or 9999 all yield a usable page) — mirroring the record's and the
 *  board's reads, because an out-of-range magnitude is not a caller bug worth
 *  failing a read over. A NON-INTEGER limit is a different failure class (the
 *  SHAPE of the argument) and stays a typed error. */
export const MAX_USAGE_QUERY_LIMIT = 500;

/** Selection + paging options a transport hands to {@link readUsagePage}. */
export interface UsagePageOptions {
  /** The store's own exact-match selection filter (never a ranking). */
  filter?: UsageQuery;
  /** Page size; defaulted to {@link DEFAULT_USAGE_QUERY_LIMIT}, then clamped. */
  limit?: number;
  /** The opaque `next_cursor` of a previous page, verbatim. */
  cursor?: string;
}

/**
 * One page of usage signals plus the boundary to resume from (`null` = last
 * page).
 *
 * `used_item_ids` is PAGE-SCOPED — the distinct `item_id`s among THIS page's
 * signals, in first-seen order. It cannot be the whole store's distinct set any
 * more: that set grows without bound with the store, which is the very defect
 * this module closes. Nothing is lost, because distinctness is idempotent under
 * union: the union of every page's `used_item_ids` across a walk to exhaustion
 * is exactly the full denominator the unpaged read used to return in one gulp,
 * and for a filter whose matches fit in one page it IS that set unchanged.
 *
 * NO `count`: under paging a count reads as "how many there are" but could only
 * ever mean "how many on this page", which is `signals.length` already — the
 * same call the board, the record and steering all made.
 */
export interface UsageSignalPage {
  signals: UsageSignal[];
  used_item_ids: string[];
  next_cursor: string | null;
}

/**
 * Decode a usage page cursor to the id boundary it names, or throw the USAGE
 * seam's own typed error.
 *
 * The mechanical half — canonical base64url, then JSON — is
 * transport/keyset-page.ts's `parseListCursorPayload`, which RETURNS a problem
 * tag and never throws. That split is deliberate and load-bearing twice over:
 * the canonical round trip is easy to get subtly wrong (`Buffer.from(x,
 * 'base64url')` silently accepts padded, wrong-alphabet, short-group and
 * non-canonical-tail input), so it exists ONCE package-wide; and the failure has
 * to be THIS seam's error — a `UsageSchemaError`, never the record's or the
 * board's, because usage must not import another store's taxonomy (GP-26).
 *
 * The SHAPE check is the seam's own: a usage cursor is EXACTLY one element, a
 * well-formed ULID, because every signal id is one (usage/store.ts mints them
 * with record/id.ts's generator). A board or steering cursor pasted in here is a
 * two-element array and is rejected as malformed rather than half-understood. A
 * process-record cursor is also a one-element ULID and therefore indistinguish-
 * able; it decodes to a boundary this store simply has no signal after, which is
 * the same correct answer as true exhaustion.
 *
 * NEVER an empty page: every malformed shape raises. A cursor that silently
 * selected nothing would be read as "the log ended" and truncate a walk without
 * anyone noticing — the whole failure paging exists to avoid.
 *
 * What is NOT validated is the CONTENTS: a well-formed cursor naming an id no
 * signal ever had decodes fine and simply selects the signals minted after it.
 * That is deliberate — "nothing after this boundary" is the CORRECT answer at
 * true exhaustion, so there is nothing to distinguish it from.
 *
 * The offending value is deliberately NOT echoed into the message: it is
 * caller-supplied text and this message flows out through the MCP error
 * surface, which does not gate free text (P-24).
 */
export function decodeUsageCursor(cursor: string): string {
  const decoded = parseListCursorPayload(cursor);
  if (!decoded.ok) {
    throw new UsageSchemaError(
      'cursor',
      decoded.problem === 'not-canonical-base64url'
        ? 'usage query: "cursor" is not a valid page cursor (expected the opaque next_cursor from a previous page)'
        : 'usage query: "cursor" is not a valid page cursor (undecodable payload) — pass back the next_cursor from a previous page',
    );
  }
  const parsed = decoded.value;
  const id = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  if (typeof id !== 'string' || !isUlid(id)) {
    throw new UsageSchemaError(
      'cursor',
      'usage query: "cursor" is not a valid page cursor (expected an encoded [id] boundary)',
    );
  }
  return id;
}

/**
 * Clamp a caller-supplied page size into `[1, MAX_USAGE_QUERY_LIMIT]`.
 *
 * Note what clamping to a FLOOR of 1 costs: `limit: 0` no longer means "return
 * nothing" at this boundary (the store's own `query` has no limit at all and
 * still returns everything for internal callers). That is the intended reading
 * here — a transport asking for a page is asking for a page — and it keeps the
 * "shorter page ⇒ follow next_cursor" contract free of a second empty-page
 * meaning.
 */
export function clampUsageQueryLimit(limit: number): number {
  if (!Number.isInteger(limit)) {
    // String(), not JSON.stringify(): NaN/Infinity both serialize to `null` as
    // JSON, which would name the wrong problem back to the caller.
    throw new UsageSchemaError('limit', `usage query: "limit" must be an integer, got ${String(limit)}`);
  }
  if (limit < 1) return 1;
  return Math.min(limit, MAX_USAGE_QUERY_LIMIT);
}

/** The distinct `item_id`s of a page's signals, in first-seen order — the same
 *  fold `UsageStore.usedItemIds` does over the whole store, applied to the rows
 *  actually being returned (see {@link UsageSignalPage} for why page-scoped). */
function distinctItemIds(signals: readonly UsageSignal[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const signal of signals) {
    if (seen.has(signal.item_id)) continue;
    seen.add(signal.item_id);
    out.push(signal.item_id);
  }
  return out;
}

/**
 * ONE page of usage signals, oldest first, with an honest `next_cursor`.
 *
 * Exhaustion is detected by over-reading exactly one row: `limit + 1` signals
 * are taken and the extra one, if it arrives, is dropped and turned into a
 * cursor. So `next_cursor` is non-null when and only when a matching signal
 * remains — never "probably", never a cursor that yields an empty next page at
 * the boundary.
 *
 * THE ORDER IS IMPOSED HERE, not assumed. `UsageStore.query` returns rows in
 * FILE order, and file order equals id order only as long as no two sessions
 * append within the same millisecond (a ULID orders by its millisecond
 * timestamp first, then by per-session entropy, so two concurrent minters can
 * land out of order). The cursor predicate is over IDS, so a page walked in
 * file order could skip a row whose id sorts before an already-issued boundary.
 * Sorting by id makes the order the cursor pages over the order that is
 * actually walked — the two cannot disagree. The residual caveat, stated
 * plainly: a signal minted by a CONCURRENT session in the same millisecond as,
 * and with lower entropy than, a boundary already handed out is below that
 * boundary and will not appear in the rest of that walk. It is the narrowest
 * form of the caveat steering had to accept for a whole class of updates, and
 * it cannot touch a row appended more than a millisecond after the cursor was
 * issued — which is every row a mid-walk append actually produces.
 *
 * Reading the whole matching set to serve one page is the store's existing
 * shape (`query` folds the entire NDJSON file on every call, with no limit
 * parameter), not a regression introduced here; pushing the window into the
 * store is exactly the move this seam must not make, because the store's
 * unlimited read IS the denominator its internal callers need.
 */
export function readUsagePage(store: UsageStore, options: UsagePageOptions = {}): UsageSignalPage {
  const limit = clampUsageQueryLimit(options.limit ?? DEFAULT_USAGE_QUERY_LIMIT);
  const afterId = options.cursor === undefined ? undefined : decodeUsageCursor(options.cursor);
  const ordered = [...store.query(options.filter ?? {})].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // STRICTLY after the boundary: the cursor names the last row of the previous
  // page, so including it again would duplicate it.
  const remaining = afterId === undefined ? ordered : ordered.filter((signal) => signal.id > afterId);
  const window = remaining.slice(0, limit + 1);
  const hasMore = window.length > limit;
  const signals = hasMore ? window.slice(0, limit) : window;
  const last = signals.at(-1);
  return {
    signals,
    used_item_ids: distinctItemIds(signals),
    next_cursor: hasMore && last !== undefined ? encodeIdCursor(last.id) : null,
  };
}

/** An `item_id` echoed into `used_item_ids` costs its own characters plus two
 *  quotes and the comma separating it from the next one — charged to every row
 *  including the last, which over-charges a page by exactly one character. */
const USED_ITEM_ID_FRAMING_CHARS = 3;

/**
 * Apply the SHARED payload budget (transport/payload-budget.ts — one constant,
 * one prefix rule, one liveness guarantee for every bounded read in the
 * package) to a page, re-minting `next_cursor` from the last signal that
 * survived and recomputing the page-scoped `used_item_ids` over what is
 * actually returned.
 *
 * `measureItem` is injected because a bound is only meaningful against the
 * serialization ACTUALLY emitted; the one transport here is the MCP tool
 * result, which the SDK writes as compact JSON.
 *
 * EACH ROW IS CHARGED TWICE, once for the signal and once for its `item_id`'s
 * possible echo in `used_item_ids` (plus the two quotes and the comma that
 * carry it). That derived array is the second array in this envelope and it is
 * bounded only by the page, so budgeting the signals alone would let a page of
 * long, all-distinct `item_id`s emit far more than the budget allows. The
 * charge is an UPPER bound — duplicate item ids collapse in the fold and are
 * therefore over-charged — which is the safe direction for a bound.
 *
 * Liveness comes from the shared helper: a single signal larger than the whole
 * budget is returned ALONE with a valid cursor, never as an empty page that
 * would stall the walk.
 */
export function boundUsagePage(page: UsageSignalPage, measureItem: ListItemMeasure<UsageSignal>): UsageSignalPage {
  const kept = fitToListPayloadBudget(page.signals, (signal) => measureItem(signal) + signal.item_id.length + USED_ITEM_ID_FRAMING_CHARS);
  const last = kept.at(-1);
  // Nothing was dropped, or there was nothing to drop: the page — INCLUDING
  // its cursor, `null` at true exhaustion — is already correct.
  if (last === undefined || kept.length === page.signals.length) return page;
  // Rows remain by construction, so the re-minted cursor is non-null: a page
  // shortened by the budget always tells the caller to come back.
  return { signals: kept, used_item_ids: distinctItemIds(kept), next_cursor: encodeIdCursor(last.id) };
}
