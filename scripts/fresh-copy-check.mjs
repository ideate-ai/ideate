#!/usr/bin/env node
// plugin/scripts/fresh-copy-check.mjs — the P-34 FRESH-COPY TEST.
//
// This is the phase's central verification criterion: it copies the plugin
// directory to a temp location with NO monorepo context whatsoever (no root
// package.json, no pnpm-workspace.yaml, no root pnpm-lock.yaml — none of
// those live inside the copied subtree, so a plain recursive copy already
// omits them), then runs `pnpm install` + build + test THERE, and asserts
// all three are green.
//
// Why this exists: plugin/ is meant to become its own standalone repo. This
// script is the mechanical proof that it already stands alone — it proves
// the claim by exercising it, not by inspection (P-34: verification boots/
// exercises the shipped artifact).
//
// Portability requirement: this script locates the plugin directory
// RELATIVE TO ITSELF (one directory up from wherever it lives — `scripts/`
// or `tests/`) and never references any other monorepo path. That is what
// lets it run unchanged:
//   (a) from inside this monorepo, invoked as
//       `node plugin/scripts/fresh-copy-check.mjs` or
//       `pnpm --filter @ideate/plugin test:fresh-copy`, and
//   (b) later, inside the split standalone repo, where this same script
//       becomes that repo's CI backbone and "one directory up" is simply
//       the repo root.
//
// The temp copy has no lockfile entry for a workspace it is no longer part
// of, so a plain `pnpm install` (NOT --frozen-lockfile) is correct there —
// pnpm generates a fresh, self-contained lockfile for the standalone copy.
//
// Excludes from the copy: node_modules, dist, and any .tsbuildinfo files —
// none of those may leak stale monorepo-built state into the fresh install.
//
// P-40(a) — proofs must exercise at least one no-build path: after the
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
 * fresh copy must not carry (P-36/P-40(c)).
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

  console.log('\nfresh-copy-check: phase 1 (install, build, test) PASSED with no monorepo context.');

  // Phase 2 (P-40(a) no-build proof): strip every dist/ and *.tsbuildinfo
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

  console.log('\nfresh-copy-check: PASSED — phase 1 (install, build, test) and phase 2 (no-build lazy-rebuild boot test) both green with no monorepo context.');
  if (process.env['KEEP_FRESH_COPY'] === '1') {
    console.log(`fresh-copy-check: KEEP_FRESH_COPY=1 set; leaving fresh copy at ${copyDir}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
  process.exitCode = 0;
}

main();
