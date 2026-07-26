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
// Error surface: every handler below is wrapped in one try/catch; any
// `WorkStateModuleError` (the shared base every typed work-state failure —
// `WorkStateError`, `DagError`, `VerbError`, `ClaimEngineError` — extends, per
// types.ts's own note) is caught with ONE `instanceof` check and shaped into a
// typed
// `{ ok: false, code, message }` MCP error payload. Anything else (a
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
import { CursorSchema, ProgressSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, workStatePath } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { createUlidGenerator, isUlid } from '../record/id.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import type { ToolRegistrar } from '../server.js';
import { claim, complete, release, renew } from './claims.js';
import { createRealCompletionRecordWriter } from './completion-record.js';
import type { CompletionRecordWriter } from './completion-record.js';
import { checkExpiry } from './expiry.js';
import { primeOnClaim } from './priming-hook.js';
import { WorkStateStore } from './store.js';
import type { ListItemsFilter } from './store.js';
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
 * try/catch shapes into the standard `{ ok: false, code, message }` payload
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
 */
function toolError(err: unknown): CallToolResult {
  if (err instanceof WorkStateModuleError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code: err.code, message: err.message }) }],
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
      const store = new WorkStateStore(dbPath, clock);
      const verbs = new WorkStateVerbs(store, clock);
      const telemetry = new TelemetryCounters(options.telemetryDir ?? join(projectRoot, '.ideate-telemetry'), clock);
      const sessionId = options.sessionId ?? `mcp-${createUlidGenerator(clock)()}`;
      // The completion-record writer, built ONCE from the same
      // project root/telemetry/clock this context already resolved, so
      // `.ideate.json` is not re-read on every `work_complete` call.
      const completionRecordWriter = createRealCompletionRecordWriter(projectRoot, telemetry, clock);
      context = { store, verbs, clock, telemetry, sessionId, projectRoot, completionRecordWriter };
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
          const item = ctx.verbs.create({
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
          });
          return ok({ item });
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
          'depends_on entry of which is done). Selection only — never ranking. The parent_id filter is tri-state: ' +
          'omit for no containment filter, a string for the direct children of that parent, or null for roots-only ' +
          '(top-level items). Each item also carries its DERIVED referenced_by backlinks, so a superseded item ' +
          'shows what replaced it.',
        inputSchema: {
          tenant_id: zString.describe('Filter to one tenant.').optional(),
          status: zString.describe('Filter to one status: open | in_progress | done | cancelled.').optional(),
          parent_id: zString
            .describe('CONTAINMENT filter (tri-state): omit = no filter; a string = direct children of that parent; null = roots-only (top-level items).')
            .nullable()
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
          const items = ctx.verbs.list(filter);
          return ok({ items });
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
          const item = ctx.verbs.updateMeta(args.id, args.expected_version, patch, makeExpiryCheck(ctx));
          return ok({ item });
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
          const item = release(ctx.store, ctx.clock, args.id, args.claim_token, args.note);
          return ok({ item });
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
          // Completion-record post-commit hook — same call site as
          // every other verb's dependencies, reusing this context's own
          // project root/telemetry/session id/writer.
          const item = complete(ctx.store, ctx.clock, args.id, args.claim_token, args.note, {
            projectRoot: ctx.projectRoot,
            telemetry: ctx.telemetry,
            sessionId: ctx.sessionId,
            recordWriter: ctx.completionRecordWriter,
          });
          return ok({ item });
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
