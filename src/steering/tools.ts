// plugin/src/steering/tools.ts — the two LIGHT steering MCP verbs.
//
// Design goal: minimal read/write verbs. Keep the surface tiny, with lean,
// strict contracts:
//
//   - `steering_read`  — SELECTION only (by domain / status / kind). Substring
//     + exact-field filters. No scoring, no ranking — ranking is the
//     assembler's job over the selected set, never the store's. Each item
//     carries its forward `references` and its DERIVED `referenced_by`
//     backlinks (e.g. `superseded_by`).
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CursorSchema } from '@modelcontextprotocol/sdk/types.js';

import type { ToolRegistrar } from '../server.js';
import type { Clock } from '../record/id.js';
import { STEERING_STATUSES, isSteeringId } from './schema.js';
import type { SteeringReference, SteeringStatus } from './schema.js';
import { SteeringStore } from './store.js';
import type { PutResult, SteeringReadOptions } from './store.js';

/** The complete steering tool surface — two verbs, one mutable, no hard delete. */
export const STEERING_TOOL_NAMES = ['steering_read', 'steering_put'] as const;

/** Real zod string, borrowed from the SDK's own exported schema. */
const zString = CursorSchema; // a plain z.string()

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

/** A malformed-`references` arg as a typed SCHEMA tool failure (never persists). */
function referencesErrorResult(reason: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'SCHEMA', reason }) }],
    isError: true,
  };
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
          'Read steering items (guiding principles + policies): selection-only by domain (substring), status, and kind. ' +
          'Unranked by contract — no scoring; ranking is the assembler’s job over the selected set. ' +
          'Each item carries its forward `references` and its DERIVED `referenced_by` backlinks, so a superseded ' +
          'item shows what superseded it. Gated OFF by default (GP-23).',
        inputSchema: {
          domain: zString.describe('Case-insensitive substring filter matched against the item domain.').optional(),
          status: zString.describe(`Exact lifecycle status filter: ${STEERING_STATUSES.join(' | ')}.`).optional(),
          kind: zString.describe('Exact kind filter: guiding-principle | policy | …').optional(),
        },
      },
      async (args): Promise<CallToolResult> => {
        const projectRoot = options.projectRoot ?? process.cwd();
        if (!readSteeringEnabledFlag(projectRoot)) return gatedResult();
        const status = normalizeStatus(args.status);
        const read: SteeringReadOptions = {
          ...(args.domain === undefined ? {} : { domain: args.domain }),
          ...(status === undefined ? {} : { status }),
          ...(args.kind === undefined ? {} : { kind: args.kind }),
        };
        // readViews attaches derived `referenced_by` backlinks (e.g. superseded_by).
        const items = getStore(projectRoot).readViews(read);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, count: items.length, items }) }] };
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
        if ('error' in refs) return referencesErrorResult(refs.error);
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
