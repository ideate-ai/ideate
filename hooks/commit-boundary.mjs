#!/usr/bin/env node
// plugin/hooks/commit-boundary.mjs — PostToolUse capture hook, narrowed by
// hooks.json to git commits via `if: "Bash(git commit*)"` (WI-275; surface
// §2.3 — the highest-value floor-raiser: a git commit is the one
// work-completion signal every workflow shares). Appends a commit-boundary
// record — commit message + changed paths as the verification anchor —
// through bin/ideate-record (the gated core). The stdin payload carries the
// commit COMMAND, not the resulting commit, so a best-effort `git`
// subprocess enriches the record with hash/subject/changed paths; if git is
// unavailable the record is written from the payload alone — never fail.
// Non-blocking by policy (§1.1): exit 0 unconditionally, stdout stays
// silent. The HOST does the narrowing; this script records whatever it is
// handed.

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

import {
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

try {
  const payload = parsePayload(await readStdin(), 'commit-boundary');
  const sessionId = asString(payload.session_id) ?? 'unknown';
  const projectRoot = resolveProjectRoot(payload);
  const toolInput = payload.tool_input !== null && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const command = asString(toolInput.command);

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
} catch (err) {
  process.stderr.write(`ideate commit-boundary hook: ${errorMessage(err)}\n`);
}
process.exit(0);
