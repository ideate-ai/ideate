#!/usr/bin/env node
// plugin/hooks/pre-compact.mjs — PreCompact capture hook (WI-275; surface
// §2.3). Compaction is the host destroying context — exactly the moment
// un-captured session knowledge is about to become unrecoverable — so this
// hook appends a compaction-snapshot record through bin/ideate-record (the
// gated core) before the compaction runs. Non-blocking by policy (§1.1):
// exit 0 unconditionally, stdout stays silent.

import {
  appendRecord,
  asString,
  errorMessage,
  excerptOf,
  parsePayload,
  readStdin,
  resolveProjectRoot,
  skimTranscript,
} from './hook-lib.mjs';

try {
  const payload = parsePayload(await readStdin(), 'pre-compact');
  const sessionId = asString(payload.session_id) ?? 'unknown';
  const trigger = asString(payload.trigger) ?? 'unknown';
  const projectRoot = resolveProjectRoot(payload);
  const transcriptPath = asString(payload.transcript_path);
  const skim = transcriptPath === undefined ? undefined : skimTranscript(transcriptPath);

  let claim;
  const sentences = [];
  if (skim === undefined) {
    claim = `Session ${sessionId} hit ${trigger} context compaction.`;
    sentences.push(claim);
    const where = transcriptPath ?? '(no transcript_path in the hook payload)';
    sentences.push(
      `No transcript was readable at ${where}, so this snapshot carries only what the PreCompact hook payload provided.`,
    );
    sentences.push(`It still marks that a working session in ${projectRoot} ran long enough to overflow its context window.`);
  } else {
    claim = `Session ${sessionId} hit ${trigger} context compaction after ${skim.userTurns} user and ${skim.assistantTurns} assistant turns.`;
    sentences.push(claim);
    sentences.push(
      'This snapshot was taken before the host compacted the conversation, preserving session progress that compaction would otherwise make unrecoverable.',
    );
    sentences.push(
      skim.toolUses > 0
        ? `The transcript shows ${skim.toolUses} tool call(s) so far.`
        : 'The transcript shows no tool calls so far.',
    );
    const excerpt = excerptOf(skim.lastAssistantText, 240);
    if (excerpt.length > 0) sentences.push(`Most recent assistant activity: "${excerpt}"`);
  }

  appendRecord('pre-compact', {
    projectRoot,
    kind: 'compaction-snapshot',
    claim,
    anchor: transcriptPath ?? '',
    content: sentences.join(' '),
  });
} catch (err) {
  process.stderr.write(`ideate pre-compact hook: ${errorMessage(err)}\n`);
}
process.exit(0);
