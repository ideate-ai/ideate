// plugin/src/cli/ideate-record.ts — the `ideate-record` CLI (WI-274): the
// SECOND transport over the same gated record core (WI-271).
//
// Spec: docs/design/v3-composable-surface.md §1.1 — one implementation, two
// transports. This executable exposes the SAME RecordStore append/read path
// the MCP verbs (record/tools.ts) use, as a plugin `bin/` executable, so
// host hooks can write capture records with no MCP server and no agent in
// the loop (hooks invoke it via `${CLAUDE_PLUGIN_ROOT}/bin/ideate-record`).
// §2.1 Tier B: a hook-written record passes the same capture-time secret
// gate as every other write, because the ONLY write path here is
// RecordStore.append — gate-before-persist lives inside the core, and this
// module deliberately adds no second write path that could bypass it.
//
// Subcommands:
//   append       — build one record and append it through the gated core;
//                  prints the new record id.
//   read         — unranked, scope-filtered, newest-first read passthrough.
//   session-end  — Tier B capture point 2 (composable surface §2.2 row 2):
//                  reads the SessionEnd hook payload from STDIN
//                  (session_id, transcript_path, cwd, hook_event_name,
//                  reason) and appends a recall-shaped session-outcome
//                  record whose content is PROSE — structural extraction
//                  from the transcript JSONL composed into sentences, never
//                  bare metadata (boundary contract §6.2: findable
//                  vocabulary must be physically present as words; gate G8
//                  measures this floor). A missing/unreadable transcript
//                  still produces a minimal prose record; the hook never
//                  fails.
//   prime        — the priming digest (composable surface §3; boundary
//                  contract §4.3): a bounded, UNRANKED selection of the most
//                  recent (optionally scope-filtered) records, formatted as
//                  a compact digest suitable for hook additionalContext
//                  output. Recency + scope selection ONLY — ranking the
//                  record is curating it (§4.2/§4.3) and no rank/score
//                  function exists anywhere on this path.
//
// EXIT-CODE SPLIT (deliberate, documented, tested):
//   - Direct-use paths (`append`, `read`) exit 1 on bad arguments or any
//     internal failure, so scripts can detect errors.
//   - Hook-invoked paths (`session-end`, `prime`) exit 0 UNCONDITIONALLY,
//     printing diagnostics to stderr only: a capture/priming failure must
//     NEVER look like a hook failure to the host (composable surface §2.2
//     falsifiability note — "log + count, never block"). Record-write
//     failures are already telemetry-counted by the store
//     (capture_write_failed); this edge adds no swallowing beyond the exit
//     code.
//
// Wall clock lives HERE: this file is an outermost composition edge, so —
// per the repo convention (see telemetry/counters.ts) — it is the one place
// that defaults the injected clock to `() => new Date()`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { loadConfig } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { createUlidGenerator } from '../record/id.js';
import type { ProcessRecord } from '../record/schema.js';
import { RecordStore } from '../record/store.js';
import { TelemetryCounters } from '../telemetry/counters.js';

/**
 * Default prime budget — a COUNT CAP (number of records), not a token
 * estimate. The number 10 is a PLACEHOLDER: any tuning of this default is an
 * intelligence-adjacent claim and goes through the eval harness first
 * (GP-23; composable surface §3 "small fixed budget... a count cap, not a
 * tuned relevance system").
 */
export const DEFAULT_PRIME_BUDGET = 10;

/** Subcommands invoked by host hooks — the exit-0-always paths. */
const HOOK_SUBCOMMANDS: ReadonlySet<string> = new Set(['session-end', 'prime']);

const USAGE = `Usage: ideate-record <subcommand> [options]

Subcommands:
  append --kind <k> --claim <c> [--anchor <a>] [--scope <s>]
         [--content <text> | --content -] [--task <id>]
      Append one record through the gated core (secret gate runs inside the
      store); prints the new record id. \`--content -\` reads the prose body
      from stdin.
  read [--scope <substring>] [--limit <n>] [--json]
      Print records, newest first. Scope is plain substring SELECTION over
      scope/kind/source fields — unranked by contract.
  session-end
      Hook edge (SessionEnd): reads the hook payload JSON from stdin and
      appends a recall-shaped session-outcome record (prose composed from
      the transcript when readable, minimal prose otherwise).
  prime [--scope <substring>] [--budget <n>]
      Print a compact digest of the <n> most recent records (default
      ${String(DEFAULT_PRIME_BUDGET)} — a count cap, not a token budget; unranked: recency + scope
      selection only) for hook additionalContext output.

Exit codes: append/read exit 1 on any failure (direct-use paths);
session-end/prime ALWAYS exit 0, reporting problems on stderr only (a
capture/priming failure must never look like a hook failure to the host).
`;

/** Injectable process edges, for tests; every member defaults to the real one. */
export interface CliIo {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// Small argv parser (repo posture: zero runtime dependencies)
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

/** Drain a stream to a string. A TTY stdin reads as empty — never hangs. */
async function readAll(stream: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  if (stream.isTTY === true) return '';
  let data = '';
  for await (const chunk of stream) {
    data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Composition edge: config → telemetry → store (the WI-271 core)
// ---------------------------------------------------------------------------

interface CliContext {
  store: RecordStore;
  telemetry: TelemetryCounters;
  sessionId: string;
}

/**
 * Build the per-invocation context. `loadConfig` is the §2.3 lazy-init
 * onboarding: the first hook fire / first CLI call creates `.ideate.json`
 * and the record directory. The telemetry dir mirrors record/tools.ts's
 * default (`<projectRoot>/.ideate-telemetry`) so both transports and the
 * `ideate-telemetry` CLI share one state file.
 */
function buildContext(projectRoot: string, sessionId?: string): CliContext {
  const clock: Clock = () => new Date();
  const config = loadConfig(projectRoot);
  const telemetry = new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), clock);
  const sid = sessionId ?? `cli-${createUlidGenerator(clock)()}`;
  return { store: new RecordStore(config, projectRoot, telemetry, clock), telemetry, sessionId: sid };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// append — direct-use path (exit 1 on failure)
// ---------------------------------------------------------------------------

async function runAppend(
  argv: readonly string[],
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const parsed = parseArgs(argv, {
    '--kind': 'value',
    '--claim': 'value',
    '--anchor': 'value',
    '--scope': 'value',
    '--content': 'value',
    '--task': 'value',
  });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-record: append: ${err}\n`);
    stderr.write(USAGE);
    return 1;
  }
  const kind = parsed.values.get('--kind');
  const claim = parsed.values.get('--claim');
  if (kind === undefined || claim === undefined) {
    stderr.write('ideate-record: append requires --kind and --claim\n');
    stderr.write(USAGE);
    return 1;
  }

  let content = parsed.values.get('--content') ?? '';
  if (content === '-') content = await readAll(stdin);

  const ctx = buildContext(process.cwd());
  const taskId = parsed.values.get('--task');
  // THE write: through the gated core. No second write path exists here.
  const result = ctx.store.append({
    kind,
    claim,
    verification_anchor: parsed.values.get('--anchor') ?? '',
    scope: parsed.values.get('--scope') ?? '',
    source: {
      capture_point: 'cli:append',
      session_id: ctx.sessionId,
      ...(taskId === undefined ? {} : { task_id: taskId }),
    },
    content,
  });
  if (!result.ok) {
    stderr.write(`ideate-record: append failed (${result.code}): ${result.reason}\n`);
    return 1;
  }
  stdout.write(`${result.record.id}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// read — direct-use path (exit 1 on failure)
// ---------------------------------------------------------------------------

function formatRecord(record: ProcessRecord): string {
  const task = record.source.task_id === undefined ? '' : ` / ${record.source.task_id}`;
  const lines = [
    `${record.id} [${record.kind}] ${record.source.timestamp}`,
    `  claim:  ${record.claim}`,
    `  anchor: ${record.verification_anchor}`,
    `  scope:  ${record.scope}`,
    `  source: ${record.source.capture_point} / ${record.source.session_id}${task}`,
  ];
  if (record.content.length > 0) {
    lines.push(...record.content.split('\n').map((line) => `  ${line}`));
  }
  return lines.join('\n');
}

function runRead(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  const parsed = parseArgs(argv, { '--scope': 'value', '--limit': 'value', '--json': 'switch' });
  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) stderr.write(`ideate-record: read: ${err}\n`);
    stderr.write(USAGE);
    return 1;
  }
  let limit: number | undefined;
  const limitRaw = parsed.values.get('--limit');
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) {
      stderr.write(`ideate-record: read: --limit must be a non-negative integer, got ${limitRaw}\n`);
      return 1;
    }
  }

  const ctx = buildContext(process.cwd());
  const scope = parsed.values.get('--scope');
  const records = ctx.store.read({
    ...(scope === undefined ? {} : { scope }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (parsed.switches.has('--json')) {
    stdout.write(`${JSON.stringify(records, null, 2)}\n`);
  } else {
    stdout.write(records.map(formatRecord).join('\n\n'));
    stdout.write(records.length > 0 ? '\n' : '(no records)\n');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// session-end — hook path (ALWAYS exit 0)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Structural shape of one session transcript, cheaply extracted. */
interface TranscriptSummary {
  userTurns: number;
  assistantTurns: number;
  /** tool name → use count, in first-seen order. */
  toolCounts: Map<string, number>;
  /** Distinct file paths pulled from tool_use inputs, in first-seen order. */
  files: string[];
  /** The last assistant text block seen, verbatim. */
  lastAssistantText: string;
}

/** input keys whose string values are file paths, cheaply extractable. */
const FILE_PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

/**
 * Structural extraction from a Claude Code transcript JSONL — honest and
 * cheap: turn counts, tool-use counts, file paths lifted from tool inputs,
 * and the last assistant text block. Returns undefined when the file is
 * missing/unreadable or no line parses as a transcript entry — the caller
 * then writes the minimal payload-only record instead.
 */
function summarizeTranscript(transcriptPath: string): TranscriptSummary | undefined {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
  const summary: TranscriptSummary = {
    userTurns: 0,
    assistantTurns: 0,
    toolCounts: new Map(),
    files: [],
    lastAssistantText: '',
  };
  const seenFiles = new Set<string>();
  let parsedAny = false;
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn/foreign line must not poison the whole summary
    }
    if (!isObject(entry)) continue;
    const type = entry['type'];
    if (type === 'user') {
      parsedAny = true;
      summary.userTurns += 1;
      continue;
    }
    if (type !== 'assistant') continue;
    parsedAny = true;
    summary.assistantTurns += 1;
    const message = entry['message'];
    const content = isObject(message) ? message['content'] : undefined;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block['type'] === 'text') {
        const text = asString(block['text']);
        if (text !== undefined && text.trim().length > 0) summary.lastAssistantText = text;
        continue;
      }
      if (block['type'] !== 'tool_use') continue;
      const name = asString(block['name']) ?? 'unknown-tool';
      summary.toolCounts.set(name, (summary.toolCounts.get(name) ?? 0) + 1);
      const input = block['input'];
      if (!isObject(input)) continue;
      for (const key of FILE_PATH_KEYS) {
        const value = asString(input[key]);
        if (value !== undefined && !seenFiles.has(value)) {
          seenFiles.add(value);
          summary.files.push(value);
        }
      }
    }
  }
  return parsedAny ? summary : undefined;
}

/** Relativize a path to the session cwd when it lives under it. */
function relativizePath(cwd: string, filePath: string): string {
  const rel = relative(cwd, filePath);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) ? rel : filePath;
}

/** Whitespace-collapsed, length-capped one-line excerpt. */
function excerptOf(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

/** The three prose-bearing fields of a session-outcome record. */
interface SessionOutcome {
  claim: string;
  scope: string;
  content: string;
}

/**
 * COMPOSE SENTENCES from the structural extraction (§2.2 row 2: a
 * hook-written record is not exempt from the recall-shape requirement — the
 * generating script must emit prose, not bare metadata). With a readable
 * transcript the composed content aims for ≥25 words (the G8 floor); without
 * one it is minimal prose built from the payload alone.
 */
function composeSessionOutcome(
  sessionId: string,
  reason: string,
  cwd: string,
  transcriptPath: string | undefined,
  summary: TranscriptSummary | undefined,
): SessionOutcome {
  if (summary === undefined) {
    const claim = `Session ${sessionId} ended (${reason}).`;
    const where = transcriptPath ?? '(no transcript_path in the hook payload)';
    const content =
      `${claim} No transcript was readable at ${where}, so this session-outcome record carries ` +
      `only what the SessionEnd hook payload provided. Working directory at session end: ${cwd}.`;
    return { claim, scope: '', content };
  }

  const files = summary.files.map((f) => relativizePath(cwd, f));
  const shownFiles = files.slice(0, 6);
  const moreFiles = files.length - shownFiles.length;
  const tools = [...summary.toolCounts.entries()].map(([name, count]) => `${name} (${String(count)}x)`).join(', ');

  const claim = `Session ${sessionId} ended (${reason}) after ${String(summary.userTurns)} user and ${String(summary.assistantTurns)} assistant turns.`;
  const sentences: string[] = [claim];
  sentences.push(tools.length > 0 ? `Tools used: ${tools}.` : 'No tool calls were recorded in the transcript.');
  sentences.push(
    files.length > 0
      ? `Worked on: ${shownFiles.join(', ')}${moreFiles > 0 ? ` and ${String(moreFiles)} more file(s)` : ''}.`
      : 'No file paths could be extracted from the tool inputs.',
  );
  const excerpt = excerptOf(summary.lastAssistantText);
  if (excerpt.length > 0) sentences.push(`Last activity: "${excerpt}"`);

  // Scope = the directories the session's file work landed in: the cheapest
  // honest statement of what future work this outcome is load-bearing for.
  const dirs: string[] = [];
  for (const file of files) {
    const dir = dirname(file);
    if (dir !== '.' && !dirs.includes(dir)) dirs.push(dir);
  }
  return { claim, scope: dirs.slice(0, 6).join(', '), content: sentences.join(' ') };
}

async function runSessionEnd(
  stdin: NodeJS.ReadableStream & { isTTY?: boolean },
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  // Hook path: every return from this function is 0.
  let payload: Record<string, unknown> = {};
  const raw = await readAll(stdin);
  if (raw.trim().length === 0) {
    stderr.write('ideate-record: session-end: empty stdin payload; writing a minimal record\n');
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isObject(parsed)) {
        payload = parsed;
      } else {
        stderr.write('ideate-record: session-end: stdin payload is not a JSON object; writing a minimal record\n');
      }
    } catch (err) {
      stderr.write(`ideate-record: session-end: unparseable stdin payload (${errorMessage(err)}); writing a minimal record\n`);
    }
  }

  const sessionId = asString(payload['session_id']) ?? 'unknown';
  const reason = asString(payload['reason']) ?? 'unknown';
  const payloadCwd = asString(payload['cwd']);
  const cwd = payloadCwd !== undefined && existsSync(payloadCwd) ? payloadCwd : process.cwd();
  const transcriptPath = asString(payload['transcript_path']);
  const summary = transcriptPath === undefined ? undefined : summarizeTranscript(transcriptPath);
  if (transcriptPath !== undefined && summary === undefined) {
    stderr.write(`ideate-record: session-end: transcript missing/unreadable at ${transcriptPath}; writing a payload-only record\n`);
  }

  const outcome = composeSessionOutcome(sessionId, reason, cwd, transcriptPath, summary);
  const ctx = buildContext(cwd, sessionId);
  const result = ctx.store.append({
    kind: 'session-outcome',
    claim: outcome.claim,
    verification_anchor: transcriptPath ?? '',
    scope: outcome.scope,
    source: { capture_point: 'session-end', session_id: sessionId },
    content: outcome.content,
  });
  if (!result.ok) {
    // Already counted as capture_write_failed by the store; never a hook failure.
    stderr.write(`ideate-record: session-end: capture write failed (${result.code}): ${result.reason}\n`);
    return 0;
  }
  stdout.write(`${result.record.id}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// prime — hook path (ALWAYS exit 0)
// ---------------------------------------------------------------------------

/** One compact block per record: kind, claim, anchor. No scoring, ever. */
function formatDigest(records: readonly ProcessRecord[], scope: string | undefined): string {
  const scopeNote = scope === undefined ? '' : ` matching scope "${scope}"`;
  const lines = [
    `ideate process record — ${String(records.length)} most recent record(s)${scopeNote} (unranked: recency + scope selection only):`,
  ];
  for (const record of records) {
    const claim = record.claim.trim().length > 0 ? record.claim : '(no claim)';
    const anchor = record.verification_anchor.trim().length > 0 ? ` — verify: ${record.verification_anchor}` : '';
    lines.push(`- [${record.kind}] ${claim}${anchor}`);
  }
  return `${lines.join('\n')}\n`;
}

function runPrime(argv: readonly string[], stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream): number {
  // Hook path: every return from this function is 0. Bad arguments are
  // diagnosed on stderr and defaulted — a hooks.json typo must not turn a
  // priming injection into a hook failure.
  const parsed = parseArgs(argv, { '--scope': 'value', '--budget': 'value' });
  for (const err of parsed.errors) {
    stderr.write(`ideate-record: prime: ${err} (ignored — hook path)\n`);
  }
  let budget = DEFAULT_PRIME_BUDGET;
  const budgetRaw = parsed.values.get('--budget');
  if (budgetRaw !== undefined) {
    const value = Number(budgetRaw);
    if (Number.isInteger(value) && value > 0) {
      budget = value;
    } else {
      stderr.write(
        `ideate-record: prime: --budget must be a positive integer, got ${budgetRaw}; using default ${String(DEFAULT_PRIME_BUDGET)}\n`,
      );
    }
  }

  const ctx = buildContext(process.cwd());
  // Counter 2: a priming injection fired from this source (telemetry §3.5).
  ctx.telemetry.primingRequested('cli:prime', ctx.sessionId);
  const scope = parsed.values.get('--scope');
  // SELECTION, not ranking: the store returns newest-first, scope-substring-
  // filtered, count-capped — no score is computed anywhere on this path.
  const records = ctx.store.read({ ...(scope === undefined ? {} : { scope }), limit: budget });
  if (records.length === 0) return 0; // an empty record injects nothing — silence, not noise
  stdout.write(formatDigest(records, scope));
  return 0;
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

/** CLI entry. Returns the process exit code (see the exit-code split above). */
export async function main(argv: string[] = process.argv.slice(2), io: CliIo = {}): Promise<number> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    if (subcommand === undefined) {
      stderr.write(USAGE);
      return 1;
    }
    stdout.write(USAGE);
    return 0;
  }

  const rest = argv.slice(1);
  const isHookPath = HOOK_SUBCOMMANDS.has(subcommand);
  try {
    switch (subcommand) {
      case 'append':
        return await runAppend(rest, stdin, stdout, stderr);
      case 'read':
        return runRead(rest, stdout, stderr);
      case 'session-end':
        return await runSessionEnd(stdin, stdout, stderr);
      case 'prime':
        return runPrime(rest, stdout, stderr);
      default:
        stderr.write(`ideate-record: unknown subcommand ${subcommand}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    // Internal failure fell out of a subcommand (e.g. a corrupt .ideate.json
    // throwing from loadConfig). Diagnose loudly; the exit-code split decides
    // whether the caller sees it as a failure.
    stderr.write(`ideate-record: ${subcommand} failed internally: ${errorMessage(err)}\n`);
    return isHookPath ? 0 : 1;
  }
}
