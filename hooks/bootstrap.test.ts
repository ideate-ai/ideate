// hooks/bootstrap.test.ts — behavioral tests for the first-launch bootstrap.
//
// bootstrap.sh must (re)build only when needed and never run stale output. It's
// POSIX sh, so these tests spawn it in a temp CLAUDE_PLUGIN_ROOT with a FAKE
// `npm` on PATH (records its calls; fabricates dist/ + node_modules) so a full
// npm install/tsc build never runs — the tests assert the DECISION (fast-path
// vs rebuild vs fail) deterministically, not a real build.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const NODE_DIR = dirname(process.execPath); // the real node, for cases that need it
const tmps: string[] = [];

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** A temp plugin root with the minimal shape bootstrap inspects. */
function makeRoot(opts: { built?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ideate-bootstrap-'));
  tmps.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'package.json'), '{"name":"t","version":"0.0.0"}\n');
  writeFileSync(join(root, 'tsconfig.json'), '{}\n');
  if (opts.built) {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'server.js'), '// built\n');
    mkdirSync(join(root, 'node_modules', '@modelcontextprotocol'), { recursive: true });
  }
  return root;
}

/**
 * Force relative freshness by pinning EVERY input bootstrap compares. Pinning
 * only some leaves the rest at their sub-ms creation time, which can round
 * newer than dist/ and flip the decision — so set all three sources together.
 */
function setFreshness(root: string, fresh: boolean): void {
  const now = Date.now() / 1000;
  const distT = fresh ? now + 60 : now - 60;
  const srcT = fresh ? now - 60 : now + 60;
  utimesSync(join(root, 'dist', 'server.js'), distT, distT);
  // Pin the src DIRECTORY too — find stats it, and a same-instant dir rounds newer.
  for (const s of ['src', 'src/index.ts', 'package.json', 'tsconfig.json']) {
    utimesSync(join(root, s), srcT, srcT);
  }
}

/** A fake `npm` that logs its args and fabricates the build outputs in cwd. */
function fakeNpmBin(): string {
  const bin = mkdtempSync(join(tmpdir(), 'ideate-fakebin-'));
  tmps.push(bin);
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> ./.npm-calls\nmkdir -p ./node_modules/@modelcontextprotocol ./dist\n: > ./dist/server.js\nexit 0\n',
  );
  chmodSync(join(bin, 'npm'), 0o755);
  return bin;
}

/**
 * A fake `node` + `npm` pair for the too-old-Node path. `node -v` reports the
 * given version; `node -e '…version gate…'` exits 1 when `tooOld` is set (the
 * signal bootstrap uses to detect <22.5). `npm` is the same fabricating fake
 * as {@link fakeNpmBin} so a build must NOT fire (the gate rejects before it).
 */
function fakeNodeAndNpmBin(opts: { nodeVersion: string; tooOld: boolean }): string {
  const bin = mkdtempSync(join(tmpdir(), 'ideate-fakebin-'));
  tmps.push(bin);
  const gateExit = opts.tooOld ? 1 : 0;
  writeFileSync(
    join(bin, 'node'),
    `#!/bin/sh\nif [ "$1" = "-v" ]; then echo "${opts.nodeVersion}"; exit 0; fi\nif [ "$1" = "-e" ]; then exit ${String(gateExit)}; fi\nexit 0\n`,
  );
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> ./.npm-calls\nmkdir -p ./node_modules/@modelcontextprotocol ./dist\n: > ./dist/server.js\nexit 0\n',
  );
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'npm'), 0o755);
  return bin;
}

function run(root: string, path: string): { status: number | null; stderr: string; npmCalled: boolean } {
  const r = spawnSync('sh', [BOOTSTRAP], {
    cwd: root,
    env: { CLAUDE_PLUGIN_ROOT: root, PATH: path, HOME: root },
    encoding: 'utf8',
    timeout: 20_000,
  });
  const callsFile = join(root, '.npm-calls');
  return {
    status: r.status,
    stderr: r.stderr ?? '',
    npmCalled: existsSync(callsFile) && readFileSync(callsFile, 'utf8').trim().length > 0,
  };
}

const withNode = (extra: string) => `${extra}:${NODE_DIR}:/usr/bin:/bin`;

describe('bootstrap.sh', () => {
  it('fast-paths (no build) when already built and current', () => {
    const root = makeRoot({ built: true });
    setFreshness(root, true);
    const bin = fakeNpmBin();
    const res = run(root, withNode(bin));
    expect(res.status).toBe(0);
    expect(res.npmCalled).toBe(false); // did NOT rebuild
  });

  it('REBUILDS when a source file is newer than dist/ (staleness after an update)', () => {
    const root = makeRoot({ built: true });
    setFreshness(root, false); // src newer than dist/server.js
    const bin = fakeNpmBin();
    const res = run(root, withNode(bin));
    expect(res.status).toBe(0);
    expect(res.npmCalled).toBe(true); // rebuilt despite dist/ existing
  });

  it('builds when dist/ is absent (fresh install) — runs install THEN build', () => {
    const root = makeRoot({ built: false });
    const bin = fakeNpmBin();
    const res = run(root, withNode(bin));
    expect(res.status).toBe(0);
    expect(res.npmCalled).toBe(true);
    expect(existsSync(join(root, 'dist', 'server.js'))).toBe(true);
    // The clean-build sequence is the full shipped path: `npm install` then
    // `npm run build` (the bootstrap a user's first launch runs). The fake
    // npm records every invocation's args, so assert both steps fired.
    const calls = readFileSync(join(root, '.npm-calls'), 'utf8').trim().split('\n');
    expect(calls.some((c) => /^install\b/.test(c))).toBe(true);
    expect(calls.some((c) => /^run build/.test(c))).toBe(true);
  });

  it('prints actionable guidance and does NOT build when Node is absent', () => {
    const root = makeRoot({ built: false });
    const bin = fakeNpmBin();
    // PATH without the real node dir.
    const res = run(root, `${bin}:/usr/bin:/bin`);
    expect(res.status).toBe(0); // never blocks
    expect(res.stderr).toMatch(/Node\.js was not found|requires Node/i);
    expect(res.npmCalled).toBe(false);
  });

  it('prints actionable guidance and does NOT build when Node is too old (<22.5)', () => {
    const root = makeRoot({ built: false });
    const bin = fakeNodeAndNpmBin({ nodeVersion: 'v18.0.0', tooOld: true });
    const res = run(root, `${bin}:/usr/bin:/bin`);
    expect(res.status).toBe(0); // never blocks
    expect(res.stderr).toMatch(/too old|requires Node/i);
    expect(res.npmCalled).toBe(false);
  });

  it('reclaims a DEAD builder\'s lock and rebuilds (no wedge)', () => {
    const root = makeRoot({ built: false });
    // A lock left by a crashed builder: a pid that is not alive.
    mkdirSync(join(root, '.bootstrap.lock'));
    writeFileSync(join(root, '.bootstrap.lock', 'pid'), '2147483647\n'); // implausible, dead
    const bin = fakeNpmBin();
    const res = run(root, withNode(bin));
    expect(res.status).toBe(0);
    expect(res.npmCalled).toBe(true); // reclaimed and built rather than waiting forever
  });
});
