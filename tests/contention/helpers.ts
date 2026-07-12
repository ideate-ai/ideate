// plugin/tests/contention/helpers.ts — shared process-spawn/barrier utilities
// for the WI-304 contention suite.
//
// Every test in this suite drives the work-state contract through the BUILT
// dist modules (P-34 discipline — the same discipline schema.test.ts's
// worker-thread test and telemetry/counters.multiprocess.test.ts's two-real-
// process test already apply), from REAL, SEPARATE OS processes spawned with
// `node:child_process`'s `spawn` — never `node:worker_threads`, never vitest
// forks. Child bodies are written out as plain `.mjs` files (Node cannot
// execute `.ts` without a loader) and imported by the built `dist/work-state/
// *.js` / `dist/cli/ideate-work.js` modules via `file://` URLs, exactly like
// the two precedents above.
//
// Barrier pattern (ported byte-for-byte in spirit from
// telemetry/counters.multiprocess.test.ts, WI-285): every child spins on a
// `goFile`'s existence before doing anything contentious; the parent writes
// the go file only once every child is already spawned and spinning, so the
// race is genuine (all children enter their contended call at once) rather
// than a lucky ordering of sequential process starts.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Absolute path to `plugin/` (this file lives at `plugin/tests/contention/`). */
export const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Absolute path to `plugin/dist/`. */
export const DIST_DIR = join(PLUGIN_DIR, 'dist');

/**
 * Build the plugin (via the project's own `tsc -b`) iff `dist/work-state/
 * store.js` is missing — mirrors the identical bootstrap in
 * telemetry/counters.multiprocess.test.ts and schema.test.ts, so this suite
 * stays self-sufficient when run in isolation, even though the documented
 * order (criterion 8) is `pnpm run build` then the suite.
 */
export function ensureBuilt(): void {
  const marker = join(DIST_DIR, 'work-state', 'store.js');
  if (!existsSync(marker)) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], {
      cwd: PLUGIN_DIR,
      stdio: 'pipe',
    });
  }
}

/** A `file://` URL string for a path relative to `dist/`, for use inside a
 *  generated child script's own `import` statements (children run as plain
 *  Node ESM, so relative specifiers won't resolve from a temp script dir —
 *  every import in a child script must be an absolute `file://` URL). */
export function distUrl(relPathUnderDist: string): string {
  return pathToFileURL(join(DIST_DIR, relPathUnderDist)).href;
}

const tempDirRegistry: string[] = [];

/** A fresh temp directory, tracked for `cleanupTempDirs()`. */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirRegistry.push(dir);
  return dir;
}

/** Remove every temp directory `makeTempDir` has handed out so far. Call
 *  from each test file's own `afterEach`/`afterAll`. */
export function cleanupTempDirs(): void {
  while (tempDirRegistry.length > 0) {
    const dir = tempDirRegistry.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a generated child-process script body (plain ESM `.mjs`) into `dir`
 *  under `name`, returning its absolute path. */
export function writeChildScript(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source, 'utf8');
  return path;
}

/** The lines a child script needs, verbatim, to spin on a `goFile` path
 *  (already bound to a local variable named `goFile` in the child's own
 *  argv-parsing prologue) before doing anything contentious. Requires
 *  `existsSync` to already be imported by the child script. */
export function barrierWaitLines(goFileExpr = 'goFile', timeoutMs = 10_000): string[] {
  return [
    `const __barrierDeadline = Date.now() + ${String(timeoutMs)};`,
    `while (!existsSync(${goFileExpr})) {`,
    `  if (Date.now() > __barrierDeadline) {`,
    `    process.stderr.write('barrier timeout: go file never appeared\\n');`,
    `    process.exit(97);`,
    `  }`,
    `}`,
  ];
}

/** Release a barrier file previously waited on via {@link barrierWaitLines}. */
export function releaseBarrier(goFile: string): void {
  writeFileSync(goFile, 'go', 'utf8');
}

/** Result of one spawned child Node process. */
export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** A running child process handle: the real OS pid (for the afterAll orphan
 *  check), a way to observe stdout lines as they arrive (for barrier-style
 *  cross-process synchronization via printed markers), and the eventual
 *  settled result. */
export interface RunningChild {
  pid: number;
  /** Resolves the first time a line matching `predicate` appears on stdout.
   *  Safe to call before or after the line has already arrived. */
  waitForLine(predicate: (line: string) => boolean, timeoutMs?: number): Promise<string>;
  /** Send a real OS signal to the child (default SIGKILL). */
  kill(signal?: NodeJS.Signals): void;
  /** Resolves once the process has exited. */
  result: Promise<ChildResult>;
}

/** Spawn a real, separate Node OS process running `scriptPath` with `args`.
 *  Never a worker thread, never a vitest fork — `child_process.spawn` against
 *  `process.execPath`, exactly like the WI-285 precedent. */
export function runNodeScript(scriptPath: string, args: readonly string[] = []): RunningChild {
  const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (child.pid === undefined) {
    throw new Error(`failed to spawn child process for ${scriptPath}`);
  }
  const pid = child.pid;

  let stdoutBuf = '';
  let stderrBuf = '';
  const lineWaiters: { predicate: (line: string) => boolean; resolve: (line: string) => void }[] = [];
  const seenLines: string[] = [];
  // The FULL accumulated stdout text, for `ChildResult.stdout` — distinct
  // from `stdoutBuf` below, which is only the not-yet-newline-terminated
  // tail used for incremental line detection. An earlier version of this
  // function returned `stdoutBuf` itself as the settled result's `stdout`,
  // which is empty whenever the child's last write ends in '\n' (the normal
  // case) — every contention test's final JSON.parse of `result.stdout`
  // then failed with "Unexpected end of JSON input". Fixed by accumulating
  // every chunk here, independently of the line-splitting bookkeeping.
  let fullStdout = '';

  function checkWaiters(line: string): void {
    for (let i = lineWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = lineWaiters[i];
      if (waiter !== undefined && waiter.predicate(line)) {
        lineWaiters.splice(i, 1);
        waiter.resolve(line);
      }
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    fullStdout += text;
    stdoutBuf += text;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      seenLines.push(line);
      checkWaiters(line);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  const result = new Promise<ChildResult>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout: fullStdout, stderr: stderrBuf });
    });
  });

  function waitForLine(predicate: (line: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const already = seenLines.find(predicate);
    if (already !== undefined) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = lineWaiters.findIndex((w) => w.predicate === predicate);
        if (idx >= 0) lineWaiters.splice(idx, 1);
        reject(new Error(`timed out waiting for a matching stdout line after ${String(timeoutMs)}ms (seen so far: ${JSON.stringify(seenLines)})`));
      }, timeoutMs);
      lineWaiters.push({
        predicate,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
      });
    });
  }

  return {
    pid,
    waitForLine,
    kill: (signal: NodeJS.Signals = 'SIGKILL') => {
      child.kill(signal);
    },
    result,
  };
}

/**
 * Criterion 7 (machine discipline): verify, with a REAL `ps` invocation, that
 * none of `pids` is still alive. Returns the (empty-on-success) list of pids
 * still found alive, so the caller can both `expect(...).toEqual([])` and
 * print a human-readable report.
 */
export function stillAlivePids(pids: readonly number[]): number[] {
  const alive: number[] = [];
  for (const pid of pids) {
    try {
      // `ps -p <pid>` exits 0 with a matching row iff the process still
      // exists; exits nonzero (throws here) once it's reaped. This is the
      // literal `ps` check criterion 7 asks for — not a `process.kill(pid,
      // 0)` signal probe.
      execFileSync('ps', ['-p', String(pid)], { stdio: 'pipe' });
      alive.push(pid);
    } catch {
      // Not found — reaped, as expected.
    }
  }
  return alive;
}

/** Sleep for real wall-clock time — used ONLY for the short lease windows
 *  this suite's own acceptance criteria call for (orphan-recovery leases,
 *  fencing's post-expiry wait), never as a substitute for barrier
 *  synchronization. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The readiness-handshake barrier this suite uses for genuine N-way races
 * (criterion 1) and cross-process TOCTOU races (criterion 4): every child
 * warms up (imports, opens/probes its own DB connection) BEFORE printing
 * `readyLine`, then spins on `goFile`. Only once every child has printed its
 * ready line does the parent release the barrier — so the contended call
 * genuinely starts for every child within one poll-loop tick of each other,
 * regardless of per-process Node/V8 startup jitter (a plain "write goFile
 * right after spawn", the WI-285 precedent's shape, is not tight enough here:
 * that test's contended operation was a 500-iteration loop that dominates
 * startup jitter; ours is a single sub-millisecond CAS, so startup jitter
 * alone could decide the "race" without this handshake).
 */
export async function synchronizeAndRelease(
  children: readonly RunningChild[],
  goFile: string,
  readyLine = 'READY',
): Promise<void> {
  await Promise.all(children.map((c) => c.waitForLine((line) => line === readyLine)));
  releaseBarrier(goFile);
}
