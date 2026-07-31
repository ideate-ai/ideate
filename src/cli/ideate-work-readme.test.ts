// plugin/src/cli/ideate-work-readme.test.ts — the README's `ideate-work` flag
// sets, checked against the shipped CLI rather than hand-maintained. The board
// CLI's twin of ideate-record-readme.test.ts.
//
// WHY this file exists: `ideate-work list` grew --limit, --cursor and
// --include-spec, and the README kept saying "the same eleven verbs as
// subcommands … `--json` on the read verbs" — the record CLI got a full
// rewrite for the identical change and the board CLI got neither a doc update
// nor a parity test. So a reader of the public README could not learn that
// `ideate-work list --json` TRUNCATES. This pins the three statements of that
// surface together:
//
//   1. the README bullet (what an integrator reads),
//   2. the CLI's own `--help` output (what the shipped binary says of itself),
//   3. the parseArgs spec in the source (what it actually accepts — an
//      undeclared flag is an `unknown argument` error).
//
// The SUBCOMMAND ROSTER is derived too: it comes from main()'s own dispatch
// switch, not a list typed here, so a twelfth subcommand that ships without a
// README bullet fails this suite rather than passing it silently.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-work');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-work.js');
const README = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
const CLI_SOURCE = readFileSync(join(PLUGIN_DIR, 'src', 'cli', 'ideate-work.ts'), 'utf8');

let scratchRoot: string;

beforeAll(() => {
  // Same self-sufficiency posture as ideate-work.test.ts: the bin runs
  // compiled output, so build it if this suite runs before `npm run build`.
  if (!existsSync(DIST_CLI)) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }
  // A throwaway cwd for the behavioral probe: the board is lazily created
  // under cwd, and this suite must never write one into the repository.
  scratchRoot = mkdtempSync(join(tmpdir(), 'ideate-work-readme-'));
}, 120_000);

afterAll(() => {
  if (scratchRoot !== undefined) rmSync(scratchRoot, { recursive: true, force: true });
});

/** Every distinct `--flag` token in a chunk of text, sorted. */
function flagsIn(text: string): string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])].sort();
}

/** The subcommand → runner pairs main() actually dispatches, read out of its
 *  own switch: the roster is the SHIPPED one, never a list maintained here. */
function shippedSubcommands(): { subcommand: string; runner: string }[] {
  const entry = CLI_SOURCE.slice(CLI_SOURCE.indexOf('export function main('));
  const pairs = [...entry.matchAll(/case '([a-z-]+)':\s*\n?\s*return (run[A-Za-z]+)\(/g)].map((m) => ({
    subcommand: m[1] as string,
    runner: m[2] as string,
  }));
  if (pairs.length === 0) throw new Error('no subcommand dispatch found in ideate-work main()');
  return pairs;
}

/** The README bullet documenting one subcommand's invocation line. */
function readmeFlags(subcommand: string): string[] {
  const line = README.split('\n').find((l) => l.startsWith(`- \`ideate-work ${subcommand} `));
  if (line === undefined) throw new Error(`README has no \`ideate-work ${subcommand}\` bullet`);
  // Only the backticked invocation itself — the prose after it discusses
  // flags in sentences and is not a signature.
  const signature = /`([^`]+)`/.exec(line)?.[1];
  if (signature === undefined) throw new Error(`README bullet for ${subcommand} carries no backticked signature`);
  return flagsIn(signature);
}

/** The subcommand's signature lines out of the shipped binary's own --help. */
function helpFlags(help: string, subcommand: string): string[] {
  // Signature lines are indented 2 (first) / 7+ (continuation); the
  // description that follows is indented 6 and mentions flags in prose.
  const block = new RegExp(`\\n  ${subcommand} ([\\s\\S]*?)\\n {6}\\S`).exec(help)?.[1];
  if (block === undefined) throw new Error(`--help has no ${subcommand} usage block`);
  return flagsIn(block);
}

/** The flags `parseArgs` is actually given for one subcommand's runner. */
function acceptedFlags(runner: string): string[] {
  const start = CLI_SOURCE.indexOf(`function ${runner}(`);
  if (start < 0) throw new Error(`no ${runner} in the CLI source`);
  const spec = /parseArgs\(argv, \{([\s\S]*?)\}\)/.exec(CLI_SOURCE.slice(start))?.[1];
  if (spec === undefined) throw new Error(`no parseArgs spec in ${runner}`);
  return [...spec.matchAll(/'(--[a-z][a-z-]*)':/g)].map((m) => m[1] as string).sort();
}

describe("the README's ideate-work flag sets match the shipped CLI", () => {
  let help: string;
  beforeAll(() => {
    // The artifact speaking for itself: run the real bin.
    help = execFileSync(process.execPath, [BIN_PATH, '--help'], { cwd: scratchRoot, encoding: 'utf8' });
  });

  it.each(shippedSubcommands())(
    '$subcommand: README, --help and the parseArgs spec name the same flags',
    ({ subcommand, runner }) => {
      const accepted = acceptedFlags(runner);
      expect(accepted.length).toBeGreaterThan(0); // the extraction itself must bite
      expect(readmeFlags(subcommand)).toEqual(accepted);
      expect(helpFlags(help, subcommand)).toEqual(accepted);
    },
  );

  it('a flag the README does not document is rejected — the sets above are exhaustive', () => {
    // The behavioral half: `list` accepts exactly its declared flags, so an
    // undeclared one is an error rather than a silently ignored argument.
    // (Direct-use path → exit 1; execFileSync throws on nonzero.)
    expect(readmeFlags('list')).not.toContain('--everything');
    expect(() =>
      execFileSync(process.execPath, [BIN_PATH, 'list', '--everything'], { cwd: scratchRoot, stdio: 'pipe' }),
    ).toThrow();
  });
});
