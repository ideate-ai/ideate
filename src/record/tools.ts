// plugin/src/record/tools.ts — the three record MCP verbs, closing
// the record core.
//
// EXACTLY three process-record verbs: `record_append` (append one
// discovery-candidate record), `record_read` (unranked, scope-filtered read —
// standalone priming), `record_decision` (sugar for
// `record_append(kind=decision)`, the ADR entry point). Append-only: no
// update/delete verb exists at this surface — the guard is enforced BY
// ABSENCE, here exactly as in store.ts.
//
// Each write handler performs the capture write as a synchronous
// `store.append(...)` statement before it returns — unguarded, unconditional.
// No parameter, flag, or option gates whether the record is written; the only
// way to not write is to not call the verb. The falsifiability check is
// grep-shaped by design: `writeRecord` below contains the single
// `store.append` call both write verbs share, and each handler calls it
// unconditionally as its first act after arg validation. `record_decision` IS
// its capture: the decision write and the capture are one operation, because
// `record_decision` composes prose and calls the SAME `writeRecord` path as
// `record_append` — there is no separate decision store to fall out of sync.
//
// Secret gate: every write goes through RecordStore.append, whose
// gate-before-persist masks every text field before any filesystem write.
// This module adds no second write path — the gate cannot be bypassed from
// here.
//
// Registration is SIDE-EFFECT FREE: registering the tools touches no
// filesystem. The composition edge (loadConfig → TelemetryCounters →
// RecordStore) is built lazily inside the first tool CALL, so the
// lazy-init onboarding — first MCP call creates `.ideate.json` and the
// record directory — fires on first use, never at boot. (Note: the SDK
// advertises the `tools` capability as soon as a tool registers; that is
// protocol state on the in-memory server object, not a side effect.)
//
// Payload discipline (record_read): this transport — not the store — is where
// the record read becomes BOUNDED. The record is APPEND-ONLY, so an unbounded
// read grows monotonically forever; measured on this project's own record it
// is already ~3.08M characters (~770k tokens), ~45x the payload that once blew
// a client's per-tool-result cap. `record_read` therefore returns SUMMARY rows
// (every field except the prose body, plus a derived `content_length`), at
// most `limit` of them per call with an opaque `next_cursor` to resume from,
// AND at most `LIST_PAYLOAD_BUDGET_CHARS` characters of serialized rows
// (transport/payload-budget.ts — the ONE budget the CLI's `read --json`
// enforces too; this file only supplies the compact per-item measure matching
// what the SDK actually writes). All three are needed: projection alone still
// leaves `scope="finding"` at ~70k characters, and a count of rows is not a
// bound on bytes. `include_content: true` opts the body back in, and
// `record_read(id, include_content: true)` is the by-id retrieval path — a
// SELECTION filter, not a fourth verb: the ratified surface stays exactly
// record_append / record_read / record_decision. The paging machinery itself
// is record/read-page.ts, shared with the CLI so the two doors cannot drift.
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
import { CursorSchema, ProgressSchema, ToolAnnotationsSchema } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from '../config/ideate-config.js';
import type { ToolRegistrar } from '../server.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { LIST_PAYLOAD_BUDGET_CHARS, measureCompactItemChars } from '../transport/payload-budget.js';
import type { Clock } from './id.js';
import { createUlidGenerator, isUlid } from './id.js';
import {
  DEFAULT_RECORD_READ_LIMIT,
  MAX_RECORD_READ_LIMIT,
  boundRecordPage,
  projectRecordRow,
  readRecordPage,
} from './read-page.js';
import type { RecordReference } from './schema.js';
import { RecordSchemaError } from './schema.js';
import { RecordStore } from './store.js';
import type { AppendResult } from './store.js';

/** The complete record tool surface — three verbs, no update, no delete. */
export const RECORD_TOOL_NAMES = ['record_append', 'record_read', 'record_decision'] as const;

/** Real zod building blocks, borrowed from the SDK's own exported schemas. */
const zString = CursorSchema; // a plain z.string()
const zNumber = ProgressSchema.shape.progress; // a plain z.number()
// `.unwrap()` peels the SDK's own `.optional()` off, leaving a plain
// z.boolean() this file can re-decorate — the same borrow-don't-depend trick
// as the two above.
const zBoolean = ToolAnnotationsSchema.shape.readOnlyHint.unwrap();

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
  references?: RecordReference[] | undefined;
  content: string;
}

/**
 * Assemble the forward-edge list from the two write-verb arguments: the
 * ergonomic `supersedes` (a single record id → a `supersedes` edge) and the
 * general `references` escape hatch (a JSON array of `{rel, id}` for arbitrary
 * typed edges). The JSON envelope is parsed here; each reference id is
 * validated as a well-formed ULID so a typo is rejected with a typed SCHEMA
 * error at the tool layer before it can persist as a silent dangling edge.
 * (The store re-validates at the write chokepoint — defense in depth for the
 * CLI/migration transports that bypass this function.)
 */
function referencesFromArgs(
  supersedes: string | undefined,
  referencesJson: string | undefined,
): { refs: RecordReference[] } | { error: string } {
  const refs: RecordReference[] = [];
  if (supersedes !== undefined && supersedes !== '') {
    if (!isUlid(supersedes)) {
      return { error: `supersedes: ${JSON.stringify(supersedes)} is not a well-formed ULID` };
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
      const ref = item as RecordReference;
      if (typeof ref?.id !== 'string' || !isUlid(ref.id)) {
        return { error: `references: id ${JSON.stringify(ref?.id)} is not a well-formed ULID` };
      }
      refs.push(ref);
    }
  }
  return { refs };
}

/**
 * `source.capture_point`, derived from kind: a decision write IS the capture
 * (`record_decision`), everything else enters through the generic append
 * verb. Derivation lives in the shared
 * write path, so `record_append(kind=decision)` and `record_decision(...)`
 * stamp identical provenance — the sugar is byte-equivalent.
 */
function capturePointFor(kind: string): string {
  return kind === 'decision' ? 'mcp:record_decision' : 'mcp:record_append';
}

/**
 * THE one write path. Both write verbs call this and nothing else writes;
 * the `store.append` statement below is the Tier A capture write —
 * synchronous, before return, unguarded by any parameter or flag.
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
    ...(params.references === undefined ? {} : { references: params.references }),
    content: params.content,
  });
}

/** A malformed argument as a typed SCHEMA tool failure — the one error shape
 *  every verb here uses (a bad `references` arg on the write verbs, which
 *  never persists; a bad `cursor`/`limit` on the read verb). */
function schemaErrorResult(reason: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'SCHEMA', reason }) }],
    isError: true,
  };
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
 * tool call (the lazy-init onboarding of config/ideate-config.ts).
 */
export function createRecordToolsRegistrar(options: RecordToolsOptions = {}): ToolRegistrar {
  let context: ToolContext | undefined;

  /** Lazy composition edge — runs once, inside the first tool CALL. */
  const getContext = (): ToolContext => {
    if (context === undefined) {
      const clock = options.clock ?? (() => new Date());
      const projectRoot = options.projectRoot ?? process.cwd();
      // First call = onboarding: loadConfig lazily creates .ideate.json and
      // the record directory when absent (ideate-config.ts).
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
          'Append-only: no update or delete verb exists; a correction is a new record that SUPERSEDES the ' +
          'record it replaces — pass its id as `supersedes` so readers of the old record see it was superseded. ' +
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
          supersedes: zString
            .describe('Id of a record this one replaces. Recorded as a `supersedes` edge; the superseded record surfaces it as a backlink on read.')
            .optional(),
          references: zString
            .describe('Advanced: a JSON array of additional typed edges, e.g. [{"rel":"refutes","id":"01..."}]. `rel` is open vocabulary.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        const refs = referencesFromArgs(args.supersedes, args.references);
        if ('error' in refs) return schemaErrorResult(refs.error);
        // Tier A capture write — unconditional; no parameter gates it.
        const result = writeRecord(ctx, {
          kind: args.kind,
          claim: args.claim,
          verification_anchor: args.verification_anchor,
          scope: args.scope,
          task_id: args.task_id,
          references: refs.refs,
          content: args.content,
        });
        return appendToolResult(result);
      },
    );

    server.registerTool(
      'record_read',
      {
        description:
          'Read process records: newest first, optionally filtered by scope (plain substring selection over ' +
          'scope/kind/source fields) or by exact id. Unranked by contract — selection only, no scoring. ' +
          'SUMMARY ROWS BY DEFAULT: each row carries every field EXCEPT the prose body — id, kind, claim, scope, ' +
          'verification_anchor, source, references, referenced_by — plus content_length, the body length in ' +
          'UTF-16 code units (JS string length — NOT the same unit as work_list\'s spec_length, which counts ' +
          'Unicode code points; they can disagree on astral text). To read a body, pass include_content: true; to read ONE record in full, pass its id with ' +
          'include_content: true (that pair IS the by-id fetch — there is no separate get verb). ' +
          `PAGED: at most \`limit\` rows per call (default ${String(DEFAULT_RECORD_READ_LIMIT)}, clamped into ` +
          `1..${String(MAX_RECORD_READ_LIMIT)}); the result carries next_cursor — a string when more matching ` +
          'records exist, null on the last page. A page may also come back SHORTER than `limit` to stay within a ' +
          `payload budget (roughly ${String(LIST_PAYLOAD_BUDGET_CHARS)} characters of rows, which include_content ` +
          'reaches quickly), so never read a short page as exhaustion: follow next_cursor, which is non-null ' +
          'whenever records remain for ANY reason and null ONLY at true exhaustion. Pass it back as `cursor` to ' +
          'get the next page. The cursor is OPAQUE (never construct or parse one; a malformed cursor is a typed ' +
          'SCHEMA error, never an empty page) and is tied to the filter it was issued for — walk one filter to ' +
          'exhaustion before changing it. THERE IS NO "RETURN EVERYTHING": absence of `limit` means the default ' +
          'page, and the record FILES on disk are the durable export surface for a consumer that genuinely needs ' +
          'the whole store. Each row also carries its DERIVED referenced_by backlinks — computed over the WHOLE ' +
          'record, so a backlink from a record on another page still appears, and a superseded record still shows ' +
          'what replaced it.',
        inputSchema: {
          scope: zString
            .describe('Case-insensitive substring filter matched against scope, kind, and source fields.')
            .optional(),
          id: zString
            .describe('EXACT record id (ULID). Selects that one record; combine with include_content for the by-id fetch.')
            .optional(),
          include_content: zBoolean
            .describe('Return the prose body on every row (default false — summary rows). content_length is present either way, and paging applies regardless.')
            .optional(),
          limit: zNumber
            .int()
            .describe(`Maximum rows in this page. Default ${String(DEFAULT_RECORD_READ_LIMIT)}; clamped into 1..${String(MAX_RECORD_READ_LIMIT)}.`)
            .optional(),
          cursor: zString
            .describe('Opaque resumption point: the next_cursor from the previous page. Invalidated by changing any filter.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        try {
          // The DEFAULT page size, the clamp and the cursor contract all live
          // in read-page.ts, shared with the CLI — never in the store, whose
          // absent-limit behavior stays "every matching record" for internal
          // callers (context/assemble-prototype.ts). readViews attaches the
          // derived `referenced_by` backlinks (e.g. superseded_by).
          const page = readRecordPage(ctx.store, {
            ...(args.scope === undefined ? {} : { scope: args.scope }),
            ...(args.id === undefined ? {} : { id: args.id }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
          });
          const rows = page.records.map((view) => projectRecordRow(view, args.include_content === true));
          // …and the payload BUDGET on top of the count limit: `limit` bounds
          // the row COUNT, this bounds the characters those rows serialize to.
          // The COMPACT measure is the right one here — the SDK writes this
          // result as `JSON.stringify(body)` with no indent.
          const bounded = boundRecordPage({ records: rows, next_cursor: page.next_cursor }, measureCompactItemChars);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: true, records: bounded.records, next_cursor: bounded.next_cursor }),
              },
            ],
          };
        } catch (err) {
          // A malformed cursor or limit is THIS seam's typed error (never the
          // board's WorkStateError — GP-26). Anything else is genuinely
          // unexpected and re-thrown to the SDK's own error handling.
          if (err instanceof RecordSchemaError) return schemaErrorResult(err.message);
          throw err;
        }
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
          supersedes: zString
            .describe('Id of a prior decision this one overturns. Recorded as a `supersedes` edge; the old decision surfaces it as a backlink on read.')
            .optional(),
          references: zString
            .describe('Advanced: a JSON array of additional typed edges, e.g. [{"rel":"relates-to","id":"01..."}].')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        const refs = referencesFromArgs(args.supersedes, args.references);
        if ('error' in refs) return schemaErrorResult(refs.error);
        // Capture write — the SAME code path as record_append
        // (the write is the capture), unconditional.
        const result = writeRecord(ctx, {
          kind: 'decision',
          claim: args.claim,
          verification_anchor: args.verification_anchor,
          scope: args.scope,
          task_id: args.task_id,
          references: refs.refs,
          content: composeDecisionContent(args.claim, args.rationale),
        });
        return appendToolResult(result);
      },
    );
  };
}
