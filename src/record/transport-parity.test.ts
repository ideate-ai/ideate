// plugin/src/record/transport-parity.test.ts — the cross-TRANSPORT freshness
// guard for the record store's two-transport contract (docs/transport-
// contract.md). P-40 sibling-surface parity, applied ACROSS transports: the
// guarantee "a write through one transport is visible on the next read through
// the other" must hold for BOTH transports, in the same change as the first.
//
// The store-level pin (store.test.ts:987 — two in-process RecordStore
// instances sharing one on-disk store) certifies the MECHANISM. THIS test
// certifies the shipped COMPOSITION: the real CLI bin (a separate process,
// fresh store per invocation — src/cli/ideate-record.ts:225-235) and the warm
// long-lived RecordStore the MCP transport composes (src/record/tools.ts:258-
// 278, one store lazily built and reused for the session). A future
// "optimization" that cached the directory listing on the warm instance and
// invalidated it only on the instance's own append() would pass store.test.ts
// :987 (two in-process instances, the second bumps nothing on the first) yet
// fail here, because the CLI writes from a process the warm instance never
// sees — which is occurrence 4 (finding 01KYWCRF6894TK8VF5QXEXRZ5K), the
// regression this split (store.ts:197-228 — listing never cached, contents
// cached because immutable) exists to prevent.
//
// Both transports share one on-disk store: with no .ideate.json the CLI's
// loadConfig() defaults to DEFAULT_RECORD_PATH (config/ideate-config.ts:158,
// 219), the same path the in-process store is constructed with.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { Clock } from './id.js';
import { RecordStore } from './store.js';
import { TelemetryCounters } from '../telemetry/counters.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-record');

const FIXED_ISO = '2026-07-09T12:00:00.000Z';
const tempDirs: string[] = [];

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  // The CLI runs compiled output; build UNCONDITIONALLY (P-50: the verified
  // path must BE the shipped path), mirroring ideate-record.test.ts.
  execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
}, 120_000);

interface ParityProject {
  projectRoot: string;
  telemetryDir: string;
  recordDir: string;
}

function makeProject(): ParityProject {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-transport-parity-'));
  const telemetryDir = mkdtempSync(join(tmpdir(), 'ideate-transport-parity-tel-'));
  tempDirs.push(projectRoot, telemetryDir);
  return { projectRoot, telemetryDir, recordDir: join(projectRoot, DEFAULT_RECORD_PATH) };
}

/** The warm long-lived RecordStore the MCP transport composes
 *  (record/tools.ts:258-278: lazily built once, reused for the whole session). */
function warmMcpStyleStore(project: ParityProject): RecordStore {
  const config: IdeateConfigV3 = {
    schema_version: V3_SCHEMA_VERSION,
    record: { path: DEFAULT_RECORD_PATH },
    backend: 'local',
  };
  const clock: Clock = () => new Date(FIXED_ISO);
  return new RecordStore(config, project.projectRoot, new TelemetryCounters(project.telemetryDir, clock), clock);
}

/** The short-lived CLI transport: a child process, fresh store per invocation.
 *  Returns the appended record's id (the bin prints it on stdout). */
function cliAppend(projectRoot: string, claim: string): string {
  const out = execFileSync(
    process.execPath,
    [BIN_PATH, 'append', '--kind', 'finding', '--claim', claim, '--anchor', 'a.ts', '--content', `Body for ${claim}.`],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  return out.trim();
}

/** The CLI transport's read, newest-first ids. */
function cliReadJsonIds(projectRoot: string): string[] {
  const out = JSON.parse(
    execFileSync(process.execPath, [BIN_PATH, 'read', '--json'], { cwd: projectRoot, encoding: 'utf8' }),
  ) as { records: { id: string }[]; next_cursor: string | null };
  return out.records.map((r) => r.id);
}

describe('cross-transport freshness: the record store through BOTH its transports (P-40 across transports)', () => {
  it('a CLI write (separate process) is visible to a warm MCP-style instance on its very next read', () => {
    const project = makeProject();
    const warm = warmMcpStyleStore(project);
    // Warm the instance with an initial read BEFORE any CLI write — the
    // regime where a cached directory listing would hide the later write
    // (occurrence 4). An empty result here warms the memo without seeing
    // any file.
    expect(warm.readViews().map((r) => r.id)).toEqual([]);

    const cliId = cliAppend(project.projectRoot, 'written by the CLI transport');

    // The warm instance must see the CLI's write on its very next call. A
    // cached listing invalidated only by the instance's own append() would
    // return [] here — silent incomplete reads to a consumer whose
    // conclusions are universally quantified over the record.
    expect(warm.readViews().map((r) => r.id)).toEqual([cliId]);
  });

  it('a warm-instance write is visible to the CLI transport (separate process) on its next read', () => {
    const project = makeProject();
    const warm = warmMcpStyleStore(project);
    const appended = warm.append({
      kind: 'finding',
      claim: 'written by the warm instance',
      verification_anchor: 'a.ts',
      scope: 'transport-parity',
      source: { capture_point: 'test', session_id: 'parity' },
      content: 'Body from the warm instance.',
    });
    if (!appended.ok) throw new Error(`append failed: ${appended.reason}`);

    // The CLI — a fresh process with a fresh store — must see the warm
    // instance's write. This is the easy direction (the CLI re-lists the
    // directory on every invocation, so it sees foreign writes by
    // construction); pinned for PARITY so a regression that breaks one
    // direction cannot pass the other off as the whole guarantee.
    expect(cliReadJsonIds(project.projectRoot)).toEqual([appended.record.id]);
  });

  it('repeated CLI writes between warm-instance reads are ALL visible — the listing is re-read every call, not snapshotted once', () => {
    const project = makeProject();
    const warm = warmMcpStyleStore(project);
    warm.readViews(); // warm before any CLI write

    const expectedNewestFirst: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const cliId = cliAppend(project.projectRoot, `CLI write ${i}`);
      expectedNewestFirst.unshift(cliId);
      // Each warm read must see EVERY CLI write so far, newest-first — the
      // directory listing is re-read on every call (store.ts:200-217), not
      // cached on the first. A snapshotted-once listing would show only the
      // first write forever.
      expect(warm.readViews().map((r) => r.id)).toEqual(expectedNewestFirst);
    }
    // The CLI agrees on the full set, newest-first — both transports end on
    // the same view of the one on-disk store.
    expect(cliReadJsonIds(project.projectRoot)).toEqual(expectedNewestFirst);
  });
});