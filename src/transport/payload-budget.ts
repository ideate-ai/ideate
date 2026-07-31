// plugin/src/transport/payload-budget.ts — the ONE payload budget every
// bounded read enforces, and the ONE implementation that applies it.
//
// WHY this is its own neutral module rather than a store's: the budget is
// TRANSPORT policy, not storage. It answers "how much may one page carry on
// the wire", a question the delegation board (work-state/), the process
// record (record/) and steering (steering/) all face identically and must all
// answer the SAME way — while remaining separate stores that share no schema
// (GP-26: narrow seams). Parking it in any one of those stores would force
// the other two to import that store to stay in step, which is exactly the
// coupling the seams exist to prevent; parking a copy in each transport is
// how two doors quietly start disagreeing about what "bounded" means.
//
// SINGLE DEFINITION, mechanically: `LIST_PAYLOAD_BUDGET_CHARS` and
// `applyListPayloadBudget` are defined HERE and nowhere else in the package,
// and the only files that import them are the transports listed in
// payload-budget.test.ts's drift test. That test walks the whole source tree
// and fails if a second definition appears anywhere or if an unlisted file
// reaches for one (GP-24: a grep-falsifiable promise about code shape).
//
// This module applies nothing on its own and knows nothing about any store:
// it takes a page a store already produced and hands back a page that fits.
// The stores' own reads stay unbounded — an absent limit still means "every
// matching row" for in-repo consumers that sweep a whole store
// (context/assemble-prototype.ts).

import { encodeListCursor } from './keyset-page.js';
import type { ListItemsPage } from './keyset-page.js';

/**
 * The maximum number of characters of SERIALIZED ITEMS one page may carry,
 * whatever `limit` (or the page default) would otherwise return. Shared by
 * every bounded read — today the MCP `work_list` tool (work-state/tools.ts)
 * and the CLI's `list --json` (cli/ideate-work.ts).
 *
 * WHY a second bound at all: `limit` counts ITEMS, and an item is not a fixed
 * size. Measured over the MCP transport, a default page of 100 summary rows
 * with realistic titles serializes to ~42k characters, and
 * `{ limit: 500, include_spec: true }` on a 120-item board with 500-character
 * specs serializes to ~103k — LARGER than the ~66k payload that blew a
 * client's per-tool-result token cap and prompted the projection in the first
 * place. An item-count bound alone therefore does not bound the payload; this
 * one does, and it applies to EVERY path — summary rows and `include_spec`
 * alike — because `include_spec` is exactly the parameter that makes rows big.
 *
 * WHY the CLI is bounded too, despite writing to a byte stream with no token
 * cap: `bin/ideate-work list --json` is an AGENT-facing path (agents/
 * journal-keeper.md instructs an agent to run exactly that command), so its
 * stdout lands in a context window as a tool result under the same kind of cap
 * the MCP result was — measured at 66,324 characters on a real 125-item board,
 * larger than the failure this budget exists to prevent. One transport bounded
 * and the other not would just move the failure to the other door.
 *
 * WHY 40,000: at the usual ~4 characters per token that is ~10k tokens of
 * items, which leaves a wide margin under a typical 25k-token per-tool-result
 * cap for the result envelope and for the conversation the caller is actually
 * having. It is deliberately a round, memorable number rather than a tuned
 * one: the guarantee callers depend on is "a page is bounded and `next_cursor`
 * tells you whether to come back", not any particular size.
 *
 * WHY `LIST_` when records and steering read the same budget: it names
 * LIST-SHAPED reads — many rows, one page at a time — not the board's
 * `work_list` verb specifically.
 */
export const LIST_PAYLOAD_BUDGET_CHARS = 40_000;

/**
 * How many characters ONE item costs on the wire — the per-transport half of
 * {@link applyListPayloadBudget}, injected because the transports do not
 * write the same bytes. Bounding a payload is only meaningful against the
 * serialization that is ACTUALLY emitted, so each transport passes the measure
 * matching its own writer: {@link measureCompactItemChars} for MCP (the SDK
 * serializes a tool result compactly) and {@link measurePrettyItemChars} for
 * the CLI (which pretty-prints at 2-space indent, ~35% larger for the same
 * rows). Passing the wrong one would silently under- or over-count.
 */
export type ListItemMeasure<T> = (item: T) => number;

/**
 * The MCP transport's measure: an item as compact JSON, which is exactly what
 * the SDK writes into a tool result (`JSON.stringify(body)`, no indent).
 */
export function measureCompactItemChars(item: unknown): number {
  return JSON.stringify(item).length;
}

/** Items sit two levels deep in the CLI's envelope (`{ "items": [ … ] }`), so
 *  every line of an item carries four extra spaces on the wire. */
const PRETTY_ITEM_INDENT_CHARS = 4;
/** …and every row but the last pays a `,\n` separator; charging it to all of
 *  them keeps the measure conservative by exactly one character per page. */
const PRETTY_ITEM_SEPARATOR_CHARS = 2;

/**
 * The CLI transport's measure: an item as it is actually WRITTEN by
 * `list --json` — pretty-printed at 2-space indent, nested inside the
 * `{ "items": [ … ], "next_cursor": … }` envelope, plus its separator.
 *
 * WHY not just reuse {@link measureCompactItemChars} there: the CLI serializes
 * with `JSON.stringify(x, null, 2)`, so its on-the-wire size is roughly 35%
 * larger than the compact form for identical rows. Budgeting the compact form
 * would let the CLI emit ~54k characters against a 40k budget — bounding
 * something it does not write. The point of the budget is bounding REAL output.
 *
 * What is (and is not) covered: this counts the ITEMS REGION, mirroring the MCP
 * path, where the budget likewise bounds the items and not the `{ok:true, …}`
 * result envelope around them. The CLI's own framing — the object braces, the
 * two keys and the cursor string, on the order of a hundred characters — sits
 * outside the budget, because the cursor is not known until the page's rows are
 * chosen.
 */
export function measurePrettyItemChars(item: unknown): number {
  const rendered = JSON.stringify(item, null, 2);
  const lines = rendered.split('\n').length;
  return rendered.length + PRETTY_ITEM_INDENT_CHARS * lines + PRETTY_ITEM_SEPARATOR_CHARS;
}

/**
 * The budget ARITHMETIC, alone: the longest PREFIX of `items` that fits in
 * {@link LIST_PAYLOAD_BUDGET_CHARS} under `measureItem` — plus the liveness
 * rule, which is the property to not get wrong. If `items` had ANY row this
 * returns AT LEAST ONE row: an item larger than the entire budget comes back
 * ALONE rather than as an empty page, because an empty page with a cursor
 * stalls a walk forever (the caller loops, or reads it as "the store ended"
 * and stops early). The budget bounds how much a page carries BEYOND its first
 * row; it is never a filter that can drop a row entirely.
 *
 * WHY this is exported separately from {@link applyListPayloadBudget}: closing
 * a page needs one thing this arithmetic does not know — how to re-mint the
 * cursor. `applyListPayloadBudget` mints the `[sort_key, id]` pair the board
 * and steering page over; the process record pages over the ULID `id` ALONE
 * (its id is a total order by construction, so a second key would be noise),
 * so its cursor is a one-element encoding no signature of that function can
 * produce. Rather than fork the loop — which is exactly how two doors start
 * disagreeing about what "bounded" means — the record transports (record/
 * read-page.ts's `boundRecordPage`) call THIS and mint their own cursor. One
 * budget, one prefix rule, one liveness guarantee, whatever the cursor shape.
 */
export function fitToListPayloadBudget<T>(items: readonly T[], measureItem: ListItemMeasure<T>): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = measureItem(item);
    // The `kept.length > 0` guard IS the liveness guarantee above.
    if (kept.length > 0 && used + size > LIST_PAYLOAD_BUDGET_CHARS) break;
    kept.push(item);
    used += size;
  }
  return kept;
}

/**
 * Close a page early when its serialized items would exceed
 * {@link LIST_PAYLOAD_BUDGET_CHARS}, re-deriving `next_cursor` from the LAST
 * INCLUDED row so the caller resumes exactly where the shortened page stopped.
 * Keyset paging is what makes this trivial: the cursor is a position in a
 * store's stable creation order (transport/keyset-page.ts's
 * `encodeListCursor`), so any row can end a page.
 *
 * ONE implementation, every transport (see {@link ListItemMeasure}): they
 * differ only in the `measureItem` they pass, so the budget, the liveness
 * rule and the cursor rebuild cannot drift between doors.
 *
 * LIVENESS — the property to not get wrong: if the page had ANY row, this
 * returns AT LEAST ONE row. A single item larger than the entire budget is
 * returned ALONE, with a valid `next_cursor`, rather than as an empty page —
 * an empty page with a cursor would stall the walk forever (the caller would
 * loop, or read the empty page as "the board ended" and stop early). The
 * budget is therefore a bound on how much a page carries BEYOND its first row,
 * never a filter that can drop a row entirely.
 *
 * Honesty of `next_cursor` is preserved in both directions: shortening a page
 * always yields a non-null cursor (rows remain, by construction), and a page
 * that fits is returned untouched — including its `null` cursor at true
 * exhaustion.
 *
 * THE SORT KEY IS INJECTABLE, in one overload only. Re-minting a cursor means
 * knowing which field the store's order is keyed on, and the three seams do
 * not agree: the board and the process record page over immutable
 * `created_at`, while steering pages over `updated_at` (its items are mutable
 * — an amendment restamps that field). The two-argument form is the
 * `created_at` default, so every existing caller is untouched and cannot pick
 * the wrong key by omission; a store keyed on anything else does not typecheck
 * until it passes `sortKeyOf` explicitly. One implementation either way — the
 * budget, the liveness rule and the cursor rebuild still cannot drift.
 */
export function applyListPayloadBudget<T extends { id: string; created_at: string }>(
  page: ListItemsPage<T>,
  measureItem: ListItemMeasure<T>,
): ListItemsPage<T>;
export function applyListPayloadBudget<T extends { id: string }>(
  page: ListItemsPage<T>,
  measureItem: ListItemMeasure<T>,
  sortKeyOf: (item: T) => string,
): ListItemsPage<T>;
export function applyListPayloadBudget<T extends { id: string; created_at?: string }>(
  page: ListItemsPage<T>,
  measureItem: ListItemMeasure<T>,
  sortKeyOf?: (item: T) => string,
): ListItemsPage<T> {
  // The prefix rule and the liveness guarantee live in ONE place
  // ({@link fitToListPayloadBudget}); this function adds only the cursor
  // re-mint, which is the half that differs between cursor shapes.
  const kept = fitToListPayloadBudget(page.items, measureItem);
  const last = kept.at(-1);
  // Nothing was dropped (`kept.length === page.items.length`, the common
  // case), or there was nothing to drop (an empty page — `last` undefined):
  // either way the page, INCLUDING its cursor, is already correct.
  if (last === undefined || kept.length === page.items.length) return page;
  // `last.created_at` is non-optional in the two-argument overload's signature,
  // so the fallback is unreachable through either public form (a T without
  // `created_at` cannot reach here without a `sortKeyOf`).
  return { items: kept, next_cursor: encodeListCursor(sortKeyOf === undefined ? (last.created_at ?? '') : sortKeyOf(last), last.id) };
}
