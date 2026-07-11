// plugin/src/telemetry/counters.multiprocess.test.ts — a REAL two-OS-process
// append race over one telemetry state dir (WI-285).
//
// counters.ts claims its appends are single atomic O_APPEND writes, so two
// concurrent PROCESSES never corrupt the state. The in-process interleaving
// test in counters.test.ts cannot prove that — it never leaves one process.
// This test spawns two child Node processes that hold at a filesystem
// barrier, released together, and each append N events to the SAME state
// file through the real compiled TelemetryCounters; the fold must then see
// exactly 2N events with zero skipped (torn/corrupt) lines. This makes the
// "race-tested with two real processes" claim (commit 50804e5) true going
// forward.
//
// Kept fork-cap friendly: one test, two short-lived children, well under 10s.

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TELEMETRY_FILE } from './counters.js';
import { reportFromDir } from './report.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const DIST_COUNTERS = join(PLUGIN_DIR, 'dist', 'telemetry', 'counters.js');

const EVENTS_PER_WRITER = 500;
const CAPTURE_POINT = 'multiprocess_race';

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  // The children import the compiled library (plain Node cannot load .ts).
  // Build incrementally if dist is absent, exactly like the CLI smoke test
  // in counters.test.ts — documented order is `pnpm build` then `pnpm test`,
  // this only keeps the test self-sufficient when run in isolation.
  if (!existsSync(DIST_COUNTERS)) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], {
      cwd: PLUGIN_DIR,
      stdio: 'pipe',
    });
  }
}, 120_000);

/**
 * The child writer: spins at a filesystem barrier (`goFile`), then appends
 * `count` capture_fired events through the REAL TelemetryCounters. The
 * barrier means both children enter their append loops together — a genuine
 * cross-process race, not two sequential runs that happen to share a file.
 */
function childScriptSource(): string {
  return [
    `import { existsSync } from 'node:fs';`,
    `import { TelemetryCounters } from ${JSON.stringify(pathToFileURL(DIST_COUNTERS).href)};`,
    ``,
    `const [stateDir, goFile, sessionId, countArg] = process.argv.slice(2);`,
    `const deadline = Date.now() + 10_000;`,
    `while (!existsSync(goFile)) {`,
    `  if (Date.now() > deadline) {`,
    `    process.stderr.write('barrier timeout: go file never appeared');`,
    `    process.exit(1);`,
    `  }`,
    `}`,
    `const telemetry = new TelemetryCounters(stateDir, () => new Date());`,
    `// counters.ts drops failed appends with an async process warning instead`,
    `// of throwing; a drop would silently shrink the count, so surface any`,
    `// warning as a nonzero exit (the listener fires before the process exits).`,
    `process.on('warning', (warning) => {`,
    `  process.stderr.write('telemetry warning: ' + warning.message + '\\n');`,
    `  process.exitCode = 2;`,
    `});`,
    `const count = Number(countArg);`,
    `for (let i = 0; i < count; i += 1) {`,
    `  telemetry.captureFired(${JSON.stringify(CAPTURE_POINT)}, sessionId);`,
    `}`,
    ``,
  ].join('\n');
}

interface ChildResult {
  code: number | null;
  stderr: string;
}

function runWriter(
  scriptPath: string,
  stateDir: string,
  goFile: string,
  sessionId: string,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [scriptPath, stateDir, goFile, sessionId, String(EVENTS_PER_WRITER)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('two real OS processes racing appends into one state dir', () => {
  it(
    `folds exactly ${2 * EVENTS_PER_WRITER} events with zero loss or corruption`,
    async () => {
      const stateDir = makeTempDir('ideate-telemetry-mp-state-');
      const workDir = makeTempDir('ideate-telemetry-mp-work-');
      const scriptPath = join(workDir, 'writer.mjs');
      const goFile = join(workDir, 'go');
      writeFileSync(scriptPath, childScriptSource(), 'utf8');

      // Launch BOTH children before releasing the barrier: each spins on the
      // go file, so both append loops start together and genuinely interleave.
      const writerA = runWriter(scriptPath, stateDir, goFile, 'sess-mp-A');
      const writerB = runWriter(scriptPath, stateDir, goFile, 'sess-mp-B');
      writeFileSync(goFile, 'go', 'utf8');

      const [resultA, resultB] = await Promise.all([writerA, writerB]);
      expect(resultA, `writer A stderr: ${resultA.stderr}`).toMatchObject({ code: 0 });
      expect(resultB, `writer B stderr: ${resultB.stderr}`).toMatchObject({ code: 0 });

      // The dashboard read: every event from both processes, none torn.
      const { report, skippedLines } = reportFromDir(stateDir);
      expect(skippedLines).toBe(0);
      expect(report.captureFired.total).toBe(2 * EVENTS_PER_WRITER);
      expect(report.captureFired.byPoint).toEqual({ [CAPTURE_POINT]: 2 * EVENTS_PER_WRITER });
      expect(report.captureFired.bySession).toEqual({
        'sess-mp-A': EVENTS_PER_WRITER,
        'sess-mp-B': EVENTS_PER_WRITER,
      });

      // Raw-bytes corroboration: exactly 2N complete lines, each one a
      // parseable event with the expected shape — no interleaved fragments.
      const lines = readFileSync(join(stateDir, TELEMETRY_FILE), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2 * EVENTS_PER_WRITER);
      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>;
        expect(event['counter']).toBe('capture_fired');
        expect(event['point']).toBe(CAPTURE_POINT);
        expect(['sess-mp-A', 'sess-mp-B']).toContain(event['sessionId']);
      }
    },
    20_000,
  );
});
