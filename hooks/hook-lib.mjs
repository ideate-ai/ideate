// plugin/hooks/hook-lib.mjs — shared plumbing for the ideate capture hook
// scripts (WI-275; docs/design/v3-composable-surface.md §2.3).
//
// Every hook script is THIN: parse the event JSON from stdin, compose a
// small recall-shaped prose record (sentences, not bare metadata — these
// records feed gate G8), and hand it to `bin/ideate-record append` — the
// ONLY write path, so every hook-written record passes the same
// capture-time secret gate as every other write (surface §2.1). The plugin
// root is resolved from THIS file's location, never from cwd — hooks must
// not depend on where the host happened to spawn them.
//
// Hook policy (surface §1.1): every ideate hook is non-blocking — exit 0
// always, side effects only. Nothing here ever writes a blocking field to
// stdout; the child CLI's stdout is captured, never inherited.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));

/** The plugin root, resolved from this file's own location (cwd-free). */
export const PLUGIN_ROOT = join(HOOKS_DIR, '..');

/** The one write path: the gated `ideate-record` CLI (surface §2.1). */
export const RECORD_BIN = join(PLUGIN_ROOT, 'bin', 'ideate-record');

export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/** Drain stdin to a string; a TTY stdin reads as empty — never hangs. */
export async function readStdin() {
  if (process.stdin.isTTY === true) return '';
  let data = '';
  for await (const chunk of process.stdin) {
    data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return data;
}

/**
 * Parse the hook payload JSON. Anything unparseable degrades to `{}` with a
 * one-line stderr diagnostic — garbage stdin composes a minimal record, it
 * never turns into a hook failure.
 */
export function parsePayload(raw, hookName) {
  if (raw.trim().length === 0) {
    process.stderr.write(`ideate ${hookName} hook: empty stdin payload; composing a minimal record\n`);
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    process.stderr.write(`ideate ${hookName} hook: stdin payload is not a JSON object; composing a minimal record\n`);
  } catch (err) {
    process.stderr.write(`ideate ${hookName} hook: unparseable stdin payload (${errorMessage(err)}); composing a minimal record\n`);
  }
  return {};
}

export function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** The project root the record lands in: the payload cwd when it exists. */
export function resolveProjectRoot(payload) {
  const cwd = asString(payload.cwd);
  return cwd !== undefined && existsSync(cwd) ? cwd : process.cwd();
}

/** Whitespace-collapsed, length-capped one-line excerpt. */
export function excerptOf(text, maxLength = 160) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength - 1)}…`;
}

/**
 * Append one record through the CLI (the gated core's second transport).
 * The child's stdout (the new record id) is CAPTURED, never inherited:
 * this process's stdout is host-visible hook output and stays silent. The
 * child's STDERR, by contrast, is forwarded to this hook's own stderr
 * UNCONDITIONALLY — on success AND on failure (WI-281, closes cycle-7 S1:
 * reading it only on nonzero exit discarded the secret-gate redaction
 * warnings in transit, because a redaction is a successful append). Stderr
 * is diagnostic-only to the host, so forwarding never blocks anything and
 * exit-0 behavior is unchanged. A failed append is likewise diagnosed on
 * stderr only — the store has already counted it (capture_write_failed);
 * it must never look like a hook failure to the host (log + count, never
 * block).
 */
export function appendRecord(hookName, { projectRoot, kind, claim, anchor = '', scope = '', content, taskId }) {
  const args = [RECORD_BIN, 'append', '--kind', kind, '--claim', claim, '--anchor', anchor, '--scope', scope, '--content', '-'];
  if (taskId !== undefined) args.push('--task', taskId);
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    input: content,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Forward the child's stderr verbatim, success or failure — redaction
  // warnings and other diagnostics must survive the hook transport.
  const childStderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (childStderr.length > 0) {
    process.stderr.write(childStderr.endsWith('\n') ? childStderr : `${childStderr}\n`);
  }
  if (result.error !== undefined) {
    process.stderr.write(`ideate ${hookName} hook: could not run ideate-record (${errorMessage(result.error)})\n`);
    return false;
  }
  if (result.status !== 0) {
    process.stderr.write(`ideate ${hookName} hook: append exited ${String(result.status)}\n`);
    return false;
  }
  return true;
}

/**
 * Light structural skim of a transcript JSONL: turn counts, tool-use count,
 * and the last assistant text block. Deliberately smaller than the CLI's
 * session-end summarizer — a PreCompact snapshot needs "where was this
 * session" prose, not a full outcome digest. Returns undefined when the
 * file is missing/unreadable or nothing parses as a transcript entry.
 */
export function skimTranscript(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
  const skim = { userTurns: 0, assistantTurns: 0, toolUses: 0, lastAssistantText: '' };
  let parsedAny = false;
  for (const line of raw.split('\n')) {
    if (line.trim().length > 0) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        entry = undefined; // a torn/foreign line must not poison the skim
      }
      if (entry !== undefined && entry !== null && typeof entry === 'object') {
        if (entry.type === 'user') {
          parsedAny = true;
          skim.userTurns += 1;
        } else if (entry.type === 'assistant') {
          parsedAny = true;
          skim.assistantTurns += 1;
          const content = entry.message !== null && typeof entry.message === 'object' ? entry.message.content : undefined;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block !== null && typeof block === 'object') {
                if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
                  skim.lastAssistantText = block.text;
                } else if (block.type === 'tool_use') {
                  skim.toolUses += 1;
                }
              }
            }
          }
        }
      }
    }
  }
  return parsedAny ? skim : undefined;
}
