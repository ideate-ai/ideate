#!/usr/bin/env node
// plugin/hooks/session-start.mjs — SessionStart hook (WI-303): wraps the
// priming call hooks.json previously invoked directly against
// bin/ideate-record, and ADDITIONALLY triggers the opportunistic work-state
// board sweep (docs/spikes/v3-work-delegation.md §3.2 rule 2b: "the host
// session-start/end hooks may trigger a board-wide expiry pass" — the
// hybrid expiry mechanism's second half; the lazy per-verb check,
// expiry.ts's `checkExpiry`, is the first half, wired into every id-scoped
// work-state MCP tool call — work-state/tools.ts).
//
// Priming (unchanged behavior, now wrapped rather than invoked directly):
// per the current hooks docs (verified 2026-07-09,
// https://code.claude.com/docs/en/hooks), SessionStart's plain stdout IS
// shown to the model as additionalContext — unlike SubagentStart, which
// needs the JSON `hookSpecificOutput` wrapper (see subagent-start.mjs's own
// doc comment). So this script re-emits `ideate-record prime`'s stdout
// VERBATIM; the untrusted-data framing envelope that CLI already wraps a
// non-empty digest in travels through unchanged.
//
// The board sweep runs AFTER priming, is non-blocking (never affects this
// hook's own exit code, always 0), and its own stdout is discarded — only
// its stderr is forwarded — so a sweep diagnostic can never corrupt the
// digest landing in additionalContext (existing hook discipline —
// hook-lib.mjs).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { errorMessage, parsePayload, readStdin, resolveProjectRoot, PLUGIN_ROOT, RECORD_BIN } from './hook-lib.mjs';

const WORK_BIN = join(PLUGIN_ROOT, 'bin', 'ideate-work');

try {
  const payload = parsePayload(await readStdin(), 'session-start');
  const projectRoot = resolveProjectRoot(payload);

  const primeResult = spawnSync(process.execPath, [RECORD_BIN, 'prime', '--budget', '10'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (primeResult.error !== undefined) {
    process.stderr.write(`ideate session-start hook: could not run ideate-record (${errorMessage(primeResult.error)})\n`);
  } else {
    const primeStderr = typeof primeResult.stderr === 'string' ? primeResult.stderr : '';
    if (primeStderr.length > 0) {
      process.stderr.write(primeStderr.endsWith('\n') ? primeStderr : `${primeStderr}\n`);
    }
    if (primeResult.status === 0 && typeof primeResult.stdout === 'string' && primeResult.stdout.length > 0) {
      process.stdout.write(primeResult.stdout);
    }
  }

  // Opportunistic board sweep (§3.2 rule 2b) — non-blocking: exit 0 always,
  // silent stdout (never allowed to leak into the digest above), stderr
  // forwarded.
  const sweepResult = spawnSync(process.execPath, [WORK_BIN, 'sweep'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (sweepResult.error !== undefined) {
    process.stderr.write(`ideate session-start hook: could not run ideate-work sweep (${errorMessage(sweepResult.error)})\n`);
  } else {
    const sweepStderr = typeof sweepResult.stderr === 'string' ? sweepResult.stderr : '';
    if (sweepStderr.length > 0) {
      process.stderr.write(sweepStderr.endsWith('\n') ? sweepStderr : `${sweepStderr}\n`);
    }
  }
} catch (err) {
  process.stderr.write(`ideate session-start hook: ${errorMessage(err)}\n`);
}
process.exit(0);
