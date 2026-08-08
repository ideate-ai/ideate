#!/usr/bin/env node
// plugin/hooks/commit-boundary.mjs — PostToolUse capture hook for git commits:
// the highest-value floor-raiser, because a git commit is the one
// work-completion signal every workflow shares. Appends a commit-boundary
// record — commit message + changed paths, hash as the verification anchor —
// through bin/ideate-record (the gated core). The stdin payload carries the
// commit COMMAND, not the resulting commit, so a best-effort `git` subprocess
// enriches the record with hash/subject/changed paths. Non-blocking by policy:
// exit 0 unconditionally, stdout stays silent.
//
// THIS SCRIPT NARROWS FOR ITSELF. It used to say "the HOST does the narrowing;
// this script records whatever it is handed", trusting hooks.json's
// `if: "Bash(git commit*)"`. That gate does not hold. Measured 2026-08-07
// against this project's own record: of 487 commit-boundary records, **416
// were produced by commands containing no `git commit` at all** — heredoc-fed
// interpreters, `set -e` scripts, for-loops, brace expansion. One commit,
// d99ecc1c3e86, was re-reported ten times over the 38 minutes after it landed,
// with HEAD unmoved throughout. The condition fails OPEN on command shapes its
// evaluator cannot decompose, and a hook cannot see that it has been handed a
// spurious invocation.
//
// So there are two gates here, either of which alone would have stopped every
// false record above, and which fail independently:
//
//   1. COMMAND SHAPE — the tool input must actually invoke `git commit`.
//      Purely local; needs no repository and no store.
//   2. HEAD NOVELTY — the commit at HEAD must not already be recorded.
//      Makes recording the same commit twice a no-op, which also covers the
//      host firing twice for one real commit.
//
// The point is not which gate catches what. It is that a floor mechanism must
// not carry a correctness precondition it cannot itself check.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RECORD_BIN,
  appendRecord,
  asString,
  errorMessage,
  excerptOf,
  parsePayload,
  readStdin,
  resolveProjectRoot,
} from './hook-lib.mjs';

/** Best-effort git read; undefined on ANY failure (no repo, no git, etc.). */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return result.stdout;
}

/**
 * GATE 1 — does this command actually commit?
 *
 * True when some statement in the command invokes `git commit`, allowing for
 * the flags `git` itself accepts before a subcommand (`git -C dir commit`,
 * `git --no-pager commit`). Statement boundaries are the shell's own
 * separators, so `echo hi && git commit -m x` passes and a command that merely
 * MENTIONS the words in a string does not.
 *
 * Deliberately a shape test, not a parse: this runs on every Bash tool call
 * and must stay cheap and predictable. It errs toward writing — a commit
 * phrased unusually enough to slip past still faces gate 2, and the failure it
 * exists to stop is the flood, not the rare miss.
 */
export function commandCommits(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  // Quoted spans are DATA, not commands: `echo "remember to git commit"` and
  // `grep -rn "git commit" docs/` must not read as commits. Blanking them
  // first costs nothing for a real commit, whose `git commit` always sits
  // outside the quotes even when its message does not.
  const unquoted = command.replace(/'[^']*'/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  // Then split on shell statement separators — ; & | newline, which between
  // them also cover the && and || pairs — and ask whether any statement
  // invokes `git commit`, allowing the flags git accepts before a subcommand
  // (`git -C dir commit`, `git --no-pager commit`).
  //
  // Residual, accepted knowingly: a heredoc BODY that mentions `git commit`
  // outside quotes still reads as a commit here. Gate 2 covers it — the
  // commit at HEAD would already be recorded — and tightening this into a
  // real shell parser would trade a rare, harmless false positive for a
  // parser running on every Bash tool call.
  return unquoted
    .split(/[;&|\n]+/)
    .some((statement) => /(^|\s)git(\s+-[^\s]+(\s+[^\s-][^\s]*)?)*\s+commit(\s|$)/.test(statement));
}

/**
 * GATE 2 — has this commit already been recorded?
 *
 * Reads back a bounded window of the project's most recent commit-boundary
 * records and looks for the hash among their verification anchors. A window
 * rather than just the newest record because history does not only move
 * forward: a reset or a rebase can put an already-recorded commit back at
 * HEAD, and re-recording it would be the same duplicate this gate exists to
 * prevent.
 *
 * Returns `undefined` — not `false` — when the check could not run, so the
 * caller can tell "not a duplicate" from "could not tell".
 */
function alreadyRecorded(projectRoot, hash) {
  if (hash === undefined) return undefined;
  const result = spawnSync(
    process.execPath,
    [RECORD_BIN, 'read', '--scope', 'commit-boundary', '--limit', '40', '--json'],
    { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error !== undefined || result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.records)) return undefined;
    return parsed.records.some((record) => asString(record?.verification_anchor) === hash);
  } catch {
    return undefined;
  }
}

/**
 * The hook proper. Separated from the module body so that importing this file
 * — which the gate tests do, to exercise `commandCommits` against the real
 * shipped implementation rather than a copy of it — does not run the hook,
 * drain stdin, and call `process.exit` inside the test runner.
 */
async function main() {
  const payload = parsePayload(await readStdin(), 'commit-boundary');
  const sessionId = asString(payload.session_id) ?? 'unknown';
  const projectRoot = resolveProjectRoot(payload);
  const toolInput = payload.tool_input !== null && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const command = asString(toolInput.command);

  // GATE 1. Silent, because this is the common case on a spurious invocation
  // and a diagnostic here would fire on ordinary shell commands.
  if (!commandCommits(command)) process.exit(0);

  const headRaw = git(['log', '-1', '--pretty=%H%n%s'], projectRoot);
  const [hash, subject] = headRaw === undefined ? [] : headRaw.split('\n');
  const filesRaw = git(['show', '--name-only', '--pretty=format:', 'HEAD'], projectRoot);
  const files =
    filesRaw === undefined
      ? []
      : filesRaw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0);

  // GATE 2. A duplicate is a silent no-op — the record already exists, so
  // there is nothing to report and nothing wrong. An UNAVAILABLE check is
  // different and is said out loud: the write proceeds on gate 1 alone, and
  // a reader of the stderr stream should know the idempotency guarantee did
  // not hold for it (P-45 — never downgrade in silence).
  const duplicate = alreadyRecorded(projectRoot, hash);
  if (duplicate === true) process.exit(0);
  if (duplicate === undefined && hash !== undefined) {
    process.stderr.write(
      `ideate commit-boundary hook: could not read back existing commit-boundary records, so the ` +
        `duplicate check was skipped for ${hash.slice(0, 12)}; writing on the command-shape gate alone.\n`,
    );
  }

  const claim =
    hash !== undefined && asString(subject) !== undefined
      ? `Git commit ${hash.slice(0, 12)} landed in session ${sessionId}: ${subject}`
      : `A git commit was made in session ${sessionId}.`;
  const sentences = [claim];
  if (command !== undefined) sentences.push(`The commit command was: ${excerptOf(command, 240)}`);
  if (files.length > 0) {
    const shown = files.slice(0, 8);
    const more = files.length - shown.length;
    sentences.push(`It changed ${files.length} path(s): ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`);
  } else {
    sentences.push('The changed-path list could not be determined from the repository (best-effort git lookup failed).');
  }
  sentences.push('A commit is a workflow-agnostic work-completion boundary; this record anchors session knowledge to it.');

  // Scope = the directories the commit touched: the cheapest honest
  // statement of what future work this boundary is load-bearing for.
  const dirs = [];
  for (const file of files) {
    const dir = dirname(file);
    if (dir !== '.' && !dirs.includes(dir)) dirs.push(dir);
  }

  appendRecord('commit-boundary', {
    projectRoot,
    kind: 'commit-boundary',
    claim,
    anchor: hash ?? '',
    scope: dirs.slice(0, 6).join(', '),
    content: sentences.join(' '),
  });
}

// Run only when this file IS the process entry point. Hook policy is
// unchanged on that path: exit 0 unconditionally, stdout silent.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`ideate commit-boundary hook: ${errorMessage(err)}\n`);
  }
  process.exit(0);
}
