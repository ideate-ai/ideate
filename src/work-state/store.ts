// plugin/src/work-state/store.ts — the persistence core of the work-state
// contract.
//
// Covers the contract and local-mode equivalence (SQLite, WAL, busy-timeout).
// This module owns row<->type mapping and the storage PRIMITIVES only:
// insert, get, list, the metadata-update primitive (version bump), event
// append, and the per-item claim-token counter. Claim
// acquisition/renewal/completion semantics (compare-and-set, lease expiry,
// cycle detection) are OUT OF SCOPE — that is claims.ts and verbs.ts, built on
// top of these primitives.
//
// Gate-before-persist (mirrors record/store.ts): the free-text fields
// this layer accepts — `title`, an event's `note`, and the `rel` of every
// reference edge — pass through scanAndMask BEFORE any write. `spec` is
// deliberately NEVER gated: it is opaque, store-as-is, no code path may
// parse OR transform it (masking would be a transform). Edge ids are
// ULID-validated at the write chokepoint before persist, so a typo can never
// land as a silent dangling edge (the record store's exact posture).
//
// Forward-edge persistence (v3 schema): the `"references"` column stores
// ONLY the forward typed edge (`supersedes` primary). The reverse edge —
// `superseded_by` — is DERIVED on read by the view reads
// ({@link WorkStateStore.getItemView}/{@link WorkStateStore.listItemViews}),
// never stored: one stored direction, one mental model shared with the
// process-record store, and no forward/reverse drift is possible.
//
// Intentional narrowing beyond the contract: `title`, `spec`, and
// `spec_format` must be NON-EMPTY strings on insert. The contract is silent
// on minimum length; this layer treats an empty value as a caller bug.
// Presence-checked, never parsed — the opacity guarantee is untouched.
// Relax here if bare-task use ever matters; nothing downstream depends on
// non-emptiness.
//
// Reserved-field guard: `rank` is a reserved name. Any top-level `rank` key on
// a create/update-meta payload is rejected with a typed
// `WorkStateError('RESERVED_FIELD', ...)`. The other deliberately-absent
// fields (priority, estimates, sprints, labels, review states) simply have no
// place in the validated shape below — they are never read out of an input
// payload, so supplying them is a silent no-op rather than a stored field.
// Only `rank` gets the explicit, named rejection.
//
// Projection + keyset paging (the summary read): alongside the full-fidelity
// reads (`listItems`/`listItemViews`, which every INTERNAL TypeScript caller
// keeps using unchanged), this module offers ONE projected read —
// {@link WorkStateStore.listItemSummaryViews} — that leaves the opaque `spec`
// body in the database and returns `LENGTH(spec) AS spec_length` instead, and
// that can walk the board a page at a time by KEYSET (a `(created_at, id)`
// boundary), never OFFSET. Two properties are load-bearing:
//   - Absent options = today's behavior. No limit means no `LIMIT` clause and
//     `next_cursor: null` — the DEFAULT page size is a TRANSPORT decision
//     (work-state/tools.ts, cli/ideate-work.ts), never imposed here, so an
//     in-repo consumer that needs the whole board (context/assemble-prototype.ts)
//     can never be silently truncated by this layer.
//   - `spec_length` is computed in SQL, exactly once, by SQLite's own
//     `LENGTH()`, which on TEXT counts unicode CODE POINTS. It is deliberately
//     NOT recomputed in JS: `String.prototype.length` counts UTF-16 code
//     units, so on non-BMP text the two disagree by a factor of two per
//     astral character (10 emoji: `spec_length` 10, `spec.length` 20 — pinned
//     behaviorally in store.test.ts, "counts code points, not UTF-16 units"),
//     and one source of truth beats two almost-agreeing ones. `spec_length` is
//     therefore a triage hint about SIZE, not a JS string index.
//
// Shared transport policy (applied by the transports, never by this module):
// alongside `DEFAULT_LIST_LIMIT`/`MAX_LIST_LIMIT` this file owns the ONE
// payload budget both list transports enforce — `LIST_PAYLOAD_BUDGET_CHARS`
// and `applyListPayloadBudget`. It lives here rather than in either transport
// because both must agree on it and this is the only home the CLI can import
// without pulling in the MCP SDK; the two differ only in the per-item measure
// they pass (compact for MCP, pretty-printed for the CLI's `list --json`), so
// the budget itself cannot drift between the two doors.
//
// Events table discipline: this file contains NO `UPDATE events` and NO
// `DELETE FROM events` statement — the only SQL touching `events` is the
// single INSERT in `insertEventRow` and the single SELECT in `events()`.
// That absence is what makes the events table append-only BY CONSTRUCTION,
// mechanically grep-falsifiable.

import { Buffer } from 'node:buffer';
import type { DatabaseSync } from 'node:sqlite';

import { scanAndMask } from '../secret-gate/scan.js';
import type { Clock, UlidGenerator } from '../record/id.js';
import { createUlidGenerator, isUlid } from '../record/id.js';
import { openForRead, openForWrite } from './schema.js';
import { withBusyWrap, withWriteTransaction } from './tx.js';
import {
  DEFAULT_TENANT_ID,
  WorkStateError,
} from './types.js';
import type {
  ActorRef,
  AppendEventInput,
  Claim,
  NewWorkItemInput,
  UpdateMetaInput,
  WorkItem,
  WorkItemReference,
  WorkItemStatus,
  WorkStateEvent,
} from './types.js';

/**
 * Filter for {@link WorkStateStore.listItems} — selection only, no ranking.
 *
 * `parent_id` is the CONTAINMENT filter, and it is TRI-STATE — the
 * distinction between "key absent" and "key present with value null" is
 * load-bearing (mirrors `UpdateMetaInput.parent_id`; see types.ts):
 *   - ABSENT (key not on the filter): no containment filter — list everything
 *     matching tenant/status (the behavior before containment existed).
 *   - PRESENT as a string: CHILDREN-OF — only the direct children of that
 *     parent (`WHERE parent_id = ?`).
 *   - PRESENT as `null`: ROOTS-ONLY — only top-level items (`WHERE parent_id
 *     IS NULL`).
 * Direct children only (one level) — matches the board's existing direct-only
 * posture (`claimable`); no transitive/recursive query is added.
 */
export interface ListItemsFilter {
  tenant_id?: string;
  status?: WorkItemStatus;
  parent_id?: string | null;
}

/**
 * The largest page {@link WorkStateStore.listItemSummaryViews} will ever
 * return, whatever a caller asks for. A page size above this is CLAMPED down
 * (not rejected) — an over-eager caller gets a bounded answer plus a
 * `next_cursor`, which is strictly more useful than a typed failure.
 */
export const MAX_LIST_LIMIT = 500;

/**
 * The default page size the TRANSPORTS apply (work-state/tools.ts's
 * `work_list`, cli/ideate-work.ts's `list --json`). It lives here so the tool
 * description, the CLI usage text and the code all read one constant — but it
 * is deliberately NOT applied by this module: an absent `limit` on
 * {@link ListPageOptions} means "no LIMIT clause at all" (see the file header).
 */
export const DEFAULT_LIST_LIMIT = 100;

/**
 * Projection + paging options for {@link WorkStateStore.listItemSummaryViews}.
 * Every field is optional and every default is "behave like the unpaginated,
 * summary read": no `spec`, no `LIMIT`, no cursor.
 */
export interface ListPageOptions {
  /** Page size. ABSENT = no limit (the whole filtered board, `next_cursor:
   *  null`). Present = clamped into `[1, MAX_LIST_LIMIT]` (see
   *  {@link clampListLimit}); a non-integer is a typed SCHEMA error. */
  limit?: number;
  /** The opaque boundary returned as a previous page's `next_cursor`. A
   *  malformed value is a typed SCHEMA error, NEVER a silent empty page. */
  cursor?: string;
  /** Opt back in to the full opaque `spec` body on every returned item.
   *  `spec_length` is present either way. Default false. */
  include_spec?: boolean;
}

/** One page of a keyset read: the rows, plus the boundary to resume from
 *  (`null` when this page is the last one). */
export interface ListItemsPage<T> {
  items: T[];
  /** Opaque — encode/decode is this module's business alone (see
   *  {@link encodeListCursor}). */
  next_cursor: string | null;
}

/**
 * A work item WITHOUT its opaque `spec` body: every other current `WorkItem`
 * field, plus `spec_length` (the SQL-computed character count of the spec
 * that was left in the database). `spec_format` deliberately stays — it is a
 * short triage hint, not a payload. `spec` itself reappears ONLY when the
 * caller opts in via {@link ListPageOptions.include_spec}; the key is absent
 * entirely otherwise, so a consumer can never mistake a projected row for a
 * full one.
 */
export interface WorkItemSummary extends Omit<WorkItem, 'spec'> {
  spec_length: number;
  spec?: string;
}

/** The summary twin of {@link WorkItemView}: a projected row plus the same
 *  DERIVED reverse edges, built by the same full-board {@link buildReferrerMap}
 *  scan — a page boundary never changes an item's backlinks. */
export type WorkItemSummaryView = WorkItemSummary & { referenced_by: WorkItemReference[] };

/** The decoded form of a page cursor: the `(created_at, id)` boundary of the
 *  last row of the previous page, in the board's one stable order. */
export interface ListCursor {
  created_at: string;
  id: string;
}

/** One SPEC-FREE containment row — the whole board's `(id, parent_id, status)`
 *  triples, and nothing else. Backs verbs.ts's containment gate, which must
 *  consult every item on the board but has no business loading a single spec
 *  body to do it. */
export interface ContainmentRow {
  id: string;
  parent_id: string | null;
  status: WorkItemStatus;
}

/**
 * Encode a page boundary as `base64url(JSON.stringify([created_at, id]))`.
 * The encoder is `node:buffer`'s own base64url (C-13: no hand-rolled
 * serialization — no delimiter concatenation, no manual escaping), so a
 * timestamp containing a delimiter-shaped character can never split a cursor.
 * The RESULT is opaque at the contract level: callers pass it back verbatim
 * and never construct or parse one.
 */
export function encodeListCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

/**
 * Decode a page cursor, or throw `WorkStateError('SCHEMA', …)`.
 *
 * WHAT IS GUARANTEED — the ENCODING and the SHAPE. Three independent ways to
 * be malformed are each rejected LOUDLY, so a cursor that is not one of this
 * module's own cursors cannot degrade into an empty page (which a caller would
 * read as "the board ended"):
 *   1. not canonical base64url (re-encoding the decoded bytes must reproduce
 *      the input exactly — `Buffer.from(…, 'base64url')` is otherwise lenient
 *      and silently drops characters it does not recognize);
 *   2. not JSON;
 *   3. JSON, but not the `[created_at, id]` pair this module encodes.
 *
 * WHAT IS NOT GUARANTEED — the CONTENTS. A well-formed cursor naming a
 * boundary that no row ever had (`encodeListCursor('', '')`, or a position on
 * a different board) decodes cleanly and simply selects nothing, which the
 * caller sees as an empty page. That is deliberate, not an oversight: the same
 * "no rows after this boundary" answer is the CORRECT one at true exhaustion
 * and after a filter change, so there is nothing to distinguish it from. The
 * guard against misreading it is that cursors are OPAQUE — a caller echoes
 * back a value this module minted and never constructs one — and validating
 * contents (a boundary that once existed can legitimately be deleted) would
 * cost a query to buy no reachable safety.
 *
 * The offending value is deliberately NOT echoed into the message: this text
 * flows out through the MCP/CLI error surfaces, which do not gate free text.
 */
export function decodeListCursor(cursor: string): ListCursor {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) {
    throw new WorkStateError(
      'SCHEMA',
      'work-state store: "cursor" is not a valid page cursor (expected the opaque next_cursor from a previous list page)',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new WorkStateError(
      'SCHEMA',
      'work-state store: "cursor" is not a valid page cursor (undecodable payload) — pass back the next_cursor from a previous list page',
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new WorkStateError(
      'SCHEMA',
      'work-state store: "cursor" is not a valid page cursor (expected an encoded [created_at, id] boundary)',
    );
  }
  return { created_at: parsed[0], id: parsed[1] };
}

/**
 * Clamp a caller-supplied page size into `[1, MAX_LIST_LIMIT]`. Clamping, not
 * rejecting, is the deliberate choice for an out-of-range size (0, a negative,
 * or 9999 all yield a usable page); a NON-INTEGER limit is a different failure
 * class — a caller bug about the SHAPE of the argument, not its magnitude —
 * and stays a typed SCHEMA error.
 */
export function clampListLimit(limit: number): number {
  if (!Number.isInteger(limit)) {
    // String(), not JSON.stringify(): NaN/Infinity both serialize to `null`
    // as JSON, which would name the wrong problem back to the caller.
    throw new WorkStateError('SCHEMA', `work-state store: "limit" must be an integer, got ${String(limit)}`);
  }
  if (limit < 1) return 1;
  return Math.min(limit, MAX_LIST_LIMIT);
}

/**
 * The maximum number of characters of SERIALIZED ITEMS one list page may
 * carry, whatever `limit` (or the page default) would otherwise return. Shared
 * by BOTH transports — the MCP `work_list` tool (work-state/tools.ts) and the
 * CLI's `list --json` (cli/ideate-work.ts).
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
 * WHY this constant lives HERE rather than in either transport: it is TRANSPORT
 * policy (exactly like {@link DEFAULT_LIST_LIMIT}) that BOTH transports must
 * agree on, and this module is the only home both can import without dragging
 * in the MCP SDK. It is deliberately NOT applied by this module: the store's
 * absent-options behavior stays "every matching row, no truncation" for the
 * in-repo consumer that sweeps the whole board (context/assemble-prototype.ts).
 */
export const LIST_PAYLOAD_BUDGET_CHARS = 40_000;

/**
 * How many characters ONE item costs on the wire — the per-transport half of
 * {@link applyListPayloadBudget}, injected because the two transports do not
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
 * Close a page early when its serialized items would exceed
 * {@link LIST_PAYLOAD_BUDGET_CHARS}, re-deriving `next_cursor` from the LAST
 * INCLUDED row so the caller resumes exactly where the shortened page stopped.
 * Keyset paging is what makes this trivial: the cursor is a position in the
 * board's stable creation order ({@link encodeListCursor}), so any row can end
 * a page.
 *
 * ONE implementation, both transports (see {@link ListItemMeasure}): MCP and
 * CLI differ only in the `measureItem` they pass, so the budget, the liveness
 * rule and the cursor rebuild cannot drift between the two doors.
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
 */
export function applyListPayloadBudget<T extends { id: string; created_at: string }>(
  page: ListItemsPage<T>,
  measureItem: ListItemMeasure<T>,
): ListItemsPage<T> {
  const kept: T[] = [];
  let used = 0;
  for (const item of page.items) {
    const size = measureItem(item);
    // The `kept.length > 0` guard IS the liveness guarantee above.
    if (kept.length > 0 && used + size > LIST_PAYLOAD_BUDGET_CHARS) break;
    kept.push(item);
    used += size;
  }
  const last = kept.at(-1);
  // Nothing was dropped (`kept.length === page.items.length`, the common
  // case), or there was nothing to drop (an empty page — `last` undefined):
  // either way the page, INCLUDING its cursor, is already correct.
  if (last === undefined || kept.length === page.items.length) return page;
  return { items: kept, next_cursor: encodeListCursor(last.created_at, last.id) };
}

/**
 * A work item enriched with its DERIVED reverse edges — `referenced_by[i]`
 * means "item `id` points at this one with `rel`" (so a `supersedes` forward
 * edge surfaces here as a `superseded_by`-style backlink on the superseded
 * item). Derived per read by {@link WorkStateStore.getItemView} and
 * {@link WorkStateStore.listItemViews}; never persisted — the board stores
 * ONLY the forward edge, mirroring record/store.ts's `ProcessRecordView`.
 */
export type WorkItemView = WorkItem & { referenced_by: WorkItemReference[] };

/** Gate one free-text field through the secret scanner before persist. */
function gate(text: string): string {
  return scanAndMask(text).content;
}

/** Gate every member of every reference edge before persist (see the
 *  gate-before-persist note in the file header). */
function gateReferences(references: readonly WorkItemReference[]): WorkItemReference[] {
  return references.map((ref) => ({ rel: gate(ref.rel), id: gate(ref.id) }));
}

/** Reject a reserved top-level field (`rank`) on a create/update payload. */
function assertNoReservedField(raw: Record<string, unknown>, context: string): void {
  if ('rank' in raw) {
    throw new WorkStateError(
      'RESERVED_FIELD',
      `work-state store: "rank" is a reserved field name and may not be supplied on a ${context} payload; encode any ordering hint inside "spec" instead`,
    );
  }
}

function requireObject(input: unknown, context: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkStateError('SCHEMA', `work-state store: a ${context} payload must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkStateError(
      'SCHEMA',
      `work-state store: field "${field}" must be a non-empty string; got ${value === undefined ? 'absent' : typeof value}`,
    );
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be a string when present`);
  }
  return value;
}

/**
 * Validate a `parent_id`-shaped field: a value whose domain legitimately
 * includes `null` (a real "root" value, NOT an "unchanged" sentinel — see
 * types.ts's `UpdateMetaInput.parent_id`). `null` passes through as `null`;
 * a string passes through as-is; anything else is a typed SCHEMA error.
 * Callers own the tri-state "key absent vs present" distinction (this helper
 * is only reached when the key IS present).
 */
function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be a string or null when present`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be an array of strings`);
  }
  return value as string[];
}

/**
 * Validate a `references` edge list (shape only — mirrors record/schema.ts's
 * validateReferences). Must be an array of `{rel, id}` objects with NON-EMPTY
 * strings: an empty `rel` or `id` is a malformed edge, not a valid empty
 * value. ULID well-formedness is checked separately at the write chokepoint
 * ({@link assertReferenceIdsAreUlids}) so the two failure classes stay
 * distinct, exactly the record store's split.
 */
function requireReferenceArray(value: unknown, field: string): WorkItemReference[] {
  if (!Array.isArray(value)) {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be an array of {rel, id}`);
  }
  return value.map((item, i): WorkItemReference => {
    const raw = requireObject(item, `${field}[${i}]`);
    const rel = requireNonEmptyString(raw['rel'], `${field}[${i}].rel`);
    const id = requireNonEmptyString(raw['id'], `${field}[${i}].id`);
    return { rel, id };
  });
}

/**
 * Validate every reference id as a well-formed ULID at the write chokepoint
 * (insertItem/updateMeta — every write transport funnels here), so a typo is
 * rejected with a typed SCHEMA error before it can persist as a silent
 * dangling edge. Mirrors record/store.ts's append-time check verbatim in
 * posture; target EXISTENCE is a separate, verb-level concern (dag.ts's
 * assertSupersedesTargetsExist).
 */
function assertReferenceIdsAreUlids(references: readonly WorkItemReference[], context: string): void {
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    if (ref === undefined || !isUlid(ref.id)) {
      throw new WorkStateError(
        'SCHEMA',
        `work-state store: ${context} references[${String(i)}].id is not a well-formed ULID: ${JSON.stringify(ref?.id)}`,
      );
    }
  }
}

function validateActorRef(value: unknown, field: string): ActorRef {
  const raw = requireObject(value, field);
  const human = requireNonEmptyString(raw['human'], `${field}.human`);
  const agent = requireOptionalString(raw['agent'], `${field}.agent`);
  return agent === undefined ? { human } : { human, agent };
}

interface ValidatedNewWorkItemInput {
  tenant_id: string;
  title: string;
  spec: string;
  spec_format: string;
  depends_on: string[];
  /** The resolved CONTAINMENT parent: a parent id, or `null` for a
   *  root. Absent-or-null on the input both resolve to `null` here. */
  parent_id: string | null;
  /** Typed forward edges (supersedes primary); absent on the input resolves
   *  to `[]` here. Shape-validated; ids are ULID-checked at the chokepoint. */
  references: WorkItemReference[];
  created_by: ActorRef;
}

function validateNewWorkItemInput(input: unknown): ValidatedNewWorkItemInput {
  const raw = requireObject(input, 'create');
  assertNoReservedField(raw, 'create');
  return {
    tenant_id: requireOptionalString(raw['tenant_id'], 'tenant_id') ?? DEFAULT_TENANT_ID,
    title: requireNonEmptyString(raw['title'], 'title'),
    // `spec` is opaque: required-as-string, but never further inspected —
    // whatever bytes/text a tool supplies pass straight through unmodified.
    spec: requireNonEmptyString(raw['spec'], 'spec'),
    spec_format: requireNonEmptyString(raw['spec_format'], 'spec_format'),
    depends_on: raw['depends_on'] === undefined ? [] : requireStringArray(raw['depends_on'], 'depends_on'),
    // Containment parent: absent OR null both mean "create as a root".
    // Fully orthogonal to `depends_on` — never read against it here.
    parent_id: raw['parent_id'] === undefined ? null : requireNullableString(raw['parent_id'], 'parent_id'),
    references: raw['references'] === undefined ? [] : requireReferenceArray(raw['references'], 'references'),
    created_by: validateActorRef(raw['created_by'], 'created_by'),
  };
}

interface ValidatedUpdateMetaInput {
  title?: string;
  spec?: string;
  spec_format?: string;
  depends_on?: string[];
  /** Present iff the patch sets `parent_id`. ABSENT on this
   *  validated shape = leave unchanged; PRESENT (a string OR `null`) = the
   *  new value, where `null` clears the parent back to root. */
  parent_id?: string | null;
  /** Present iff the patch replaces the forward-edge list wholesale
   *  (`[]` clears every edge); ABSENT = unchanged — `depends_on`'s exact
   *  replace-semantics. */
  references?: WorkItemReference[];
}

function validateUpdateMetaInput(input: unknown): ValidatedUpdateMetaInput {
  const raw = requireObject(input, 'update_meta');
  assertNoReservedField(raw, 'update_meta');
  const out: ValidatedUpdateMetaInput = {};
  if (raw['title'] !== undefined) out.title = requireNonEmptyString(raw['title'], 'title');
  if (raw['spec'] !== undefined) out.spec = requireNonEmptyString(raw['spec'], 'spec');
  if (raw['spec_format'] !== undefined) out.spec_format = requireNonEmptyString(raw['spec_format'], 'spec_format');
  if (raw['depends_on'] !== undefined) out.depends_on = requireStringArray(raw['depends_on'], 'depends_on');
  // Tri-state: a `parent_id` key present with a string OR `null` is a
  // real set (`null` clears to root); a key absent (=== undefined) is left
  // unchanged. This is the one UpdateMeta field whose set value legitimately
  // includes `null` — see types.ts's `UpdateMetaInput.parent_id`.
  if (raw['parent_id'] !== undefined) out.parent_id = requireNullableString(raw['parent_id'], 'parent_id');
  if (raw['references'] !== undefined) out.references = requireReferenceArray(raw['references'], 'references');
  return out;
}

interface ValidatedAppendEventInput {
  item_id: string;
  actor: ActorRef;
  transition: string;
  claim_token?: number;
  note?: string;
  at: string;
}

function validateAppendEventInput(input: unknown, defaultAt: () => string): ValidatedAppendEventInput {
  const raw = requireObject(input, 'event');
  const item_id = requireNonEmptyString(raw['item_id'], 'item_id');
  const actor = validateActorRef(raw['actor'], 'actor');
  const transition = requireNonEmptyString(raw['transition'], 'transition');
  const claimTokenRaw = raw['claim_token'];
  if (claimTokenRaw !== undefined && typeof claimTokenRaw !== 'number') {
    throw new WorkStateError('SCHEMA', 'work-state store: field "claim_token" must be a number when present');
  }
  const note = requireOptionalString(raw['note'], 'note');
  const at = requireOptionalString(raw['at'], 'at') ?? defaultAt();
  return {
    item_id,
    actor,
    transition,
    ...(claimTokenRaw === undefined ? {} : { claim_token: claimTokenRaw }),
    ...(note === undefined ? {} : { note: gate(note) }),
    at,
  };
}

/** Row shape as returned by `SELECT * FROM items`. */
interface ItemRow {
  id: string;
  tenant_id: string;
  title: string;
  spec: string;
  spec_format: string;
  status: string;
  depends_on: string;
  /** The nullable CONTAINMENT column. A legacy read against a schema
   *  that predates the column would surface `undefined` — `rowToWorkItem`
   *  defaults that to `null` (a root). */
  parent_id: string | null;
  /** The forward-edge column (JSON array text). A legacy read against a
   *  pre-v3 schema (a below-current board opened read-only before the next
   *  write migrates it) would surface `undefined` — `rowToWorkItem` defaults
   *  that to `'[]'` (no edges), exactly `parent_id`'s defensive posture. */
  references: string;
  created_by_human: string;
  created_by_agent: string | null;
  created_at: string;
  updated_at: string;
  version: number | bigint;
  claim_holder_human: string | null;
  claim_holder_agent: string | null;
  claim_token: number | bigint | null;
  claim_acquired_at: string | null;
  claim_lease_expires: string | null;
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Row shape as returned by the PROJECTED items SELECT
 * ({@link selectItemSummaryRows}): every {@link ItemRow} column EXCEPT `spec`,
 * plus SQLite's own `LENGTH(spec)`. `spec` is present only when the caller
 * opted in.
 */
interface ItemSummaryRow extends Omit<ItemRow, 'spec'> {
  spec_length: number | bigint;
  spec?: string;
}

/**
 * Map every WorkItem field EXCEPT `spec` off a row. Shared by
 * {@link rowToWorkItem} (which adds the stored spec) and
 * {@link rowToWorkItemSummary} (which adds `spec_length` instead) so the two
 * reads can never drift on claim assembly, edge parsing or the legacy-column
 * defaults.
 */
function rowToItemFields(row: Omit<ItemRow, 'spec'>): Omit<WorkItem, 'spec'> {
  const claim: Claim | null =
    row.claim_token === null
      ? null
      : {
          holder:
            row.claim_holder_agent === null
              ? { human: row.claim_holder_human as string }
              : { human: row.claim_holder_human as string, agent: row.claim_holder_agent },
          claim_token: toNumber(row.claim_token),
          acquired_at: row.claim_acquired_at as string,
          lease_expires: row.claim_lease_expires as string,
        };
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    title: row.title,
    spec_format: row.spec_format,
    status: row.status as WorkItemStatus,
    claim,
    depends_on: JSON.parse(row.depends_on) as string[],
    // Always present on a read (mirrors `claim`), `null` for a root.
    // `?? null` defends a legacy read where the column is absent.
    parent_id: row.parent_id ?? null,
    // Always present on a read (mirrors `depends_on`), `[]` for no edges.
    // `?? '[]'` defends a legacy read where the pre-v3 column is absent.
    references: JSON.parse(row.references ?? '[]') as WorkItemReference[],
    created_by:
      row.created_by_agent === null
        ? { human: row.created_by_human }
        : { human: row.created_by_human, agent: row.created_by_agent },
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: toNumber(row.version),
  };
}

/** The full-fidelity mapping: every field plus the opaque `spec` body,
 *  exactly as stored. */
function rowToWorkItem(row: ItemRow): WorkItem {
  return { ...rowToItemFields(row), spec: row.spec };
}

/**
 * The projected mapping: every field EXCEPT `spec`, plus SQLite's own
 * `LENGTH(spec)` as `spec_length` — and `spec` itself ONLY when the projected
 * SELECT was asked to carry it. The key is omitted (not set to `undefined`),
 * so `JSON.stringify` of a default row has no `spec` key at all.
 */
function rowToWorkItemSummary(row: ItemSummaryRow): WorkItemSummary {
  return {
    ...rowToItemFields(row),
    spec_length: toNumber(row.spec_length),
    ...(row.spec === undefined ? {} : { spec: row.spec }),
  };
}

interface EventRow {
  seq: number | bigint;
  item_id: string;
  actor_human: string;
  actor_agent: string | null;
  transition: string;
  claim_token: number | bigint | null;
  note: string | null;
  at: string;
}

function rowToEvent(row: EventRow): WorkStateEvent {
  return {
    item_id: row.item_id,
    actor: row.actor_agent === null ? { human: row.actor_human } : { human: row.actor_human, agent: row.actor_agent },
    transition: row.transition,
    ...(row.claim_token === null ? {} : { claim_token: toNumber(row.claim_token) }),
    ...(row.note === null ? {} : { note: row.note }),
    at: row.at,
  };
}

function getItemRow(db: DatabaseSync, id: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
}

/**
 * The set of column names the `items` table CURRENTLY has. Every
 * migration-added column (`parent_id`, `"references"`) is optional in practice:
 * view reads go through openForRead, which by design does NOT migrate, so a
 * below-current board can be read before any write brings it forward. A
 * prepared SELECT naming an absent column throws `no such column` at PREPARE
 * time — before any row is read, so a per-row `?? null` could never fire — and
 * that is why every statement that names those columns EXPLICITLY (rather than
 * `SELECT *`) asks here first. Same `PRAGMA table_info` check schema.ts's
 * migrateSchema uses for its guarded ADD COLUMN.
 */
function itemColumns(db: DatabaseSync): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name));
}

/**
 * Build the reverse-edge map over EVERY item on the board: target id -> the
 * `{rel, id: referrer-id}` backlinks pointing at it. Scanned newest-created
 * first (the same order `listItems` emits), so each target's backlink list
 * reads newest-first, mirroring record/store.ts's readViews walk.
 *
 * The map is built from every row — NOT just the rows a list filter returns —
 * so a backlink is never missed just because the referring item didn't match
 * the filter (record/store.ts's exact completeness posture). Cost is one full
 * scan of a small board table; no index is added (GP-24's mechanical,
 * no-new-index posture).
 *
 * Legacy pre-v3 board (user_version < 3): the `"references"` column does not
 * exist yet, and a prepared SELECT naming it throws `no such column:
 * "references"` at PREPARE time — before any row is read, so a per-row
 * `?? '[]'` could never fire. View reads go through openForRead, which (by
 * design) does NOT migrate, so an unmigrated board would otherwise surface a
 * raw, untyped SQLite failure on a plain list/get. A pre-v3 board has no
 * edges by definition, so the guard returns an empty map; the migration rung
 * adds the column on the next write open. Same PRAGMA table_info existence
 * check schema.ts's migrateSchema uses for its guarded ADD COLUMN.
 */
function buildReferrerMap(db: DatabaseSync): Map<string, WorkItemReference[]> {
  const referrers = new Map<string, WorkItemReference[]>();
  if (!itemColumns(db).has('references')) return referrers; // legacy pre-v3 board — no edges by definition
  const rows = db
    .prepare('SELECT id, "references" FROM items ORDER BY created_at DESC, id DESC')
    .all() as unknown as { id: string; references: string }[];
  for (const row of rows) {
    for (const ref of JSON.parse(row.references ?? '[]') as WorkItemReference[]) {
      const list = referrers.get(ref.id);
      const back: WorkItemReference = { rel: ref.rel, id: row.id };
      if (list === undefined) referrers.set(ref.id, [back]);
      else list.push(back);
    }
  }
  return referrers;
}

/**
 * The one WHERE-clause builder every filtered-items SELECT shares (the full
 * read `selectItemRows` and the projected read `selectItemSummaryRows`): the
 * optional tenant/status filters plus the tri-state containment filter (see
 * {@link ListItemsFilter}). `= NULL` cannot be expressed via a bound param, so
 * the roots-only case emits the literal `parent_id IS NULL` clause with no
 * param; the children-of case binds the parent id. A `parent_id` key that is
 * absent (or present-but-undefined) applies no containment filter at all.
 */
function buildFilterClauses(filter?: ListItemsFilter): { clauses: string[]; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.tenant_id !== undefined) {
    clauses.push('tenant_id = ?');
    params.push(filter.tenant_id);
  }
  if (filter?.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter !== undefined && 'parent_id' in filter) {
    const parentFilter = filter.parent_id;
    if (parentFilter === null) {
      clauses.push('parent_id IS NULL');
    } else if (parentFilter !== undefined) {
      clauses.push('parent_id = ?');
      params.push(parentFilter);
    }
  }
  return { clauses, params };
}

/** The board's ONE stable list order — creation order, newest first, with the
 *  id as the tie-break that makes it total. Selection, never ranking (GP-27):
 *  a cursor over this order is a resumption point, not a priority. */
const LIST_ORDER_BY = 'ORDER BY created_at DESC, id DESC';

/**
 * The one FULL-FIDELITY filtered-items SELECT, shared by `listItems` and
 * `listItemViews`: every column including the opaque `spec` body, newest-
 * created-first, no limit. Internal TypeScript callers (context/
 * assemble-prototype.ts's reverse-edge sweep) depend on both properties.
 */
function selectItemRows(db: DatabaseSync, filter?: ListItemsFilter): ItemRow[] {
  const { clauses, params } = buildFilterClauses(filter);
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM items${where} ${LIST_ORDER_BY}`).all(...params) as unknown as ItemRow[];
}

/** Resolved (already validated/clamped) projection + keyset arguments for
 *  {@link selectItemSummaryRows}. */
interface SummarySelect {
  includeSpec: boolean;
  limit?: number;
  cursor?: ListCursor;
}

/**
 * The column list of the PROJECTED read. `spec` is named only when the caller
 * opted in; `LENGTH(spec)` is always computed IN SQL (the one source of truth
 * for `spec_length` — see the file header). The two migration-added columns
 * are substituted with their documented defaults when a below-current board
 * has not got them yet (see {@link itemColumns}), which keeps this read as
 * legacy-tolerant as the `SELECT *` path it sits beside.
 *
 * This is an explicit ALLOW-LIST, not a `SELECT *` minus `spec`: naming the
 * columns is what makes "this read never touches the spec body" true by
 * construction and grep-falsifiable. The cost of an allow-list is drift — a
 * column added to schema.ts's DDL and forgotten here would silently vanish
 * from every summary row — so it is EXPORTED purely so store.test.ts can hold
 * it against `PRAGMA table_info(items)` mechanically: the projection names
 * EVERY items column except exactly two — `spec` (replaced by `spec_length`)
 * and `claim_token_counter` (the internal monotonic fencing-token source,
 * which is not a `WorkItem` field and is absent from the full read's
 * {@link ItemRow} too). That test turns DDL drift into a failing build rather
 * than a silently missing field. Nothing outside this module calls this at
 * runtime.
 */
export function summaryColumns(db: DatabaseSync, includeSpec: boolean): string[] {
  const present = itemColumns(db);
  return [
    'id',
    'tenant_id',
    'title',
    'spec_format',
    'status',
    'depends_on',
    present.has('parent_id') ? 'parent_id' : 'NULL AS parent_id',
    present.has('references') ? '"references"' : `'[]' AS "references"`,
    'created_by_human',
    'created_by_agent',
    'created_at',
    'updated_at',
    'version',
    'claim_holder_human',
    'claim_holder_agent',
    'claim_token',
    'claim_acquired_at',
    'claim_lease_expires',
    'LENGTH(spec) AS spec_length',
    ...(includeSpec ? ['spec'] : []),
  ];
}

/**
 * The PROJECTED, keyset-paged filtered-items SELECT.
 *
 * KEYSET, not OFFSET: the page boundary is the last row's `(created_at, id)`
 * pair, so a row inserted (or removed) between two page fetches cannot shift
 * the window and make an unseen row skip past it — the property an OFFSET
 * page loses the moment the board is written to concurrently, and the reason
 * this shape is also the one expressible on a future remote backend. The
 * predicate is written out as an explicit OR rather than an SQL row-value
 * comparison for exactly that portability.
 *
 * Returns up to `limit + 1` rows on purpose: the extra PROBE row is how the
 * caller learns whether a next page exists without a second COUNT query. It is
 * never returned to a caller — {@link WorkStateStore.listItemSummaryViews}
 * slices it off.
 */
function selectItemSummaryRows(db: DatabaseSync, filter: ListItemsFilter | undefined, select: SummarySelect): ItemSummaryRow[] {
  const { clauses, params } = buildFilterClauses(filter);
  if (select.cursor !== undefined) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(select.cursor.created_at, select.cursor.created_at, select.cursor.id);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  let limitClause = '';
  if (select.limit !== undefined) {
    limitClause = ' LIMIT ?';
    params.push(select.limit + 1);
  }
  const columns = summaryColumns(db, select.includeSpec).join(', ');
  return db
    .prepare(`SELECT ${columns} FROM items${where} ${LIST_ORDER_BY}${limitClause}`)
    .all(...params) as unknown as ItemSummaryRow[];
}

/** The single INSERT this module ever issues against `events`. A standalone
 *  function (not a class method) — it touches no store instance state — so
 *  both the class's own `appendEvent` and the internal-but-exported
 *  `appendEventRowOn` (below) share the exact one statement. */
function insertEventRow(db: DatabaseSync, event: ValidatedAppendEventInput): void {
  db.prepare(
    `INSERT INTO events (item_id, actor_human, actor_agent, transition, claim_token, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.item_id,
    event.actor.human,
    event.actor.agent ?? null,
    event.transition,
    event.claim_token ?? null,
    event.note ?? null,
    event.at,
  );
}

/**
 * Append one immutable transition event on an ALREADY-OPEN connection, for a
 * caller that is running its own `BEGIN IMMEDIATE ... COMMIT` unit and needs
 * the event insert to commit atomically with the state transition it records
 * (every transition appends an immutable event — a crash between a
 * transition's own commit and a separately-connected event insert would
 * otherwise leave the transition unaudited). Internal-but-exported:
 * not part of `WorkStateStore`'s public surface (siblings import it
 * directly), but validation — including the secret gate on `note` — is
 * IDENTICAL to `appendEvent`'s; this is not a relaxed or partial path.
 * Callers own `db`'s lifecycle (open/transaction/close) entirely; this
 * function neither opens nor closes it, and neither begins nor commits/rolls
 * back the transaction.
 */
export function appendEventRowOn(db: DatabaseSync, input: unknown, defaultAt: () => string): WorkStateEvent {
  const validated = validateAppendEventInput(input, defaultAt);
  insertEventRow(db, validated);
  return {
    item_id: validated.item_id,
    actor: validated.actor,
    transition: validated.transition,
    ...(validated.claim_token === undefined ? {} : { claim_token: validated.claim_token }),
    ...(validated.note === undefined ? {} : { note: validated.note }),
    at: validated.at,
  };
}

/**
 * The work-state store. One instance per (session, database file); its
 * ULID generator carries the per-session entropy convention shared with the
 * process record store (record/id.ts).
 *
 * Every public method opens its own connection and closes it before
 * returning — see schema.ts's file header for the lazy-init rationale this
 * protects. `get`/`list`/`events` never create the database file; `insert`,
 * `updateMeta`, `appendEvent`, and `nextClaimToken` do (on first call).
 */
export class WorkStateStore {
  readonly #dbPath: string;
  readonly #clock: Clock;
  readonly #nextId: UlidGenerator;

  constructor(dbPath: string, clock: Clock) {
    this.#dbPath = dbPath;
    this.#clock = clock;
    this.#nextId = createUlidGenerator(clock);
  }

  /** The resolved database file path this store reads/writes. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /**
   * Insert a new work item. Assigns a fresh ULID id, `status: 'open'`,
   * `claim: null`, `version: 1`, and stamps `created_at`/`updated_at` from
   * the injected clock. Appends the immutable `create` event. `title` is
   * gated through the secret scanner before persist; `spec` is stored as-is
   * (never gated, never parsed).
   */
  insertItem(input: unknown): WorkItem {
    const validated = validateNewWorkItemInput(input);
    assertReferenceIdsAreUlids(validated.references, 'create');
    const db = openForWrite(this.#dbPath);
    try {
      const id = this.#nextId();
      const now = this.#clock().toISOString();
      const title = gate(validated.title);
      // Gate both members of every edge — same gate-before-persist posture as
      // `title`; rel tokens and ULIDs never match a secret pattern, so this is
      // a no-op in practice but keeps the invariant total (record/store.ts's
      // exact posture on its own references field).
      const references = gateReferences(validated.references);
      // The item insert and its `create` event commit as ONE atomic unit —
      // otherwise these would be two separate auto-committing statements on
      // the same connection, so a crash between them could leave an item with
      // no `create` event, violating the "every transition appends an
      // immutable event" invariant. The BEGIN IMMEDIATE/COMMIT/ROLLBACK
      // boilerplate lives in tx.ts's `withWriteTransaction`, which also
      // re-types an exhausted busy_timeout as `WorkStateError('BUSY', ...)`
      // instead of letting a raw node:sqlite lock error escape.
      withWriteTransaction(db, (db) => {
        db.prepare(
          `INSERT INTO items (
            id, tenant_id, title, spec, spec_format, status, depends_on, parent_id, "references",
            created_by_human, created_by_agent, created_at, updated_at, version,
            claim_token_counter, claim_holder_human, claim_holder_agent,
            claim_token, claim_acquired_at, claim_lease_expires
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL)`,
        ).run(
          id,
          validated.tenant_id,
          title,
          validated.spec,
          validated.spec_format,
          JSON.stringify(validated.depends_on),
          validated.parent_id,
          JSON.stringify(references),
          validated.created_by.human,
          validated.created_by.agent ?? null,
          now,
          now,
        );
        insertEventRow(db, {
          item_id: id,
          actor: validated.created_by,
          transition: 'create',
          at: now,
        });
      });
      const row = getItemRow(db, id);
      if (row === undefined) throw new WorkStateError('SCHEMA', 'work-state store: insert did not persist the row');
      return rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /** Fetch one work item by id, or `null` if it does not exist (or the
   *  database has never been written to). Never creates the database file. */
  getItem(id: string): WorkItem | null {
    const db = openForRead(this.#dbPath);
    if (db === null) return null;
    try {
      const row = getItemRow(db, id);
      return row === undefined ? null : rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /**
   * Like {@link getItem}, but the returned item carries its DERIVED reverse
   * edges in `referenced_by` — so a caller reading a superseded item sees what
   * replaced it without scanning the board itself. The backlink map is built
   * from EVERY item on the board (see {@link buildReferrerMap}), never
   * persisted. Never creates the database file.
   */
  getItemView(id: string): WorkItemView | null {
    const db = openForRead(this.#dbPath);
    if (db === null) return null;
    try {
      const row = getItemRow(db, id);
      if (row === undefined) return null;
      const referrers = buildReferrerMap(db);
      return { ...rowToWorkItem(row), referenced_by: referrers.get(row.id) ?? [] };
    } finally {
      db.close();
    }
  }

  /** List work items, newest-created-first, optionally filtered by tenant
   *  and/or status — SELECTION only, never ranking. Never creates the
   *  database file. */
  listItems(filter?: ListItemsFilter): WorkItem[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      return selectItemRows(db, filter).map(rowToWorkItem);
    } finally {
      db.close();
    }
  }

  /**
   * Like {@link listItems}, but each returned item carries its DERIVED
   * reverse edges in `referenced_by` — the list-twin of {@link getItemView},
   * mirroring record/store.ts's readViews. The backlink map is built over
   * EVERY item on the board, including ones the filter excludes from the
   * result, so a returned item's backlink is never missed just because the
   * referring item didn't match the filter. Never creates the database file.
   */
  listItemViews(filter?: ListItemsFilter): WorkItemView[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      const rows = selectItemRows(db, filter);
      const referrers = buildReferrerMap(db);
      return rows.map((row) => ({ ...rowToWorkItem(row), referenced_by: referrers.get(row.id) ?? [] }));
    } finally {
      db.close();
    }
  }

  /**
   * The PROJECTED, keyset-paged twin of {@link listItemViews}: the same
   * filtered, newest-created-first selection and the same DERIVED
   * `referenced_by` backlinks, but WITHOUT the opaque `spec` body — each item
   * carries `spec_length` instead (computed in SQL; see the file header), and
   * `spec` returns only when `page.include_spec` is set.
   *
   * Absent page options mean "behave like the unpaginated read": no `LIMIT`
   * clause, `next_cursor: null`. A present `limit` is clamped into
   * `[1, MAX_LIST_LIMIT]` ({@link clampListLimit}); a present `cursor` resumes
   * after that boundary. BOTH are validated BEFORE the database is opened, so
   * a malformed cursor is a typed SCHEMA error even on a board that does not
   * exist yet — never a silent empty page a caller would read as "the board
   * ended".
   *
   * NO server-side cursor state exists: a cursor encodes only a position in
   * the board's stable creation order, so changing `filter` between pages
   * INVALIDATES it (the same position is now a position in a different
   * selection). Walk one filter to exhaustion, then start the next.
   *
   * Never creates the database file.
   */
  listItemSummaryViews(filter?: ListItemsFilter, page?: ListPageOptions): ListItemsPage<WorkItemSummaryView> {
    // Validate first, open second (see the doc comment): an empty board must
    // not swallow a malformed cursor.
    const limit = page?.limit === undefined ? undefined : clampListLimit(page.limit);
    const cursor = page?.cursor === undefined ? undefined : decodeListCursor(page.cursor);
    const db = openForRead(this.#dbPath);
    if (db === null) return { items: [], next_cursor: null };
    try {
      const rows = selectItemSummaryRows(db, filter, {
        includeSpec: page?.include_spec === true,
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      // The probe row (limit + 1) is proof that a next page exists; it is
      // sliced off rather than returned.
      const hasMore = limit !== undefined && rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      // Built over EVERY item on the board, exactly as the unpaginated view
      // read does — so an item's backlinks never depend on which page it
      // landed on.
      const referrers = buildReferrerMap(db);
      const last = pageRows[pageRows.length - 1];
      return {
        items: pageRows.map((row) => ({ ...rowToWorkItemSummary(row), referenced_by: referrers.get(row.id) ?? [] })),
        next_cursor: hasMore && last !== undefined ? encodeListCursor(last.created_at, last.id) : null,
      };
    } finally {
      db.close();
    }
  }

  /**
   * Every item's `(id, parent_id, status)` triple — the whole board, no
   * filter, and deliberately NO `spec`. This is the read verbs.ts's
   * containment gate needs: that gate must consult every item (a parent stays
   * non-claimable even when its pending child is excluded by a filter or falls
   * on a different page), and loading 100+ opaque spec bodies to answer a
   * question about three columns is exactly the payload blowup the projected
   * read exists to avoid. Never creates the database file.
   */
  listContainmentRows(): ContainmentRow[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      // `parent_id` is named explicitly, so a below-current board that predates
      // the column gets the documented default rather than a prepare-time
      // `no such column` throw (see {@link itemColumns}).
      const parentColumn = itemColumns(db).has('parent_id') ? 'parent_id' : 'NULL AS parent_id';
      const rows = db.prepare(`SELECT id, ${parentColumn}, status FROM items`).all() as unknown as {
        id: string;
        parent_id: string | null;
        status: string;
      }[];
      return rows.map((row) => ({ id: row.id, parent_id: row.parent_id ?? null, status: row.status as WorkItemStatus }));
    } finally {
      db.close();
    }
  }

  /**
   * The metadata-update storage primitive (`update_meta`'s persistence
   * layer). Applies only the fields present on `patch`; bumps `version` by
   * exactly 1 and stamps `updated_at`. Throws `NOT_FOUND` if the item does
   * not exist, `VERSION_CONFLICT` if `expectedVersion` does not match the
   * item's current version. Cycle detection over `depends_on` is a verb-level
   * concern — not enforced here.
   */
  updateMeta(id: string, expectedVersion: number, patch: unknown): WorkItem {
    const validated = validateUpdateMetaInput(patch);
    if (validated.references !== undefined) assertReferenceIdsAreUlids(validated.references, 'update_meta');
    const db = openForWrite(this.#dbPath);
    try {
      const current = getItemRow(db, id);
      if (current === undefined) {
        throw new WorkStateError('NOT_FOUND', `work-state store: no item with id ${JSON.stringify(id)}`);
      }
      if (toNumber(current.version) !== expectedVersion) {
        throw new WorkStateError(
          'VERSION_CONFLICT',
          `work-state store: update_meta expected version ${String(expectedVersion)} but item ${id} is at version ${String(toNumber(current.version))}`,
        );
      }
      const now = this.#clock().toISOString();
      const nextTitle = validated.title === undefined ? current.title : gate(validated.title);
      const nextSpec = validated.spec === undefined ? current.spec : validated.spec;
      const nextSpecFormat = validated.spec_format === undefined ? current.spec_format : validated.spec_format;
      const nextDependsOn = validated.depends_on === undefined ? current.depends_on : JSON.stringify(validated.depends_on);
      // Tri-state: absent on the validated patch (=== undefined) leaves
      // the stored parent unchanged; present (a string OR null) is the new
      // value, null clearing to root. `?? null` on the current value defends a
      // legacy read whose column predates the migration. Orthogonal to
      // `depends_on` — this never reads or writes the dependency column.
      const nextParentId = validated.parent_id === undefined ? (current.parent_id ?? null) : validated.parent_id;
      // Wholesale replace (depends_on's exact semantics): absent leaves the
      // stored edge list unchanged; present — including `[]`, which clears
      // every edge — is the new full list, gated before persist like every
      // other free-text field. `?? '[]'` defends a legacy pre-v3 row.
      const nextReferences =
        validated.references === undefined ? (current.references ?? '[]') : JSON.stringify(gateReferences(validated.references));
      // The version predicate lives in the UPDATE itself (the check above
      // alone is a TOCTOU window — a concurrent update_meta between the SELECT
      // and this write would be silently overwritten). The pre-check stays for
      // the precise typed error; this WHERE clause is the actual guarantee.
      // This bare autocommit statement is wrapped in `withBusyWrap` (tx.ts) so
      // an exhausted busy_timeout surfaces as a typed `WorkStateError('BUSY',
      // ...)` rather than a raw node:sqlite lock error.
      const result = withBusyWrap(() =>
        db
          .prepare(
            `UPDATE items SET title = ?, spec = ?, spec_format = ?, depends_on = ?, parent_id = ?, "references" = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
          )
          .run(nextTitle, nextSpec, nextSpecFormat, nextDependsOn, nextParentId, nextReferences, now, id, expectedVersion),
      );
      if (result.changes !== 1) {
        throw new WorkStateError(
          'VERSION_CONFLICT',
          `work-state store: update_meta lost a concurrent race on item ${id} (expected version ${String(expectedVersion)})`,
        );
      }
      const row = getItemRow(db, id);
      if (row === undefined) throw new WorkStateError('SCHEMA', 'work-state store: update_meta did not persist the row');
      return rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /**
   * Append one immutable transition event, opening (and committing) its OWN
   * connection. `note`, when present, is gated through the secret scanner
   * before persist. This is the standalone entry point for a caller that has
   * no already-open transaction of its own to fold the event into; a caller
   * that DOES (claims.ts, expiry.ts, verbs.ts's `transitionStatus`) uses
   * {@link appendEventRowOn} instead, so the event commits
   * atomically with the transition it records rather than on a second,
   * separate connection.
   */
  appendEvent(input: unknown): WorkStateEvent {
    const validated = validateAppendEventInput(input, () => this.#clock().toISOString());
    const db = openForWrite(this.#dbPath);
    try {
      // Bare autocommit INSERT, wrapped so an exhausted busy_timeout
      // surfaces as a typed `WorkStateError('BUSY', ...)`.
      withBusyWrap(() => insertEventRow(db, validated));
      return {
        item_id: validated.item_id,
        actor: validated.actor,
        transition: validated.transition,
        ...(validated.claim_token === undefined ? {} : { claim_token: validated.claim_token }),
        ...(validated.note === undefined ? {} : { note: validated.note }),
        at: validated.at,
      };
    } finally {
      db.close();
    }
  }

  /** All events for one item, oldest first — the full immutable audit trail.
   *  Never creates the database file. */
  events(itemId: string): WorkStateEvent[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      const rows = db.prepare('SELECT * FROM events WHERE item_id = ? ORDER BY seq ASC').all(itemId) as unknown as EventRow[];
      return rows.map(rowToEvent);
    } finally {
      db.close();
    }
  }

  /**
   * Atomically increment and return the per-item claim-token counter. This
   * is the fencing-token monotonicity source: a counter column on
   * the item row, so a token is never reused even after a claim is released
   * or a lease expires and the claim fields are cleared. Building the actual
   * claim/renew/complete compare-and-set on top of this primitive is
   * claims.ts's scope.
   */
  nextClaimToken(id: string): number {
    const db = openForWrite(this.#dbPath);
    try {
      // Bare autocommit UPDATE...RETURNING, wrapped so an exhausted
      // busy_timeout surfaces as a typed `WorkStateError('BUSY', ...)`.
      const row = withBusyWrap(() =>
        db
          .prepare('UPDATE items SET claim_token_counter = claim_token_counter + 1 WHERE id = ? RETURNING claim_token_counter')
          .get(id) as { claim_token_counter: number | bigint } | undefined,
      );
      if (row === undefined) {
        throw new WorkStateError('NOT_FOUND', `work-state store: no item with id ${JSON.stringify(id)}`);
      }
      return toNumber(row.claim_token_counter);
    } finally {
      db.close();
    }
  }
}

export type { NewWorkItemInput, UpdateMetaInput, AppendEventInput };
