#!/usr/bin/env node
// plugin/scripts/fresh-copy-check.mjs — the FRESH-COPY CHECK.
//
// This is the central standalone-verification criterion: it copies the
// plugin directory to a temp location with NO surrounding workspace context
// whatsoever (no parent package.json, no pnpm-workspace.yaml, no parent
// pnpm-lock.yaml — none of those live inside the copied subtree, so a plain
// recursive copy already omits them), then runs `pnpm install` + build +
// test THERE, and asserts all three are green.
//
// Why this exists: this package is meant to stand entirely on its own. This
// script is the mechanical proof that it does — it proves the claim by
// exercising it, not by inspection.
//
// Portability requirement: this script locates the plugin directory
// RELATIVE TO ITSELF (one directory up from wherever it lives — `scripts/`
// or `tests/`) and never references any path outside the package. That is
// what lets it run unchanged as `node scripts/fresh-copy-check.mjs` or
// `pnpm test:fresh-copy`, with "one directory up" being simply the repo
// root.
//
// The temp copy has no lockfile entry for any enclosing workspace, so a
// plain `pnpm install` (NOT --frozen-lockfile) is correct there — pnpm
// generates a fresh, self-contained lockfile for the standalone copy.
//
// Excludes from the copy: node_modules, dist, and any .tsbuildinfo files —
// none of those may leak stale built state into the fresh install.
//
// A throwaway `git init` in the copy, before the test step: the suite run
// in phase 1 below includes tests/integration/shipped-markdown-registry.ts's
// scanners, which decide what counts as "shipped" markdown by asking git's
// ignore rules (`git check-ignore`) — the mechanism that keeps
// `docs/architecture/build/`'s generated copies out of the governed set.
// That oracle needs a git work tree to consult; this copy has none, because
// `.git` is excluded above (in a submodule checkout it is a gitlink FILE
// pointing at the parent repository's modules directory — exactly the kind
// of enclosing-layout reference this fresh copy must not carry). Without
// SOME repository here, the registry module's own fail-loud guard would
// (correctly) throw rather than silently widen what it governs. `git init`
// creates a new, self-contained repository with no reference to anything
// outside the copied subtree — it satisfies the oracle's precondition
// without reintroducing what excluding `.git` guards against. The copy
// already carries every `.gitignore` file the oracle reads (a plain
// recursive copy includes them; they are ordinary tracked-content files,
// not special git-internal state), so a bare `git init` — no `add`, no
// `commit` — is enough for `git check-ignore` to answer correctly.
//
// The check also exercises at least one no-build path: after the
// install -> build -> test cycle above passes (phase 1, the "built" proof),
// this script deletes dist/ and any *.tsbuildinfo files from the fresh copy
// and re-runs the composition boot test file alone (phase 2, the "no-build"
// proof). That test's own beforeAll lazily rebuilds dist/ by invoking the
// package-local tsc directly (see tests/composition/server-boot.test.ts) —
// phase 2 is what proves that lazy rebuild finds its tsc from a truly clean
// state, with no parent repository to fall back on. PASS requires both
// phases to be green; either failing fails the whole script.
//
// On failure the temp copy is LEFT IN PLACE for debugging (its path is
// printed) instead of being cleaned up; on success it is removed unless
// KEEP_FRESH_COPY=1 is set in the environment.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** The directory to prove stands alone — one level up from this script. */
const pluginDir = join(scriptDir, '..');

/**
 * Never copy these, wherever they occur in the tree. '.git' matters in a
 * submodule checkout, where it is a gitlink FILE pointing at a parent
 * repo's modules dir — exactly the kind of enclosing-layout reference the
 * fresh copy must not carry.
 */
const EXCLUDED_NAMES = new Set(['node_modules', 'dist', '.git']);
// Note: today the only *.tsbuildinfo lives at dist/.tsbuildinfo (single
// composite project), so the recursive sweep below is future-proofing for
// a project-references split, not a guard against a present multi-file
// case.

function shouldExclude(path) {
  const name = basename(path);
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.endsWith('.tsbuildinfo')) return true;
  return false;
}

/**
 * Recursively delete every `dist` directory and every `*.tsbuildinfo` file
 * found under `root`, wherever they occur — the no-build phase must start
 * from a state with zero built/incremental-build artifacts, not just the
 * top-level dist/.
 */
function removeBuildArtifacts(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue; // never descend into deps
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist') {
        rmSync(full, { recursive: true, force: true });
        continue;
      }
      removeBuildArtifacts(full);
    } else if (entry.isFile() && entry.name.endsWith('.tsbuildinfo')) {
      rmSync(full, { force: true });
    }
  }
}

function run(label, command, args, cwd) {
  console.log(`\n=== fresh-copy-check: ${label} (${command} ${args.join(' ')}) ===`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) {
    console.error(`fresh-copy-check: ${label} failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`fresh-copy-check: ${label} exited with code ${String(result.status)}`);
    return false;
  }
  return true;
}

function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'ideate-plugin-fresh-copy-'));
  const copyDir = join(tempRoot, 'plugin');
  mkdirSync(copyDir, { recursive: true });

  console.log(`fresh-copy-check: copying ${pluginDir} -> ${copyDir}`);
  cpSync(pluginDir, copyDir, {
    recursive: true,
    filter: (src) => !shouldExclude(src),
  });

  // A throwaway, self-contained git repository — see the header comment for
  // why this is required (the shipped-markdown-registry's ignore-rule
  // oracle needs SOME work tree to consult) and why it is safe (no `.git`
  // was copied, so there is nothing enclosing to reintroduce). No `add`, no
  // `commit`: `git check-ignore` reads `.gitignore` files straight off disk,
  // it does not need anything staged or committed.
  console.log('fresh-copy-check: git init-ing the fresh copy (throwaway, self-contained — no enclosing reference)');
  const gitInitResult = spawnSync('git', ['init', '--quiet'], { cwd: copyDir, stdio: 'inherit', shell: false });
  if (gitInitResult.error || gitInitResult.status !== 0) {
    console.error(`fresh-copy-check: git init failed in the fresh copy: ${gitInitResult.error?.message ?? `exit ${String(gitInitResult.status)}`}`);
    process.exitCode = 1;
    return;
  }

  // scripts/migrate-v2 is a workspace member (pnpm-workspace.yaml +
  // package.json#workspaces), so the single top-level `pnpm install` below
  // reaches its deps (js-yaml) too — no separate install step needed. A
  // committed test executes migrate.mjs and parses the same YAML with that
  // package's own js-yaml as an INDEPENDENT oracle (P-40b); workspace
  // membership satisfies P-40a's fresh-clone clause without weakening that
  // independence — migrate.mjs's logic is still never imported by the test.
  const steps = [
    ['install', 'pnpm', ['install']],
    ['build', 'pnpm', ['run', 'build']],
    ['test', 'pnpm', ['run', 'test']],
  ];

  let ok = true;
  for (const [label, command, args] of steps) {
    if (!run(label, command, args, copyDir)) {
      ok = false;
      break;
    }
  }

  if (!ok) {
    console.error(`\nfresh-copy-check: FAILED (phase 1: install/build/test). Fresh copy left in place for debugging: ${copyDir}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nfresh-copy-check: phase 1 (install, build, test) PASSED with no surrounding workspace context.');

  // Phase 2 (no-build proof): strip every dist/ and *.tsbuildinfo
  // from the fresh copy, then re-run the composition boot test alone. Its
  // own beforeAll lazily rebuilds dist/ via the package-local tsc — this is
  // the truly-clean-state exercise of that path.
  console.log('\nfresh-copy-check: phase 2 — deleting dist/ and *.tsbuildinfo, then re-running the boot test with NO prior build');
  removeBuildArtifacts(copyDir);

  const noBuildOk = run(
    'no-build boot test',
    'pnpm',
    ['exec', 'vitest', 'run', 'tests/composition/server-boot.test.ts'],
    copyDir,
  );

  if (!noBuildOk) {
    console.error(`\nfresh-copy-check: FAILED (phase 2: no-build boot test). Fresh copy left in place for debugging: ${copyDir}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nfresh-copy-check: PASSED — phase 1 (install, build, test) and phase 2 (no-build lazy-rebuild boot test) both green with no surrounding workspace context.');
  if (process.env['KEEP_FRESH_COPY'] === '1') {
    console.log(`fresh-copy-check: KEEP_FRESH_COPY=1 set; leaving fresh copy at ${copyDir}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exitCode = 0;
}

main();
