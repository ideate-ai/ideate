// plugin/src/usage/tools.ts — the two context-usage MCP verbs.
//
// Citation/usage instrumentation is the HARD PREREQUISITE of the
// context-quality metric — otherwise no edge is written when an agent uses an
// artifact. These two verbs close that gap on the composable surface:
//
//   - usage_capture — the MECHANICAL write. Given captured worker text and the
//     authoritative delivered set (manifest ids), it string-matches (no
//     inference) and appends one usage signal per cited id. The server never
//     judges relevance; it records which supplied ids are present in supplied
//     text. Intended mechanical callers are the eval/replay harness and (later)
//     a hook capture point — never an agent choosing what to "cite."
//   - usage_query — the READ. Returns usage signals + the distinct USED item
//     set for a filter (seed/task/manifest/session/kind). Under a `seed_id`
//     filter the used-item set IS the per-task recall denominator.
//
// usage_query is BOUNDED (usage/read-page.ts): at most `limit` signals per call
// AND at most the shared payload budget's worth of characters, plus an opaque
// keyset cursor over the store's ULID order. Usage is append-only measurement
// data, so an unbounded read grows monotonically forever — measured on this
// repo's equivalent-medium NDJSON, the whole envelope is 637,619 characters
// (~159k tokens), roughly 10x the payload that once exceeded a client's
// per-tool-result cap and hard-failed the call. The DEFAULT lives at this
// transport boundary, never in the store, whose absent-limit read stays "every
// matching signal" for the in-process metric that reads the denominator whole.
//
// Append-only: like the record surface, there is NO update/delete verb — the
// guard is enforced by API absence (usage/store.ts).
//
// Registration is side-effect free (mirrors record/tools.ts): the store is
// composed lazily inside the first tool CALL, so composing this registrar at
// module scope keeps boot pure. The usage directory is INJECTED, defaulting to
// `<projectRoot>/.ideate/usage` — no `.ideate.json` key is added.
//
// Parameter schemas reuse the SDK's own exported zod primitives (CursorSchema
// = z.string(), ProgressSchema.shape.progress = z.number()), exactly as
// record/tools.ts does, so the plugin adds no zod dependency of its own.

import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CursorSchema, ProgressSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { createUlidGenerator } from '../record/id.js';
import type { ToolRegistrar } from '../server.js';
import { LIST_PAYLOAD_BUDGET_CHARS, measureCompactItemChars } from '../transport/payload-budget.js';
import { captureCitedContext } from './capture.js';
import { DEFAULT_USAGE_QUERY_LIMIT, MAX_USAGE_QUERY_LIMIT, boundUsagePage, readUsagePage } from './read-page.js';
import { UsageSchemaError } from './schema.js';
import { UsageStore } from './store.js';
import type { UsageQuery } from './store.js';

/** The complete usage tool surface — two verbs, no update, no delete. */
export const USAGE_TOOL_NAMES = ['usage_capture', 'usage_query'] as const;

/** Default usage directory, relative to the project root. Grouped with the
 *  record store under `.ideate/` (both are process-signal stores). */
export const DEFAULT_USAGE_DIR = '.ideate/usage';

/** Real zod building blocks, borrowed from the SDK's own exported schemas —
 *  the same borrow-don't-depend trick record/tools.ts uses, so this file adds
 *  no zod dependency of its own. */
const zString = CursorSchema; // a plain z.string()
const zNumber = ProgressSchema.shape.progress; // a plain z.number()

/** Options for the registrar factory — all defaulted at the composition edge. */
export interface UsageToolsOptions {
  /** Project root the usage log lives under. Default: `process.cwd()` at first call. */
  projectRoot?: string;
  /** Usage store directory. Default: `<projectRoot>/.ideate/usage`. */
  usageDir?: string;
  /** Session identity stamped into `source.session_id`. Default: `mcp-<ULID>` minted once. */
  sessionId?: string;
  /** Injected clock. Default: wall clock. */
  clock?: Clock;
}

/** The lazily-built per-server context: one store, one session identity. */
interface ToolContext {
  store: UsageStore;
  sessionId: string;
}

/** Shape a tool payload into a single-text-block CallToolResult. */
function jsonResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** A caller-input failure (a malformed cursor, a non-integer limit) as a typed
 *  SCHEMA result — never a silent empty page, which a caller would read as "the
 *  log ended". Mirrors record/tools.ts's shape so the two read surfaces fail
 *  the same way. */
function schemaErrorResult(reason: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'SCHEMA', reason }) }],
    isError: true,
  };
}

/**
 * Build the registrar for the two usage verbs. Matches server.ts's
 * `ToolRegistrar` shape. Calling the registrar registers tools and does
 * NOTHING else — store construction waits for the first tool CALL.
 */
export function createUsageToolsRegistrar(options: UsageToolsOptions = {}): ToolRegistrar {
  let context: ToolContext | undefined;

  const getContext = (): ToolContext => {
    if (context === undefined) {
      const clock = options.clock ?? (() => new Date());
      const projectRoot = options.projectRoot ?? process.cwd();
      const usageDir = options.usageDir ?? join(projectRoot, DEFAULT_USAGE_DIR);
      const sessionId = options.sessionId ?? `mcp-${createUlidGenerator(clock)()}`;
      context = { store: new UsageStore(usageDir, clock), sessionId };
    }
    return context;
  };

  return (server: McpServer): void => {
    server.registerTool(
      'usage_capture',
      {
        description:
          'Record which DELIVERED context items a worker actually USED, forming the effectiveness denominator ' +
          'for retrieval quality. Mechanical: the supplied `delivered` ids are string-matched against `text` ' +
          '(no relevance inference); one append-only signal is written per cited id. Intended caller is a ' +
          'mechanical capture point (eval/replay harness or a hook), not agent discretion.',
        inputSchema: {
          text: zString.describe('The captured worker text to scan for citations of delivered items.'),
          delivered: zString
            .array()
            .describe('Authoritative delivered set: the item ids the assembler offered (the manifest ids).'),
          seed_id: zString.describe('The seed the assembly was for (usually the claimed work item).').optional(),
          manifest_id: zString.describe('The assembly manifest the items were delivered in.').optional(),
          task_id: zString.describe('Task / work-item ID in scope, stamped as provenance.').optional(),
          kind: zString.describe("Usage kind — 'used_context' (default) or 'cites'.").optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        const signals = captureCitedContext(ctx.store, {
          text: args.text,
          delivered: args.delivered,
          source: {
            capture_point: 'mcp:usage_capture',
            session_id: ctx.sessionId,
            ...(args.task_id === undefined ? {} : { task_id: args.task_id }),
          },
          ...(args.seed_id === undefined ? {} : { seed_id: args.seed_id }),
          ...(args.manifest_id === undefined ? {} : { manifest_id: args.manifest_id }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        });
        return jsonResult({
          ok: true,
          captured: signals.length,
          item_ids: signals.map((s) => s.item_id),
          ids: signals.map((s) => s.id),
        });
      },
    );

    server.registerTool(
      'usage_query',
      {
        description:
          'Read context-usage signals: exact-match filtered by seed/task/manifest/session/kind/item. Returns the ' +
          'matching signals plus `used_item_ids` — the distinct USED items of THIS PAGE, which under a seed_id ' +
          'filter accumulate into the per-task recall denominator (union the pages of a full walk; for a filter ' +
          'that fits in one page it already IS that set). Selection only, unranked (no scoring) — like record_read. ' +
          `PAGED, oldest first: at most \`limit\` signals per call (default ${String(DEFAULT_USAGE_QUERY_LIMIT)}, ` +
          `clamped into 1..${String(MAX_USAGE_QUERY_LIMIT)}), in the store's ULID id order; the result is ` +
          '{ok, signals, used_item_ids, next_cursor} — next_cursor is a string whenever matching signals remain ' +
          'and null ONLY at true exhaustion. Pass it back as `cursor` to get the next page. A page may also come ' +
          `back SHORTER than \`limit\` to stay within a payload budget (roughly ${String(LIST_PAYLOAD_BUDGET_CHARS)} ` +
          'characters of signals and their echoed item ids), so never read a short page as exhaustion: follow ' +
          'next_cursor until it is null. The cursor is OPAQUE (never construct or parse one; a malformed cursor ' +
          'is a typed SCHEMA error, never an empty page) and is tied to the filter it was issued for — walk one ' +
          'filter to exhaustion before changing it. THERE IS NO "RETURN EVERYTHING": absence of `limit` means the ' +
          'default page. The order is ascending, so a signal appended DURING a walk lands on a later page rather ' +
          'than being missed.',
        inputSchema: {
          item_id: zString.describe('Filter: the delivered item id that was used.').optional(),
          seed_id: zString.describe('Filter: the seed (work item) the assembly was for.').optional(),
          manifest_id: zString.describe('Filter: the assembly manifest.').optional(),
          task_id: zString.describe('Filter: the task / work-item id in provenance.').optional(),
          session_id: zString.describe('Filter: the capturing session.').optional(),
          kind: zString.describe("Filter: usage kind ('used_context' | 'cites').").optional(),
          limit: zNumber
            .int()
            .describe(`Maximum signals in this page. Default ${String(DEFAULT_USAGE_QUERY_LIMIT)}; clamped into 1..${String(MAX_USAGE_QUERY_LIMIT)}.`)
            .optional(),
          cursor: zString
            .describe('Opaque resumption point: the next_cursor from the previous page. Invalidated by changing any filter.')
            .optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const ctx = getContext();
        const filter: UsageQuery = {
          ...(args.item_id === undefined ? {} : { item_id: args.item_id }),
          ...(args.seed_id === undefined ? {} : { seed_id: args.seed_id }),
          ...(args.manifest_id === undefined ? {} : { manifest_id: args.manifest_id }),
          ...(args.task_id === undefined ? {} : { task_id: args.task_id }),
          ...(args.session_id === undefined ? {} : { session_id: args.session_id }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        };
        try {
          // The DEFAULT page size, the clamp and the cursor contract all live in
          // read-page.ts — never in the store, whose absent-limit behavior stays
          // "every matching signal" for the in-process metric that reads the
          // denominator whole.
          const page = readUsagePage(ctx.store, { filter, ...(args.limit === undefined ? {} : { limit: args.limit }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }) });
          // …and the payload BUDGET on top of the count limit: `limit` bounds the
          // signal COUNT, this bounds the characters those signals serialize to.
          // The COMPACT measure is the right one here — the SDK writes this
          // result as `JSON.stringify(body)` with no indent.
          const bounded = boundUsagePage(page, measureCompactItemChars);
          // NO `count`: under paging it would read as "how many there are" but
          // could only mean "how many on this page" — signals.length already
          // says that, and next_cursor is the only honest answer to "is there
          // more".
          return jsonResult({
            ok: true,
            used_item_ids: bounded.used_item_ids,
            signals: bounded.signals,
            next_cursor: bounded.next_cursor,
          });
        } catch (err) {
          // A malformed cursor or limit is THIS seam's typed error
          // (UsageSchemaError, never the record's or the board's — GP-26),
          // surfaced as a typed SCHEMA failure rather than a silent empty page.
          if (err instanceof UsageSchemaError) return schemaErrorResult(err.message);
          throw err;
        }
      },
    );
  };
}
