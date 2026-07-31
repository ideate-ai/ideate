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

/**
 * Wall-clock budgets for ONE bootstrap.sh invocation, in ms.
 *
 * These are fail-fast guards against a WEDGED script, not performance
 * assertions. Measured on this suite's own machine (Apple silicon, macOS 25.5,
 * Node 24) against the fake npm these tests put on PATH — no real `npm install`
 * or `tsc` ever runs here, so an invocation is cheap and barely moves under
 * load:
 *   - idle:                                     p50 124ms  p95 138ms  max 173ms  (n=40)
 *   - under 3 CONCURRENT full suites (12 forks, including the ~105-process CLI
 *     paging tests):                            p50 180ms  p95 301ms  max 329ms  (n=60)
 *
 * BUILD_BUDGET_MS is ~60x the worst loaded invocation observed, and is kept
 * BOUNDED rather than raised further on purpose: the only legitimately slow
 * path in bootstrap.sh is its wait-for-a-live-builder loop (sleep 2, capped at
 * 900s), which no case here exercises. If a case ever reaches that loop, that
 * IS the defect, and this file should say so in seconds rather than minutes.
 *
 * DECISION_BUDGET_MS covers the cases that decide NOT to build (fast path, Node
 * absent, Node too old). They do strictly less work than the build cases, so
 * they keep a tighter budget and still fail fast if they ever start building.
 *
 * If you landed here from a timeout: read the failure message BEFORE touching
 * these numbers — it names the actual cause (timeout vs signal vs spawn
 * failure). Re-tightening or re-loosening a bare guess is how the previous
 * hard-coded 20s reported every environmental kill as a bootstrap.sh bug.
 */
const BUILD_BUDGET_MS = 20_000;
const DECISION_BUDGET_MS = 10_000;

/**
 * Spawn bootstrap.sh against `root`, and REQUIRE that the child actually ran to
 * completion and reported an exit code.
 *
 * spawnSync yields `status: null` whenever the child never exited on its own:
 * killed by our own `timeout` (error.code ETIMEDOUT; the accompanying signal
 * varies — SIGTERM or SIGPIPE, both observed), killed by someone else's signal
 * (e.g. macOS jetsam under memory pressure — signal set, no error), or never
 * spawned at all (error.code ENOENT/EAGAIN/ENOMEM, which a
 * box out of process slots can produce and which the 4-fork suite's
 * process-heavy files push toward). NONE of those is evidence about
 * bootstrap.sh's DECISION — but the previous version passed the null straight
 * into `expect(res.status).toBe(0)`, which blamed the script with
 * `expected null to be +0` and taught readers to wave the failure through.
 *
 * So a non-completion throws HERE, naming what actually happened; only a real
 * exit code reaches the caller. A genuine bootstrap failure still arrives as a
 * non-zero `status` and still fails the caller's assertion normally.
 */
function run(
  root: string,
  path: string,
  budgetMs: number = BUILD_BUDGET_MS,
): { status: number; stderr: string; npmCalled: boolean } {
  const r = spawnSync('sh', [BOOTSTRAP], {
    cwd: root,
    env: { CLAUDE_PLUGIN_ROOT: root, PATH: path, HOME: root },
    encoding: 'utf8',
    timeout: budgetMs,
  });
  if (r.status === null) {
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    const why =
      code === 'ETIMEDOUT'
        ? `TIMED OUT after ${String(budgetMs)}ms and was killed (${r.signal ?? 'no signal'}) — it never reported an exit code, so this says NOTHING about the script's decision. Either bootstrap.sh wedged, or this machine is far slower/more loaded than the measured envelope above.`
        : code !== undefined
          ? `FAILED TO SPAWN (${code}) — the machine could not start the child (process/memory exhaustion, or 'sh' is missing). Not a bootstrap.sh failure.`
          : `was KILLED by ${r.signal ?? 'an unknown signal'} before exiting — not a bootstrap.sh failure.`;
    throw new Error(`bootstrap.sh did not complete: it ${why}\nstderr: ${r.stderr ?? ''}`);
  }
  const callsFile = join(root, '.npm-calls');
  return {
    status: r.status,
    stderr: r.stderr ?? '',
    npmCalled: existsSync(callsFile) && readFileSync(callsFile, 'utf8').trim().length > 0,
  };
}

const withNode = (extra: string) => `${extra}:${NODE_DIR}:/usr/bin:/bin`;

/**
 * retry: 1 buys exactly one re-attempt against the environmental non-completions
 * described on {@link run} (a killed or unspawnable child), which are noise
 * about this machine rather than facts about bootstrap.sh.
 *
 * It is deliberately at the CASE level, not inside run(): a killed invocation
 * can leave the temp root half-built (a reclaimed lock dir, a partial
 * .npm-calls, a fabricated dist/), so re-running the spawn in place would test a
 * DIFFERENT scenario than the one named. Retrying the case re-enters makeRoot()
 * and rebuilds the fixture from scratch, so attempt 2 asserts the same thing
 * attempt 1 did.
 *
 * This cannot mask a real defect: a wedged or genuinely failing bootstrap.sh
 * fails both attempts, and the second failure is what gets reported.
 */
describe('bootstrap.sh', { retry: 1 }, () => {
  it('fast-paths (no build) when already built and current', () => {
    const root = makeRoot({ built: true });
    setFreshness(root, true);
    const bin = fakeNpmBin();
    const res = run(root, withNode(bin), DECISION_BUDGET_MS); // decides not to build
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
    const res = run(root, `${bin}:/usr/bin:/bin`, DECISION_BUDGET_MS); // rejects before any build
    expect(res.status).toBe(0); // never blocks
    expect(res.stderr).toMatch(/Node\.js was not found|requires Node/i);
    expect(res.npmCalled).toBe(false);
  });

  it('prints actionable guidance and does NOT build when Node is too old (<22.5)', () => {
    const root = makeRoot({ built: false });
    const bin = fakeNodeAndNpmBin({ nodeVersion: 'v18.0.0', tooOld: true });
    const res = run(root, `${bin}:/usr/bin:/bin`, DECISION_BUDGET_MS); // rejects before any build
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
