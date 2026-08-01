// plugin/src/cli/ideate-record-readme.test.ts — the README's `ideate-record`
// flag sets, checked against the shipped CLI rather than hand-maintained.
//
// WHY this file exists: the README documented `ideate-record read [--scope]
// [--limit] [--json]` long after the CLI grew --id/--cursor/--include-content,
// and nothing caught it — prose about a shipped surface had no artifact to
// disagree with. This pins the three statements of that surface together:
//
//   1. the README bullet (what an integrator reads),
//   2. the CLI's own `--help` output (what the shipped binary says of itself),
//   3. the parseArgs spec in the source (what it actually accepts — an
//      undeclared flag is an `unknown argument` error).
//
// All three must name the SAME flags. Add a flag to the CLI and this fails
// until the README says so; document a flag that does not exist and it fails
// on the behavioral probe below.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-record');
const README = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
const CLI_SOURCE = readFileSync(join(PLUGIN_DIR, 'src', 'cli', 'ideate-record.ts'), 'utf8');

beforeAll(() => {
  // Build UNCONDITIONALLY, every run — `tsc -b` is incremental, so a no-op
  // rebuild is cheap, and a conditional (skip when dist/ already exists) let
  // this suite pass green against a STALE dist left by a previous change
  // (P-50: the verified path must BE the shipped path).
  execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
}, 120_000);

/** Every distinct `--flag` token in a chunk of text, sorted. */
function flagsIn(text: string): string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])].sort();
}

/** The README bullet documenting one subcommand's invocation line. */
function readmeFlags(subcommand: string): string[] {
  const line = README.split('\n').find((l) => l.startsWith(`- \`ideate-record ${subcommand} `));
  if (line === undefined) throw new Error(`README has no \`ideate-record ${subcommand}\` bullet`);
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

describe("the README's ideate-record flag sets match the shipped CLI", () => {
  let help: string;
  beforeAll(() => {
    // The artifact speaking for itself: run the real bin.
    help = execFileSync(process.execPath, [BIN_PATH, '--help'], { cwd: PLUGIN_DIR, encoding: 'utf8' });
  });

  it.each([
    { subcommand: 'read', runner: 'runRead' },
    { subcommand: 'append', runner: 'runAppend' },
    { subcommand: 'prime', runner: 'runPrime' },
  ])('$subcommand: README, --help and the parseArgs spec name the same flags', ({ subcommand, runner }) => {
    const accepted = acceptedFlags(runner);
    expect(accepted.length).toBeGreaterThan(0); // the extraction itself must bite
    expect(readmeFlags(subcommand)).toEqual(accepted);
    expect(helpFlags(help, subcommand)).toEqual(accepted);
  });

  it('a flag the README does not document is rejected — the sets above are exhaustive', () => {
    // The behavioral half: `read` accepts exactly its declared flags, so an
    // undeclared one is an error rather than a silently ignored argument.
    // (Direct-use path → exit 1; execFileSync throws on nonzero.)
    expect(readmeFlags('read')).not.toContain('--everything');
    expect(() =>
      execFileSync(process.execPath, [BIN_PATH, 'read', '--everything'], { cwd: PLUGIN_DIR, stdio: 'pipe' }),
    ).toThrow();
  });
});
