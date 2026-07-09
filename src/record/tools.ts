// plugin/src/record/tools.ts — the three record MCP verbs (WI-273), closing
// the Layer-0 record core.
//
// Spec: docs/design/v3-composable-surface.md §1.1 — EXACTLY three
// process-record verbs: `record_append` (append one discovery-candidate
// record), `record_read` (unranked, scope-filtered read — standalone priming,
// boundary contract §4.3), `record_decision` (sugar for
// `record_append(kind=decision)`, the ADR entry point). Append-only: no
// update/delete verb exists at this surface (boundary contract §4.2 — the
// guard is enforced BY ABSENCE, here exactly as in store.ts).
//
// Tier A capture (composable surface §2.1): each write handler performs the
// capture write as a synchronous `store.append(...)` statement before it
// returns — unguarded, unconditional. No parameter, flag, or option gates
// whether the record is written; the only way to not write is to not call
// the verb. The falsifiability check is grep-shaped by design: `writeRecord`
// below contains the single `store.append` call both write verbs share, and
// each handler calls it unconditionally as its first act after arg
// validation. `record_decision` IS its capture (boundary contract §2 row 4):
// the decision write and the capture are one operation, because
// `record_decision` composes prose and calls the SAME `writeRecord` path as
// `record_append` — there is no separate decision store to fall out of sync.
//
// Secret gate: every write goes through RecordStore.append (the WI-271
// core), whose gate-before-persist masks every text field before any
// filesystem write. This module adds no second write path — the gate cannot
// be bypassed from here.
//
// Registration is SIDE-EFFECT FREE: registering the tools touches no
// filesystem. The composition edge (loadConfig → TelemetryCounters →
// RecordStore) is built lazily inside the first tool CALL, so the §2.3
// lazy-init onboarding — first MCP call creates `.ideate.json` and the
// record directory — fires on first use, never at boot. (Note: the SDK
// advertises the `tools` capability as soon as a tool registers; that is
// protocol state on the in-memory server object, not a side effect.)
//
// Parameter schemas: the repo ships zero runtime dependencies beyond the MCP
// SDK, and `zod` is the SDK's own dependency, not the plugin's. Rather than
// add a dependency, the parameter schemas are derived from real zod instances
// the SDK itself exports (`CursorSchema` is a plain `z.string()`,
// `ProgressSchema.shape.progress` a plain `z.number()`); zod schemas are
// immutable, so `.describe()`/`.optional()`/`.int()` mint fresh derived
// schemas. registerTool therefore gets genuine zod schemas — argument
// validation and the tools/list JSON schema both come out exact.

import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CursorSchema, ProgressSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from '../config/ideate-config.js';
import type { ToolRegistrar } from '../server.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import type { Clock } from './id.js';
import { createUlidGenerator } from './id.js';
import { RecordStore } from './store.js';
import type { AppendResult } from './store.js';

/** The complete record tool surface — three verbs, no update, no delete. */
export const RECORD_TOOL_NAMES = ['record_append', 'record_read', 'record_decision'] as const;

/** Real zod building blocks, borrowed from the SDK's own exported schemas. */
const zString = CursorSchema; // a plain z.string()
const zNumber = ProgressSchema.shape.progress; // a plain z.number()

/** Options for the registrar factory — all defaulted at the composition edge. */
export interface RecordToolsOptions {
  /** Project root the record lives under. Default: `process.cwd()` at first call. */
  projectRoot?: string;
  /**
   * Telemetry state directory. Default: `<projectRoot>/.ideate-telemetry`,
   * matching the `ideate-telemetry` CLI's placeholder default (never
   * `.ideate/` — see telemetry/cli.ts) so the CLI reads what the server wrote.
   */
  telemetryDir?: string;
  /** Session identity stamped into `source.session_id`. Default: `mcp-<ULID>` minted once per registrar. */
  sessionId?: string;
  /** Injected clock. Default: wall clock — this factory is the outermost composition edge. */
  clock?: Clock;
}

/** The lazily-built per-server context: one store, one session identity. */
interface ToolContext {
  store: RecordStore;
  sessionId: string;
}

/** What both write verbs hand to the single shared write path. */
interface WriteParams {
  kind: string;
  claim: string;
  verification_anchor?: string | undefined;
  scope?: string | undefined;
  task_id?: string | undefined;
  content: string;
}

/**
 * `source.capture_point`, derived from kind: a decision write is boundary
 * contract §2 row 4 (`record_decision` IS the capture), everything else
 * enters through the generic append verb. Derivation lives in the shared
 * write path, so `record_append(kind=decision)` and `record_decision(...)`
 * stamp identical provenance — the sugar is byte-equivalent.
 */
function capturePointFor(kind: string): string {
  return kind === 'decision' ? 'mcp:record_decision' : 'mcp:record_append';
}

/**
 * THE one write path. Both write verbs call this and nothing else writes;
 * the `store.append` statement below is the Tier A capture write —
 * synchronous, before return, unguarded by any parameter or flag
 * (composable surface §2.1 falsifiability standard).
 */
function writeRecord(ctx: ToolContext, params: WriteParams): AppendResult {
  return ctx.store.append({
    kind: params.kind,
    claim: params.claim,
    verification_anchor: params.verification_anchor ?? '',
    scope: params.scope ?? '',
    source: {
      capture_point: capturePointFor(params.kind),
      session_id: ctx.sessionId,
      ...(params.task_id === undefined ? {} : { task_id: params.task_id }),
    },
    content: params.content,
  });
}

/** Shape an AppendResult into a CallToolResult: id + redaction summary, or a typed failure. */
function appendToolResult(result: AppendResult): CallToolResult {
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
        text: JSON.stringify({ ok: true, id: result.record.id, kind: result.record.kind, redactions: result.redactions }),
      },
    ],
  };
}

/** Compose the recall-shaped prose body of a decision record from claim + rationale. */
function composeDecisionContent(claim: string, rationale: string | undefined): string {
  const rationaleText = rationale === undefined || rationale === '' ? '' : `\n\nRationale: ${rationale}`;
  return `Decision: ${claim}${rationaleText}`;
}

/**
 * Build the registrar for the three record verbs. Matches server.ts's
 * `ToolRegistrar` shape — push the returned function onto `toolRegistrars`
 * (or apply it directly) to contribute the tools at boot.
 *
 * Calling the registrar registers tools and does NOTHING else: config
 * loading, directory creation, and store construction all wait for the first
 * tool call (the lazy-init onboarding of config/ideate-config.ts §2.3).
 */
export function createRecordToolsRegistrar(options: RecordToolsOptions = {}): ToolRegistrar {
  let context: ToolContext | undefined;

  /** Lazy composition edge — runs once, inside the first tool CALL. */
  const getContext = (): ToolContext => {
    if (context === undefined) {
      const clock = options.clock ?? (() => new Date());
      const projectRoot = options.projectRoot ?? process.cwd();
      // First call = onboarding: loadConfig lazily creates .ideate.json and
      // the record directory when absent (ideate-config.ts §2.3).
      const config = loadConfig(projectRoot);
      const telemetry = new TelemetryCounters(options.telemetryDir ?? join(projectRoot, '.ideate-telemetry'), clock);
      const sessionId = options.sessionId ?? `mcp-${createUlidGenerator(clock)()}`;
      context = { store: new RecordStore(config, projectRoot, telemetry, clock), sessionId };
    }
    return context;
  };

  return (server: McpServer): void => {
    server.registerTool(
      'record_append',
      {
        description:
          'Append one process record (a discovery-candidate entry) to the project record. ' +
          'Append-only: no update or delete verb exists; a correction is a new record referencing the superseded id. ' +
          'Every write passes the capture-time secret-scanning gate before persisting.',
        inputSchema: {
          kind: zString.describe(
            'Record kind — open vocabulary: decision | finding | session-outcome | subagent-outcome | commit-boundary | task-completion | …',
          ),
          claim: zString.describe('The candidate discovery statement (may be empty).'),
          verification_anchor: zString.describe('How the claim can be checked (file, command, test).').optional(),
          scope: zString.describe('What future work the claim is load-bearing for.').optional(),
          content: zString.describe('Recall-shaped prose body: the words a future question might use.'),
          task_id: zString.describe('Task / work-item ID, when one is in scope.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        // Tier A capture write — unconditional; no parameter gates it.
        const result = writeRecord(ctx, {
          kind: args.kind,
          claim: args.claim,
          verification_anchor: args.verification_anchor,
          scope: args.scope,
          task_id: args.task_id,
          content: args.content,
        });
        return appendToolResult(result);
      },
    );

    server.registerTool(
      'record_read',
      {
        description:
          'Read process records: newest first, optionally scope-filtered (plain substring selection over ' +
          'scope/kind/source fields), optionally limited. Unranked by contract — selection only, no scoring.',
        inputSchema: {
          scope: zString
            .describe('Case-insensitive substring filter matched against scope, kind, and source fields.')
            .optional(),
          limit: zNumber.int().min(0).describe('Maximum number of records returned (newest first).').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        const records = ctx.store.read({
          ...(args.scope === undefined ? {} : { scope: args.scope }),
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, count: records.length, records }) }],
        };
      },
    );

    server.registerTool(
      'record_decision',
      {
        description:
          'Log a decision (the ADR entry point). Sugar for record_append with kind=decision: the decision ' +
          'write IS its capture — same append-only path, same secret gate, one operation.',
        inputSchema: {
          claim: zString.describe('The decision itself, stated as a claim.'),
          rationale: zString.describe('Why this was decided (and what was rejected), as prose.').optional(),
          verification_anchor: zString.describe('How the decision can be checked (file, command, test).').optional(),
          scope: zString.describe('What future work the decision is load-bearing for.').optional(),
          task_id: zString.describe('Task / work-item ID, when one is in scope.').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        // Tier A capture write — the SAME code path as record_append
        // (boundary contract §2 row 4: the write is the capture), unconditional.
        const result = writeRecord(ctx, {
          kind: 'decision',
          claim: args.claim,
          verification_anchor: args.verification_anchor,
          scope: args.scope,
          task_id: args.task_id,
          content: composeDecisionContent(args.claim, args.rationale),
        });
        return appendToolResult(result);
      },
    );
  };
}
