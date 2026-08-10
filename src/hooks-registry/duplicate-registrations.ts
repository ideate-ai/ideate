// plugin/src/hooks-registry/duplicate-registrations.ts — detection for the
// same lifecycle hook being wired up twice.
//
// WHAT WENT WRONG. This repository registered all seven ideate hooks twice:
// once through the installed plugin's own `hooks/hooks.json`, and again
// through `.claude/settings.local.json` pointing at the working-tree copies.
// Both fired on every event, so every captured fact was stored twice and the
// ten-record priming digest carried five distinct facts while presenting as
// ten. Nothing noticed for the life of the repository; it was found by chance,
// reading an unrelated stray directory.
//
// The project already holds a rule that a fact asserted in more than one file
// must have a single source of truth or an automated drift check, and that
// hand-maintained duplication across surfaces is a defect (P-38). A hook
// registration is exactly that: "run this script on this event", asserted in
// two independent files that nothing reconciles.
//
// WHAT COUNTS AS A DUPLICATE — the real design question, settled by measuring
// rather than assuming (decision 01KZN1AFZ8QJK4ZM8H8S27QZPD).
//
// Keying on "same event registered twice" would be wrong and useless. On the
// machine this was written for, SEVEN events already have multiple sources:
// SessionEnd has four, SessionStart three, and five more have two apiece —
// beepboop, cyberbrain, superpowers, kg and ideate each observing the same
// lifecycle events with their OWN scripts. That is what the extension point is
// for. A check that fired on it would be ignored within a day.
//
// The defect shape is narrower: the same SCRIPT wired for the same event by
// two different sources. Two flavours, and the second is the one that actually
// happened:
//
//   - `same-path`: byte-identical command, or two commands resolving to the
//     same absolute script. Unambiguous.
//   - `same-script-different-paths`: the same script NAME reached by different
//     absolute paths — the plugin's `${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs`
//     resolving into the install cache, and the project's local settings
//     naming `/Users/dan/code/ideate/plugin/hooks/session-start.mjs` in the
//     working tree. A naive path comparison would have missed the real defect
//     entirely, because those two strings never match.
//
// Script basenames do not collide across the installed plugins (checked: all
// fourteen registered scripts on this machine have exactly one owning plugin),
// so the name is a sound identity for this purpose. If that ever stops being
// true the finding is still only a WARNING, never a failure — see below.
//
// WHERE THIS RUNS, AND WHY NOT THE TEST SUITE. This is a property of a
// developer's MACHINE CONFIGURATION, not of the shipped source. A vitest case
// asserting "no duplicates on this machine" would fail for a contributor whose
// setup is perfectly fine, and pass vacuously in continuous integration where
// no plugin is installed at all — coverage in name only. So the machine-facing
// half runs as a SessionStart diagnostic that warns loudly and durably
// (hooks/session-start.mjs), matching the existing rule that a degraded or
// unexpected configuration must never be adopted in silence (P-45). The pure
// half — everything below except `enumerateRegistrations`'s filesystem reads —
// is covered by falsification fixtures in the suite, which is where a check's
// own logic belongs.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** One "run this script on this event" assertion, from one source. */
export interface HookRegistration {
  /** Lifecycle event name, e.g. `SessionStart`. */
  event: string;
  /** The command string exactly as declared. */
  command: string;
  /** Absolute script path after `${CLAUDE_PLUGIN_ROOT}` expansion, when derivable. */
  scriptPath?: string;
  /** The script's basename, when derivable — the identity used for matching. */
  scriptName?: string;
  /** Human-readable label for where this registration came from. */
  source: string;
}

export type DuplicateKind = 'same-path' | 'same-script-different-paths';

export interface DuplicateFinding {
  event: string;
  /** The script wired more than once for this event. */
  scriptName: string;
  kind: DuplicateKind;
  /** Every source that registered it, in the order encountered. */
  sources: string[];
  /** The distinct resolved paths involved. */
  paths: string[];
}

const SCRIPT_PATTERN = /[\w.\-/${}]*[\w.-]+\.(?:mjs|cjs|js|ts|sh|py)/;

/**
 * Pull the script out of a hook command string, expanding
 * `${CLAUDE_PLUGIN_ROOT}` when a plugin root is known.
 *
 * Commands are shell strings and may be quoted, wrapped, or carry arguments;
 * this deliberately extracts the first script-looking token rather than
 * parsing a shell. A command with no recognizable script yields `undefined`
 * and is simply never matched against anything — silence, not a false report.
 */
export function extractScript(
  command: string,
  pluginRoot?: string,
): { scriptPath?: string; scriptName?: string } {
  const match = SCRIPT_PATTERN.exec(command.replace(/^["']|["']$/g, ''));
  if (match === null) return {};
  let raw = match[0].replace(/^["']|["']$/g, '');
  if (pluginRoot !== undefined) {
    raw = raw.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot).replace(/\$CLAUDE_PLUGIN_ROOT/g, pluginRoot);
  }
  const scriptName = path.basename(raw);
  // Only call it a path when it actually looks resolved — an unexpanded
  // `${...}` is a name we can still match on, but not a path we can compare.
  const scriptPath = raw.includes('${') || !raw.includes('/') ? undefined : path.normalize(raw);
  return scriptName.length > 0
    ? { scriptName, ...(scriptPath === undefined ? {} : { scriptPath }) }
    : {};
}

/**
 * Flatten one `hooks` block — the `{ Event: [{ matcher?, hooks: [...] }] }`
 * shape used identically by a plugin manifest and a settings file — into flat
 * registrations. Malformed sub-structures are skipped rather than thrown on:
 * a detector that dies on unexpected input reports nothing, which is the
 * failure mode it exists to prevent.
 */
export function parseHooksBlock(
  hooks: unknown,
  source: string,
  pluginRoot?: string,
): HookRegistration[] {
  const out: HookRegistration[] = [];
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (group === null || typeof group !== 'object') continue;
      const inner = (group as Record<string, unknown>)['hooks'];
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        if (hook === null || typeof hook !== 'object') continue;
        const command = (hook as Record<string, unknown>)['command'];
        if (typeof command !== 'string' || command.length === 0) continue;
        out.push({ event, command, source, ...extractScript(command, pluginRoot) });
      }
    }
  }
  return out;
}

/**
 * Find events wired to the same script more than once.
 *
 * Registrations from the SAME source are not compared against each other: a
 * single manifest listing a script twice for one event is that manifest's own
 * business, and is not the cross-file drift this exists to catch.
 */
export function findDuplicateRegistrations(
  registrations: readonly HookRegistration[],
): DuplicateFinding[] {
  // Grouped by (event, scriptName). The group carries its own event and name
  // rather than encoding them into the key and splitting them back out: a
  // delimiter would have to be a character neither an event nor a script
  // basename can contain, and every such character is a control character —
  // which turns this source file into something git treats as binary, so it
  // stops being diffable and reviewable. Carrying the fields is simply better.
  interface Group {
    event: string;
    scriptName: string;
    registrations: HookRegistration[];
  }
  const groups = new Map<string, Group>();
  for (const reg of registrations) {
    if (reg.scriptName === undefined) continue;
    const key = JSON.stringify([reg.event, reg.scriptName]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { event: reg.event, scriptName: reg.scriptName, registrations: [reg] });
    } else {
      existing.registrations.push(reg);
    }
  }

  const findings: DuplicateFinding[] = [];
  for (const group of groups.values()) {
    const sources = [...new Set(group.registrations.map((r) => r.source))];
    if (sources.length < 2) continue; // same source listing it twice: not our concern
    const paths = [
      ...new Set(group.registrations.map((r) => r.scriptPath).filter((p): p is string => p !== undefined)),
    ];
    findings.push({
      event: group.event,
      scriptName: group.scriptName,
      kind: paths.length <= 1 ? 'same-path' : 'same-script-different-paths',
      sources,
      paths,
    });
  }
  return findings.sort((a, b) => a.event.localeCompare(b.event) || a.scriptName.localeCompare(b.scriptName));
}

/** Read and parse a JSON file, returning undefined on absence or corruption. */
function readJson(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export interface EnumerateOptions {
  /** The project whose settings files are consulted. */
  projectRoot: string;
  /** Claude Code's config directory — `~/.claude` in normal use. */
  claudeDir: string;
}

/**
 * Derive the COMPLETE set of hook registrations reaching a project, from the
 * files themselves — never from a hand-maintained list, which would be the
 * same duplication defect one level up.
 *
 * Four layers: the user's own settings, the project's checked-in settings, the
 * project's local settings, and every installed plugin's hook manifest.
 */
export function enumerateRegistrations(options: EnumerateOptions): HookRegistration[] {
  const { projectRoot, claudeDir } = options;
  const out: HookRegistration[] = [];

  const settingsFiles: [string, string][] = [
    [path.join(claudeDir, 'settings.json'), 'user settings'],
    [path.join(projectRoot, '.claude', 'settings.json'), 'project settings'],
    [path.join(projectRoot, '.claude', 'settings.local.json'), 'project local settings'],
  ];
  for (const [file, label] of settingsFiles) {
    const parsed = readJson(file);
    if (parsed === undefined) continue;
    out.push(...parseHooksBlock(parsed['hooks'], label));
  }

  const installed = readJson(path.join(claudeDir, 'plugins', 'installed_plugins.json'));
  const plugins = installed?.['plugins'];
  if (plugins !== null && typeof plugins === 'object' && !Array.isArray(plugins)) {
    for (const [name, entries] of Object.entries(plugins as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue;
        const installPath = (entry as Record<string, unknown>)['installPath'];
        if (typeof installPath !== 'string') continue;
        const manifest = readJson(path.join(installPath, 'hooks', 'hooks.json'));
        if (manifest === undefined) continue;
        out.push(...parseHooksBlock(manifest['hooks'], `plugin ${name}`, installPath));
      }
    }
  }

  return out;
}

/**
 * Render findings as a loud, durable operator warning. Empty string when
 * there is nothing to say, so a caller can test emptiness rather than parse.
 */
export function formatDuplicateWarning(findings: readonly DuplicateFinding[]): string {
  if (findings.length === 0) return '';
  const lines = [
    '',
    '  ⚠  ideate: DUPLICATE HOOK REGISTRATION DETECTED',
    '',
    `  ${String(findings.length)} lifecycle hook(s) are wired up more than once for this project.`,
    '  Every event they observe is being captured twice, so the process record',
    '  stores each fact twice and the session priming digest carries half the',
    '  distinct facts it appears to.',
    '',
  ];
  for (const f of findings) {
    lines.push(`  ${f.event} -> ${f.scriptName}`);
    lines.push(`      registered by: ${f.sources.join(' AND ')}`);
    if (f.kind === 'same-script-different-paths') {
      lines.push('      (same script reached by different paths:)');
      for (const p of f.paths) lines.push(`        ${p}`);
    }
  }
  lines.push('');
  lines.push('  Fix: leave exactly ONE registration. See decision 01KZN1AFZ8QJK4ZM8H8S27QZPD.');
  lines.push('');
  return `${lines.join('\n')}\n`;
}
