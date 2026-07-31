// plugin/src/version-consistency.test.ts — the shipped version, stated in
// several places, checked against ONE source of truth instead of being
// hand-reconciled.
//
// WHY this file exists: the 3.0.1 bump had to update the version by hand in
// seven places across five files, and nothing bound them. The failure mode is
// not cosmetic — the marketplace listing can advertise a version the running
// server denies, or an install can report a version that does not match the
// manifest Claude Code actually read. SERVER_VERSION's own comment already
// said "mirrored from .claude-plugin/plugin.json": a mirror with no check.
// This is that check (P-52: an enumeration of a shipped set is verified
// against its source, never hand-maintained; GP-24: the promise about code
// shape fails the build when the shape drifts).
//
// SOURCE OF TRUTH: `.claude-plugin/plugin.json`.
//   It is the manifest Claude Code reads to install the plugin, so it is the
//   version a user actually ends up running — every other statement is a copy
//   made for some other consumer (npm tooling, the marketplace listing, the
//   MCP handshake). `package.json` was the alternative (it is what `npm
//   version` writes), but npm publishing is not ratified for this package
//   (`"private": true`), so its version is downstream of the plugin manifest
//   rather than the other way round. Consequence worth stating: `npm version`
//   would update package.json ALONE and this suite would go red until the
//   plugin manifest follows — which is the intended behaviour, not a bug.
//
// NO VERSION LITERAL LIVES IN THIS FILE. A test asserting the current version
// by hand would be one more copy to maintain — the exact defect. Every
// expectation is derived from the source of truth, and the final test
// mechanically re-checks that this file stays literal-free.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SERVER_VERSION } from './server.js';

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));

function readJson(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, ...segments), 'utf8')) as Record<string, unknown>;
}

/** The one version every other surface must agree with. */
const SOURCE_OF_TRUTH = readJson('.claude-plugin', 'plugin.json')['version'];

describe('the shipped version agrees across every surface that states it', () => {
  it('the source of truth (.claude-plugin/plugin.json) states a real semver', () => {
    // Without this, a missing/renamed key would read `undefined` and every
    // comparison below would pass by matching nothing against nothing.
    expect(SOURCE_OF_TRUTH).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
  });

  it('package.json matches — what npm tooling and the fresh-copy install read', () => {
    expect(readJson('package.json')['version']).toBe(SOURCE_OF_TRUTH);
  });

  it('marketplace.json matches in BOTH places — the listing metadata and the plugin entry', () => {
    // Two independent occurrences in one file; the 3.0.1 bump had to touch
    // both by hand. The entry is located by name rather than by index so a
    // reordering (or a second plugin arriving) cannot make this vacuous.
    const marketplace = readJson('.claude-plugin', 'marketplace.json');
    const pluginName = readJson('.claude-plugin', 'plugin.json')['name'];

    expect((marketplace['metadata'] as Record<string, unknown>)['version']).toBe(SOURCE_OF_TRUTH);

    const entries = marketplace['plugins'] as Array<Record<string, unknown>>;
    const entry = entries.find((candidate) => candidate['name'] === pluginName);
    expect(entry, `marketplace.json has no plugins entry named ${String(pluginName)}`).toBeDefined();
    expect(entry?.['version']).toBe(SOURCE_OF_TRUTH);
  });

  it('SERVER_VERSION matches — the version the running MCP server reports over the wire', () => {
    // The imported symbol, not a regex over server.ts: what the server
    // actually hands to the MCP handshake is what gets compared.
    expect(SERVER_VERSION).toBe(SOURCE_OF_TRUTH);
  });

  it("package-lock.json matches on the package's OWN entries only — never a dependency's", () => {
    // The trap: the lockfile states this package's version twice AND states
    // the same version string for an unrelated transitive dependency
    // (ajv-formats happens to sit on the same number today). A naive text
    // match would bind that dependency's version to ours and go red on an
    // unrelated `npm update`. So the entries are addressed STRUCTURALLY, by
    // the keys that belong to this package, and the identity of each entry is
    // re-checked against package.json's name before it is trusted.
    const lock = readJson('package-lock.json');
    const packageName = readJson('package.json')['name'];
    const packages = lock['packages'] as Record<string, Record<string, unknown>>;

    expect(lock['name']).toBe(packageName);
    expect(lock['version']).toBe(SOURCE_OF_TRUTH);

    const root = packages[''];
    expect(root, 'package-lock.json has no root ("") package entry').toBeDefined();
    expect(root?.['name']).toBe(packageName);
    expect(root?.['version']).toBe(SOURCE_OF_TRUTH);

    // Present only if this package is ever installed into its own tree (e.g.
    // as a workspace link). Checked when it exists so a future layout change
    // does not quietly drop a surface; absent today, and absence is fine.
    const selfLink = packages[`node_modules/${String(packageName)}`];
    if (selfLink !== undefined) {
      expect(selfLink['version']).toBe(SOURCE_OF_TRUTH);
    }
  });

  it('the enclosing monorepo root package.json matches, WHEN this package is checked out inside it', () => {
    // DECISION on the root package.json (which is outside this package): it
    // is covered, but conditionally — because it is not always there.
    // scripts/fresh-copy-check.mjs copies this directory alone into a temp
    // dir with no surrounding workspace, so a test that unconditionally
    // reached up and out would fail the standalone proof, and the public
    // plugin repo has no monorepo root at all. So: detect the monorepo root
    // (a sibling package.json AND the pnpm-workspace.yaml that declares this
    // package — both, so an unrelated parent package cannot be mistaken for
    // it) and assert it when found. Where it is genuinely absent there is
    // nothing to drift from, and the test says so rather than omitting it.
    const rootPackageJson = join(PLUGIN_DIR, '..', 'package.json');
    const workspaceDecl = join(PLUGIN_DIR, '..', 'pnpm-workspace.yaml');
    const insideMonorepo = existsSync(rootPackageJson) && existsSync(workspaceDecl);

    if (!insideMonorepo) {
      // Standalone checkout or fresh copy: no root to reconcile.
      expect(insideMonorepo).toBe(false);
      return;
    }

    const root = JSON.parse(readFileSync(rootPackageJson, 'utf8')) as Record<string, unknown>;
    expect(root['version']).toBe(SOURCE_OF_TRUTH);
  });

  it('this test file itself carries no version literal — the guard cannot become an extra copy', () => {
    // P-41: the guard gets its own guard. If someone "fixes" a red run by
    // pasting the new version in here, this bites. Quoted semver-shaped
    // strings are banned outright, comments included, to keep the rule
    // simple enough to be obvious.
    const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const literals = ownSource.match(/['"`]\d+\.\d+\.\d+[^'"`]*['"`]/g) ?? [];
    expect(literals).toEqual([]);
  });
});
