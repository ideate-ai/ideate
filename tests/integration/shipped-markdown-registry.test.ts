// plugin/tests/integration/shipped-markdown-registry.test.ts — falsifies
// shipped-markdown-registry.ts's shared exclusion mechanism (P-41: a guard
// must carry its own falsification fixtures, proving it fires on an induced
// violation and stays quiet on agreement; P-35: removing the guarded code
// must make these fail).
//
// THE FIXTURE IS INDEPENDENT OF THE GUARDED CODE (P-41's harder bar): every
// fixture below builds its OWN throwaway git repository from scratch (`git
// init` under a fresh temp dir, its own `.gitignore`, its own files) — none
// of it is copied from, or aimed at, `docs/architecture/build/` specifically.
// That proves the PROPERTY (the module excludes whatever git's ignore rules
// currently match, and nothing else) rather than the spelling of this one
// repo's current `build/` entry. The four scanner suites separately prove
// the real-world instance of this (their own registry-equality assertions
// already show `docs/architecture/build/*.md` absent from, and
// `docs/architecture/*.md` present in, their registries against the actual
// plugin tree) — this file proves the underlying module would do the same
// thing for ANY ignore rule, in ANY repo.
//
// THE ORACLE CHOICE THIS FALSIFIES: `git ls-files` (tracked-only) was
// rejected in favor of `git check-ignore` (ignore-rules) specifically
// because the former would hide a real, untracked, not-yet-`git add`-ed new
// document — the exact failure mode the architecture docs suffered while
// still untracked. The second describe block below proves that choice: an
// untracked file that is NOT ignored is still treated as shipped.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { listShippedMarkdownFiles, listShippedMarkdownFilesUnderRoots, SHIPPED_PROSE_ROOTS } from './shipped-markdown-registry.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(base: string, rel: string, content: string): void {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** A fresh, isolated git repository under its own temp dir — never
 *  `docs/architecture`, never anything this plugin ships. `git init` alone
 *  (no commits, no `git add`) is enough for `git check-ignore` to consult
 *  its `.gitignore` files, which is exactly the state this module's oracle
 *  needs to answer from. */
function makeIsolatedGitRepo(): string {
  const base = mkdtempSync(join(tmpdir(), 'shipped-md-registry-test-'));
  tempDirs.push(base);
  execFileSync('git', ['init', '--quiet'], { cwd: base });
  return base;
}

describe('the ignore-rule oracle excludes what git actually ignores, in an independent repo (P-41)', () => {
  it('a file under a path matched by a fresh .gitignore rule is excluded from the shipped walk', () => {
    const base = makeIsolatedGitRepo();
    // Deliberately NOT named "build" — proves the PROPERTY (whatever the
    // repo's ignore rules say), not this project's specific directory name.
    writeFile(base, '.gitignore', 'scratch-output/\n');
    writeFile(base, 'skills/a/SKILL.md', 'a real, shipped skill file');
    writeFile(base, 'skills/a/scratch-output/copy.md', 'a generated copy that should never be governed');

    const files = listShippedMarkdownFiles(base, 'skills');
    expect(files).toContain('skills/a/SKILL.md');
    expect(files).not.toContain('skills/a/scratch-output/copy.md');
  });

  it('a synthetic multi-root walk (mirroring the real scanners\' skills/agents/docs) excludes only the ignored branch', () => {
    const base = makeIsolatedGitRepo();
    writeFile(base, '.gitignore', 'docs/generated/\n');
    writeFile(base, 'skills/x/SKILL.md', 'shipped');
    writeFile(base, 'agents/y.md', 'shipped');
    writeFile(base, 'docs/z.md', 'shipped, not under the ignored branch');
    writeFile(base, 'docs/generated/copy-of-z.md', 'generated, gitignored, must not be governed');

    const files = listShippedMarkdownFilesUnderRoots(base, SHIPPED_PROSE_ROOTS);
    expect(files.sort()).toEqual(['agents/y.md', 'docs/z.md', 'skills/x/SKILL.md'].sort());
  });

  it('a tree with no matching ignore rule at all stays quiet — nothing wrongly excluded', () => {
    const base = makeIsolatedGitRepo();
    writeFile(base, '.gitignore', 'nothing-here-matches/\n');
    writeFile(base, 'skills/a/SKILL.md', 'shipped');
    writeFile(base, 'skills/a/b/nested.md', 'also shipped, just nested');

    const files = listShippedMarkdownFiles(base, 'skills');
    expect(files.sort()).toEqual(['skills/a/SKILL.md', 'skills/a/b/nested.md'].sort());
  });
});

describe('the oracle is ignore-rules, not the tracked-file list — a genuine new, untracked document still ships (the chosen trade-off)', () => {
  it('an untracked file that is NOT ignored is included, even though `git add` was never run on it', () => {
    const base = makeIsolatedGitRepo();
    writeFile(base, '.gitignore', 'build/\n');
    // No `git add`, no commit — this file is exactly as untracked as
    // docs/architecture/*.md were the day they were first written, and as
    // any brand-new doc will be the day it is authored.
    writeFile(base, 'docs/brand-new-doc.md', 'a genuine new source document, never committed');

    const files = listShippedMarkdownFiles(base, 'docs');
    expect(files).toContain('docs/brand-new-doc.md');

    // Falsifies the REJECTED alternative directly: `git ls-files` (tracked
    // only) would NOT see this file at all, proving that oracle is stricter
    // in exactly the wrong direction for this case.
    const tracked = execFileSync('git', ['-C', base, 'ls-files', 'docs'], { encoding: 'utf8' });
    expect(tracked).not.toMatch(/brand-new-doc\.md/);
  });

  it('once that same path becomes actually ignored, it is excluded — the exclusion tracks the RULE, not the git-add state', () => {
    const base = makeIsolatedGitRepo();
    writeFile(base, '.gitignore', 'docs/brand-new-doc.md\n');
    writeFile(base, 'docs/brand-new-doc.md', 'now explicitly ignored by name, still untracked');

    const files = listShippedMarkdownFiles(base, 'docs');
    expect(files).not.toContain('docs/brand-new-doc.md');
  });
});

describe('non-ASCII paths are quoted by git in its default output — the oracle must not be fooled by that (repair for the Andon)', () => {
  it('a file under an ignored directory whose name has non-ASCII bytes is still correctly excluded', () => {
    const base = makeIsolatedGitRepo();
    // `git check-ignore --stdin` (without `-z`) C-quotes any path containing
    // non-ASCII bytes in its OUTPUT — e.g. "café/copy.md" comes back as
    // `"caf\303\251/copy.md"` — which then fails to match this module's own
    // unquoted, unescaped relative paths unless the module reads git's
    // output in a mode that disables that quoting (`-z`). Reproduced live
    // against a real git binary before this fix: without `-z` this file was
    // wrongly kept as "shipped" even though git's ignore rules matched it.
    writeFile(base, '.gitignore', 'café/\n');
    writeFile(base, 'skills/a/SKILL.md', 'a real, shipped skill file');
    writeFile(base, 'skills/a/café/copy.md', 'generated, under a non-ASCII ignored directory name');

    const files = listShippedMarkdownFiles(base, 'skills');
    expect(files).toContain('skills/a/SKILL.md');
    expect(files).not.toContain('skills/a/café/copy.md');
  });

  it('a non-ASCII path that is NOT ignored is still correctly included (the quoting fix does not over-exclude)', () => {
    const base = makeIsolatedGitRepo();
    writeFile(base, '.gitignore', 'nothing-here-matches/\n');
    writeFile(base, 'docs/café/notes.md', 'a genuine shipped doc under a non-ASCII directory name');

    const files = listShippedMarkdownFiles(base, 'docs');
    expect(files).toContain('docs/café/notes.md');
  });
});

describe('git failures other than "no work tree" or "nothing ignored" are reported, not silently swallowed (repair for the Andon)', () => {
  it('a corrupt gitlink (a `.git` FILE pointing at a gitdir that does not exist) throws instead of returning "nothing excluded"', () => {
    const base = mkdtempSync(join(tmpdir(), 'shipped-md-registry-corrupt-'));
    tempDirs.push(base);
    // A real `git init` repo's `.git` is a DIRECTORY; a submodule's is a
    // FILE containing `gitdir: <path>` — the same shape `.git` has in a
    // submodule checkout. Point it at a gitdir that does not exist: git's
    // error for this is `fatal: not a git repository: <path>`, WITHOUT the
    // "(or any of the parent directories)" suffix the genuine "no repo
    // anywhere in the path" case has — this module must tell the two apart
    // rather than treating both as "legitimately no work tree here".
    writeFile(base, '.git', 'gitdir: /nonexistent/path/that/does/not/exist\n');
    writeFile(base, 'skills/a/SKILL.md', 'a real, shipped skill file');

    expect(() => listShippedMarkdownFiles(base, 'skills')).toThrow(/git/i);
  });
});

describe('outside any git work tree, there is no oracle to consult — nothing is excluded (the accepted trade-off for synthetic test trees)', () => {
  it('a plain, non-git temp tree is walked with no exclusion at all', () => {
    const base = mkdtempSync(join(tmpdir(), 'shipped-md-registry-no-git-'));
    tempDirs.push(base);
    // Confirm this tree genuinely has no git authority before trusting the
    // verdict on it — mirrors the discipline every synthetic fixture in the
    // four scanner suites already relies on (os.tmpdir() is never inside a
    // git work tree).
    expect(() => execFileSync('git', ['-C', base, 'rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })).toThrow();

    writeFile(base, 'skills/a/SKILL.md', 'no git here at all');
    writeFile(base, 'skills/a/build/copy.md', 'would be excluded in a real repo, but there is no oracle here');

    const files = listShippedMarkdownFiles(base, 'skills');
    expect(files.sort()).toEqual(['skills/a/SKILL.md', 'skills/a/build/copy.md'].sort());
  });
});

describe('the real plugin tree: generated build output is excluded, genuine source docs are not (P-35 — removing the exclusion breaks this)', () => {
  const PLUGIN_DIR = new URL('../..', import.meta.url).pathname;

  // CREATES the generated file it tests, rather than assuming one is lying
  // around. The first version of this test asserted that
  // `docs/architecture/build/` already existed on disk — which is true only
  // on a machine where someone has run `render.sh`, because that directory is
  // gitignored and never committed. It passed locally and failed on every
  // fresh checkout, taking CI red on the release candidate (finding
  // 01KZCRBGT2QTVJF3BNTSCD9S1V). A test written to prove generated output is
  // excluded must not depend on that output happening to be present; it makes
  // its own, and cleans up only what it made.
  it('a generated file under docs/architecture/build/ is excluded from the shipped walk', () => {
    const buildDir = join(PLUGIN_DIR, 'docs/architecture/build');
    const probe = join(buildDir, 'coordinator-probe.md');
    const dirPreexisted = existsSync(buildDir);
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(probe, '# probe\n\nGenerated output. Must never be governed by the prose censuses.\n');
    try {
      const files = listShippedMarkdownFiles(PLUGIN_DIR, 'docs');
      expect(files).not.toContain('docs/architecture/build/coordinator-probe.md');
      expect(files.filter((f) => f.startsWith('docs/architecture/build/'))).toEqual([]);
    } finally {
      rmSync(probe, { force: true });
      // Only remove the directory if this test created it — on a developer
      // machine it holds a real rendered PDF pipeline that is not ours to bin.
      if (!dirPreexisted) rmSync(buildDir, { recursive: true, force: true });
    }
  });

  it('the six architecture source docs are present on disk AND governed by the shipped walk', () => {
    const files = listShippedMarkdownFiles(PLUGIN_DIR, 'docs');
    for (const doc of [
      '00-overview.md',
      '01-process-record.md',
      '02-delegation-board.md',
      '03-steering.md',
      '04-transports-and-infra.md',
      '05-usage-audit.md',
    ]) {
      expect(files).toContain(`docs/architecture/${doc}`);
    }
  });
});
