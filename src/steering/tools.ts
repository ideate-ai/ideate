// plugin/src/steering/tools.ts — the two LIGHT steering MCP verbs.
//
// Design goal: minimal read/write verbs. Keep the surface tiny, with lean,
// strict contracts:
//
//   - `steering_read`  — SELECTION only (by id / domain / status / kind).
//     Substring + exact-field filters. No scoring, no ranking — ranking is the
//     assembler's job over the selected set, never the store's. Each item
//     carries its forward `references` and its DERIVED `referenced_by`
//     backlinks (e.g. `superseded_by`). BOUNDED: projected (no `history` by
//     default), keyset-paged over `(updated_at, id)`, and capped by the shared
//     payload budget — see below.
//   - `steering_put`   — create-or-amend ONE item. On amend, the prior version
//     is appended to `amendment_history` and status may flip; no hard delete
//     (deprecate via status). This is the one mutable verb. A `supersedes`
//     (or general `references`) argument records a typed FORWARD edge naming a
//     DIFFERENT item this one replaces — cross-item supersession, additive
//     with the within-item lifecycle.
//
// GP-23 GATE. Nothing that shapes what a model attends to ships live ahead of
// the eval that measures it, and steering IS attention-shaping. So both verbs
// are gated behind a config flag `steering.enabled` in `.ideate.json`, default
// ABSENT -> false. The flag is read DIRECTLY off the raw config JSON
// (mirroring work-state/priming-hook.ts's readClaimPrimingFlag), which keeps
// the check read-only and side-effect-free: it never triggers loadConfig's
// lazy-init of `.ideate.json`/the record dir, and NO environment variable is
// consulted. While the flag is off (the only state today) each verb returns a
// typed GATED marker and writes NOTHING.
//
// SIDE-EFFECT-FREE REGISTRATION (matches record/tools.ts, work-state/tools.ts):
// building the registrar and calling it registers the two tools and touches no
// filesystem. The store is composed lazily inside the first ENABLED tool call,
// so a gated-off server never creates the steering directory. Construction is
// pure — no reads, no writes, nothing on stdout.
//
// Parameter schemas reuse the SDK's own exported zod instances (CursorSchema =
// z.string(), ProgressSchema.shape.progress = z.number()), exactly as
// record/tools.ts does, so no zod dependency is added to the plugin.
//
// BOUNDING `steering_read` — three bounds, all at THIS door. Unbounded, the
// verb returned every item with its full amendment trail in one result: 55,997
// characters over this project's own 103-item store, already past the 40,000
// character payload budget the board adopted, and the skills call it with NO
// arguments at all (skills/refine, skills/init), so "just require a filter" was
// never an option. The three bounds are (1) a PROJECTION — `history` omitted,
// `history_length` kept, `include_history` to opt back in; (2) KEYSET PAGING
// over `(updated_at, id)` with a default `limit` applied HERE, never in the
// store (see DEFAULT_STEERING_READ_LIMIT — the store's unbounded read is what
// context/assemble-prototype.ts's supersession sweep depends on); and (3) the
// SHARED payload budget (transport/payload-budget.ts), which can close a page
// short of `limit`. The `statement` is deliberately NOT projectable: it is
// two-thirds of the payload, but the statement IS the rule, so paging and the
// budget — not projection — are what actually bound this read.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CursorSchema, ProgressSchema, ToolAnnotationsSchema } from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistrar } from '../server.js';
import type { Clock } from '../record/id.js';
import { LIST_PAYLOAD_BUDGET_CHARS, applyListPayloadBudget, measureCompactItemChars } from '../transport/payload-budget.js';
import { STEERING_STATUSES, SteeringSchemaError, isSteeringId } from './schema.js';
import type { SteeringAmendment, SteeringReference, SteeringStatus } from './schema.js';
import { MAX_STEERING_READ_LIMIT, SteeringStore } from './store.js';
import type { PutResult, SteeringItemView, SteeringPageOptions, SteeringReadOptions } from './store.js';

/** The complete steering tool surface — two verbs, one mutable, no hard delete. */
export const STEERING_TOOL_NAMES = ['steering_read', 'steering_put'] as const;

/** Real zod string, borrowed from the SDK's own exported schema. */
const zString = CursorSchema; // a plain z.string()
/** …and a real zod number/boolean, from the SDK's own exported schemas
 *  (record/tools.ts and work-state/tools.ts borrow the same two), so the plugin
 *  still adds no zod dependency of its own. */
const zNumber = ProgressSchema.shape.progress; // a plain z.number()
const zBoolean = ToolAnnotationsSchema.shape.readOnlyHint.unwrap(); // a plain z.boolean()

/**
 * The DEFAULT page size for `steering_read`, applied HERE at the transport and
 * NOWHERE else. This is the single most load-bearing placement decision in the
 * bounded read: `SteeringStore.readViews()` with no page options still returns
 * EVERY item, which is exactly what context/assemble-prototype.ts's steering
 * sweep needs — it derives `supersedes` backlinks across the whole set and
 * emits superseded-candidate entries, so a default parked in the store would
 * silently truncate that sweep and destroy supersession detection with no
 * error anywhere. The MCP verb is the only door that needs bounding (there is
 * no steering CLI), so the default lives at that door.
 */
export const DEFAULT_STEERING_READ_LIMIT = 100;

/** Options for the registrar factory — all defaulted at the composition edge. */
export interface SteeringToolsOptions {
  /** Project root the steering store lives under. Default: `process.cwd()` at first call. */
  projectRoot?: string;
  /** Override the resolved steering directory (probe seam for the future config resolver). */
  steeringPath?: string;
  /** Injected clock. Default: wall clock — this factory is the outermost composition edge. */
  clock?: Clock;
}

/**
 * Read the `steering.enabled` flag directly off `<projectRoot>/.ideate.json`.
 * A missing file, unparseable JSON, a non-object shape, an absent `steering`
 * block, or any `enabled` value other than the literal `true` all resolve to
 * `false` — a read-only probe that never throws and never writes.
 */
export function readSteeringEnabledFlag(projectRoot: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, '.ideate.json'), 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const steering = (parsed as Record<string, unknown>)['steering'];
  if (steering === null || typeof steering !== 'object' || Array.isArray(steering)) return false;
  return (steering as Record<string, unknown>)['enabled'] === true;
}

/** The gated-off marker both verbs return while `steering.enabled` is not true. */
function gatedResult(): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: 'GATED',
          reason:
            'steering is gated OFF (GP-23): set steering.enabled=true in .ideate.json to enable the steering verbs. ' +
            'Steering shapes what a model attends to and ships dark until the eval validates it.',
        }),
      },
    ],
    isError: true,
  };
}

/** Shape a PutResult into a CallToolResult. */
function putToolResult(result: PutResult): CallToolResult {
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code: result.code, reason: result.reason }) }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, id: result.item.id, status: result.item.status, amended: result.amended }),
      },
    ],
  };
}

function normalizeStatus(value: string | undefined): SteeringStatus | undefined {
  if (value === undefined) return undefined;
  return STEERING_STATUSES.includes(value as SteeringStatus) ? (value as SteeringStatus) : undefined;
}

/**
 * Assemble the forward-edge list from steering_put's two edge arguments: the
 * ergonomic `supersedes` (a single steering id → a `supersedes` edge naming
 * the DIFFERENT item this one replaces) and the general `references` escape
 * hatch (a JSON array of `{rel, id}` for arbitrary typed edges). The JSON
 * envelope is parsed here; each edge id is validated as a well-formed steering
 * id so a typo is rejected with a typed SCHEMA error at the tool layer before
 * it can persist as a silent dangling edge. (The store re-validates — and
 * existence-checks — at the write chokepoint, defense in depth for transports
 * that bypass this function. Mirrors record/tools.ts's referencesFromArgs,
 * adapted to this store's caller-chosen stem ids.)
 */
function referencesFromArgs(
  supersedes: string | undefined,
  referencesJson: string | undefined,
): { refs: SteeringReference[] } | { error: string } {
  const refs: SteeringReference[] = [];
  if (supersedes !== undefined && supersedes !== '') {
    if (!isSteeringId(supersedes)) {
      return { error: `supersedes: ${JSON.stringify(supersedes)} is not a well-formed steering id` };
    }
    refs.push({ rel: 'supersedes', id: supersedes });
  }
  if (referencesJson !== undefined && referencesJson !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(referencesJson);
    } catch {
      return { error: 'references: not valid JSON (expected an array of {rel, id})' };
    }
    if (!Array.isArray(parsed)) return { error: 'references: must be a JSON array of {rel, id}' };
    for (const item of parsed) {
      const ref = item as SteeringReference;
      if (typeof ref?.rel !== 'string' || ref.rel.length === 0) {
        return { error: 'references: rel must be a non-empty string' };
      }
      if (typeof ref?.id !== 'string' || !isSteeringId(ref.id)) {
        return { error: `references: id ${JSON.stringify(ref?.id)} is not a well-formed steering id` };
      }
      refs.push({ rel: ref.rel, id: ref.id });
    }
  }
  return { refs };
}

/**
 * A malformed ARGUMENT as a typed SCHEMA tool failure — a bad `references`
 * payload on put (which never persists), or a bad `limit`/`cursor` on read.
 * One shape for both verbs so a caller sees one failure taxonomy.
 */
function schemaErrorResult(reason: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'SCHEMA', reason }) }],
    isError: true,
  };
}

/**
 * One row of `steering_read`'s PROJECTED page: the full item view minus the
 * amendment trail, plus `history_length`, with `history` restored only when
 * the caller opted in.
 */
export type SteeringReadRow = Omit<SteeringItemView, 'history'> & { history_length: number; history?: SteeringAmendment[] };

/**
 * Project one item for the wire: DROP `history` unless asked for, and always
 * report `history_length`.
 *
 * WHY drop it by default. `history` is the only term of a steering item that
 * grows without bound — every `put` pushes the prior `{at, status, statement}`
 * (store.ts), and a statement averages a few hundred characters, so a store
 * whose rules have each been amended a handful of times carries several times
 * its own live text in superseded text. Measured on this project's 103-item
 * store the trail is only 686 characters TODAY (exactly one amendment exists),
 * which is precisely why the guard is cheap to take now: there is almost no
 * amendment trail to migrate around. The statement itself is NOT projectable —
 * the statement IS the rule — so paging plus the payload budget is what
 * actually bounds this read; dropping `history` is the forward guard, not the
 * fix.
 *
 * WHY `history_length` is present in BOTH modes rather than only when history
 * is omitted: it is the board's `spec_length` precedent exactly — a projected
 * read must still let a reader tell an AMENDED rule from a virgin one (and
 * decide whether the trail is worth a second call), and a field that appears
 * and disappears with a flag is a field callers write conditionals around. It
 * costs ~18 characters per row, under 5% of a full page, against a `history`
 * key that is unbounded.
 */
function projectSteeringView(item: SteeringItemView, includeHistory: boolean): SteeringReadRow {
  const { history, ...rest } = item;
  return { ...rest, history_length: history.length, ...(includeHistory ? { history } : {}) };
}

/**
 * Build the registrar for the two steering verbs. Matches server.ts's
 * `ToolRegistrar` shape. Calling the registrar registers the tools and does
 * NOTHING else — the store is composed lazily inside the first ENABLED call.
 */
export function createSteeringToolsRegistrar(options: SteeringToolsOptions = {}): ToolRegistrar {
  let store: SteeringStore | undefined;

  const getStore = (projectRoot: string): SteeringStore => {
    if (store === undefined) {
      const clock = options.clock ?? (() => new Date());
      store = new SteeringStore(projectRoot, clock, options.steeringPath === undefined ? undefined : { steeringPath: options.steeringPath });
    }
    return store;
  };

  return (server: McpServer): void => {
    server.registerTool(
      'steering_read',
      {
        description:
          'Read steering items (guiding principles + policies): selection-only by id (exact), domain (substring), status, and kind. ' +
          'Unranked by contract — no scoring; ranking is the assembler’s job over the selected set. ' +
          'Each item carries its forward `references` and its DERIVED `referenced_by` backlinks, so a superseded ' +
          'item shows what superseded it. PROJECTED BY DEFAULT: the `history` amendment trail is OMITTED and every item ' +
          'instead carries history_length (how many prior versions exist, 0 for a never-amended item) — set ' +
          'include_history: true to get the trail back. To retrieve ONE item in full, pass its id (exact match) with ' +
          'include_history: true. PAGED: at most `limit` items per call (default ' +
          `${String(DEFAULT_STEERING_READ_LIMIT)}, clamped into 1..${String(MAX_STEERING_READ_LIMIT)}` +
          '), newest-updated first (updated_at descending, id ascending as the tie-break); the result is ' +
          '{ok, items, next_cursor} — next_cursor is a string when more matching items remain and null ONLY at true ' +
          'exhaustion, so exhausting a selection means following next_cursor, passing it back as `cursor`, until it is ' +
          'null. A page may also be SHORTER than `limit` to stay within a payload size budget (roughly ' +
          `${String(LIST_PAYLOAD_BUDGET_CHARS)}` +
          ' characters of items — a page of steering statements reaches it well before 100 items), so never read a ' +
          'short page as "done". The cursor is OPAQUE (never construct or parse one; a malformed cursor is a typed ' +
          'SCHEMA error, never an empty page) and is tied to the filters it was issued for — changing id/domain/status/kind ' +
          'between pages invalidates it. CAVEAT (P-52): steering items are MUTABLE and every steering_put restamps ' +
          'updated_at, which is the field this order and cursor are keyed on — amending an item part-way through a ' +
          'walk moves it to the front of the order, so a not-yet-reached item can be pushed past your cursor and ' +
          'missed by that walk. Re-run a walk that must not miss an amendment. Gated OFF by default (GP-23).',
        inputSchema: {
          id: zString.describe('Exact item id (e.g. GP-21) — the by-id retrieval path; pair with include_history for the full item.').optional(),
          domain: zString.describe('Case-insensitive substring filter matched against the item domain.').optional(),
          status: zString.describe(`Exact lifecycle status filter: ${STEERING_STATUSES.join(' | ')}.`).optional(),
          kind: zString.describe('Exact kind filter: guiding-principle | policy | …').optional(),
          include_history: zBoolean
            .describe('Include the full `history` amendment trail on every returned item (default false — history_length is present either way, and paging applies regardless).')
            .optional(),
          limit: zNumber
            .int()
            .describe(`Maximum items in this page. Default ${String(DEFAULT_STEERING_READ_LIMIT)}; clamped into 1..${String(MAX_STEERING_READ_LIMIT)}.`)
            .optional(),
          cursor: zString
            .describe('Opaque resumption point: the next_cursor from the previous page. Invalidated by changing any filter.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const projectRoot = options.projectRoot ?? process.cwd();
        // THE GATE STAYS FIRST — ahead of argument validation, cursor decoding
        // and any store touch. A gated project must not be able to learn
        // anything from an error message (not even that its cursor was
        // malformed), and must never cause the steering directory to be
        // created just by calling with bad arguments.
        if (!readSteeringEnabledFlag(projectRoot)) return gatedResult();
        const status = normalizeStatus(args.status);
        const read: SteeringReadOptions = {
          ...(args.id === undefined ? {} : { id: args.id }),
          ...(args.domain === undefined ? {} : { domain: args.domain }),
          ...(status === undefined ? {} : { status }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        };
        // The DEFAULT page size is applied HERE, at the transport boundary —
        // never in the store, whose absent-limit behavior stays "every matching
        // item" for the in-repo sweep (context/assemble-prototype.ts, which
        // needs every item to derive supersession). Clamping and cursor
        // decoding stay in the store, beside the order they are predicates on.
        const page: SteeringPageOptions = {
          limit: args.limit ?? DEFAULT_STEERING_READ_LIMIT,
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        };
        try {
          // readViewsPage attaches derived `referenced_by` backlinks (e.g.
          // superseded_by) from the WHOLE store, then takes one keyset page.
          const raw = getStore(projectRoot).readViewsPage(read, page);
          // PROJECT before BUDGETING: the budget must measure the bytes this
          // transport actually writes, and the projection is what decides them.
          const projected = raw.items.map((item) => projectSteeringView(item, args.include_history === true));
          // …and the payload BUDGET on top: `limit` bounds the item COUNT, this
          // bounds the characters those items serialize to (transport/
          // payload-budget.ts — ONE budget, ONE implementation, shared with the
          // board's doors). A page shortened here still carries an honest
          // next_cursor, rebuilt from its last included row — over `updated_at`,
          // this store's sort key, which is why the key is passed explicitly.
          // The COMPACT measure is the right one: the SDK writes this result as
          // `JSON.stringify(body)` with no indent.
          const result = applyListPayloadBudget({ items: projected, next_cursor: raw.next_cursor }, measureCompactItemChars, (item) => item.updated_at);
          // NO `count`: under paging it would read as "how many there are" but
          // could only mean "how many on this page" — items.length already says
          // that, and next_cursor is the only honest answer to "is there more".
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, items: result.items, next_cursor: result.next_cursor }) }] };
        } catch (err) {
          // A malformed limit/cursor is THIS seam's typed error
          // (SteeringSchemaError, never the board's WorkStateError — GP-26),
          // surfaced as a typed SCHEMA failure rather than a silent empty page.
          if (err instanceof SteeringSchemaError) return schemaErrorResult(err.message);
          throw err;
        }
      },
    );

    server.registerTool(
      'steering_put',
      {
        description:
          'Create or amend one steering item (a guiding principle or policy). On amend the prior version is appended to ' +
          'amendment_history and status may flip; there is no hard delete — deprecate via status. To REPLACE a different ' +
          'item rather than amend this one in place, pass its id as `supersedes` — readers of the old item see it was ' +
          'superseded. Gated OFF by default (GP-23).',
        inputSchema: {
          id: zString.describe('Stable item id / filename stem, e.g. GP-23 or POL-auth-1 ([A-Za-z0-9][A-Za-z0-9._-]*).'),
          kind: zString.describe('Steering kind: guiding-principle | policy | …'),
          statement: zString.describe('The steering text itself (the rule / principle, as prose).'),
          domain: zString.describe('Organizing scope tag this item applies to (may be empty).').optional(),
          status: zString.describe(`Lifecycle status: ${STEERING_STATUSES.join(' | ')} (default: prior status, else active).`).optional(),
          supersedes: zString
            .describe('Id of a steering item this one replaces. Recorded as a `supersedes` edge; the superseded item surfaces it as a backlink on read.')
            .optional(),
          references: zString
            .describe('Advanced: a JSON array of additional typed edges, e.g. [{"rel":"clarifies","id":"GP-01"}]. `rel` is open vocabulary.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const projectRoot = options.projectRoot ?? process.cwd();
        if (!readSteeringEnabledFlag(projectRoot)) return gatedResult();
        const status = normalizeStatus(args.status);
        const refs = referencesFromArgs(args.supersedes, args.references);
        if ('error' in refs) return schemaErrorResult(refs.error);
        // Only pass an edge list when an edge ARG was supplied — otherwise an
        // absent-args put would materialize as `references: []` and CLEAR a
        // prior item's edges on amend (absent = carry-prior is the contract).
        // referencesFromArgs treats '' as absent, so the guard must too: an
        // empty-string arg (a common LLM serialization of an unset optional)
        // must NOT count as "supplied" or it would clear edges the same way.
        const edgeArgsSupplied =
          (args.supersedes !== undefined && args.supersedes !== '') ||
          (args.references !== undefined && args.references !== '');
        const result = getStore(projectRoot).put({
          id: args.id,
          kind: args.kind,
          statement: args.statement,
          ...(args.domain === undefined ? {} : { domain: args.domain }),
          ...(status === undefined ? {} : { status }),
          ...(edgeArgsSupplied ? { references: refs.refs } : {}),
        });
        return putToolResult(result);
      },
    );
  };
}
