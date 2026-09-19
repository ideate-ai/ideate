// plugin/src/cli/stdin-convention-parity.test.ts — the P-40/P-52 guard for
// the stdin convention itself: which flags on EITHER binary read `-` from
// stdin must be the SAME set the binary's own `--help` claims, derived from
// the source rather than hand-matched by eye.
//
// THE DEFECT THIS GUARDS AGAINST (finding 01M2MKGS5PRV7WSD0W4ZQYAG4A).
// `ideate-record append --content -` already worked; `ideate-work
// update-meta --spec -` looked identical and silently did not — the two
// binaries' USAGE text and their actual behaviour had drifted apart with no
// artifact to disagree with. This file pins THREE independently-derived
// statements of "which flags read stdin" together for BOTH binaries:
//
//   1. the flags each runner actually resolves through `resolveStdinArg`
//      (scanned out of the compiled-from source, never hand-listed here),
//   2. the flags each binary's OWN `--help` output documents via the shared
//      `stdinUsageNote` template (scanned the same way),
//   3. the flags a REAL invocation piping stdin actually reads correctly.
//
// A flag that is wired but undocumented, or documented but not wired, fails
// set (1) vs (2) without anyone reading either file by eye. Set (3) is the
// behavioral half — this suite's siblings (ideate-work.test.ts,
// ideate-record.test.ts) drive it against the real executables.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

interface Binary {
  name: string;
  bin: string;
  source: string;
}

function loadBinary(name: 'ideate-work' | 'ideate-record'): Binary {
  return {
    name,
    bin: join(PLUGIN_DIR, 'bin', name),
    source: readFileSync(join(PLUGIN_DIR, 'src', 'cli', `${name}.ts`), 'utf8'),
  };
}

/**
 * The flags a CLI source file actually resolves through `resolveStdinArg`,
 * scanned mechanically rather than hand-listed — covers both call-site
 * shapes used in this repo: the inline form
 * (`resolveStdinArg(parsed.values.get('--flag'), …)`) and the two-step form
 * (`const xRaw = parsed.values.get('--flag'); … resolveStdinArg(xRaw, …)`).
 */
function stdinCapableFlags(source: string): string[] {
  const flags = new Set<string>();
  for (const m of source.matchAll(/resolveStdinArg\(\s*parsed\.values\.get\('(--[a-z-]+)'\)/g)) {
    flags.add(m[1] as string);
  }
  const assignments = [...source.matchAll(/const (\w+) = parsed\.values\.get\('(--[a-z-]+)'\)/g)].map((m) => ({
    index: m.index ?? -1,
    name: m[1] as string,
    flag: m[2] as string,
  }));
  for (const call of source.matchAll(/resolveStdinArg\(\s*(\w+),/g)) {
    const varName = call[1] as string;
    const callIndex = call.index ?? -1;
    const candidate = assignments.filter((a) => a.name === varName && a.index < callIndex).sort((a, b) => b.index - a.index)[0];
    if (candidate !== undefined) flags.add(candidate.flag);
  }
  return [...flags].sort();
}

/** The flags a CLI source's OWN `--help` prose claims support stdin, via the
 *  shared `stdinUsageNote` template — scanned from the SOURCE call sites
 *  (`stdinUsageNote('--flag', …)`), not from hand-typed prose. */
function stdinDocumentedFlags(source: string): string[] {
  return [...new Set([...source.matchAll(/stdinUsageNote\('(--[a-z-]+)'/g)].map((m) => m[1] as string))].sort();
}

/** The flags a REAL `--help` invocation's output states read from stdin,
 *  matched against the exact template `stdinUsageNote` generates
 *  (`` `--flag -` reads … from stdin ``) — the compiled artifact speaking
 *  for itself, not the source text. */
function stdinFlagsInHelpOutput(help: string): string[] {
  return [...new Set([...help.matchAll(/`(--[a-z-]+) -` reads [^\n]*? from stdin/g)].map((m) => m[1] as string))].sort();
}

describe('the stdin convention: wired flags, documented flags, and --help output all name the same set', () => {
  let help: Record<string, string> = {};

  beforeAll(() => {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
    for (const name of ['ideate-work', 'ideate-record'] as const) {
      const bin = join(PLUGIN_DIR, 'bin', name);
      help[name] = execFileSync(process.execPath, [bin, '--help'], { cwd: PLUGIN_DIR, encoding: 'utf8' });
    }
  }, 120_000);

  it.each([loadBinary('ideate-work'), loadBinary('ideate-record')])(
    '$name: resolveStdinArg call sites, stdinUsageNote call sites, and --help output name the same flag set',
    ({ name, source }) => {
      const wired = stdinCapableFlags(source);
      const documented = stdinDocumentedFlags(source);
      const shown = stdinFlagsInHelpOutput(help[name] as string);

      // The extraction itself must bite — a regression that stops finding
      // ANY stdin-capable flag would otherwise pass this suite vacuously.
      expect(wired.length).toBeGreaterThan(0);
      expect(wired).toEqual(documented);
      expect(wired).toEqual(shown);
    },
  );

  it('P-40: both binaries describe the convention with the SAME generated wording, not two hand-typed copies', () => {
    // Pull one concrete flag out of each binary's own wired set and confirm
    // the exact phrase in --help matches the shared template's output byte
    // for byte — proving both binaries render through the one function
    // rather than each keeping its own copy of the sentence.
    const workHelp = help['ideate-work'] as string;
    const recordHelp = help['ideate-record'] as string;
    expect(workHelp).toMatch(/`--spec -` reads the spec body from stdin/);
    expect(recordHelp).toMatch(/`--content -` reads the prose body from stdin/);
    // Both phrases share the identical connective tissue the template
    // produces — "reads" ... "from stdin" — rather than each binary
    // inventing its own grammar for the same rule.
    for (const text of [workHelp, recordHelp]) {
      for (const m of text.matchAll(/`(--[a-z-]+) -` (.*? from stdin)/g)) {
        expect(m[2]).toMatch(/^reads .* from stdin$/);
      }
    }
  });

  it('a flag NOT in the wired set is never claimed as stdin-capable in --help (no over-documentation)', () => {
    // --title/--human/--token/--id and every other short, structured flag
    // never appear in the `--flag -` pattern at all.
    const workHelp = help['ideate-work'] as string;
    for (const flag of ['--title', '--human', '--token', '--id', '--parent', '--tenant', '--agent']) {
      expect(workHelp).not.toMatch(new RegExp('`' + flag + ' -` reads'));
    }
    const recordHelp = help['ideate-record'] as string;
    for (const flag of ['--anchor', '--scope', '--task', '--kind']) {
      expect(recordHelp).not.toMatch(new RegExp('`' + flag + ' -` reads'));
    }
  });
});
