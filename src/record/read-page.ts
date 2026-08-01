// plugin/src/record/read-page.ts — the process record's BOUNDED read, shared
// by both of its transports.
//
// WHY this module exists at all: the record is append-only, so an unbounded
// read grows monotonically forever. Measured on this project's own record —
// 1,598 records — the whole store serializes to ~3.08 MILLION characters
// (~770k tokens), roughly 45x the ~66k payload that once exceeded a client's
// per-tool-result cap and hard-failed the call; even `scope="finding"` alone
// is ~337k. A read that can only answer "everything" is therefore a read that
// will eventually answer nothing at all.
//
// THREE mechanisms, because no two of them suffice (each number above is why):
//   1. PROJECTION — `content` is 73.9% of the payload (2.22M of 3.08M chars),
//      so summary rows are ~3.8x smaller. Not enough on its own: projected,
//      `scope="finding"` is still ~70k characters.
//   2. A COUNT limit — bounds rows, but a row is not a fixed size (record
//      bodies run from empty to ~39k characters), so it does not bound bytes.
//   3. The shared PAYLOAD BUDGET (transport/payload-budget.ts) — the only one
//      that bounds what actually goes on the wire.
//
// WHERE THE DEFAULT LIVES: here, at the transport boundary, never in
// store.ts. `RecordStore.read`/`readViews` still mean "every matching record"
// when no limit is given, because in-repo consumers sweep the store
// deliberately (context/assemble-prototype.ts self-bounds with
// `{scope, limit: 32}`) and a default imposed one layer down would silently
// truncate them. Both record transports — the MCP `record_read` tool and the
// `ideate-record read` CLI — go through the functions below, so the default,
// the clamp, the cursor contract and the projection cannot drift between the
// two doors.
//
// PAGING IS SELECTION, NOT RANKING (GP-27): the walk is the store's own
// newest-first id order, and a cursor is a POSITION in it. Nothing here scores,
// weights, or reorders anything.

import { fitToListPayloadBudget } from '../transport/payload-budget.js';
import type { ListItemMeasure } from '../transport/payload-budget.js';
import { encodeIdCursor, parseListCursorPayload } from '../transport/keyset-page.js';
import { isUlid } from './id.js';
import { RecordSchemaError } from './schema.js';
import type { RecordStore } from './store.js';
import type { ProcessRecordView } from './store.js';

/**
 * Default page size when a caller names none. A COUNT CAP, deliberately round:
 * at the measured mean summary row (~523 characters) a full page is ~52k
 * characters, which the payload budget then closes at ~40k — i.e. the default
 * page is budget-bound rather than count-bound on a typical store, exactly as
 * intended. The guarantee callers depend on is "a page is bounded and
 * next_cursor tells you whether to come back", not any particular size.
 */
export const DEFAULT_RECORD_READ_LIMIT = 100;

/** Ceiling on a caller-supplied page size. Out-of-range values CLAMP (0, a
 *  negative, or 9999 all yield a usable page) — mirroring the board's
 *  `clampListLimit`, because an out-of-range magnitude is not a caller bug
 *  worth failing a read over. A NON-INTEGER limit is a different failure class
 *  (the SHAPE of the argument) and stays a typed error. */
export const MAX_RECORD_READ_LIMIT = 500;

/**
 * One returned row: every field of a record view EXCEPT the prose body, plus
 * `content_length` — the body's length in UTF-16 CODE UNITS (JS
 * `String.prototype.length`; NOT Unicode code points), always present, so a
 * caller can see what it did not receive and decide whether to fetch it. This
 * generalizes the shape the priming digest has always emitted (cli/
 * ideate-record.ts's `formatDigest`: kind + claim + anchor + supersession),
 * which is the universal priming floor — it is not a new judgment about what a
 * record's "summary" is.
 *
 * Deliberately NOT aligned to the board's `spec_length` (work-state/store.ts),
 * which counts CODE POINTS via SQLite's own `LENGTH()`: this row's length is
 * computed in JS (`content.length` below), and the SAME JS `.length` also
 * drives this module's own payload-budget accounting (transport/payload-
 * budget.ts measures `JSON.stringify(item).length` on these very rows) — so
 * aligning `content_length` to code points would make it disagree with the
 * truncation math for the row it describes. The two surfaces measure "length"
 * in different units for that reason, not by drift; {@link projectRecordRow}
 * below is pinned to UTF-16 code units by a non-BMP test in
 * read-page.test.ts.
 *
 * `content` comes back only when the caller asks for it (`include_content`),
 * and `content_length` stays present either way so the two shapes differ by
 * ADDITION alone.
 */
export type ProcessRecordRow = Omit<ProcessRecordView, 'content'> & {
  content_length: number;
  content?: string;
};

/** One page of rows plus the boundary to resume from (`null` = last page).
 *  `records`, not `items`, to match the record's own vocabulary — and NO
 *  `count`: under paging a count reads as "how many there are" but could only
 *  ever mean "how many on this page", which is `records.length` already. */
export interface RecordRowPage {
  records: ProcessRecordRow[];
  next_cursor: string | null;
}

/** The same page shape before projection — full views, straight from the store. */
export interface RecordViewPage {
  records: ProcessRecordView[];
  next_cursor: string | null;
}

/** Selection + paging options a transport hands to {@link readRecordPage}. */
export interface RecordPageOptions {
  /** Substring SELECTION over scope/kind/source (never a ranking). */
  scope?: string;
  /** Exact-match id — the by-id fetch. */
  id?: string;
  /** Page size; defaulted to {@link DEFAULT_RECORD_READ_LIMIT}, then clamped. */
  limit?: number;
  /** The opaque `next_cursor` of a previous page, verbatim. */
  cursor?: string;
}

/**
 * Decode a record page cursor to the id boundary it names, or throw the
 * RECORD's own typed error.
 *
 * The mechanical half — canonical base64url, then JSON — is
 * transport/keyset-page.ts's `parseListCursorPayload`, which RETURNS a problem
 * tag and never throws. That split is deliberate and load-bearing twice over:
 * the canonical round trip is easy to get subtly wrong (`Buffer.from(x,
 * 'base64url')` silently accepts padded, wrong-alphabet, short-group and
 * non-canonical-tail input), so it exists ONCE package-wide; and the failure
 * has to be THIS seam's error — a `RecordSchemaError`, never the board's
 * `WorkStateError`, because the process record must not import the board's
 * taxonomy (GP-26: narrow seams).
 *
 * The SHAPE check is the seam's own: a record cursor is EXACTLY one element,
 * a well-formed ULID (see `encodeIdCursor` for why one). A board or steering
 * cursor pasted in here is a two-element array and is rejected as malformed
 * rather than half-understood.
 *
 * NEVER an empty page: every malformed shape raises. A cursor that silently
 * selected nothing would be read as "the record ended" and truncate a walk
 * without anyone noticing — which is the whole failure paging exists to avoid.
 *
 * What is NOT validated is the CONTENTS: a well-formed cursor naming an id no
 * record ever had decodes fine and simply selects the records older than it.
 * That is deliberate — the same "nothing after this boundary" answer is the
 * CORRECT one at true exhaustion, so there is nothing to distinguish it from.
 *
 * The offending value is deliberately NOT echoed into the message: it is
 * caller-supplied text and this message flows out through the MCP and CLI
 * error surfaces, which do not gate free text (P-24).
 */
export function decodeRecordCursor(cursor: string): string {
  const decoded = parseListCursorPayload(cursor);
  if (!decoded.ok) {
    throw new RecordSchemaError(
      'cursor',
      decoded.problem === 'not-canonical-base64url'
        ? 'record read: "cursor" is not a valid page cursor (expected the opaque next_cursor from a previous page)'
        : 'record read: "cursor" is not a valid page cursor (undecodable payload) — pass back the next_cursor from a previous page',
    );
  }
  const parsed = decoded.value;
  const id = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
  if (typeof id !== 'string' || !isUlid(id)) {
    throw new RecordSchemaError(
      'cursor',
      'record read: "cursor" is not a valid page cursor (expected an encoded [id] boundary)',
    );
  }
  return id;
}

/**
 * Clamp a caller-supplied page size into `[1, MAX_RECORD_READ_LIMIT]`.
 *
 * Note what clamping to a FLOOR of 1 costs: `limit: 0` no longer means "return
 * nothing" (store.ts's own `read` still honours 0 for internal callers). That
 * is the intended reading at this boundary — a transport asking for a page is
 * asking for a page — and it keeps the "shorter page ⇒ follow next_cursor"
 * contract free of a second empty-page meaning.
 */
export function clampRecordReadLimit(limit: number): number {
  if (!Number.isInteger(limit)) {
    // String(), not JSON.stringify(): NaN/Infinity both serialize to `null` as
    // JSON, which would name the wrong problem back to the caller.
    throw new RecordSchemaError('limit', `record read: "limit" must be an integer, got ${String(limit)}`);
  }
  if (limit < 1) return 1;
  return Math.min(limit, MAX_RECORD_READ_LIMIT);
}

/**
 * ONE page of record VIEWS, newest first, with an honest `next_cursor`.
 *
 * Exhaustion is detected by over-reading exactly one row: the store is asked
 * for `limit + 1` records and the extra one, if it arrives, is dropped and
 * turned into a cursor. So `next_cursor` is non-null when and only when a
 * matching record remains — never "probably", never a cursor that yields an
 * empty next page at the boundary.
 *
 * Views, not projected rows: the CLI's human-readable listing needs the full
 * record (it prints the body), while both machine paths project. Splitting
 * projection out of paging keeps one paging implementation for all three.
 */
export function readRecordPage(store: RecordStore, options: RecordPageOptions = {}): RecordViewPage {
  const limit = clampRecordReadLimit(options.limit ?? DEFAULT_RECORD_READ_LIMIT);
  const beforeId = options.cursor === undefined ? undefined : decodeRecordCursor(options.cursor);
  const records = store.readViews({
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(beforeId === undefined ? {} : { before_id: beforeId }),
    limit: limit + 1,
  });
  const hasMore = records.length > limit;
  const page = hasMore ? records.slice(0, limit) : records;
  const last = page.at(-1);
  return {
    records: page,
    next_cursor: hasMore && last !== undefined ? encodeIdCursor(last.id) : null,
  };
}

/**
 * Project one view into a returned row: drop `content`, add `content_length`,
 * and put `content` back only when the caller asked for it.
 *
 * The key is OMITTED rather than set to `undefined` when excluded, so a caller
 * can test presence (`'content' in row`) and a JSON payload carries no
 * misleading null.
 *
 * `content_length` is JS `String.prototype.length` — UTF-16 code units — by
 * deliberate choice, not oversight: see this file's `ProcessRecordRow` doc
 * comment for why it is not aligned to the board's code-point-counted
 * `spec_length`.
 */
export function projectRecordRow(view: ProcessRecordView, includeContent: boolean): ProcessRecordRow {
  const { content, ...rest } = view;
  return { ...rest, content_length: content.length, ...(includeContent ? { content } : {}) };
}

/**
 * Apply the SHARED payload budget (transport/payload-budget.ts — one constant,
 * one prefix rule, one liveness guarantee for every bounded read in the
 * package) to a projected page, re-minting `next_cursor` from the last row
 * that survived.
 *
 * `measureItem` is injected because the two record transports do not write the
 * same bytes: the MCP tool result is compact JSON, the CLI writes 2-space
 * indented JSON (~35% larger for identical rows). Bounding a payload is only
 * meaningful against the serialization ACTUALLY emitted.
 *
 * Liveness comes from the shared helper: a single record larger than the whole
 * budget is returned ALONE with a valid cursor, never as an empty page that
 * would stall the walk.
 */
export function boundRecordPage(page: RecordRowPage, measureItem: ListItemMeasure<ProcessRecordRow>): RecordRowPage {
  const kept = fitToListPayloadBudget(page.records, measureItem);
  const last = kept.at(-1);
  // Nothing was dropped, or there was nothing to drop: the page — INCLUDING
  // its cursor, `null` at true exhaustion — is already correct.
  if (last === undefined || kept.length === page.records.length) return page;
  // Rows remain by construction, so the re-minted cursor is non-null: a page
  // shortened by the budget always tells the caller to come back.
  return { records: kept, next_cursor: encodeIdCursor(last.id) };
}
