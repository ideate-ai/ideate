#!/usr/bin/env node
// plugin/hooks/task-completed.mjs — TaskCompleted capture hook (WI-275;
// surface §2.3). For users of Claude Code's native task list / agent teams,
// TaskCompleted is a work-item-completion analogue outside ideate's board —
// this raises capture coverage for exactly the population most likely never
// to touch ideate's lifecycle. Appends a native-task-completion record
// through bin/ideate-record (the gated core). Non-blocking by policy
// (§1.1): exit 0 unconditionally, stdout stays silent.

import {
  appendRecord,
  asString,
  errorMessage,
  excerptOf,
  parsePayload,
  readStdin,
  resolveProjectRoot,
} from './hook-lib.mjs';

try {
  const payload = parsePayload(await readStdin(), 'task-completed');
  const sessionId = asString(payload.session_id) ?? 'unknown';
  const taskId = asString(payload.task_id);
  const title = asString(payload.task_title);
  const description = asString(payload.task_description);
  const projectRoot = resolveProjectRoot(payload);

  const claim =
    title !== undefined
      ? `Native task ${taskId ?? 'unknown'} was completed: ${excerptOf(title, 160)}`
      : `Native task ${taskId ?? 'unknown'} was completed.`;
  const sentences = [claim];
  if (description !== undefined) sentences.push(`Its description was: ${excerptOf(description, 300)}`);
  sentences.push(
    `Claude Code's native task list marked this task complete during session ${sessionId}; the surrounding session-outcome, commit-boundary, and subagent-outcome records carry the substance of the work it names.`,
  );

  appendRecord('task-completed', {
    projectRoot,
    kind: 'native-task-completion',
    claim,
    content: sentences.join(' '),
    ...(taskId === undefined ? {} : { taskId }),
  });
} catch (err) {
  process.stderr.write(`ideate task-completed hook: ${errorMessage(err)}\n`);
}
process.exit(0);
