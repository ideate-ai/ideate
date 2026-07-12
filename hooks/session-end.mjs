#!/usr/bin/env node
// plugin/hooks/session-end.mjs — SessionEnd hook (WI-303): wraps the
// session-outcome capture hooks.json previously invoked directly against
// bin/ideate-record, and ADDITIONALLY triggers the opportunistic work-state
// board sweep (docs/spikes/v3-work-delegation.md §3.2 rule 2b — the hybrid
// expiry mechanism's second half; the per-verb lazy check is the first
// half, wired into every id-scoped work-state MCP tool call —
// work-state/tools.ts).
//
// Capture (unchanged behavior, now wrapped rather than invoked directly):
// the SessionEnd hook payload from stdin is forwarded VERBATIM to
// `ideate-record session-end`, which composes the recall-shaped
// session-outcome record (see cli/ideate-record.ts's own doc comment) — the
// only write path, so this record passes the same capture-time secret gate
// as every other write.
//
// The board sweep runs AFTER capture, is non-blocking (never affects this
// hook's own exit code, always 0), and both children's stdout stay silent —
// only stderr is forwarded, unconditionally (existing hook discipline —
// hook-lib.mjs; WI-281 closes cycle-7 S1: reading stderr only on nonzero
// exit would discard the secret-gate redaction warnings in transit).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { errorMessage, readStdin, resolveProjectRoot, PLUGIN_ROOT, RECORD_BIN } from './hook-lib.mjs';

const WORK_BIN = join(PLUGIN_ROOT, 'bin', 'ideate-work');

try {
  const raw = await readStdin();

  const captureResult = spawnSync(process.execPath, [RECORD_BIN, 'session-end'], {
    input: raw,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const captureStderr = typeof captureResult.stderr === 'string' ? captureResult.stderr : '';
  if (captureStderr.length > 0) {
    process.stderr.write(captureStderr.endsWith('\n') ? captureStderr : `${captureStderr}\n`);
  }
  if (captureResult.error !== undefined) {
    process.stderr.write(`ideate session-end hook: could not run ideate-record (${errorMessage(captureResult.error)})\n`);
  }

  // Opportunistic board sweep (§3.2 rule 2b) — non-blocking: exit 0 always,
  // silent stdout, stderr forwarded.
  // Shared resolution (F-303-001 minor: an earlier inline copy of this logic
  // was weaker than hook-lib's — it accepted an empty-string cwd).
  let cwd = process.cwd();
  try {
    cwd = resolveProjectRoot(JSON.parse(raw));
  } catch {
    // Payload wasn't parseable JSON — ideate-record session-end already
    // diagnosed this on stderr (forwarded above); the sweep just runs
    // against this process's own cwd instead.
  }
  const sweepResult = spawnSync(process.execPath, [WORK_BIN, 'sweep'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (sweepResult.error !== undefined) {
    process.stderr.write(`ideate session-end hook: could not run ideate-work sweep (${errorMessage(sweepResult.error)})\n`);
  } else {
    const sweepStderr = typeof sweepResult.stderr === 'string' ? sweepResult.stderr : '';
    if (sweepStderr.length > 0) {
      process.stderr.write(sweepStderr.endsWith('\n') ? sweepStderr : `${sweepStderr}\n`);
    }
  }
} catch (err) {
  process.stderr.write(`ideate session-end hook: ${errorMessage(err)}\n`);
}
process.exit(0);
