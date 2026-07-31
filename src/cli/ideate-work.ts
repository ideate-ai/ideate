// plugin/src/cli/ideate-work.ts — the `ideate-work` CLI: the
// SECOND transport over the same work-state logic layer the MCP verbs
// (work-state/tools.ts) use.
//
// The eleven-verb surface, mirrored here one subcommand per verb (create/get/
// list/update-meta/claim/renew/release/complete/cancel/reopen/events), PLUS
// one CLI-ONLY twelfth subcommand, `sweep`, that is NOT part of the
// eleven-verb MCP surface: it runs expiry.ts's `sweepBoard` (the
// opportunistic board-wide expiry pass), the mechanism the
// SessionStart/SessionEnd hooks trigger (hooks/session-start.mjs,
// hooks/session-end.mjs).
//
// EXIT-CODE SPLIT (mirrors cli/ideate-record.ts):
//   - --help/-h/no-args: print USAGE to stdout, exit 0 — a safe, informative
//     no-op, not an error.
//   - Direct-use verbs (create/get/list/update-meta/claim/renew/release/
//     complete/cancel/reopen/events) exit 1 on bad arguments or any internal
//     failure, so scripts can detect errors.
//   - `sweep` is a HOOK path: it ALWAYS exits 0, reporting problems on
//     stderr only, and prints nothing to stdout on success (silent stdout —
//     a sweep result must never corrupt whatever the calling hook is
//     itself emitting).
//
// Actor derivation mirrors work-state/tools.ts exactly (and, one layer
// deeper, the engine's own signatures): create/cancel/reopen/claim take
// --human/--agent; renew/release/complete take NEITHER — no such flags
// exist for those three subcommands at all.
//
// Wall clock lives HERE: this file is an outermost composition edge (repo
// convention — see telemetry/counters.ts).

import { join } from 'node:path';

import { loadConfig, workStatePath } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { createUlidGenerator } from '../record/id.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import {
  LIST_PAYLOAD_BUDGET_CHARS,
  applyListPayloadBudget,
  measurePrettyItemChars,
} from '../transport/payload-budget.js';
import { claim, complete, release, renew } from '../work-state/claims.js';
import { createRealCompletionRecordWriter } from '../work-state/completion-record.js';
import type { CompletionRecordWriter } from '../work-state/completion-record.js';
import { checkExpiry, sweepBoard } from '../work-state/expiry.js';
import { primeOnClaim } from '../work-state/priming-hook.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  WorkStateStore,
} from '../work-state/store.js';
import type { ListItemsFilter, ListPageOptions } from '../work-state/store.js';
import { WorkStateModuleError } from '../work-state/types.js';
import type { ActorRef, UpdateMetaInput, WorkItem, WorkItemStatus, WorkStateEvent } from '../work-state/types.js';
import type { ExpiryCheck } from '../work-state/verbs.js';
import { WorkStateVerbs } from '../work-state/verbs.js';

/** The one CLI-only subcommand — never an MCP tool (see file header). */
const HOOK_SUBCOMMANDS: ReadonlySet<string> = new Set(['sweep']);

const USAGE = `Usage: ideate-work <subcommand> [options]

Subcommands (mirror the eleven MCP work-state verbs):
  create --title <t> --spec <s> --spec-format <f> --human <h> [--agent <a>]
         [--depends-on <id1,id2,...>] [--supersedes <id>] [--tenant <t>]
      Create a new work item; prints the created item as JSON.
      \`--supersedes <id>\` records a supersedes edge to the item this one
      replaces — the superseded item surfaces the replacement as a derived
      referenced_by backlink on get/list.
  get --id <id> [--json]
      Fetch one work item by id (or null). Runs the lazy-expiry seam first.
  list [--tenant <t>] [--status <open|in_progress|done|cancelled>] [--json]
       [--include-spec] [--limit <n>] [--cursor <c>]
      List work items with the derived claimability view attached.
      Rows are SUMMARIES: every field except the opaque spec body, plus
      spec_length. \`--include-spec\` requires --json (the human listing never
      prints spec bodies, so reading them would be a silent no-op); fetch a
      single item's spec with \`get --id\` instead when you can.
      \`--json\` prints {"items": [...], "next_cursor": ...} and pages at
      ${String(DEFAULT_LIST_LIMIT)} items by default; the human-readable
      listing is UNPAGED unless you pass --limit or --cursor, and prints a
      resume hint when more items remain. --limit is clamped into
      1..${String(MAX_LIST_LIMIT)}. --cursor takes the next_cursor of a previous page
      verbatim: it is opaque (a malformed one is an error, never an empty
      page), it is invalidated by changing --tenant/--status (so walk one
      filter to exhaustion before changing it), and it implies the default
      page size when no --limit is given.
      A --json page may come back SHORTER than --limit: it also stays within
      the same ~${String(LIST_PAYLOAD_BUDGET_CHARS)}-character payload budget the MCP work_list
      tool applies (this listing is an agent-facing path too — see
      agents/journal-keeper.md), measured on the INDENTED bytes this stream
      actually writes, not on a compact form it does not. So never infer
      exhaustion from a short page: follow next_cursor, which is non-null
      whenever items remain for ANY reason and null ONLY at true exhaustion.
      A single item larger than the whole budget is still returned, alone.
      The human-readable listing is NOT budgeted.
  update-meta --id <id> --expected-version <n> [--title <t>] [--spec <s>]
         [--spec-format <f>] [--depends-on <id1,id2,...>] [--supersedes <id>]
      Update metadata via optimistic CAS on version.
  claim --id <id> --human <h> [--agent <a>] [--lease-ms <n>]
      Claim an open, claimable item; mints a fencing token.
  renew --id <id> --token <n> [--lease-ms <n>]
      Renew an active claim's lease. No actor flags — the token proves identity.
  release --id <id> --token <n> [--note <n>]
      Release an active claim back to open. No actor flags.
  complete --id <id> --token <n> [--note <n>]
      Complete an active claim. No actor flags.
  cancel --id <id> --human <h> [--agent <a>]
      Cancel an item from open or in_progress; voids any active claim.
  reopen --id <id> --human <h> [--agent <a>]
      Reopen an item from done back to open.
  events --id <id> [--json]
      All events for one item, oldest first.
  sweep [--tenant <t>]
      CLI-ONLY (not an MCP tool): run the opportunistic board-wide expiry
      pass (expiry.ts's sweepBoard) — the mechanism SessionStart/SessionEnd
      hooks trigger. ALWAYS exits 0; stdout stays silent; diagnostics go to
      stderr only.

Exit codes: every subcommand above sweep exits 1 on any failure (direct-use
paths); sweep ALWAYS exits 0 (a hook-invoked path — see hooks/session-start.mjs
and hooks/session-end.mjs).
`;

/** Injectable process edges, for tests; every member defaults to the real one. */
export interface CliIo {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// Small argv parser (repo posture: zero runtime dependencies — mirrors
// cli/ideate-record.ts's own parser byte-for-byte in shape).
// ---------------------------------------------------------------------------

type FlagKind = 'value' | 'switch';

interface ParsedArgs {
  values: Map<string, string>;
  switches: Set<string>;
  errors: string[];
}

function parseArgs(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>): ParsedArgs {
  const parsed: ParsedArgs = { values: new Map(), switches: new Set(), errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const kind = spec[arg];
    if (kind === undefined) {
      parsed.errors.push(`unknown argument ${arg}`);
      continue;
    }
    if (kind === 'switch') {
      parsed.switches.add(arg);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      parsed.errors.push(`${arg} requires a value`);
      continue;
    }
    parsed.values.set(arg, value);
    i += 1;
  }
  return parsed;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shape a caught error for stderr: a typed WorkStateModuleError prints its
 *  code; anything else prints its message alone. */
function describeError(err: unknown): string {
  if (err instanceof WorkStateModuleError) return `${err.code}: ${err.message}`;
  return errorMessage(err);
}

function parseIntArg(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new WorkStateModuleErrorForCli(`${flag} must be an integer, got ${raw}`);
  }
  return value;
}

/** A tiny CLI-local parse-failure marker — distinct from the engine's own
 *  typed errors (WorkStateModuleError), which this file never subclasses. */
class WorkStateModuleErrorForCli extends Error {
  constructor(message: string) {
    super(message);
  }
}

const STATUS_VALUES: readonly WorkItemStatus[] = ['open', 'in_progress', 'done', 'cancelled'];

function parseStatusArg(raw: string | undefined): WorkItemStatus | undefined {
  if (raw === undefined) return undefined;
  if (!(STATUS_VALUES as readonly string[]).includes(raw)) {
    throw new WorkStateModuleErrorForCli(`--status must be one of ${STATUS_VALUES.join(', ')}, got ${raw}`);
  }
  return raw as WorkItemStatus;
}

function actorFrom(human: string, agent: string | undefined): ActorRef {
  return agent === undefined ? { human } : { human, agent };
}

// ---------------------------------------------------------------------------
// Composition edge: config → store/verbs → telemetry (mirrors work-state/tools.ts)
// ---------------------------------------------------------------------------

interface CliContext {
  store: WorkStateStore;
  verbs: WorkStateVerbs;
  clock: Clock;
  telemetry: TelemetryCounters;
  sessionId: string;
  projectRoot: string;
  /** Built once per invocation (mirrors work-state/tools.ts's own
   *  memoized context). */
  completionRecordWriter: CompletionRecordWriter;
}

function buildContext(projectRoot: string): CliContext {
  const clock: Clock = () => new Date();
  const config = loadConfig(projectRoot);
  const dbPath = join(workStatePath(config, projectRoot), 'board.db');
  const store = new WorkStateStore(dbPath, clock);
  const verbs = new WorkStateVerbs(store, clock);
  const telemetry = new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), clock);
  const sessionId = `cli-${createUlidGenerator(clock)()}`;
  // The completion-record writer, built from the SAME project
  // root/telemetry/clock this context already resolved.
  const completionRecordWriter = createRealCompletionRecordWriter(projectRoot, telemetry, clock);
  return { store, verbs, clock, telemetry, sessionId, projectRoot, completionRecordWriter };
}

function makeExpiryCheck(ctx: CliContext): ExpiryCheck {
  return (itemId: string): void => {
    checkExpiry(ctx.store, ctx.clock, itemId);
  };
}

function printItem(item: WorkItem, stdout: NodeJS.WritableStream, asJson: boolean): void {
  stdout.write(asJson ? `${JSON.stringify(item, null, 2)}\n` : `${JSON.stringify(item)}\n`);
}

function printEvents(events: readonly WorkStateEvent[], stdout: NodeJS.WritableStream, asJson: boolean): void {
  if (asJson) {
    stdout.write(`${JSON.stringify(events, null, 2)}\n`);
    return;
  }
  if (events.length === 0) {
    stdout.write('(no events)\n');
    return;
  }
  for (const event of events) {
    const note = event.note === undefined ? '' : ` note=${JSON.stringify(event.note)}`;
    const token = event.claim_token === undefined ? '' : ` token=${String(event.claim_token)}`;
    stdout.write(`${event.at} ${event.transition} actor=${event.actor.human}${token}${note}\n`);
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers — direct-use paths (exit 1 on failure)
// ---------------------------------------------------------------------------

function runCreate(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, {
    '--title': 'value',
    '--spec': 'value',
    '--spec-format': 'value',
    '--depends-on': 'value',
    '--supersedes': 'value',
    '--tenant': 'value',
    '--human': 'value',
    '--agent': 'value',
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: create: ${err}\n`);
    return 1;
  }
  const title = parsed.values.get('--title');
  const spec = parsed.values.get('--spec');
  const specFormat = parsed.values.get('--spec-format');
  const human = parsed.values.get('--human');
  if (title === undefined || spec === undefined || specFormat === undefined || human === undefined) {
    stderr.write('ideate-work: create requires --title, --spec, --spec-format, and --human\n');
    return 1;
  }
  const dependsOnRaw = parsed.values.get('--depends-on');
  const dependsOn = dependsOnRaw === undefined ? undefined : dependsOnRaw.split(',').filter((s) => s.length > 0);
  const supersedes = parsed.values.get('--supersedes');
  const tenantId = parsed.values.get('--tenant');
  const agent = parsed.values.get('--agent');

  const ctx = buildContext(process.cwd());
  try {
    const item = ctx.verbs.create({
      title,
      spec,
      spec_format: specFormat,
      ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
      // The ergonomic supersedes flag maps to one typed forward edge —
      // mirrors cli/ideate-record.ts's --supersedes exactly. ULID
      // well-formedness and target existence are validated one layer down
      // (store.ts's write chokepoint and dag.ts's guard), so a malformed or
      // dangling id surfaces as a typed engine error here, exit 1.
      ...(supersedes === undefined || supersedes === '' ? {} : { references: [{ rel: 'supersedes', id: supersedes }] }),
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      created_by: actorFrom(human, agent),
    });
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: create failed (${describeError(err)})\n`);
    return 1;
  }
}

function runGet(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--json': 'switch' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: get: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  if (id === undefined) {
    stderr.write('ideate-work: get requires --id\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const item = ctx.verbs.get(id, makeExpiryCheck(ctx));
    if (item === null) {
      stdout.write(parsed.switches.has('--json') ? 'null\n' : '(not found)\n');
      return 0;
    }
    printItem(item, stdout, parsed.switches.has('--json'));
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: get failed (${describeError(err)})\n`);
    return 1;
  }
}

function runList(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, {
    '--tenant': 'value',
    '--status': 'value',
    '--json': 'switch',
    '--include-spec': 'switch',
    '--limit': 'value',
    '--cursor': 'value',
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: list: ${err}\n`);
    return 1;
  }
  // --include-spec is a --json-ONLY flag, and it is rejected loudly rather
  // than ignored: the human listing prints `id [status] title` and has nowhere
  // to put a spec body, so honouring the flag there would read every opaque
  // spec out of SQLite and print none of it — a silent no-op with a real cost.
  // Rejected before the store is opened, so the misuse costs nothing.
  if (parsed.switches.has('--include-spec') && !parsed.switches.has('--json')) {
    stderr.write('ideate-work: list: --include-spec requires --json (the human-readable listing never prints spec bodies)\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const status = parseStatusArg(parsed.values.get('--status'));
    const tenantId = parsed.values.get('--tenant');
    const filter: ListItemsFilter = {
      ...(tenantId === undefined ? {} : { tenant_id: tenantId }),
      ...(status === undefined ? {} : { status }),
    };
    const asJson = parsed.switches.has('--json');
    const limitRaw = parsed.values.get('--limit');
    const cursor = parsed.values.get('--cursor');
    // The default page size applies to --json only: that is the
    // machine-consumed path (and the payload-bounding one, mirroring the MCP
    // work_list tool). The human listing is one short line per item and has
    // always shown the whole board — silently truncating it would be a
    // behavior change, so it stays UNPAGED unless the operator asks for a page.
    // Clamping ([1, MAX_LIST_LIMIT]) and cursor decoding both live in the
    // store, so this transport cannot drift from the MCP one.
    //
    // …and --cursor IS asking for a page: resuming from a boundary with no
    // LIMIT clause would emit every remaining row and then report
    // `next_cursor: null` — a page that is not a page, reporting exhaustion it
    // did not verify. So a --cursor without an explicit --limit takes the
    // default page size on BOTH paths, which also makes the human path's
    // "resume with --cursor …" hint lead somewhere coherent.
    const limit =
      limitRaw === undefined ? (asJson || cursor !== undefined ? DEFAULT_LIST_LIMIT : undefined) : parseIntArg(limitRaw, '--limit');
    const page: ListPageOptions = {
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(parsed.switches.has('--include-spec') ? { include_spec: true } : {}),
    };
    const result = ctx.verbs.listSummaries(filter, page);
    if (asJson) {
      // The payload BUDGET, on top of the count limit — the SAME budget and
      // the SAME implementation the MCP work_list tool applies
      // (transport/payload-budget.ts), because this is an agent-facing path too:
      // agents/journal-keeper.md has an agent run `ideate-work list --json`,
      // so this stdout lands in a context window as a tool result, under the
      // same kind of cap the MCP result was (measured at 66,324 characters on
      // a real 125-item board — larger than the failure the budget exists to
      // prevent). A page shortened here still carries an honest next_cursor,
      // rebuilt from its last INCLUDED row.
      //
      // The PRETTY measure, not the compact one: this path writes
      // `JSON.stringify(…, null, 2)`, ~35% larger than the compact form for
      // identical rows, and a budget must bound what is actually written.
      const bounded = applyListPayloadBudget(result, measurePrettyItemChars);
      stdout.write(`${JSON.stringify({ items: bounded.items, next_cursor: bounded.next_cursor }, null, 2)}\n`);
    } else if (result.items.length === 0) {
      stdout.write('(no items)\n');
    } else {
      for (const item of result.items) {
        stdout.write(`${item.id} [${item.status}]${item.claimable ? ' claimable' : ''} ${item.title}\n`);
      }
      // Only reachable when --limit or --cursor was passed (see above), so the
      // no-flags human listing is byte-for-byte what it always was.
      if (result.next_cursor !== null) {
        stdout.write(`(more items — resume with --cursor ${result.next_cursor})\n`);
      }
    }
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: list failed (${describeError(err)})\n`);
    return 1;
  }
}

function runUpdateMeta(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, {
    '--id': 'value',
    '--expected-version': 'value',
    '--title': 'value',
    '--spec': 'value',
    '--spec-format': 'value',
    '--depends-on': 'value',
    '--supersedes': 'value',
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: update-meta: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const expectedVersionRaw = parsed.values.get('--expected-version');
  if (id === undefined || expectedVersionRaw === undefined) {
    stderr.write('ideate-work: update-meta requires --id and --expected-version\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const expectedVersion = parseIntArg(expectedVersionRaw, '--expected-version');
    const dependsOnRaw = parsed.values.get('--depends-on');
    const supersedes = parsed.values.get('--supersedes');
    const patch: UpdateMetaInput = {
      ...(parsed.values.has('--title') ? { title: parsed.values.get('--title') as string } : {}),
      ...(parsed.values.has('--spec') ? { spec: parsed.values.get('--spec') as string } : {}),
      ...(parsed.values.has('--spec-format') ? { spec_format: parsed.values.get('--spec-format') as string } : {}),
      ...(dependsOnRaw === undefined ? {} : { depends_on: dependsOnRaw.split(',').filter((s) => s.length > 0) }),
      // `--supersedes <id>` maps to one typed forward edge with wholesale-replace
      // semantics (mirrors `create --supersedes` and the MCP work_update_meta).
      ...(supersedes === undefined || supersedes === '' ? {} : { references: [{ rel: 'supersedes', id: supersedes }] }),
    };
    const item = ctx.verbs.updateMeta(id, expectedVersion, patch, makeExpiryCheck(ctx));
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: update-meta failed (${describeError(err)})\n`);
    return 1;
  }
}

function runClaim(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--human': 'value', '--agent': 'value', '--lease-ms': 'value' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: claim: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const human = parsed.values.get('--human');
  if (id === undefined || human === undefined) {
    stderr.write('ideate-work: claim requires --id and --human\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const leaseMsRaw = parsed.values.get('--lease-ms');
    const leaseMs = leaseMsRaw === undefined ? undefined : parseIntArg(leaseMsRaw, '--lease-ms');
    const actor = actorFrom(human, parsed.values.get('--agent'));
    const item = claim(ctx.store, ctx.clock, id, actor, leaseMs === undefined ? undefined : { leaseMs });
    // Wired, mechanically-gated-off claim-time priming seam —
    // same call site as the MCP work_claim tool (work-state/tools.ts).
    primeOnClaim({ projectRoot: ctx.projectRoot, itemId: id, actor, sessionId: ctx.sessionId, telemetry: ctx.telemetry });
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: claim failed (${describeError(err)})\n`);
    return 1;
  }
}

function runRenew(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--token': 'value', '--lease-ms': 'value' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: renew: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const tokenRaw = parsed.values.get('--token');
  if (id === undefined || tokenRaw === undefined) {
    stderr.write('ideate-work: renew requires --id and --token\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const token = parseIntArg(tokenRaw, '--token');
    const leaseMsRaw = parsed.values.get('--lease-ms');
    const leaseMs = leaseMsRaw === undefined ? undefined : parseIntArg(leaseMsRaw, '--lease-ms');
    const item = renew(ctx.store, ctx.clock, id, token, leaseMs === undefined ? undefined : { leaseMs });
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: renew failed (${describeError(err)})\n`);
    return 1;
  }
}

function runRelease(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--token': 'value', '--note': 'value' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: release: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const tokenRaw = parsed.values.get('--token');
  if (id === undefined || tokenRaw === undefined) {
    stderr.write('ideate-work: release requires --id and --token\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const token = parseIntArg(tokenRaw, '--token');
    const item = release(ctx.store, ctx.clock, id, token, parsed.values.get('--note'));
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: release failed (${describeError(err)})\n`);
    return 1;
  }
}

function runComplete(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--token': 'value', '--note': 'value' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: complete: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const tokenRaw = parsed.values.get('--token');
  if (id === undefined || tokenRaw === undefined) {
    stderr.write('ideate-work: complete requires --id and --token\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const token = parseIntArg(tokenRaw, '--token');
    // Completion-record post-commit hook — same call site as the MCP
    // work_complete tool (work-state/tools.ts), reusing this context's own
    // project root/telemetry/session id/writer.
    const item = complete(ctx.store, ctx.clock, id, token, parsed.values.get('--note'), {
      projectRoot: ctx.projectRoot,
      telemetry: ctx.telemetry,
      sessionId: ctx.sessionId,
      recordWriter: ctx.completionRecordWriter,
    });
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: complete failed (${describeError(err)})\n`);
    return 1;
  }
}

function runCancel(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--human': 'value', '--agent': 'value' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: cancel: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const human = parsed.values.get('--human');
  if (id === undefined || human === undefined) {
    stderr.write('ideate-work: cancel requires --id and --human\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const actor = actorFrom(human, parsed.values.get('--agent'));
    const item = ctx.verbs.cancel(id, actor, makeExpiryCheck(ctx));
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: cancel failed (${describeError(err)})\n`);
    return 1;
  }
}

function runReopen(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--human': 'value', '--agent': 'value' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: reopen: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  const human = parsed.values.get('--human');
  if (id === undefined || human === undefined) {
    stderr.write('ideate-work: reopen requires --id and --human\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const actor = actorFrom(human, parsed.values.get('--agent'));
    const item = ctx.verbs.reopen(id, actor, makeExpiryCheck(ctx));
    printItem(item, stdout, false);
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: reopen failed (${describeError(err)})\n`);
    return 1;
  }
}

function runEvents(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--id': 'value', '--json': 'switch' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: events: ${err}\n`);
    return 1;
  }
  const id = parsed.values.get('--id');
  if (id === undefined) {
    stderr.write('ideate-work: events requires --id\n');
    return 1;
  }
  const ctx = buildContext(process.cwd());
  try {
    const events = ctx.verbs.events(id, makeExpiryCheck(ctx));
    printEvents(events, stdout, parsed.switches.has('--json'));
    return 0;
  } catch (err) {
    stderr.write(`ideate-work: events failed (${describeError(err)})\n`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// sweep — CLI-ONLY, hook path (ALWAYS exit 0, silent stdout)
// ---------------------------------------------------------------------------

function runSweep(argv: readonly string[], stderr: NodeJS.WritableStream): number {
  // Hook path: every return from this function is 0; stdout stays silent
  // (see file header — a sweep result must never corrupt a calling hook's
  // own output).
  const parsed = parseArgs(argv, { '--tenant': 'value' });
  for (const err of parsed.errors) {
    stderr.write(`ideate-work: sweep: ${err} (ignored — hook path)\n`);
  }
  try {
    const ctx = buildContext(process.cwd());
    const tenantId = parsed.values.get('--tenant');
    const results = sweepBoard(ctx.store, ctx.clock, tenantId === undefined ? undefined : { tenant_id: tenantId });
    const recovered = results.filter((r) => r.expired).length;
    if (recovered > 0) {
      stderr.write(`ideate-work: sweep: reclaimed ${String(recovered)} expired claim(s)\n`);
    }
  } catch (err) {
    stderr.write(`ideate-work: sweep: internal failure (${describeError(err)}) — never a hook failure\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/** CLI entry. Returns the process exit code (see the exit-code split above). */
export function main(argv: string[] = process.argv.slice(2), io: CliIo = {}): number {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    stdout.write(USAGE);
    return 0;
  }

  const rest = argv.slice(1);
  const isHookPath = HOOK_SUBCOMMANDS.has(subcommand);
  try {
    switch (subcommand) {
      case 'create':
        return runCreate(rest, stdout, stderr);
      case 'get':
        return runGet(rest, stdout, stderr);
      case 'list':
        return runList(rest, stdout, stderr);
      case 'update-meta':
        return runUpdateMeta(rest, stdout, stderr);
      case 'claim':
        return runClaim(rest, stdout, stderr);
      case 'renew':
        return runRenew(rest, stdout, stderr);
      case 'release':
        return runRelease(rest, stdout, stderr);
      case 'complete':
        return runComplete(rest, stdout, stderr);
      case 'cancel':
        return runCancel(rest, stdout, stderr);
      case 'reopen':
        return runReopen(rest, stdout, stderr);
      case 'events':
        return runEvents(rest, stdout, stderr);
      case 'sweep':
        return runSweep(rest, stderr);
      default:
        stderr.write(`ideate-work: unknown subcommand ${subcommand}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    stderr.write(`ideate-work: ${subcommand} failed internally: ${errorMessage(err)}\n`);
    return isHookPath ? 0 : 1;
  }
}
