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
//     set for a filter (seed/task/manifest/session/kind). `usedItemIds` under a
//     `seed_id` filter IS the per-task recall denominator.
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
import { CursorSchema } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { createUlidGenerator } from '../record/id.js';
import type { ToolRegistrar } from '../server.js';
import { captureCitedContext } from './capture.js';
import { UsageStore } from './store.js';
import type { UsageQuery } from './store.js';

/** The complete usage tool surface — two verbs, no update, no delete. */
export const USAGE_TOOL_NAMES = ['usage_capture', 'usage_query'] as const;

/** Default usage directory, relative to the project root. Grouped with the
 *  record store under `.ideate/` (both are process-signal stores). */
export const DEFAULT_USAGE_DIR = '.ideate/usage';

/** Real zod building block, borrowed from the SDK's own exported schema. */
const zString = CursorSchema; // a plain z.string()

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
          'matching signals plus `used_item_ids` — the distinct USED items, which under a seed_id filter is the ' +
          "per-task recall denominator. Selection only, unranked (no scoring) — like record_read.",
        inputSchema: {
          item_id: zString.describe('Filter: the delivered item id that was used.').optional(),
          seed_id: zString.describe('Filter: the seed (work item) the assembly was for.').optional(),
          manifest_id: zString.describe('Filter: the assembly manifest.').optional(),
          task_id: zString.describe('Filter: the task / work-item id in provenance.').optional(),
          session_id: zString.describe('Filter: the capturing session.').optional(),
          kind: zString.describe("Filter: usage kind ('used_context' | 'cites').").optional(),
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
        const signals = ctx.store.query(filter);
        const usedItemIds = ctx.store.usedItemIds(filter);
        return jsonResult({ ok: true, count: signals.length, used_item_ids: usedItemIds, signals });
      },
    );
  };
}
