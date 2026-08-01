// plugin/src/work-state/tools.ts — the eleven work-state MCP verbs, closing
// the delegation-board surface begun by store.ts/claims.ts/verbs.ts.
//
// The eleven-verb surface: `create`, `get`, `list`, `update_meta`, `claim`,
// `renew`, `release`, `complete`, `cancel`, `reopen`, `events`. This module is
// a thin MCP adapter over the already-built logic layer:
//   - the seven non-claim verbs (create/get/list/update_meta/cancel/reopen/
//     events) go through `WorkStateVerbs` (verbs.ts);
//   - the four claim-lifecycle verbs (claim/renew/release/complete) call
//     claims.ts's module-level functions directly — they are not methods on
//     `WorkStateVerbs` (per verbs.ts's own header, claim-lifecycle verbs are
//     built in a sibling file).
// No business logic lives here: every verb's validation, CAS, cycle
// guard, and audit-event append already lives one layer down.
//
// Payload discipline (work_list): this transport — not the logic layer — is
// where the board read becomes BOUNDED. `work_list` calls verbs.ts's
// `listSummaries`, so it returns SUMMARY rows (no opaque `spec` body; a
// SQL-computed `spec_length` instead) and at most `DEFAULT_LIST_LIMIT` items
// per call unless the caller asks otherwise, with an opaque `next_cursor` to
// resume from — AND at most `LIST_PAYLOAD_BUDGET_CHARS` characters of
// serialized items (transport/payload-budget.ts's `applyListPayloadBudget`,
// the ONE budget the CLI's `list --json` enforces too — this file only
// supplies the compact per-item measure matching what the SDK actually
// writes), because a count of
// items is not a bound on bytes (100
// summary rows, or a handful of `include_spec: true` ones, can each exceed the
// payload that blew the client's token cap in the first place).
// `work_get` remains the full-spec fetch, and `include_spec: true`
// opts back in here. The default lives HERE deliberately: `verbs.list()` still
// returns every matching item with its spec, because an in-repo consumer
// (context/assemble-prototype.ts) sweeps the whole board and renders those
// specs — a default imposed one layer down would silently truncate it.
//
// Actor derivation: tool inputs carry an explicit `actor_human`/`actor_agent`
// pair (the wire-level flattening of the contract's `ActorRef`) for `create`,
// `cancel`, `reopen`, and `claim` — the four verbs whose engine-level
// signature accepts an actor. `renew`, `complete`, and `release` accept NO
// actor input whatsoever (no schema field for it): claims.ts's own functions
// have no actor parameter for these three — the claim token proves identity,
// and the audit event is always attributed to the claim's own holder, read
// back off the row inside the same locked transaction (claims.ts). Mirroring
// the engine's signatures exactly here means there is no wire-level path that
// could ever let a caller misattribute a renew/complete/release to someone
// else.
//
// Why flattened `actor_human`/`actor_agent` rather than a nested `actor`
// object: the repo's zero-runtime-dependency posture (record/tools.ts's own
// header) derives every parameter schema from zod instances already
// exported by the MCP SDK (`zod` itself is the SDK's transitive dependency,
// not a direct one of this package) — there is no `z.object(...)`
// constructor available to reach for without adding a direct `zod`
// dependency. Every zod schema in this file is still a REAL zod instance
// (`.optional()`/`.describe()`/`.int()`/`.array()` all mint genuine derived
// schemas), so argument validation and the tools/list JSON schema both stay
// exact; the ActorRef CONCEPT is carried as two flat fields instead of one
// nested object.
//
// The real expiry seam: every id-scoped `WorkStateVerbs` call below
// (`get`/`update_meta`/`cancel`/`reopen`/`events`) is passed a REAL
// `ExpiryCheck` built on expiry.ts's `checkExpiry` — never the `noopExpiryCheck`
// default verbs.ts ships for its own standalone testability. This closes the
// verb-layer seam: an id-scoped touch through this MCP surface always
// evaluates (and, if needed, reclaims) an expired lease first. `claim`/`renew`/
// `complete`/`release` need no such wiring here — claims.ts's own functions
// already call `checkExpiry` internally as their documented first step.
//
// `work_list`'s OWN seam (decision 01KYX9BGM9N9FGXQDMESN94FX1): `listSummaries`
// stays side-effect-free by design (verbs.ts's own header) — a per-ITEM reclaim
// on a many-row read was explicitly declined there. But the session-boundary
// sweep (hooks/session-start.mjs, hooks/session-end.mjs) does not reach every
// consumer of this page: an autopilot run is ONE continuous session by design
// (skills/autopilot/SKILL.md — "keeps one continuous context"; its spawned
// subagents fire SubagentStart/SubagentStop, which never sweep), so a claim
// that lapses mid-run can sit invisible for the rest of the run with no
// engine-level bound. This handler closes that gap the way option (b) of that
// decision chose: ONE `sweepBoard` call, here, before the page is served — not
// per row, and not inside verbs.ts (which stays decoupled from expiry.ts by
// its own stated boundary). Cost is one indexed `status='in_progress'` scan
// (idx_items_tenant_status) plus one CAS write per genuinely-expired claim —
// measured directly (no process-spawn noise; this server is long-lived)
// against this repo's own real board (159 items, 1 in_progress): sweepBoard
// averages 0.63ms/call, listItemSummaryViews(limit 20) averages 0.69ms/call —
// the SAME order of magnitude as the read it now always precedes, not a
// multiple of it. Scoped to the SAME `tenant_id` this call filters to,
// matching TenantGuard posture.
//
// Error surface: every handler below is wrapped in one try/catch; any
// `WorkStateModuleError` (the shared base every typed work-state failure —
// `WorkStateError`, `DagError`, `VerbError`, `ClaimEngineError` — extends, per
// types.ts's own note) is caught with ONE `instanceof` check and shaped into a
// typed
// `{ ok: false, code, message, reason }` MCP error payload — `message` and
// `reason` carry the identical string; see `toolError`'s own doc comment for
// why both keys are present. Anything else (a
// genuinely unexpected internal error) is re-thrown and falls through to
// the MCP SDK's own generic error handling — this module never silently
// swallows a non-work-state failure.
//
// Secret gate (criterion 6): `title` and event `note` fields are gated
// BELOW this layer, inside store.ts (`scanAndMask` before persist — see
// store.ts's own header). This module never calls the gate itself and never
// re-masks an already-returned value — the pass-through is verified by
// tools.test.ts planting a secret-shaped title and asserting the MASKED
// value comes back from `work_create`, never the raw one.
//
// Claim-time priming (criterion 5): `work_claim`'s handler calls
// `primeOnClaim` (priming-hook.ts) AFTER a successful claim — the wired,
// mechanically-gated-off seam. See that module's own header for the full
// gating contract.
//
// Registration is SIDE-EFFECT FREE, mirroring record/tools.ts: config
// loading and store construction happen lazily inside the first tool CALL,
// never at registrar-call time.

import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CursorSchema, ProgressSchema, ToolAnnotationsSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, workStatePath } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { createUlidGenerator, isUlid } from '../record/id.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import {
  LIST_PAYLOAD_BUDGET_CHARS,
  applyListPayloadBudget,
  measureCompactItemChars,
} from '../transport/payload-budget.js';
import { createProjectIdResolver } from '../transport/id-resolver.js';
import type { UnresolvedId } from '../transport/id-lint.js';
import type { ToolRegistrar } from '../server.js';
import { claim, complete, release, renew } from './claims.js';
import { createRealCompletionRecordWriter } from './completion-record.js';
import type { CompletionRecordWriter } from './completion-record.js';
import { createGatedUsageCaptureWriter } from './completion-usage-hook.js';
import type { UsageCaptureWriter } from './completion-usage-hook.js';
import { checkExpiry, sweepBoard } from './expiry.js';
import { primeOnClaim } from './priming-hook.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  WorkStateStore,
} from './store.js';
import type { ListItemsFilter, ListPageOptions } from './store.js';
import { WorkStateError, WorkStateModuleError } from './types.js';
import type { ActorRef, UpdateMetaInput, WorkItemReference, WorkItemStatus } from './types.js';
import type { ExpiryCheck } from './verbs.js';
import { WorkStateVerbs } from './verbs.js';

/** The complete work-state tool surface — eleven verbs. */
export const WORK_STATE_TOOL_NAMES = [
  'work_create',
  'work_get',
  'work_list',
  'work_update_meta',
  'work_claim',
  'work_renew',
  'work_release',
  'work_complete',
  'work_cancel',
  'work_reopen',
  'work_events',
] as const;

/** Real zod building blocks, borrowed from the SDK's own exported schemas
 *  (see the file header's zero-runtime-dependency note). */
const zString = CursorSchema; // a plain z.string()
const zNumber = ProgressSchema.shape.progress; // a plain z.number()
// `.unwrap()` peels the SDK's own `.optional()` off, leaving a plain
// z.boolean() this file can re-decorate — the same borrow-don't-depend trick
// as the two above (see the file header's zero-runtime-dependency note).
const zBoolean = ToolAnnotationsSchema.shape.readOnlyHint.unwrap();

const STATUS_VALUES: readonly WorkItemStatus[] = ['open', 'in_progress', 'done', 'cancelled'];

/** Validate a caller-supplied status filter against the closed status set. */
function parseStatus(value: string | undefined): WorkItemStatus | undefined {
  if (value === undefined) return undefined;
  if (!(STATUS_VALUES as readonly string[]).includes(value)) {
    throw new WorkStateError(
      'SCHEMA',
      `work-state tools: "status" must be one of ${STATUS_VALUES.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return value as WorkItemStatus;
}

/** Reassemble the flattened `actor_human`/`actor_agent` wire fields into an `ActorRef`. */
function actorFromArgs(human: string, agent: string | undefined): ActorRef {
  return agent === undefined ? { human } : { human, agent };
}

/**
 * Assemble the forward-edge list from the two write-verb arguments: the
 * ergonomic `supersedes` (a single item id → a `supersedes` edge) and the
 * general `references` escape hatch (a JSON array of `{rel, id}` for arbitrary
 * typed edges). Mirrors record/tools.ts's `referencesFromArgs` exactly, with
 * one adaptation to this module's own error idiom: a malformed arg THROWS a
 * typed `WorkStateError('SCHEMA', …)`, which the handlers' existing
 * try/catch shapes into the standard error payload via {@link toolError} —
 * see that function's own doc comment for the emitted keys rather than a
 * second copy of them here (P-52)
 * (record/tools.ts returns a sentinel object instead because its append path
 * has no try/catch). Target EXISTENCE is not checked here — that is dag.ts's
 * write-time guard one layer down; ULID well-formedness is also re-checked at
 * store.ts's write chokepoint (defense in depth for the CLI transport, which
 * bypasses this function). Returns `undefined` when neither arg is present —
 * the caller then omits the `references` key entirely, preserving
 * update_meta's "absent = unchanged" semantics.
 */
function referencesFromArgs(supersedes: string | undefined, referencesJson: string | undefined): WorkItemReference[] | undefined {
  // An empty string is treated as absent (record/tools.ts's exact rule), so
  // `supersedes: ""` can never accidentally clear an item's edges on
  // update_meta — only a present, parsed `references: "[]"` does that.
  const sup = supersedes === '' ? undefined : supersedes;
  const refsJson = referencesJson === '' ? undefined : referencesJson;
  if (sup === undefined && refsJson === undefined) return undefined;
  const refs: WorkItemReference[] = [];
  if (sup !== undefined) {
    if (!isUlid(sup)) {
      throw new WorkStateError('SCHEMA', `work-state tools: supersedes ${JSON.stringify(sup)} is not a well-formed ULID`);
    }
    refs.push({ rel: 'supersedes', id: sup });
  }
  if (refsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(refsJson);
    } catch {
      throw new WorkStateError('SCHEMA', 'work-state tools: references is not valid JSON (expected an array of {rel, id})');
    }
    if (!Array.isArray(parsed)) {
      throw new WorkStateError('SCHEMA', 'work-state tools: references must be a JSON array of {rel, id}');
    }
    for (const item of parsed) {
      const ref = item as WorkItemReference;
      if (typeof ref?.rel !== 'string' || ref.rel.length === 0) {
        throw new WorkStateError('SCHEMA', `work-state tools: references rel ${JSON.stringify(ref?.rel)} must be a non-empty string`);
      }
      if (typeof ref?.id !== 'string' || !isUlid(ref.id)) {
        throw new WorkStateError('SCHEMA', `work-state tools: references id ${JSON.stringify(ref?.id)} is not a well-formed ULID`);
      }
      refs.push({ rel: ref.rel, id: ref.id });
    }
  }
  return refs;
}

/** Options for the registrar factory — all defaulted at the composition edge,
 *  mirroring record/tools.ts's `RecordToolsOptions`. */
export interface WorkStateToolsOptions {
  /** Project root the work-state board lives under. Default: `process.cwd()` at first call. */
  projectRoot?: string;
  /** Explicit database file path override (tests). Default:
   *  `<workStatePath(config, projectRoot)>/board.db`. */
  dbPath?: string;
  /** Telemetry state directory. Default: `<projectRoot>/.ideate-telemetry`,
   *  matching record/tools.ts's own default so both surfaces share one telemetry stream. */
  telemetryDir?: string;
  /** Session identity stamped into telemetry events. Default: `mcp-<ULID>` minted once per registrar. */
  sessionId?: string;
  /** Injected clock. Default: wall clock — this factory is an outermost composition edge. */
  clock?: Clock;
}

/** The lazily-built per-server context. */
interface ToolContext {
  store: WorkStateStore;
  verbs: WorkStateVerbs;
  clock: Clock;
  telemetry: TelemetryCounters;
  sessionId: string;
  projectRoot: string;
  /** Built once per context (not per completion) — see this
   *  factory's own composition edge below. */
  completionRecordWriter: CompletionRecordWriter;
  /** Built once per context, mirroring `completionRecordWriter` — see
   *  completion-usage-hook.ts's file header for what this writer captures
   *  and why. */
  usageCaptureWriter: UsageCaptureWriter;
}

/** Build the real `ExpiryCheck` (criterion 2) for one context — the lazy
 *  expiry seam every id-scoped `WorkStateVerbs` call below is wired to. */
function makeExpiryCheck(ctx: ToolContext): ExpiryCheck {
  return (itemId: string): void => {
    checkExpiry(ctx.store, ctx.clock, itemId);
  };
}

/** Shape a successful verb result into a `CallToolResult`. */
function ok(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...payload }) }] };
}

/**
 * Shape a caught error into a typed MCP error payload (criterion 1): ONE
 * `instanceof WorkStateModuleError` check covers every typed failure this
 * package's logic layer can raise. Anything else is re-thrown — not this
 * module's to swallow.
 *
 * Carries BOTH `message` (this module's own historical key, asserted by
 * tools.test.ts) and `reason` (the key record/tools.ts, steering/tools.ts and
 * usage/tools.ts have always used for the identical `{ok:false, code,
 * <string>}` shape on the other three bounded-read surfaces) with the same
 * string value. This is an ADDITIVE fix, not a rename: a review of this
 * item's cleanup pass found consumers reading each key on a different
 * surface (this package's own tests read `message`; record/tools.test.ts and
 * usage/tools.test.ts read `reason`), so removing either would break a real
 * consumer. Adding the missing key here — rather than stripping `message` or
 * pushing `message` onto the other three — resolves the drift a caller would
 * hit writing one handler for "a malformed cursor on a bounded read" (that
 * handler reads `reason` today, and got `undefined` on `work_list` before
 * this).
 */
function toolError(err: unknown): CallToolResult {
  if (err instanceof WorkStateModuleError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code: err.code, message: err.message, reason: err.message }) }],
      isError: true,
    };
  }
  throw err;
}

/**
 * Build the registrar for the eleven work-state verbs. Matches server.ts's
 * `ToolRegistrar` shape — push the returned function onto `toolRegistrars`
 * to contribute the tools at boot.
 *
 * Calling the registrar registers tools and does NOTHING else: config
 * loading and store construction wait for the first tool CALL.
 */
export function createWorkStateToolsRegistrar(options: WorkStateToolsOptions = {}): ToolRegistrar {
  let context: ToolContext | undefined;

  /** Lazy composition edge — runs once, inside the first tool CALL. */
  const getContext = (): ToolContext => {
    if (context === undefined) {
      const clock = options.clock ?? (() => new Date());
      const projectRoot = options.projectRoot ?? process.cwd();
      // First call = onboarding: loadConfig lazily creates .ideate.json and
      // the record directory when absent (see ideate-config.ts) — the
      // work-state store itself stays lazy-init on its OWN first write
      // (schema.ts), independent of this.
      const config = loadConfig(projectRoot);
      const dbPath = options.dbPath ?? join(workStatePath(config, projectRoot), 'board.db');
      const telemetry = new TelemetryCounters(options.telemetryDir ?? join(projectRoot, '.ideate-telemetry'), clock);
      // Cross-store id-lint resolver (correction 01KYV387QKRP3V330WAS6DX95K):
      // transport/id-resolver.ts is the one module allowed to know about both
      // the board and the record store, so it — not this file — decides how
      // an id resolves. Wired unconditionally (production composition root),
      // sharing this context's own `dbPath` so it resolves against the SAME
      // board file this store writes, not a re-derived default.
      const resolveId = createProjectIdResolver(projectRoot, telemetry, clock, dbPath);
      const store = new WorkStateStore(dbPath, clock, resolveId);
      const verbs = new WorkStateVerbs(store, clock);
      const sessionId = options.sessionId ?? `mcp-${createUlidGenerator(clock)()}`;
      // The completion-record writer, built ONCE from the same
      // project root/telemetry/clock this context already resolved, so
      // `.ideate.json` is not re-read on every `work_complete` call.
      const completionRecordWriter = createRealCompletionRecordWriter(projectRoot, telemetry, clock);
      // The usage-capture writer, built ONCE from the same project root/
      // clock this context already resolved (mirrors completionRecordWriter
      // immediately above) — see completion-usage-hook.ts's file header.
      const usageCaptureWriter = createGatedUsageCaptureWriter(projectRoot, undefined, clock);
      context = { store, verbs, clock, telemetry, sessionId, projectRoot, completionRecordWriter, usageCaptureWriter };
    }
    return context;
  };

  return (server: McpServer): void => {
    server.registerTool(
      'work_create',
      {
        description:
          'Create a new work item on the delegation board. Rejects a depends_on list that references a ' +
          'nonexistent item or would introduce a cycle (typed DagError). Accepts an optional supersedes edge ' +
          '(the id of the item this one replaces); the superseded item surfaces the replacement as a derived ' +
          'backlink on read.',
        inputSchema: {
          title: zString.describe('One line, human-readable.'),
          spec: zString.describe('Opaque tool-specific payload — never parsed, never interpreted.'),
          spec_format: zString.describe('Free-form hint, e.g. "plan/outline", "speckit/spec".'),
          depends_on: zString.array().describe('IDs of items that must be done before this one is claimable.').optional(),
          parent_id: zString
            .describe('Optional CONTAINMENT parent — the id of the item this one belongs to. Omit (or null) to create a root/top-level item. Orthogonal to depends_on. Rejected (typed DagError) if it names a nonexistent item.')
            .nullable()
            .optional(),
          supersedes: zString
            .describe('Id of a work item this one replaces. Recorded as a `supersedes` forward edge; the superseded item surfaces it as a derived backlink on get/list. Rejected if not a well-formed ULID or if it names a nonexistent item.')
            .optional(),
          references: zString
            .describe('Advanced: a JSON array of additional typed edges, e.g. [{"rel":"relates-to","id":"01..."}]. `rel` is open vocabulary; every id must be a well-formed ULID naming an existing item.')
            .optional(),
          tenant_id: zString.describe('Team/board scope. Default: the local-mode single tenant.').optional(),
          actor_human: zString.describe('The creating actor — a human principal.'),
          actor_agent: zString.describe('The named agent acting on the human principal\'s behalf, if any.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const references = referencesFromArgs(args.supersedes, args.references);
          let unresolvedIds: readonly UnresolvedId[] = [];
          const item = ctx.verbs.create(
            {
              title: args.title,
              spec: args.spec,
              spec_format: args.spec_format,
              ...(args.depends_on === undefined ? {} : { depends_on: args.depends_on }),
              // Thread parent_id only when supplied. Absent OR null both
              // create a root; null is passed through so the store records a
              // root explicitly (harmless, same as absent).
              ...(args.parent_id === undefined ? {} : { parent_id: args.parent_id }),
              ...(references === undefined ? {} : { references }),
              ...(args.tenant_id === undefined ? {} : { tenant_id: args.tenant_id }),
              created_by: actorFromArgs(args.actor_human, args.actor_agent),
            },
            // `unresolved_ids` (correction 01KYV387QKRP3V330WAS6DX95K FINDING
            // 1): mirrors record/tools.ts's `appendToolResult` — the SAME
            // structured, machine-checkable envelope field every caller can
            // read, so the id-lint report reaches the calling agent, not just
            // `process.emitWarning`. Empty on the common case; WARN, never
            // reject — never flips `ok` to false.
            (ids) => {
              unresolvedIds = ids;
            },
          );
          return ok({ item, unresolved_ids: unresolvedIds });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_get',
      {
        description: 'Fetch one work item by id, or null if it does not exist. Runs the lazy-expiry seam first. The item carries its DERIVED referenced_by backlinks, so a superseded item shows what replaced it.',
        inputSchema: { id: zString.describe('The work item id.') },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const item = ctx.verbs.get(args.id, makeExpiryCheck(ctx));
          return ok({ item });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_list',
      {
        description:
          'List work items, with the derived claimability view attached to each (an open item every direct ' +
          'depends_on entry of which is done). Selection only — never ranking. SUMMARY ROWS BY DEFAULT: each item ' +
          'carries every field EXCEPT the opaque spec body, plus spec_length (its length in Unicode CODE POINTS, ' +
          'SQLite\'s own LENGTH() semantics — NOT UTF-16 code units, which is what record_read\'s content_length ' +
          'counts; the two disagree on astral text) — fetch the ' +
          'spec of an item you actually intend to work on with work_get, or set include_spec: true to get every ' +
          'spec back here. PAGED: at most `limit` items per call (default ' +
          `${String(DEFAULT_LIST_LIMIT)}, clamped into 1..${String(MAX_LIST_LIMIT)}` +
          '), newest-created first; the result carries next_cursor — a string when more matching items exist, ' +
          'null on the last page. A page may also be SHORTENED to fewer than `limit` items to stay within a ' +
          'payload size budget (roughly ' +
          `${String(LIST_PAYLOAD_BUDGET_CHARS)}` +
          ' characters of items, which include_spec reaches quickly) — so never assume a full page means more ' +
          'and a short page means done: follow next_cursor, which is non-null whenever items remain for any ' +
          'reason, and null ONLY at true exhaustion. Pass it back as `cursor` to get the next page. The cursor is OPAQUE (never ' +
          'construct or parse one; a malformed cursor is a typed SCHEMA error, never an empty page) and it is ' +
          'tied to the filter it was issued for — changing tenant_id/status/parent_id between pages invalidates ' +
          'it, so walk one filter to exhaustion before changing it. The parent_id filter is tri-state: ' +
          'omit for no containment filter, a string for the direct children of that parent, or null for roots-only ' +
          '(top-level items). Each item also carries its DERIVED referenced_by backlinks, so a superseded item ' +
          'shows what replaced it. claimable is computed against the WHOLE board, so it never depends on which ' +
          'page an item landed on.',
        inputSchema: {
          tenant_id: zString.describe('Filter to one tenant.').optional(),
          status: zString.describe('Filter to one status: open | in_progress | done | cancelled.').optional(),
          parent_id: zString
            .describe('CONTAINMENT filter (tri-state): omit = no filter; a string = direct children of that parent; null = roots-only (top-level items).')
            .nullable()
            .optional(),
          include_spec: zBoolean
            .describe('Include the full opaque spec body on every returned item (default false — summary rows). spec_length is present either way, and paging applies regardless.')
            .optional(),
          limit: zNumber
            .int()
            .describe(`Maximum items in this page. Default ${String(DEFAULT_LIST_LIMIT)}; clamped into 1..${String(MAX_LIST_LIMIT)}.`)
            .optional(),
          cursor: zString
            .describe('Opaque resumption point: the next_cursor from the previous page. Invalidated by changing any filter.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const status = parseStatus(args.status);
          const filter: ListItemsFilter = {
            ...(args.tenant_id === undefined ? {} : { tenant_id: args.tenant_id }),
            ...(status === undefined ? {} : { status }),
            // Tri-state: absent = no filter; a string = children-of;
            // null = roots-only. The key is only added when supplied, so an
            // absent arg leaves the filter free of any containment clause.
            ...(args.parent_id === undefined ? {} : { parent_id: args.parent_id }),
          };
          // Sweep BEFORE serving the page — see this file's header ("work_list's
          // OWN seam"). One board-wide pass, not per row; scoped to the same
          // tenant this call filters to.
          //
          // BEST-EFFORT (finding closed by 01KYX9BGM9N9FGXQDMESN94FX1): this
          // sweep is the ONLY thing standing between "read the board" and a
          // write-lock contention it never used to have — `checkExpiry`
          // (expiry.ts) opens `BEGIN IMMEDIATE` for EVERY in_progress item
          // before it even checks whether that item's lease expired, so a
          // concurrent writer holding the lock past `BUSY_TIMEOUT_MS` turns a
          // previously-guaranteed-success read into a `BUSY` error. That
          // regression would be worse than the gap this sweep closes, so the
          // sweep call itself is guarded, narrowly, right here — never the
          // `listSummaries` read below it. A failure here is loud (P-45: no
          // silent downgrade) but never fatal to the page; mirrors
          // cli/ideate-work.ts's `runSweep`, the standalone sweep hook path,
          // which applies the identical "never let sweepBoard's failure stop
          // the caller" rule for the same reason.
          try {
            sweepBoard(ctx.store, ctx.clock, args.tenant_id === undefined ? undefined : { tenant_id: args.tenant_id });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `ideate work-state: work_list's opportunistic sweep FAILED (${message}) — serving the page WITHOUT it; ` +
                'an expired claim may still show as in_progress until the next successful sweep\n',
            );
          }
          // The DEFAULT page size is applied HERE, at the transport boundary —
          // never in verbs.ts/store.ts, whose absent-limit behavior stays
          // "every matching row" for internal callers (context/
          // assemble-prototype.ts). Clamping and cursor decoding stay in the
          // store, so this transport and the CLI cannot drift on either.
          const page: ListPageOptions = {
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            ...(args.include_spec === true ? { include_spec: true } : {}),
          };
          // …and the payload BUDGET is applied on top of it: `limit` bounds
          // the item COUNT, this bounds the characters those items serialize
          // to (see transport/payload-budget.ts — ONE budget and ONE
          // implementation, shared with the CLI's `list --json`). A page
          // shortened here still carries an honest next_cursor, built from its
          // last included row. The COMPACT measure is the right one here: the
          // SDK writes this result as `JSON.stringify(body)` with no indent.
          const result = applyListPayloadBudget(ctx.verbs.listSummaries(filter, page), measureCompactItemChars);
          return ok({ items: result.items, next_cursor: result.next_cursor });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_update_meta',
      {
        description:
          'Update metadata (title/spec/spec_format/depends_on/parent_id/references) via optimistic CAS on version. Rejects a ' +
          'depends_on edit that would introduce a dangling reference or a cycle, and a parent_id edit that dangles ' +
          'or would make the item its own ancestor. parent_id is tri-state: omit to leave unchanged, a string to ' +
          'set/move the parent, or null to clear it back to root. supersedes/references replace the forward-edge ' +
          'list wholesale (omit both to leave it unchanged); every edge id must be a well-formed ULID naming an ' +
          'existing item. Runs the lazy-expiry seam first.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          expected_version: zNumber.int().describe('The version this edit expects to be current.'),
          title: zString.optional(),
          spec: zString.optional(),
          spec_format: zString.optional(),
          depends_on: zString.array().optional(),
          parent_id: zString
            .describe('CONTAINMENT parent (tri-state): omit = unchanged; a string = set/move parent; null = clear to root. Orthogonal to depends_on.')
            .nullable()
            .optional(),
          supersedes: zString
            .describe('Id of the work item this one replaces — sets the edge list to a single `supersedes` edge (wholesale replace).')
            .optional(),
          references: zString
            .describe('Advanced: a JSON array of typed edges, e.g. [{"rel":"supersedes","id":"01..."}] — wholesale replace; "[]" clears every edge.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const references = referencesFromArgs(args.supersedes, args.references);
          const patch: UpdateMetaInput = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.spec === undefined ? {} : { spec: args.spec }),
            ...(args.spec_format === undefined ? {} : { spec_format: args.spec_format }),
            ...(args.depends_on === undefined ? {} : { depends_on: args.depends_on }),
            // Tri-state: the key is added iff the arg is present (a
            // string OR null). Absent = leave unchanged; a string = set/move;
            // null = clear to root. The wire adapter thus preserves the
            // "key absent vs present-null" distinction the store depends on.
            ...(args.parent_id === undefined ? {} : { parent_id: args.parent_id }),
            // Wholesale replace (depends_on's semantics): the key is added
            // iff either edge arg was supplied; absent = leave unchanged.
            ...(references === undefined ? {} : { references }),
          };
          let unresolvedIds: readonly UnresolvedId[] = [];
          const item = ctx.verbs.updateMeta(args.id, args.expected_version, patch, makeExpiryCheck(ctx), (ids) => {
            unresolvedIds = ids;
          });
          return ok({ item, unresolved_ids: unresolvedIds });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_claim',
      {
        description:
          'Claim an open work item whose depends_on frontier is all done — a server-side compare-and-set. ' +
          'Mints a fencing token; at most one active claim per item, ever.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          actor_human: zString.describe('The claiming actor — a human principal.'),
          actor_agent: zString.describe('The named agent acting on the human principal\'s behalf, if any.').optional(),
          lease_ms: zNumber.int().positive().describe('Lease length override, in milliseconds (positive, max 30 days). Default: 4 hours.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const actor = actorFromArgs(args.actor_human, args.actor_agent);
          const item = claim(ctx.store, ctx.clock, args.id, actor, args.lease_ms === undefined ? undefined : { leaseMs: args.lease_ms });
          // Wired, mechanically-gated-off claim-time priming seam (criterion 5).
          primeOnClaim({
            projectRoot: ctx.projectRoot,
            itemId: args.id,
            actor,
            sessionId: ctx.sessionId,
            telemetry: ctx.telemetry,
          });
          return ok({ item });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_renew',
      {
        description:
          'Renew an active claim\'s lease. NO actor input: the claim_token proves identity — succeeds iff ' +
          'in_progress, the token matches, and the lease has not already expired.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          claim_token: zNumber.int().describe('The fencing token returned by claim.'),
          lease_ms: zNumber.int().positive().describe('Lease length override, in milliseconds (positive, max 30 days). Default: 4 hours.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const item = renew(ctx.store, ctx.clock, args.id, args.claim_token, args.lease_ms === undefined ? undefined : { leaseMs: args.lease_ms });
          return ok({ item });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_release',
      {
        description:
          'Release an active claim, returning the item to open with an optional free-text handoff note. NO ' +
          'actor input: the release is always attributed to the claim\'s own holder.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          claim_token: zNumber.int().describe('The fencing token returned by claim.'),
          note: zString.describe('Optional free-text handoff note.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          let unresolvedIds: readonly UnresolvedId[] = [];
          const item = release(ctx.store, ctx.clock, args.id, args.claim_token, args.note, (ids) => {
            unresolvedIds = ids;
          });
          return ok({ item, unresolved_ids: unresolvedIds });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_complete',
      {
        description:
          'Complete an active claim, transitioning the item to done. NO actor input: fencing rejects a stale ' +
          '(expired-and-reclaimed) token — completion is always attributed to the claim\'s own holder.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          claim_token: zNumber.int().describe('The fencing token returned by claim.'),
          note: zString.describe('Optional free-text completion summary.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          // Completion-record post-commit hook, PLUS the usage-capture
          // post-commit hook (completion-usage-hook.ts) — same call site as
          // every other verb's dependencies, reusing this context's own
          // project root/telemetry/session id/writers.
          let unresolvedIds: readonly UnresolvedId[] = [];
          const item = complete(
            ctx.store,
            ctx.clock,
            args.id,
            args.claim_token,
            args.note,
            {
              projectRoot: ctx.projectRoot,
              telemetry: ctx.telemetry,
              sessionId: ctx.sessionId,
              recordWriter: ctx.completionRecordWriter,
            },
            {
              projectRoot: ctx.projectRoot,
              telemetry: ctx.telemetry,
              sessionId: ctx.sessionId,
              usageWriter: ctx.usageCaptureWriter,
            },
            (ids) => {
              unresolvedIds = ids;
            },
          );
          return ok({ item, unresolved_ids: unresolvedIds });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_cancel',
      {
        description:
          'Cancel an item from open or in_progress; any active claim is voided in the same atomic write. ' +
          'Runs the lazy-expiry seam first.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          actor_human: zString.describe('The cancelling actor — a human principal.'),
          actor_agent: zString.describe('The named agent acting on the human principal\'s behalf, if any.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const actor = actorFromArgs(args.actor_human, args.actor_agent);
          const item = ctx.verbs.cancel(args.id, actor, makeExpiryCheck(ctx));
          return ok({ item });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_reopen',
      {
        description: 'Reopen an item from done back to open. Runs the lazy-expiry seam first.',
        inputSchema: {
          id: zString.describe('The work item id.'),
          actor_human: zString.describe('The reopening actor — a human principal.'),
          actor_agent: zString.describe('The named agent acting on the human principal\'s behalf, if any.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const actor = actorFromArgs(args.actor_human, args.actor_agent);
          const item = ctx.verbs.reopen(args.id, actor, makeExpiryCheck(ctx));
          return ok({ item });
        } catch (err) {
          return toolError(err);
        }
      },
    );

    server.registerTool(
      'work_events',
      {
        description: 'All events for one work item, oldest first — the full immutable audit trail. Runs the lazy-expiry seam first.',
        inputSchema: { id: zString.describe('The work item id.') },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          const events = ctx.verbs.events(args.id, makeExpiryCheck(ctx));
          return ok({ events });
        } catch (err) {
          return toolError(err);
        }
      },
    );
  };
}
