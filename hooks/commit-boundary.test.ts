// plugin/hooks/commit-boundary.test.ts — the guard for the commit-boundary
// hook's two self-narrowing gates.
//
// WHAT WENT WRONG. The hook trusted hooks.json's `if: "Bash(git commit*)"` and
// recorded whatever it was handed. That condition fails OPEN on command shapes
// its evaluator cannot decompose. Measured 2026-08-07 against this project's
// own record: of 487 commit-boundary records, 416 were produced by commands
// containing no `git commit` at all, and one commit was re-reported ten times
// over the 38 minutes after it landed with HEAD unmoved throughout.
//
// The fixtures below are written from the PROPERTY — "this command runs a git
// commit" — rather than from the implementation, so they stay an independent
// statement of the rule rather than a restatement of the regex (P-41). The
// negative cases are drawn from real triggering commands recovered from the
// record store, not invented.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs hook module, no type declarations by design.
import { commandCommits } from './commit-boundary.mjs';

const HOOKS_DIR = fileURLToPath(new URL('.', import.meta.url));
const PLUGIN_DIR = join(HOOKS_DIR, '..');
const HOOK = join(HOOKS_DIR, 'commit-boundary.mjs');

const tempDirs: string[] = [];
afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
}, 180_000);

// ---------------------------------------------------------------------------
// Gate 1 — command shape
// ---------------------------------------------------------------------------

describe('gate 1: a command is only a commit boundary when it actually runs `git commit`', () => {
  const COMMITS = [
    'git commit -m "a message"',
    'git commit',
    'git commit --amend --no-edit',
    'git add -A && git commit -m "staged then committed"',
    'echo starting; git commit -m x',
    'git -C plugin commit -m "committing in a submodule"',
    'git --no-pager commit -m x',
    'npm test && git commit -am "green"',
  ];
  for (const command of COMMITS) {
    it(`accepts: ${command}`, () => {
      expect(commandCommits(command)).toBe(true);
    });
  }

  // Every one of these is a REAL command recovered from a spurious
  // commit-boundary record in this project's store. Each produced a record
  // asserting that a commit had just landed.
  const NOT_COMMITS = [
    "cd /Users/dan/code && python3 - <<'PY'\nimport os, pathlib\nprint(os.getcwd())\nPY",
    'mkdir -p /Users/dan/code/ideate/harness/suites/gapscan/fixtures/payroll-ledger/{src,test,answer-key/variants}',
    'cd fixtures/answer-key && for v in variants/*.js; do echo "=== $v ==="; done',
    'until ! pgrep -f "dist/cli/run-suite.js" >/dev/null 2>&1; do sleep 15; done; echo "runner idle"',
    'set -e\nROOT=/tmp/ideate-autopilot-validation\nrm -rf "$ROOT"\nmkdir -p "$ROOT/src"\ncd "$ROOT"',
    'echo "=== branches before ==="; git branch -vv; git branch -D main 2>&1',
    'RUN=$(gh run list --repo ideate-ai/ideate --limit 1 --json databaseId --jq \'.[0].databaseId\'); echo "$RUN"',
    'git status',
    'git ls-files | grep harness',
    'git check-ignore -v .ideate.json',
  ];
  for (const command of NOT_COMMITS) {
    it(`rejects: ${command.split('\n')[0].slice(0, 62)}`, () => {
      expect(commandCommits(command)).toBe(false);
    });
  }

  it('rejects a command that merely MENTIONS committing in a string', () => {
    // The refuted hypothesis. The item recorded a correlation with commands
    // whose TEXT mentioned the record tools; the experiment showed text alone
    // does not trigger the host, and it must not trigger this gate either.
    expect(commandCommits('echo "remember to git commit later"')).toBe(false);
    expect(commandCommits('grep -rn "git commit" docs/')).toBe(false);
    expect(commandCommits('./bin/ideate-record read --limit 1 --json')).toBe(false);
  });

  it('rejects an absent or empty command rather than throwing', () => {
    expect(commandCommits(undefined)).toBe(false);
    expect(commandCommits('')).toBe(false);
    expect(commandCommits(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The whole hook, driven end to end
// ---------------------------------------------------------------------------

interface Repo {
  root: string;
  hash: string;
}

/** A real git repo with one real commit and an ideate project on top of it. */
function makeRepo(): Repo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-commit-boundary-')));
  tempDirs.push(root);
  const run = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(
    join(root, '.ideate.json'),
    `${JSON.stringify({ schema_version: 10, record: { path: '.ideate/record/' }, backend: 'local' }, null, 2)}\n`,
  );
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'the one real commit']);
  const hash = run(['rev-parse', 'HEAD']).trim();
  return { root, hash };
}

/** Fire the hook exactly as the host would: event JSON on stdin. */
function fireHook(repo: Repo, command: string): { stderr: string } {
  const payload = JSON.stringify({
    session_id: 'test-session',
    cwd: repo.root,
    tool_name: 'Bash',
    tool_input: { command },
  });
  const result = execFileSync(process.execPath, [HOOK], {
    cwd: repo.root,
    input: payload,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { stderr: String(result) };
}

/** Every commit-boundary record currently in the repo's store. */
function commitBoundaryRecords(repo: Repo): string[] {
  const dir = join(repo.root, '.ideate', 'record');
  const out: string[] = [];
  const walk = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out.filter((p) => execFileSync('grep', ['-l', 'kind: "commit-boundary"', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).length > 0);
}

describe('the hook end to end, driven the way the host drives it', () => {
  it('a real commit still produces exactly one record with the correct hash — the job is not regressed', () => {
    const repo = makeRepo();
    fireHook(repo, 'git commit -m "the one real commit"');
    const records = commitBoundaryRecords(repo);
    expect(records).toHaveLength(1);
    const body = execFileSync('cat', [records[0]], { encoding: 'utf8' });
    expect(body).toContain(repo.hash);
    expect(body).toContain('the one real commit');
  });

  it('recording the same commit twice is a no-op (idempotency)', () => {
    const repo = makeRepo();
    fireHook(repo, 'git commit -m "the one real commit"');
    expect(commitBoundaryRecords(repo)).toHaveLength(1);

    // Fire again with HEAD unmoved — exactly the shape that produced twenty
    // records for commit d99ecc1c3e86.
    fireHook(repo, 'git commit -m "the one real commit"');
    fireHook(repo, 'git commit --amend --no-edit');
    expect(commitBoundaryRecords(repo)).toHaveLength(1);
  });

  it('a non-commit command produces no record — including one that mentions ideate-record', () => {
    const repo = makeRepo();
    fireHook(repo, "cd /tmp && python3 - <<'PY'\nprint('hi')\nPY");
    fireHook(repo, './bin/ideate-record read --limit 1 --json');
    fireHook(repo, 'echo "this mentions ideate-record and ideate-work but commits nothing"');
    fireHook(repo, 'git status');
    expect(commitBoundaryRecords(repo)).toHaveLength(0);
  });

  it('a genuinely new commit IS recorded after an earlier one — the gate is novelty, not a one-shot latch', () => {
    const repo = makeRepo();
    fireHook(repo, 'git commit -m "the one real commit"');
    expect(commitBoundaryRecords(repo)).toHaveLength(1);

    writeFileSync(join(repo.root, 'b.txt'), 'second\n');
    execFileSync('git', ['add', '-A'], { cwd: repo.root, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'a second real commit'], { cwd: repo.root, stdio: 'pipe' });

    fireHook(repo, 'git commit -m "a second real commit"');
    expect(commitBoundaryRecords(repo)).toHaveLength(2);
  });

  it('a record is never attributed to a session that did not make the commit', () => {
    // The false records asserted a commit "landed in session X" for a commit
    // made in an entirely different, earlier session. With the gates in
    // place the only session that can produce a record for a commit is the
    // one whose command actually made it.
    const repo = makeRepo();
    fireHook(repo, 'git commit -m "the one real commit"');
    const first = commitBoundaryRecords(repo);
    expect(first).toHaveLength(1);

    // A later, different session fires on a command that is not a commit.
    const payload = JSON.stringify({
      session_id: 'a-completely-different-session',
      cwd: repo.root,
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    execFileSync(process.execPath, [HOOK], { cwd: repo.root, input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect(commitBoundaryRecords(repo)).toHaveLength(1);
    expect(execFileSync('cat', [first[0]], { encoding: 'utf8' })).not.toContain('a-completely-different-session');
  });

  it('fired from a SUBDIRECTORY, the record lands in the project store — not a new one beside it', () => {
    // The hooks resolve their project root from the host's reported working
    // directory, which is wherever the session happened to be standing. They
    // get the upward walk transitively: hook-lib.mjs spawns bin/ideate-record
    // with `cwd: projectRoot`, and the CLI resolves from there. Pinned here
    // because "the hooks do the same from any working directory" is a
    // separate claim from "the binaries do", and only one of them was true
    // before this change.
    const repo = makeRepo();
    const nested = join(repo.root, 'packages', 'thing');
    mkdirSync(nested, { recursive: true });

    const payload = JSON.stringify({
      session_id: 'test-session',
      cwd: nested, // the host reports the SUBDIRECTORY
      tool_input: { command: 'git commit -m "the one real commit"' },
    });
    execFileSync(process.execPath, [HOOK], { cwd: nested, input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

    expect(commitBoundaryRecords(repo)).toHaveLength(1);
    expect(existsSync(join(nested, '.ideate.json'))).toBe(false);
    expect(existsSync(join(nested, '.ideate'))).toBe(false);
  });

  it('the hook exits 0 even when the project has no git repository at all', () => {
    // Hook policy: non-blocking, always exit 0. A commit-shaped command in a
    // directory that is not a repo must not turn into a hook failure.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-no-repo-')));
    tempDirs.push(bare);
    mkdirSync(join(bare, '.ideate', 'record'), { recursive: true });
    writeFileSync(
      join(bare, '.ideate.json'),
      `${JSON.stringify({ schema_version: 10, record: { path: '.ideate/record/' }, backend: 'local' }, null, 2)}\n`,
    );
    const payload = JSON.stringify({ session_id: 's', cwd: bare, tool_input: { command: 'git commit -m x' } });
    expect(() =>
      execFileSync(process.execPath, [HOOK], { cwd: bare, input: payload, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
    ).not.toThrow();
  });
});
