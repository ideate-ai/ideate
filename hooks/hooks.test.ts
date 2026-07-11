// plugin/hooks/hooks.test.ts — WI-275 acceptance tests for the plugin's
// host hooks: the mechanical capture and priming floors
// (docs/design/v3-composable-surface.md §1.1 hook policy, §2.2 capture
// point 2, §2.3 floor-raisers, §3 priming floor).
//
// Pins:
// - hooks.json registers EXACTLY the seven ratified events (2 priming +
//   5 capture) with the documented settings.json structure; PostToolUse is
//   narrowed to git commits via the `if` permission-rule field (the HOST
//   does the narrowing — asserted on config, not runtime); the rejected
//   events (Stop, UserPromptSubmit, broad Write|Edit) are absent.
// - No blocking constructs anywhere in hooks.json or the hook scripts
//   (grep-asserted, per §2.2's falsifiability standard).
// - Every capture script, run as the real executable with a fixture stdin
//   payload against a mkdtemp project root, writes the expected record kind
//   through the CLI (file verified on disk, recall-shaped prose over the
//   word floor) and exits 0; GARBAGE stdin still exits 0.
// - subagent-start re-emits the prime digest as
//   hookSpecificOutput.additionalContext (and ONLY that), because per the
//   current docs SubagentStart plain stdout is user-facing only.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { DIGEST_FRAME_CLOSE, DIGEST_FRAME_OPEN } from '../src/cli/ideate-record.js';
import { DEFAULT_RECORD_PATH } from '../src/config/ideate-config.js';
import { parseRecord } from '../src/record/schema.js';
import type { ProcessRecord } from '../src/record/schema.js';

const HOOKS_DIR = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_DIR = join(HOOKS_DIR, '..');
const HOOKS_JSON_PATH = join(HOOKS_DIR, 'hooks.json');
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-record');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-record.js');

/** The seven ratified events — 2 priming + 5 capture. Nothing else. */
const REGISTERED_EVENTS = [
  'SessionStart',
  'SubagentStart',
  'SessionEnd',
  'PreCompact',
  'SubagentStop',
  'PostToolUse',
  'TaskCompleted',
] as const;

/** Scripts + the shared lib — the full grep surface for blocking constructs. */
const HOOK_SOURCE_FILES = [
  'hooks.json',
  'hook-lib.mjs',
  'pre-compact.mjs',
  'subagent-stop.mjs',
  'commit-boundary.mjs',
  'task-completed.mjs',
  'subagent-start.mjs',
] as const;

interface HookHandler {
  type: string;
  command: string;
  if?: string;
  timeout?: number;
}
interface HookMatcherEntry {
  matcher?: string;
  hooks: HookHandler[];
}
interface HooksConfig {
  hooks: Record<string, HookMatcherEntry[]>;
}

function loadHooksConfig(): HooksConfig {
  return JSON.parse(readFileSync(HOOKS_JSON_PATH, 'utf8')) as HooksConfig;
}

/** Every handler object across every event, flattened. */
function allHandlers(config: HooksConfig): Array<{ event: string; entry: HookMatcherEntry; handler: HookHandler }> {
  const out: Array<{ event: string; entry: HookMatcherEntry; handler: HookHandler }> = [];
  for (const [event, entries] of Object.entries(config.hooks)) {
    for (const entry of entries) {
      for (const handler of entry.hooks) out.push({ event, entry, handler });
    }
  }
  return out;
}

const tempDirs: string[] = [];
function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-hooks-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Run one hook script as the real executable with a stdin payload. */
function runHookScript(
  script: string,
  input: string,
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(HOOKS_DIR, script)], {
    cwd,
    encoding: 'utf8',
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** All persisted record files under the project's record dir, parsed. */
function readRecordFiles(projectRoot: string): Array<{ path: string; raw: string; record: ProcessRecord }> {
  const recordDir = join(projectRoot, DEFAULT_RECORD_PATH);
  if (!existsSync(recordDir)) return [];
  return readdirSync(recordDir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.md'))
    .map((rel) => {
      const path = join(recordDir, rel);
      const raw = readFileSync(path, 'utf8');
      return { path, raw, record: parseRecord(raw) };
    });
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/** A fixture payload with the standard hook stdin fields. */
function basePayload(projectRoot: string, event: string): Record<string, unknown> {
  return {
    session_id: 'sess-hooks-test',
    transcript_path: join(projectRoot, 'transcript.jsonl'),
    cwd: projectRoot,
    hook_event_name: event,
  };
}

/** Write a small but realistic transcript JSONL fixture. */
function writeTranscript(projectRoot: string): string {
  const path = join(projectRoot, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'please wire the capture hooks' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls plugin/hooks' } },
          { type: 'text', text: 'I inspected the hooks directory and started wiring the capture floor.' },
        ],
      },
    }),
    JSON.stringify({ type: 'user', message: { content: 'looks good, keep going' } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'The seven hook events are now registered and tested.' }] },
    }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
  return path;
}

const GARBAGE_STDIN = 'not json at all {{{ 12345';

beforeAll(() => {
  // The scripts shell out to the compiled CLI. Build incrementally if needed
  // (documented order is `pnpm build` then `pnpm test`; this keeps the suite
  // self-sufficient when run in isolation).
  if (!existsSync(DIST_CLI)) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], {
      cwd: PLUGIN_DIR,
      stdio: 'pipe',
    });
  }
}, 120_000);

// ---------------------------------------------------------------------------
// hooks.json registration
// ---------------------------------------------------------------------------

describe('hooks.json registration', () => {
  it('parses and registers exactly the seven ratified events (2 priming + 5 capture)', () => {
    const config = loadHooksConfig();
    expect(Object.keys(config)).toEqual(['hooks']);
    expect(Object.keys(config.hooks).sort()).toEqual([...REGISTERED_EVENTS].sort());
  });

  it('does NOT register the explicitly rejected events or broad Write|Edit matchers', () => {
    const config = loadHooksConfig();
    // Stop and UserPromptSubmit were rejected upstream (surface §2.3).
    expect(config.hooks['Stop']).toBeUndefined();
    expect(config.hooks['UserPromptSubmit']).toBeUndefined();
    // No matcher anywhere targets file-write tools.
    for (const { entry } of allHandlers(config)) {
      expect(entry.matcher ?? '').not.toMatch(/Write|Edit/);
    }
  });

  it('uses the documented structure: command handlers only, matcher entries with hooks arrays', () => {
    const config = loadHooksConfig();
    const handlers = allHandlers(config);
    expect(handlers.length).toBeGreaterThanOrEqual(REGISTERED_EVENTS.length);
    for (const { entry, handler } of handlers) {
      expect(Array.isArray(entry.hooks)).toBe(true);
      expect(handler.type).toBe('command');
      expect(typeof handler.command).toBe('string');
    }
  });

  it('every command routes through bin/ideate-record or a thin hooks/*.mjs under ${CLAUDE_PLUGIN_ROOT}', () => {
    const config = loadHooksConfig();
    for (const { event, handler } of allHandlers(config)) {
      expect(handler.command, `event ${event}`).toMatch(
        /^"\$\{CLAUDE_PLUGIN_ROOT\}\/(bin\/ideate-record" |hooks\/[a-z-]+\.mjs")/,
      );
    }
  });

  it('SessionStart primes on startup|resume|clear via the CLI prime subcommand (plain stdout IS the digest)', () => {
    const config = loadHooksConfig();
    const entries = config.hooks['SessionStart'];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.matcher).toBe('startup|resume|clear');
    expect(entries?.[0]?.hooks[0]?.command).toBe('"${CLAUDE_PLUGIN_ROOT}/bin/ideate-record" prime --budget 10');
  });

  it('SubagentStart delivers the same digest through the additionalContext wrapper script', () => {
    const config = loadHooksConfig();
    const command = config.hooks['SubagentStart']?.[0]?.hooks[0]?.command;
    expect(command).toBe('"${CLAUDE_PLUGIN_ROOT}/hooks/subagent-start.mjs"');
  });

  it('SessionEnd routes straight to the CLI session-end subcommand', () => {
    const config = loadHooksConfig();
    const command = config.hooks['SessionEnd']?.[0]?.hooks[0]?.command;
    expect(command).toBe('"${CLAUDE_PLUGIN_ROOT}/bin/ideate-record" session-end');
  });

  it('PostToolUse is narrowed to git commits: matcher Bash + if "Bash(git commit*)"', () => {
    const config = loadHooksConfig();
    const entries = config.hooks['PostToolUse'];
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.matcher).toBe('Bash');
    const handler = entries?.[0]?.hooks[0];
    expect(handler?.if).toBe('Bash(git commit*)');
    expect(handler?.command).toBe('"${CLAUDE_PLUGIN_ROOT}/hooks/commit-boundary.mjs"');
  });

  it('every referenced .mjs script exists in hooks/ and is executable', () => {
    const config = loadHooksConfig();
    for (const { handler } of allHandlers(config)) {
      const match = /hooks\/([a-z-]+\.mjs)/.exec(handler.command);
      if (match !== null) {
        const scriptPath = join(HOOKS_DIR, match[1] ?? '');
        const stat = statSync(scriptPath);
        expect(stat.isFile()).toBe(true);
        expect(stat.mode & 0o111).not.toBe(0);
        expect(readFileSync(scriptPath, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Non-blocking policy (§1.1): grep-asserted absence of blocking constructs
// ---------------------------------------------------------------------------

describe('non-blocking policy (surface §1.1)', () => {
  it.each([...HOOK_SOURCE_FILES])('%s contains no blocking constructs', (file) => {
    const raw = readFileSync(join(HOOKS_DIR, file), 'utf8');
    // Never a decision field of any kind, in code OR comments.
    expect(raw).not.toMatch(/decision/i);
    expect(raw).not.toMatch(/permissionDecision/);
    // Never continue:false in any quoting style.
    expect(raw).not.toMatch(/["']?continue["']?\s*:\s*false/);
    // Never exit code 2 (the blocking exit) — scripts exit 0 unconditionally.
    expect(raw).not.toMatch(/process\.exit\((?!0\))/);
  });
});

// ---------------------------------------------------------------------------
// pre-compact.mjs
// ---------------------------------------------------------------------------

describe('pre-compact.mjs', () => {
  it('writes a compaction-snapshot record with recall-shaped prose from the transcript, exits 0', () => {
    const root = makeProjectRoot();
    const transcriptPath = writeTranscript(root);
    const payload = { ...basePayload(root, 'PreCompact'), trigger: 'auto' };
    const result = runHookScript('pre-compact.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(''); // stdout stays silent — no host-visible output

    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    const record = files[0]?.record as ProcessRecord;
    expect(record.kind).toBe('compaction-snapshot');
    expect(record.source.capture_point).toBe('cli:append');
    expect(record.verification_anchor).toBe(transcriptPath);
    expect(record.claim).toContain('auto context compaction');
    expect(record.content).toContain('2 user and 2 assistant turns');
    expect(record.content).toContain('seven hook events');
    expect(wordCount(record.content)).toBeGreaterThanOrEqual(25);
  });

  it('still writes minimal prose when the transcript is missing, exits 0', () => {
    const root = makeProjectRoot();
    const payload = { ...basePayload(root, 'PreCompact'), trigger: 'manual' }; // transcript file never written
    const result = runHookScript('pre-compact.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]?.record.kind).toBe('compaction-snapshot');
    expect(files[0]?.record.content).toContain('No transcript was readable');
  });

  it('GARBAGE stdin still exits 0', () => {
    const root = makeProjectRoot();
    const result = runHookScript('pre-compact.mjs', GARBAGE_STDIN, root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// subagent-stop.mjs
// ---------------------------------------------------------------------------

describe('subagent-stop.mjs', () => {
  it('writes a subagent-outcome record carrying the final report (already prose), exits 0', () => {
    const root = makeProjectRoot();
    const report =
      'I explored the plugin directory and confirmed the record store shards files by year and month, ' +
      'that the secret gate runs before every persist, and that the CLI is the only write path hooks use.';
    const payload = {
      ...basePayload(root, 'SubagentStop'),
      agent_id: 'agent-42',
      agent_type: 'Explore',
      last_assistant_message: report,
    };
    const result = runHookScript('subagent-stop.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');

    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    const record = files[0]?.record as ProcessRecord;
    expect(record.kind).toBe('subagent-outcome');
    expect(record.claim).toContain('agent-42');
    expect(record.claim).toContain('Explore');
    expect(record.content).toContain(report);
    expect(wordCount(record.content)).toBeGreaterThanOrEqual(25);
  });

  it('GARBAGE stdin still exits 0', () => {
    const root = makeProjectRoot();
    const result = runHookScript('subagent-stop.mjs', GARBAGE_STDIN, root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Redaction observability across the hook transport (WI-281, cycle-7 S1)
// ---------------------------------------------------------------------------

describe('hook stderr forwarding (WI-281): redactions are visible on the SUCCESS path', () => {
  it('a planted secret in the payload surfaces the redaction warning on the hook stderr, exit 0', () => {
    const root = makeProjectRoot();
    const ghToken = `ghp_${'A1b2C3d4'.repeat(5)}`; // ghp_ + 40 alnum chars
    const payload = {
      ...basePayload(root, 'SubagentStop'),
      agent_id: 'agent-9',
      agent_type: 'Explore',
      last_assistant_message:
        `I verified the staging deploy by exporting the token ${ghToken} and re-running the smoke ` +
        'suite twice; both runs passed and the record store persisted every fixture as expected.',
    };
    const result = runHookScript('subagent-stop.mjs', JSON.stringify(payload), root);

    // Exit-0 behavior is preserved and stdout stays silent (host-visible).
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');

    // The child CLI's stderr (the store's IDEATE_RECORD_REDACTION process
    // warning) is forwarded UNCONDITIONALLY — this append SUCCEEDED, yet the
    // warning still reaches the hook's own stderr instead of being
    // discarded in transit.
    expect(result.stderr).toContain('IDEATE_RECORD_REDACTION');
    expect(result.stderr).toContain('github-token');
    expect(result.stderr).not.toContain(ghToken); // the warning names patterns, never content

    // And the persisted record is masked, as always.
    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]?.raw).not.toContain(ghToken);
    expect(files[0]?.raw).toContain('[REDACTED:github-token]');
  });

  it('a clean payload forwards no redaction warning (quiet success stays quiet)', () => {
    const root = makeProjectRoot();
    const payload = {
      ...basePayload(root, 'SubagentStop'),
      agent_id: 'agent-10',
      agent_type: 'Explore',
      last_assistant_message:
        'I confirmed the shard layout and the newest-first read order across two month boundaries; ' +
        'every fixture parsed cleanly and nothing sensitive appeared anywhere in the transcript.',
    };
    const result = runHookScript('subagent-stop.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('IDEATE_RECORD_REDACTION');
    expect(readRecordFiles(root)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// commit-boundary.mjs
// ---------------------------------------------------------------------------

function gitIn(root: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Hooks Test', ...args], {
    cwd: root,
    stdio: 'pipe',
  });
}

describe('commit-boundary.mjs', () => {
  it('writes a commit-boundary record: message + changed paths, hash as verification anchor, exits 0', () => {
    const root = makeProjectRoot();
    gitIn(root, ['init', '-q']);
    writeFileSync(join(root, 'a.txt'), 'hello capture floor\n', 'utf8');
    writeFileSync(join(root, 'b.txt'), 'second changed path\n', 'utf8');
    gitIn(root, ['add', 'a.txt', 'b.txt']);
    gitIn(root, ['commit', '-q', '-m', 'feat: add the capture fixtures']);

    const payload = {
      ...basePayload(root, 'PostToolUse'),
      tool_name: 'Bash',
      tool_input: { command: 'git commit -q -m "feat: add the capture fixtures"' },
      tool_response: { stdout: '', stderr: '' },
    };
    const result = runHookScript('commit-boundary.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');

    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    const record = files[0]?.record as ProcessRecord;
    expect(record.kind).toBe('commit-boundary');
    expect(record.claim).toContain('feat: add the capture fixtures');
    expect(record.verification_anchor).toMatch(/^[0-9a-f]{40}$/); // the commit hash — the verification anchor
    expect(record.content).toContain('a.txt');
    expect(record.content).toContain('b.txt');
    expect(record.content).toContain('git commit -q -m');
    expect(wordCount(record.content)).toBeGreaterThanOrEqual(25);
  });

  it('outside a git repo it still writes a best-effort record and exits 0 (never fail)', () => {
    const root = makeProjectRoot();
    const payload = {
      ...basePayload(root, 'PostToolUse'),
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "phantom"' },
    };
    const result = runHookScript('commit-boundary.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]?.record.kind).toBe('commit-boundary');
    expect(files[0]?.record.content).toContain('could not be determined');
  });

  it('GARBAGE stdin still exits 0', () => {
    const root = makeProjectRoot();
    const result = runHookScript('commit-boundary.mjs', GARBAGE_STDIN, root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('fires only for the narrowed matcher: the hooks.json config carries the if-narrowing (the HOST narrows)', () => {
    // Runtime narrowing belongs to the host; what is testable here is that
    // the registration confines this hook to Bash git-commit tool events.
    const config = loadHooksConfig();
    const entry = config.hooks['PostToolUse']?.[0];
    expect(entry?.matcher).toBe('Bash');
    expect(entry?.hooks).toHaveLength(1);
    expect(entry?.hooks[0]?.if).toBe('Bash(git commit*)');
  });
});

// ---------------------------------------------------------------------------
// task-completed.mjs
// ---------------------------------------------------------------------------

describe('task-completed.mjs', () => {
  it('writes a native-task-completion record with the task id threaded into source, exits 0', () => {
    const root = makeProjectRoot();
    const payload = {
      ...basePayload(root, 'TaskCompleted'),
      task_id: 'T-17',
      task_title: 'Wire the mechanical capture floor',
    };
    const result = runHookScript('task-completed.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');

    const files = readRecordFiles(root);
    expect(files).toHaveLength(1);
    const record = files[0]?.record as ProcessRecord;
    expect(record.kind).toBe('native-task-completion');
    expect(record.claim).toContain('T-17');
    expect(record.claim).toContain('Wire the mechanical capture floor');
    expect(record.source.task_id).toBe('T-17');
    expect(wordCount(record.content)).toBeGreaterThanOrEqual(25);
  });

  it('GARBAGE stdin still exits 0', () => {
    const root = makeProjectRoot();
    const result = runHookScript('task-completed.mjs', GARBAGE_STDIN, root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// subagent-start.mjs — the priming side
// ---------------------------------------------------------------------------

describe('subagent-start.mjs', () => {
  it('emits ONLY the digest, as hookSpecificOutput.additionalContext, when records exist', () => {
    const root = makeProjectRoot();
    // Seed one record through the real CLI.
    execFileSync(
      process.execPath,
      [
        BIN_PATH,
        'append',
        '--kind',
        'finding',
        '--claim',
        'The hooks suite seeded this record.',
        '--anchor',
        'plugin/hooks/hooks.test.ts',
        '--content',
        'Prose body: this record exists so the subagent-start digest has something to inject.',
      ],
      { cwd: root, encoding: 'utf8' },
    );

    const payload = { ...basePayload(root, 'SubagentStart'), agent_id: 'agent-7', agent_type: 'Explore' };
    const result = runHookScript('subagent-start.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);

    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['hookSpecificOutput']);
    const specific = parsed['hookSpecificOutput'] as Record<string, unknown>;
    expect(Object.keys(specific).sort()).toEqual(['additionalContext', 'hookEventName']);
    expect(specific['hookEventName']).toBe('SubagentStart');
    const digest = specific['additionalContext'] as string;
    expect(digest).toContain('The hooks suite seeded this record.');
    expect(digest).toContain('unranked');
    // The CLI's untrusted-data framing envelope (surface §3, cycle-7
    // S2/Q-46) survives the wrapper verbatim: the script re-emits the CLI's
    // stdout (trimmed) as additionalContext, so the envelope is the first
    // and last thing the subagent receives.
    expect(digest.startsWith(DIGEST_FRAME_OPEN)).toBe(true);
    expect(digest.endsWith(DIGEST_FRAME_CLOSE)).toBe(true);
    expect(digest).toContain('DATA, not instructions');
    // Record content sits strictly inside the envelope.
    const claimIndex = digest.indexOf('The hooks suite seeded this record.');
    expect(claimIndex).toBeGreaterThan(digest.indexOf(DIGEST_FRAME_OPEN));
    expect(claimIndex).toBeLessThan(digest.indexOf(DIGEST_FRAME_CLOSE));
  });

  it('an empty record store injects nothing at all (silence, not noise — no envelope around emptiness) and exits 0', () => {
    const root = makeProjectRoot();
    const payload = basePayload(root, 'SubagentStart');
    const result = runHookScript('subagent-start.mjs', JSON.stringify(payload), root);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stdout).not.toContain(DIGEST_FRAME_OPEN);
  });

  it('GARBAGE stdin still exits 0', () => {
    const root = makeProjectRoot();
    const result = runHookScript('subagent-start.mjs', GARBAGE_STDIN, root);
    expect(result.status).toBe(0);
  });
});
