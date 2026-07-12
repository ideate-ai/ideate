// plugin/src/cli/ideate-work.ts — the `ideate-work` CLI (WI-303): the
// SECOND transport over the same work-state logic layer the MCP verbs
// (work-state/tools.ts) use.
//
// Spec: docs/spikes/v3-work-delegation.md §3.5 — the eleven-verb surface,
// mirrored here one subcommand per verb (create/get/list/update-meta/claim/
// renew/release/complete/cancel/reopen/events), PLUS one CLI-ONLY twelfth
// subcommand, `sweep`, that is NOT part of the eleven-verb MCP surface: it
// runs expiry.ts's `sweepBoard` (the opportunistic board-wide expiry pass,
// §3.2 rule 2b), the mechanism the SessionStart/SessionEnd hooks trigger
// (hooks/session-start.mjs, hooks/session-end.mjs).
//
// EXIT-CODE SPLIT (mirrors cli/ideate-record.ts, WI-296 pattern):
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
import { claim, complete, release, renew } from '../work-state/claims.js';
import { createRealCompletionRecordWriter } from '../work-state/completion-record.js';
import type { CompletionRecordWriter } from '../work-state/completion-record.js';
import { checkExpiry, sweepBoard } from '../work-state/expiry.js';
import { primeOnClaim } from '../work-state/priming-hook.js';
import { WorkStateStore } from '../work-state/store.js';
import type { ListItemsFilter } from '../work-state/store.js';
import { WorkStateModuleError } from '../work-state/types.js';
import type { ActorRef, UpdateMetaInput, WorkItem, WorkItemStatus, WorkStateEvent } from '../work-state/types.js';
import type { ExpiryCheck } from '../work-state/verbs.js';
import { WorkStateVerbs } from '../work-state/verbs.js';

/** The one CLI-only subcommand — never an MCP tool (see file header). */
const HOOK_SUBCOMMANDS: ReadonlySet<string> = new Set(['sweep']);

const USAGE = `Usage: ideate-work <subcommand> [options]

Subcommands (mirror the eleven MCP work-state verbs):
  create --title <t> --spec <s> --spec-format <f> --human <h> [--agent <a>]
         [--depends-on <id1,id2,...>] [--tenant <t>]
      Create a new work item; prints the created item as JSON.
  get --id <id> [--json]
      Fetch one work item by id (or null). Runs the lazy-expiry seam first.
  list [--tenant <t>] [--status <open|in_progress|done|cancelled>] [--json]
      List work items with the derived claimability view attached.
  update-meta --id <id> --expected-version <n> [--title <t>] [--spec <s>]
         [--spec-format <f>] [--depends-on <id1,id2,...>]
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
  /** WI-306: built once per invocation (mirrors work-state/tools.ts's own
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
  // WI-306: the completion-record writer, built from the SAME project
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
  const tenantId = parsed.values.get('--tenant');
  const agent = parsed.values.get('--agent');

  const ctx = buildContext(process.cwd());
  try {
    const item = ctx.verbs.create({
      title,
      spec,
      spec_format: specFormat,
      ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
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
  const parsed = parseArgs(argv, { '--tenant': 'value', '--status': 'value', '--json': 'switch' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-work: list: ${err}\n`);
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
    const items = ctx.verbs.list(filter);
    if (parsed.switches.has('--json')) {
      stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    } else if (items.length === 0) {
      stdout.write('(no items)\n');
    } else {
      for (const item of items) {
        stdout.write(`${item.id} [${item.status}]${item.claimable ? ' claimable' : ''} ${item.title}\n`);
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
    const patch: UpdateMetaInput = {
      ...(parsed.values.has('--title') ? { title: parsed.values.get('--title') as string } : {}),
      ...(parsed.values.has('--spec') ? { spec: parsed.values.get('--spec') as string } : {}),
      ...(parsed.values.has('--spec-format') ? { spec_format: parsed.values.get('--spec-format') as string } : {}),
      ...(dependsOnRaw === undefined ? {} : { depends_on: dependsOnRaw.split(',').filter((s) => s.length > 0) }),
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
    // Wired, mechanically-gated-off claim-time priming seam (criterion 5) —
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
    // WI-306: completion-record post-commit hook — same call site as the MCP
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
