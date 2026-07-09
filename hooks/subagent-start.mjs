#!/usr/bin/env node
// plugin/hooks/subagent-start.mjs — SubagentStart priming hook (WI-275;
// surface §3). Delivers the same bounded prime digest SessionStart gets to
// every spawned subagent — mechanically priming other frameworks' workers
// without their frameworks knowing ideate exists.
//
// Why a wrapper instead of calling `ideate-record prime` directly (the way
// SessionStart does): per the current hooks docs (verified 2026-07-09,
// https://code.claude.com/docs/en/hooks), SubagentStart plain stdout is
// shown to the USER only — context reaches the subagent solely via
// `hookSpecificOutput.additionalContext`. So this script runs the CLI,
// captures the digest, and re-emits it in that JSON shape. The digest is
// the ONLY thing emitted — no other field of any kind — and an empty store
// emits nothing at all (silence, not noise). Exit 0 unconditionally.
//
// Untrusted-data framing (surface §3; cycle-7 finding S2 / Q-46): the CLI
// wraps every non-empty digest in an explicit envelope marking the entries
// as quoted historical DATA, not instructions. This script re-emits the
// CLI's stdout VERBATIM (whitespace-trimmed only, which cannot touch the
// envelope's first/last lines), so the framed text — envelope included — is
// exactly what lands in additionalContext. Do not compose additional prose
// around the digest here; the envelope is the CLI's job, stated once.

import { spawnSync } from 'node:child_process';

import { errorMessage, parsePayload, readStdin, resolveProjectRoot, RECORD_BIN } from './hook-lib.mjs';

try {
  const payload = parsePayload(await readStdin(), 'subagent-start');
  const projectRoot = resolveProjectRoot(payload);
  const result = spawnSync(process.execPath, [RECORD_BIN, 'prime', '--budget', '10'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) {
    process.stderr.write(`ideate subagent-start hook: could not run ideate-record (${errorMessage(result.error)})\n`);
  } else {
    const digest = (result.stdout ?? '').trim();
    if (result.status === 0 && digest.length > 0) {
      process.stdout.write(
        `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: digest } })}\n`,
      );
    }
  }
} catch (err) {
  process.stderr.write(`ideate subagent-start hook: ${errorMessage(err)}\n`);
}
process.exit(0);
