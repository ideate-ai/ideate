// plugin/src/hooks-registry/duplicate-registrations.test.ts — falsification
// fixtures for the duplicate-hook-registration check (P-41).
//
// P-41 requires that a mechanical check have committed fixtures proving it
// FIRES on an induced violation and stays QUIET on agreement, and that the
// violating fixture be an independent re-implementation of the offending
// property rather than a renamed copy of the guarded code. So the fixtures
// below are hand-written config files in the shapes a real machine produces —
// a plugin manifest using `${CLAUDE_PLUGIN_ROOT}`, a settings file naming an
// absolute working-tree path — and never import the detector's own notion of
// what a duplicate is.
//
// The headline case is deliberately the one that actually happened and that a
// naive check would MISS: the plugin manifest and the project's local settings
// naming the same script through two completely different absolute paths, so
// the two command strings never match textually.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  enumerateRegistrations,
  extractScript,
  findDuplicateRegistrations,
  formatDuplicateWarning,
  parseHooksBlock,
} from './duplicate-registrations.js';
import type { HookRegistration } from './duplicate-registrations.js';

const tempDirs: string[] = [];
afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** The `{ Event: [{ hooks: [{ command }] }] }` shape both surfaces use. */
function hooksBlock(entries: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, commands] of Object.entries(entries)) {
    out[event] = [{ hooks: commands.map((command) => ({ type: 'command', command })) }];
  }
  return out;
}

/**
 * A machine layout: a Claude config dir with settings + installed plugins, and
 * a project dir with its own settings. Built from literal file contents so the
 * fixture states the violating property itself.
 */
interface Machine {
  claudeDir: string;
  projectRoot: string;
}

function makeMachine(opts: {
  userHooks?: Record<string, string[]>;
  projectLocalHooks?: Record<string, string[]>;
  plugins?: Record<string, Record<string, string[]>>;
}): Machine {
  const root = mkdtempSync(join(tmpdir(), 'ideate-hookreg-'));
  tempDirs.push(root);
  const claudeDir = join(root, '.claude');
  const projectRoot = join(root, 'project');
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true });

  writeFileSync(
    join(claudeDir, 'settings.json'),
    JSON.stringify(opts.userHooks === undefined ? {} : { hooks: hooksBlock(opts.userHooks) }, null, 2),
  );
  writeFileSync(
    join(projectRoot, '.claude', 'settings.local.json'),
    JSON.stringify(
      opts.projectLocalHooks === undefined
        ? { permissions: { allow: [] } }
        : { permissions: { allow: [] }, hooks: hooksBlock(opts.projectLocalHooks) },
      null,
      2,
    ),
  );

  const installed: Record<string, unknown> = {};
  for (const [name, hooks] of Object.entries(opts.plugins ?? {})) {
    const installPath = join(claudeDir, 'plugins', 'cache', name);
    mkdirSync(join(installPath, 'hooks'), { recursive: true });
    writeFileSync(join(installPath, 'hooks', 'hooks.json'), JSON.stringify({ hooks: hooksBlock(hooks) }, null, 2));
    installed[name] = [{ scope: 'user', installPath, version: '1.0.0' }];
  }
  writeFileSync(
    join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: installed }, null, 2),
  );

  return { claudeDir, projectRoot };
}

// ---------------------------------------------------------------------------
// FIRES on an induced violation
// ---------------------------------------------------------------------------

describe('the check FIRES when the same hook is wired twice', () => {
  it('catches the real defect: same script, two sources, two different absolute paths', () => {
    // This is what actually happened. The plugin manifest says
    // `${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs`, which resolves into the
    // install cache; the project's local settings name the working-tree copy.
    // The two command strings share not one character of path, so any check
    // comparing commands or resolved paths would report nothing.
    const machine = makeMachine({
      plugins: { 'ideate@ideate-marketplace': { SessionStart: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"'] } },
      projectLocalHooks: { SessionStart: ['"/Users/dev/code/ideate/plugin/hooks/session-start.mjs"'] },
    });

    const findings = findDuplicateRegistrations(enumerateRegistrations(machine));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.event).toBe('SessionStart');
    expect(findings[0]?.scriptName).toBe('session-start.mjs');
    expect(findings[0]?.kind).toBe('same-script-different-paths');
    expect(findings[0]?.sources).toHaveLength(2);
  });

  it('catches an identical command declared by two sources', () => {
    const machine = makeMachine({
      userHooks: { SessionEnd: ['"/opt/tools/session-end.mjs"'] },
      projectLocalHooks: { SessionEnd: ['"/opt/tools/session-end.mjs"'] },
    });
    const findings = findDuplicateRegistrations(enumerateRegistrations(machine));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('same-path');
  });

  it('reports every duplicated event, not just the first', () => {
    const seven = ['SessionStart', 'SessionEnd', 'PreCompact', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'TaskCompleted'];
    const plugin: Record<string, string[]> = {};
    const local: Record<string, string[]> = {};
    for (const ev of seven) {
      const name = `${ev.toLowerCase()}.mjs`;
      plugin[ev] = [`"\${CLAUDE_PLUGIN_ROOT}/hooks/${name}"`];
      local[ev] = [`"/Users/dev/code/ideate/plugin/hooks/${name}"`];
    }
    const machine = makeMachine({ plugins: { 'ideate@m': plugin }, projectLocalHooks: local });
    expect(findDuplicateRegistrations(enumerateRegistrations(machine))).toHaveLength(7);
  });

  it('produces a warning that names the event, the script and both sources', () => {
    const machine = makeMachine({
      plugins: { 'ideate@ideate-marketplace': { SessionStart: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"'] } },
      projectLocalHooks: { SessionStart: ['"/Users/dev/code/ideate/plugin/hooks/session-start.mjs"'] },
    });
    const text = formatDuplicateWarning(findDuplicateRegistrations(enumerateRegistrations(machine)));
    expect(text).toContain('DUPLICATE HOOK REGISTRATION');
    expect(text).toContain('SessionStart');
    expect(text).toContain('session-start.mjs');
    expect(text).toContain('project local settings');
    expect(text).toContain('plugin ideate@ideate-marketplace');
  });
});

// ---------------------------------------------------------------------------
// STAYS QUIET on a correct configuration
// ---------------------------------------------------------------------------

describe('the check STAYS QUIET when the configuration is fine', () => {
  it('says nothing when each hook has exactly one source', () => {
    const machine = makeMachine({
      plugins: {
        'ideate@ideate-marketplace': {
          SessionStart: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"'],
          SessionEnd: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-end.mjs"'],
        },
      },
    });
    const findings = findDuplicateRegistrations(enumerateRegistrations(machine));
    expect(findings).toEqual([]);
    expect(formatDuplicateWarning(findings)).toBe('');
  });

  it('does NOT fire when different plugins observe the same event with their own scripts', () => {
    // The case that makes a naive "same event twice" check useless. On a real
    // machine SessionEnd legitimately has four observers. This must be silent.
    const machine = makeMachine({
      plugins: {
        'ideate@m': { SessionEnd: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-end.mjs"'] },
        'cyberbrain@m': { SessionEnd: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-end-extract.sh"'] },
        'kg@m': { SessionEnd: ['"${CLAUDE_PLUGIN_ROOT}/hooks/session-end-ingest.sh"'] },
        'beepboop@m': { SessionEnd: ['"${CLAUDE_PLUGIN_ROOT}/hooks/notify.sh"'] },
      },
    });
    expect(findDuplicateRegistrations(enumerateRegistrations(machine))).toEqual([]);
  });

  it('does not treat one source listing a script twice as cross-file drift', () => {
    const machine = makeMachine({
      projectLocalHooks: { SessionStart: ['"/opt/a.mjs"', '"/opt/a.mjs"'] },
    });
    expect(findDuplicateRegistrations(enumerateRegistrations(machine))).toEqual([]);
  });

  it('survives absent, empty and corrupt configuration without reporting anything', () => {
    const machine = makeMachine({});
    expect(findDuplicateRegistrations(enumerateRegistrations(machine))).toEqual([]);

    writeFileSync(join(machine.projectRoot, '.claude', 'settings.local.json'), '{ this is not json');
    expect(() => enumerateRegistrations(machine)).not.toThrow();
    expect(findDuplicateRegistrations(enumerateRegistrations(machine))).toEqual([]);

    expect(findDuplicateRegistrations([])).toEqual([]);
    expect(enumerateRegistrations({ claudeDir: '/nonexistent', projectRoot: '/nonexistent' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The parsing pieces
// ---------------------------------------------------------------------------

describe('script extraction and block parsing', () => {
  it('expands ${CLAUDE_PLUGIN_ROOT} and takes the basename as identity', () => {
    const r = extractScript('"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"', '/cache/ideate/3.2.1');
    expect(r.scriptName).toBe('session-start.mjs');
    expect(r.scriptPath).toBe('/cache/ideate/3.2.1/hooks/session-start.mjs');
  });

  it('still yields a name when the root is unknown, but no path to compare', () => {
    const r = extractScript('"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"');
    expect(r.scriptName).toBe('session-start.mjs');
    expect(r.scriptPath).toBeUndefined();
  });

  it('finds the script even with surrounding arguments', () => {
    expect(extractScript('node /opt/hooks/run.mjs --verbose').scriptName).toBe('run.mjs');
  });

  it('yields nothing for a command with no recognizable script', () => {
    expect(extractScript('echo hello').scriptName).toBeUndefined();
  });

  it('skips malformed sub-structures instead of throwing', () => {
    expect(parseHooksBlock(null, 's')).toEqual([]);
    expect(parseHooksBlock({ SessionStart: 'not-an-array' }, 's')).toEqual([]);
    expect(parseHooksBlock({ SessionStart: [{ hooks: [{ type: 'command' }] }] }, 's')).toEqual([]);
    expect(parseHooksBlock({ SessionStart: [{ hooks: [null, { command: '/a.mjs' }] }] }, 's')).toHaveLength(1);
  });

  it('flattens multiple groups and multiple hooks per event', () => {
    const regs: HookRegistration[] = parseHooksBlock(
      { PostToolUse: [{ matcher: 'Bash', hooks: [{ command: '/a.mjs' }, { command: '/b.mjs' }] }, { hooks: [{ command: '/c.mjs' }] }] },
      'src',
    );
    expect(regs.map((r) => r.scriptName)).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });
});
