#!/usr/bin/env node
// plugin/hooks/subagent-stop.mjs — SubagentStop capture hook (WI-275;
// surface §2.3). Captures delegated-work outcomes for ANY framework's
// subagents — superpowers workers, plain Task-tool agents — with zero
// cooperation from the framework: the payload's last_assistant_message is
// the subagent's final report, already prose and already recall-shaped by
// nature. Appends a subagent-outcome record through bin/ideate-record (the
// gated core). Non-blocking by policy (§1.1): exit 0 unconditionally,
// stdout stays silent.

import {
  appendRecord,
  asString,
  errorMessage,
  parsePayload,
  readStdin,
  resolveProjectRoot,
} from './hook-lib.mjs';

/** Cap on the carried final report — capped, not summarized (it is already prose). */
const REPORT_CAP = 2000;

try {
  const payload = parsePayload(await readStdin(), 'subagent-stop');
  const sessionId = asString(payload.session_id) ?? 'unknown';
  const agentType = asString(payload.agent_type) ?? 'unknown';
  const agentId = asString(payload.agent_id);
  const lastMessage = asString(payload.last_assistant_message);
  const projectRoot = resolveProjectRoot(payload);

  const who = agentId === undefined ? `A ${agentType} subagent` : `Subagent ${agentId} (${agentType})`;
  const claim = `${who} finished in session ${sessionId}.`;
  const sentences = [claim];
  if (lastMessage === undefined) {
    sentences.push(
      'The host provided no last assistant message for it, so only the completion boundary itself is recorded here.',
    );
  } else {
    const report = lastMessage.trim();
    const capped = report.length <= REPORT_CAP ? report : `${report.slice(0, REPORT_CAP - 1)}…`;
    sentences.push('Its final report to the spawning agent follows.', capped);
  }

  appendRecord('subagent-stop', {
    projectRoot,
    kind: 'subagent-outcome',
    claim,
    anchor: asString(payload.transcript_path) ?? '',
    content: sentences.join(' '),
  });
} catch (err) {
  process.stderr.write(`ideate subagent-stop hook: ${errorMessage(err)}\n`);
}
process.exit(0);
