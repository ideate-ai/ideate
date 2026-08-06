// plugin/src/cli/record-walk-snapshot.test.ts — acceptance tests for the
// EPHEMERAL walk snapshot behind `ideate-record read --json` (decision
// 01KZ1Y2RXH8ZSN76WG8875HZJ5).
//
// Pins, in the order the module's contract states them:
//   - EQUIVALENCE: the page sequence the snapshot pager emits — ids per page
//     AND the full next_cursor chain to null — is IDENTICAL to direct
//     repeated readRecordPage + projectRecordRow + boundRecordPage paging,
//     on both the unfiltered walk and a scope-selected one;
//   - FRESHNESS: an append after the build invalidates the snapshot (the
//     newest-id token), and the next paged read reflects the new record —
//     never stale data;
//   - BOUNDED OUTPUT: over a store large enough to span budget-closed pages,
//     every emitted page's pretty-serialized payload stays inside
//     LIST_PAYLOAD_BUDGET_CHARS and the cursor chain terminates at null;
//   - ENVELOPE SHAPE: exactly {records, next_cursor}, rows carrying
//     content_length and NOT content — on pages served FROM the snapshot
//     files, not only from the build;
//   - STORE ISOLATION (GP-20): a snapshot walk writes nothing under the
//     record dir — the record tree is byte-identical before/after, and the
//     snapshot lives under os.tmpdir();
//   - FALLBACK: --include-content, --id and the human-paged read bypass the
//     snapshot entirely (no snapshot dir is even created) and behave exactly
//     as before — driven against the REAL bin, like ideate-record.test.ts.
//
// In-process tests simulate cold CLI invocations by constructing a FRESH
// RecordStore per paged read against the same temp project root. All
// filesystem work happens in mkdtemp dirs and os.tmpdir() — the real record
// is never touched.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import {
  boundRecordPage,
  projectRecordRow,
  readRecordPage,
} from '../record/read-page.js';
import type { RecordRowPage } from '../record/read-page.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { LIST_PAYLOAD_BUDGET_CHARS, measurePrettyItemChars } from '../transport/payload-budget.js';
import { readWalkSnapshotPage, walkSnapshotDirForTest } from './record-walk-snapshot.js';
import type { WalkSnapshotPageOptions } from './record-walk-snapshot.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-record');

const FIXED_ISO = '2026-07-09T12:00:00.000Z';

const tempDirs: string[] = [];
const snapshotDirs: string[] = [];
// Dirs chmod'd read-only by the containment tests below — restored to
// writable BEFORE the recursive cleanup passes, or rmSync would itself be
// blocked by the very permission the test set up.
const permRestores: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (permRestores.length > 0) {
    const dir = permRestores.pop();
    if (dir !== undefined) chmodSync(dir, 0o700);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  while (snapshotDirs.length > 0) {
    const dir = snapshotDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface TestProject {
  projectRoot: string;
  telemetryDir: string;
  recordDir: string;
}

function makeProject(): TestProject {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-walk-snapshot-test-'));
  const telemetryDir = mkdtempSync(join(tmpdir(), 'ideate-walk-snapshot-telemetry-'));
  tempDirs.push(projectRoot, telemetryDir);
  return { projectRoot, telemetryDir, recordDir: join(projectRoot, DEFAULT_RECORD_PATH) };
}

/** A FRESH store over the same root — one cold CLI invocation. */
function freshStore(project: TestProject): RecordStore {
  const config: IdeateConfigV3 = {
    schema_version: V3_SCHEMA_VERSION,
    record: { path: DEFAULT_RECORD_PATH },
    backend: 'local',
  };
  const clock: Clock = () => new Date(FIXED_ISO);
  return new RecordStore(config, project.projectRoot, new TelemetryCounters(project.telemetryDir, clock), clock);
}

/** Seed `count` records through ONE store (one ULID generator, so ids are
 *  monotonic in insertion order); returns ids oldest-first. */
function seed(store: RecordStore, count: number, claimSize = 0): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = store.append({
      kind: i % 3 === 0 ? 'finding' : 'decision',
      claim: `Claim number ${String(i)}.${'c'.repeat(claimSize)}`,
      verification_anchor: 'src/cli/record-walk-snapshot.ts',
      scope: i % 2 === 0 ? 'even scope' : 'odd scope',
      source: { capture_point: 'test', session_id: 'sess-snapshot' },
      content: `A recall-shaped prose body for record ${String(i)}, long enough to read as prose.`,
    });
    if (!result.ok) throw new Error(`seed failed: ${result.reason}`);
    ids.push(result.record.id);
  }
  return ids;
}

/** The snapshot dir for this project's (scope, limit); tracked for cleanup. */
function snapshotDirOf(project: TestProject, scope?: string, limit?: number): string {
  const dir = walkSnapshotDirForTest(project.recordDir, scope, limit);
  if (!snapshotDirs.includes(dir)) snapshotDirs.push(dir);
  return dir;
}

interface WalkSnapshotManifest {
  version: number;
  selectionKey: string;
  limit: number;
  freshnessToken: string | null;
  pageCount: number;
  cursors: (string | null)[];
}

function readManifest(project: TestProject, scope?: string, limit?: number): WalkSnapshotManifest {
  return JSON.parse(readFileSync(join(snapshotDirOf(project, scope, limit), 'manifest.json'), 'utf8')) as WalkSnapshotManifest;
}

/** The DIRECT production walk: repeated readRecordPage → project → bound. */
function walkDirect(store: RecordStore, options: WalkSnapshotPageOptions): RecordRowPage[] {
  const pages: RecordRowPage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = readRecordPage(store, {
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const bounded = boundRecordPage(
      { records: page.records.map((view) => projectRecordRow(view, false)), next_cursor: page.next_cursor },
      measurePrettyItemChars,
    );
    pages.push(bounded);
    if (bounded.next_cursor === null) break;
    cursor = bounded.next_cursor;
    expect(pages.length).toBeLessThan(1_000); // liveness guard, never the assertion
  }
  return pages;
}

/** The SNAPSHOT walk: every page from a FRESH (cold) store, as the CLI does. */
function walkSnapshot(project: TestProject, options: WalkSnapshotPageOptions): RecordRowPage[] {
  snapshotDirOf(project, options.scope, options.limit); // tracked for cleanup
  const pages: RecordRowPage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = readWalkSnapshotPage(freshStore(project), {
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
    });
    pages.push(page);
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
    expect(pages.length).toBeLessThan(1_000); // liveness guard, never the assertion
  }
  return pages;
}

describe('equivalence with the direct production paging', () => {
  it('the snapshot walk emits the IDENTICAL page sequence — rows and the full cursor chain — as direct repeated paging', () => {
    const project = makeProject();
    const seeding = freshStore(project);
    const ids = seed(seeding, 60);
    const options: WalkSnapshotPageOptions = { limit: 7 };

    const direct = walkDirect(freshStore(project), options);
    expect(direct.length).toBeGreaterThan(2); // a real multi-page walk

    const snapshot = walkSnapshot(project, options);
    expect(snapshot).toEqual(direct);

    // The full cursor chain to null, explicitly: cursors[k] for k≥1 IS the
    // previous page's next_cursor, and only the last page's is null.
    for (let k = 0; k < snapshot.length; k += 1) {
      const page = snapshot[k];
      if (page === undefined) throw new Error('expected a page');
      if (k < snapshot.length - 1) expect(page.next_cursor).toBeTypeOf('string');
      else expect(page.next_cursor).toBeNull();
    }
    expect(snapshot.flatMap((p) => p.records.map((r) => r.id))).toEqual([...ids].reverse());

    // …and the identical statement through a SELECTION (the snapshot is
    // keyed per selection): scope-filtered walks agree page-for-page too.
    const scoped: WalkSnapshotPageOptions = { limit: 7, scope: 'even scope' };
    expect(walkSnapshot(project, scoped)).toEqual(walkDirect(freshStore(project), scoped));
  });

  it('a SECOND snapshot walk (every page served from the page files) is byte-identical to the first (built) walk', () => {
    const project = makeProject();
    seed(freshStore(project), 30);
    const options: WalkSnapshotPageOptions = { limit: 5 };
    const built = walkSnapshot(project, options);
    const served = walkSnapshot(project, options);
    expect(served).toEqual(built);
    // Serialized byte equality, not only deep equality — the envelope the CLI
    // writes must not drift between the build serve and the file serve.
    const serialize = (pages: RecordRowPage[]): string[] =>
      pages.map((p) => JSON.stringify({ records: p.records, next_cursor: p.next_cursor }, null, 2));
    expect(serialize(served)).toEqual(serialize(built));
  });
});

describe('freshness: the newest-id token keeps the snapshot a CACHE', () => {
  it('an append after the build rebuilds the snapshot and the next paged read reflects the new record', () => {
    const project = makeProject();
    const seeding = freshStore(project);
    const ids = seed(seeding, 8);
    const options: WalkSnapshotPageOptions = { limit: 3 };

    walkSnapshot(project, options); // builds the snapshot
    const before = readManifest(project, undefined, 3);
    expect(before.freshnessToken).toBe(ids.at(-1));

    const appended = seeding.append({
      kind: 'finding',
      claim: 'A record written after the snapshot was built.',
      verification_anchor: 'src/cli/record-walk-snapshot.ts',
      scope: 'even scope',
      source: { capture_point: 'test', session_id: 'sess-snapshot' },
      content: 'Prose body written after the snapshot build.',
    });
    if (!appended.ok) throw new Error(`append failed: ${appended.reason}`);

    const after = walkSnapshot(project, options);
    const firstPage = after[0];
    if (firstPage === undefined) throw new Error('expected a first page');
    // The newest record heads page one — no stale data, and the whole walk
    // still covers every record exactly once.
    expect(firstPage.records[0]?.id).toBe(appended.record.id);
    const walked = after.flatMap((p) => p.records.map((r) => r.id));
    expect(walked).toEqual([appended.record.id, ...[...ids].reverse()]);

    // …mechanically: the manifest was REBUILT against the new newest id.
    expect(readManifest(project, undefined, 3).freshnessToken).toBe(appended.record.id);
  });
});

describe('bounded output: the snapshot cannot unbound a page', () => {
  it('every emitted page stays inside LIST_PAYLOAD_BUDGET_CHARS and the chain terminates at null over budget-closed pages', () => {
    const project = makeProject();
    // 120 records at limit 100: the pretty-measured summary rows close page
    // one by BUDGET before the count is reached — the exact closure the
    // bounded-read arc exists for.
    const ids = seed(freshStore(project), 120);
    const pages = walkSnapshot(project, { limit: 100 });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.some((p) => p.records.length < 100)).toBe(true); // budget, not count, closed a page

    for (const page of pages) {
      // The invariant boundRecordPage enforces: the pretty-measured items
      // region never exceeds the budget…
      const measured = page.records.reduce((total, row) => total + measurePrettyItemChars(row), 0);
      expect(measured).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
      // …and the bound that matters on the wire: the bytes the CLI actually
      // writes for this page.
      const envelope = `${JSON.stringify({ records: page.records, next_cursor: page.next_cursor }, null, 2)}\n`;
      expect(envelope.length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    }
    expect(pages.at(-1)?.next_cursor).toBeNull();
    const walked = pages.flatMap((p) => p.records.map((r) => r.id));
    expect(walked).toEqual([...ids].reverse());
    expect(new Set(walked).size).toBe(ids.length);
  });
});

describe('envelope shape', () => {
  it('pages served FROM the snapshot files carry exactly {records, next_cursor}, rows with content_length and NOT content', () => {
    const project = makeProject();
    seed(freshStore(project), 12);
    const options: WalkSnapshotPageOptions = { limit: 5 };
    walkSnapshot(project, options); // build
    const served = walkSnapshot(project, options); // serve from page files
    expect(served.length).toBeGreaterThan(1);

    for (const page of served) {
      const envelope = JSON.parse(JSON.stringify({ records: page.records, next_cursor: page.next_cursor })) as Record<
        string,
        unknown
      >;
      expect(Object.keys(envelope)).toEqual(['records', 'next_cursor']);
      for (const row of page.records) {
        expect('content' in row).toBe(false);
        expect(row.content_length).toBeTypeOf('number');
        expect(row.content_length).toBeGreaterThan(0);
      }
    }
  });
});

describe('store isolation (GP-20): the snapshot writes NOTHING under the record dir', () => {
  /** The record tree as relative-path → raw-bytes, for a byte-exact diff. */
  function snapshotTree(recordDir: string): Map<string, string> {
    const tree = new Map<string, string>();
    if (!existsSync(recordDir)) return tree;
    for (const entry of readdirSync(recordDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const full = join(entry.parentPath, entry.name);
      tree.set(relative(recordDir, full), readFileSync(full, 'utf8'));
    }
    return tree;
  }

  it('the record dir is byte-identical before/after a snapshot walk, and the snapshot lives under os.tmpdir()', () => {
    const project = makeProject();
    seed(freshStore(project), 20);
    const before = snapshotTree(project.recordDir);

    walkSnapshot(project, { limit: 4 });

    expect(snapshotTree(project.recordDir)).toEqual(before);
    const dir = snapshotDirOf(project, undefined, 4);
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(relative(project.projectRoot, dir).startsWith('..')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review pins: the file-serve path is REAL (not a rebuild in disguise), a
// torn snapshot rebuilds, and a foreign cursor falls back to the live page.
// ---------------------------------------------------------------------------

describe('review pins: file-serve, torn snapshot, foreign cursor', () => {
  it('a hand-edit to page-0.json is served verbatim — the file-serve path is exercised, not a rebuild', () => {
    const project = makeProject();
    seed(freshStore(project), 30);
    const options: WalkSnapshotPageOptions = { limit: 5 };
    walkSnapshot(project, options); // build + materialize page files
    const dir = snapshotDirOf(project, undefined, 5);

    // Hand-edit page 0's first record claim to a sentinel the store never held.
    // If a later read serves the EDITED bytes, the page came FROM the file; if it
    // serves the original claim, the read silently rebuilt and this pin catches
    // it (an always-rebuild mutation in the source leaves the suite green
    // WITHOUT a test like this — the file-serve path would be dead code).
    const page0Path = join(dir, 'page-0.json');
    const page0 = JSON.parse(readFileSync(page0Path, 'utf8')) as RecordRowPage;
    const sentinel = 'SENTINEL-EDIT-CLAIM-never-seeded-by-store';
    page0.records[0]!.claim = sentinel;
    writeFileSync(page0Path, JSON.stringify(page0));

    // A fresh read with no append: manifest still fresh, page-0 exists → serve
    // the edited file verbatim.
    const served = readWalkSnapshotPage(freshStore(project), options);
    expect(served.records[0]?.claim).toBe(sentinel);
  });

  it('a torn snapshot (a missing page file mid-walk) rebuilds and the full walk stays correct', () => {
    const project = makeProject();
    const ids = seed(freshStore(project), 30);
    const options: WalkSnapshotPageOptions = { limit: 5 };
    walkSnapshot(project, options); // build
    const dir = snapshotDirOf(project, undefined, 5);

    // Delete page 1: page 0 serves from file (manifest fresh, page-0 present),
    // but page 1's read finds the file gone and rebuilds. The rebuild writes a
    // fresh, complete snapshot, so the rest of the walk serves from it — the
    // full sequence stays correct and complete (the torn path at
    // record-walk-snapshot.ts: readPageFile → undefined → rebuild).
    rmSync(join(dir, 'page-1.json'), { force: true });

    const walked = walkSnapshot(project, options);
    expect(walked.flatMap((p) => p.records.map((r) => r.id))).toEqual([...ids].reverse());
    expect(walked).toEqual(walkDirect(freshStore(project), options));
  });

  it('a cursor minted at a different limit is FOREIGN to this snapshot and falls back to the live bounded page', () => {
    const project = makeProject();
    seed(freshStore(project), 30);
    // Build the snapshot at limit 5.
    walkSnapshot(project, { limit: 5 });
    // Mint a cursor from a limit-7 walk — different page boundaries, so the
    // limit-5 manifest does not name it.
    const foreignPages = walkDirect(freshStore(project), { limit: 7 });
    const foreignCursor = foreignPages[0]?.next_cursor;
    if (foreignCursor === undefined || foreignCursor === null) throw new Error('expected a mid-walk cursor');

    // The limit-5 snapshot serves a foreign cursor via the LIVE bounded page,
    // never by guessing a nearby boundary — and that live page is exactly what
    // the direct production chain produces for the same (limit, cursor).
    const snapPage = readWalkSnapshotPage(freshStore(project), { limit: 5, cursor: foreignCursor });
    // The direct comparison must HONOR the cursor — walkDirect ignores
    // options.cursor (it walks from the start), so compute the one bounded page
    // with readRecordPage directly, exactly as livePage does internally.
    const directView = readRecordPage(freshStore(project), { limit: 5, cursor: foreignCursor });
    const directPage = boundRecordPage(
      { records: directView.records.map((view) => projectRecordRow(view, false)), next_cursor: directView.next_cursor },
      measurePrettyItemChars,
    );
    expect(snapPage).toEqual(directPage);
  });
});

// ---------------------------------------------------------------------------
// Fallback: the bypass patterns, driven against the REAL bin
// ---------------------------------------------------------------------------

function runCli(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8' });
}

interface JsonPage {
  records: Array<{ id: string; content_length?: number; content?: string }>;
  next_cursor: string | null;
}

beforeAll(() => {
  // The CLI runs against compiled output. Build UNCONDITIONALLY — `tsc -b` is
  // incremental (P-50: the verified path must BE the shipped path), mirroring
  // ideate-record.test.ts.
  execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
}, 120_000);

describe('fallback: bypass patterns never touch the snapshot (real bin)', () => {
  function cliProject(): TestProject {
    const project = makeProject();
    for (let i = 0; i < 5; i += 1) {
      runCli(
        ['append', '--kind', 'finding', '--claim', `Fallback claim ${String(i)}.`, '--anchor', 'a.ts', '--content', `Body ${String(i)}.`],
        project.projectRoot,
      );
    }
    return project;
  }

  function firstJsonRecordId(project: TestProject): string {
    const page = JSON.parse(runCli(['read', '--json'], project.projectRoot)) as JsonPage;
    const id = page.records[0]?.id;
    if (id === undefined) throw new Error('expected a record');
    return id;
  }

  it('read --json builds the snapshot; --include-content serves bodies WITHOUT creating one', () => {
    const project = cliProject();
    const dir = snapshotDirOf(project);

    const plain = runCli(['read', '--json'], project.projectRoot);
    expect(existsSync(dir)).toBe(true); // the exhaustive-summary path DID build it
    // A second identical read is served byte-identically.
    expect(runCli(['read', '--json'], project.projectRoot)).toBe(plain);

    rmSync(dir, { recursive: true, force: true });
    const withContent = JSON.parse(runCli(['read', '--json', '--include-content'], project.projectRoot)) as JsonPage;
    expect(withContent.records.length).toBe(5);
    for (const row of withContent.records) {
      expect(row.content).toBeTypeOf('string'); // bodies are back
      expect(row.content_length).toBeTypeOf('number');
    }
    expect(existsSync(dir)).toBe(false); // …and the snapshot was BYPASSED
  });

  it('read --json --id serves the one record WITHOUT creating a snapshot', () => {
    const project = cliProject();
    const id = firstJsonRecordId(project);
    const dir = snapshotDirOf(project);
    rmSync(dir, { recursive: true, force: true });

    const page = JSON.parse(runCli(['read', '--json', '--id', id], project.projectRoot)) as JsonPage;
    expect(page.records.length).toBe(1);
    expect(page.records[0]?.id).toBe(id);
    expect(page.records[0]?.content_length).toBeTypeOf('number');
    expect(page.records[0]?.content).toBeUndefined();
    expect(page.next_cursor).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });

  it('the human-paged read prints the resume hint WITHOUT creating a snapshot', () => {
    const project = cliProject();
    const dir = snapshotDirOf(project, undefined, 2);
    const out = runCli(['read', '--limit', '2'], project.projectRoot);
    expect(out).toContain('(more records — resume with --cursor ');
    expect(out).toContain('Body 4.'); // bodies print on the human path
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(snapshotDirOf(project))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Containment: the accelerator's own filesystem operations — mkdir'ing the
// cache parent, mkdir'ing the staging dir, writing the page files — must
// never turn a correct read into a failure. Fault-injected with REAL
// filesystem faults (permission, a colliding non-directory), not stubs,
// mirroring the codebase's established pattern (record/store.test.ts,
// work-state/completion-record.test.ts). This is the module's own header
// claim made falsifiable (P-35): before this fix, every test in this block
// failed with the fault propagating out of installSnapshot/buildSnapshot.
// ---------------------------------------------------------------------------

describe("containment: the accelerator's own I/O never turns a correct read into a failure", () => {
  // Permission bits do not constrain root: under a root-privileged runner (a
  // plain container image is the usual way this happens) `chmod 0500` does
  // NOT produce EACCES, the write succeeds, and the two permission-based
  // tests below fail on their assertions rather than covering anything. That
  // is a false failure, not a false pass — but it is still noise that would
  // send someone hunting a defect that is not there, so skip them explicitly
  // and say why. The colliding-file test needs no guard: ENOTDIR/EEXIST binds
  // root exactly as it binds anyone else, so the containment stays covered by
  // at least one fault in every environment.
  const skipAsRoot = process.getuid?.() === 0;

  it.skipIf(skipAsRoot)('an UNWRITABLE cache directory: the walk still returns the page sequence IDENTICAL to direct paging, with nothing installed and a loud warning naming the real fault', () => {
    const project = makeProject();
    const seeding = freshStore(project);
    const ids = seed(seeding, 20);
    const options: WalkSnapshotPageOptions = { limit: 6 };

    const dir = snapshotDirOf(project, options.scope, options.limit);
    const parent = dirname(dir);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o500); // read+execute only: nothing can be created inside it
    permRestores.push(parent);

    const emitWarning = vi.spyOn(process, 'emitWarning');
    const walked = walkSnapshot(project, options); // every page rebuilt in-memory, nothing lands on disk
    expect(walked.flatMap((p) => p.records.map((r) => r.id))).toEqual([...ids].reverse());
    // The "may never change a correct answer" clause, TESTED: identical to
    // the direct production paging chain, not merely plausible-looking.
    expect(walked).toEqual(walkDirect(freshStore(project), options));
    expect(existsSync(dir)).toBe(false); // the failed install left nothing behind

    const messages = emitWarning.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('walk snapshot build failed'))).toBe(true);
    expect(messages.some((m) => /EACCES|permission/i.test(m))).toBe(true); // names the REAL fault, not a generic one
    const warnOptions = emitWarning.mock.calls[0]?.[1] as { code?: string } | undefined;
    expect(warnOptions?.code).toBe('IDEATE_RECORD_WALK_SNAPSHOT');
  });

  it('a DIFFERENT fault (a plain file sitting where the cache tree needs a directory, not a permission problem): the walk still returns correct data and warns', () => {
    const project = makeProject();
    const seeding = freshStore(project);
    const ids = seed(seeding, 15);
    const options: WalkSnapshotPageOptions = { limit: 4 };

    const dir = snapshotDirOf(project, options.scope, options.limit);
    const parent = dirname(dir);
    mkdirSync(dirname(parent), { recursive: true });
    writeFileSync(parent, 'a plain file where the accelerator expects a directory');
    snapshotDirs.push(parent); // cleanup: rmSync handles a file path too

    const emitWarning = vi.spyOn(process, 'emitWarning');
    const walked = walkSnapshot(project, options);
    expect(walked.flatMap((p) => p.records.map((r) => r.id))).toEqual([...ids].reverse());
    expect(walked).toEqual(walkDirect(freshStore(project), options));

    const messages = emitWarning.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('walk snapshot build failed'))).toBe(true);
  });

  it.skipIf(skipAsRoot)('the real CLI: `read --json` exits 0 with the CORRECT records, installs nothing, and names the fault on stderr when the cache parent is unwritable', () => {
    const project = makeProject();
    for (let i = 0; i < 8; i += 1) {
      runCli(
        ['append', '--kind', 'finding', '--claim', `Containment claim ${String(i)}.`, '--anchor', 'a.ts', '--content', `Body ${String(i)}.`],
        project.projectRoot,
      );
    }
    // A warm-up read establishes the ground truth AND builds the snapshot
    // (which is then torn down so the next read must rebuild under the fault).
    const expected = JSON.parse(runCli(['read', '--json'], project.projectRoot)) as JsonPage;
    const dir = snapshotDirOf(project);
    rmSync(dir, { recursive: true, force: true });

    const parent = dirname(dir);
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o500);
    permRestores.push(parent);

    const result = spawnSync(process.execPath, [BIN_PATH, 'read', '--json'], { cwd: project.projectRoot, encoding: 'utf8' });
    expect(result.status).toBe(0); // never the hard exit 1 the defect produced
    const page = JSON.parse(result.stdout) as JsonPage;
    expect(page).toEqual(expected); // byte-identical to the unobstructed answer
    expect(existsSync(dir)).toBe(false); // the failed install left nothing behind
    expect(result.stderr).toContain('walk snapshot build failed'); // loud, not silent
  });
});
