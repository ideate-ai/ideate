// plugin/src/cli/record-walk-snapshot.ts — the EPHEMERAL walk snapshot behind
// the `ideate-record read --json` exhaustive-summary walk.
//
// THE MEASURED PROBLEM: every CLI invocation is a cold process with a cold
// RecordStore, and the store's backlink-complete `readViews` id-unset path
// must parse every record newer than a page's `before_id` boundary — so page
// K of an exhaustive `--cursor` walk re-parses records 1..K×limit. A full
// walk is O(N²/limit): measured 2.7–3.4s over ~46 pages on the live 3,095-
// record store, with per-doubling ratios climbing superlinearly
// (2.77× then 3.13×). Per-page process startup, by contrast, is a flat ~40ms
// — the re-walk is the cost, not the spawn.
//
// THE FIX (decision 01KZ1Y2RXH8ZSN76WG8875HZJ5): do the walk ONCE in ONE
// process — where the store's WalkCache persists across the whole paging
// sequence, making the full walk O(N) — materialize the emitted pages to an
// EPHEMERAL snapshot, and let later cold invocations serve O(page) reads from
// it. The build runs the EXISTING production paging loop verbatim —
// `readRecordPage` → `projectRecordRow(view, false)` → `boundRecordPage(...,
// measurePrettyItemChars)` following `next_cursor` to exhaustion, exactly the
// sequence cli/ideate-record.ts's runRead JSON path performs per page — so a
// materialized page is BYTE-IDENTICAL to live paging of the same store state:
// same summary rows, same budget-closed page boundaries, same cursor chain.
//
// WHAT THIS IS NOT (all three rejected by the ratified decision):
//   - NOT a durable index: nothing here outlives its freshness token, nothing
//     is written under the record dir (GP-20: the record layout is a
//     contract), and os.tmpdir() reaping can take the whole snapshot at any
//     time — the next read simply rebuilds.
//   - NOT a streamed full dump: pages stay individually bounded by the SAME
//     LIST_PAYLOAD_BUDGET_CHARS guard, applied by the SAME boundRecordPage.
//   - NOT a weakening of backlink completeness: the build parses every record
//     once through the store's own read path — the complete referrer map,
//     strictly ≥ the per-page completeness of the walk it replaces.
//
// FRESHNESS: the store is append-only, so the newest record id is a perfect
// freshness token, cheap to get (one record parsed). A snapshot whose token
// is not the current newest id is stale and is rebuilt — the token is what
// keeps this a CACHE rather than the drifting durable index the decision
// rejected.
//
// ELIGIBILITY (minimized blast radius): cli/ideate-record.ts uses this ONLY
// for the exact pattern the review agents drive — `--json` WITHOUT
// `--include-content` and WITHOUT `--id`. The by-id fetch (already cheap),
// the content-bearing read (the snapshot stores no bodies) and the
// human-readable paths all keep the pre-existing direct read, unchanged.
//
// A cursor this snapshot does not name (minted against a different selection,
// a different limit, or an older store state) is NEVER guessed at: the read
// falls back to the live bounded page, which answers any well-formed cursor
// correctly by construction. A malformed cursor raises the record's own typed
// RecordSchemaError here exactly as the direct path does — never an empty
// page.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  DEFAULT_RECORD_READ_LIMIT,
  boundRecordPage,
  clampRecordReadLimit,
  decodeRecordCursor,
  projectRecordRow,
  readRecordPage,
} from '../record/read-page.js';
import type { RecordRowPage } from '../record/read-page.js';
import type { RecordStore } from '../record/store.js';
import { measurePrettyItemChars } from '../transport/payload-budget.js';

/** Bump when the on-disk shape changes; old snapshots are simply rebuilt. */
const SNAPSHOT_VERSION = 1;

const MANIFEST_FILE = 'manifest.json';
const PAGE_FILE_PREFIX = 'page-';

/**
 * One snapshot's table of contents. `cursors[0]` is `null` — the first page,
 * requested with no `--cursor` — and `cursors[k]` for k ≥ 1 is the
 * `next_cursor` page k−1 emitted, so serving `--cursor C` is an exact-match
 * lookup, never a decode-and-guess. `freshnessToken` is the newest record id
 * captured BEFORE the build's walk: an append mid-build can only leave the
 * token naming an OLDER state than the pages reflect, so a raced build errs
 * toward one extra rebuild, never toward serving stale data as fresh.
 */
interface WalkSnapshotManifest {
  version: number;
  selectionKey: string;
  limit: number;
  freshnessToken: string | null;
  pageCount: number;
  cursors: (string | null)[];
}

/** Selection + paging options, mirroring the CLI's `read --json` flags. */
export interface WalkSnapshotPageOptions {
  /** Substring SELECTION over scope/kind/source (never a ranking). */
  scope?: string;
  /** Page size; defaulted and clamped exactly as the direct path does. */
  limit?: number;
  /** The opaque `next_cursor` of a previous page, verbatim. */
  cursor?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One string naming the selection — the snapshot is per (selection, limit). */
function selectionKeyOf(scope: string | undefined): string {
  return JSON.stringify({ scope: scope ?? null });
}

function hashKey(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/** Canonical path when it exists, the unresolved one otherwise — a stable
 *  identity for the store either way, never a throw on an empty store whose
 *  record dir nothing has created yet. */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The snapshot's home: `os.tmpdir()/ideate-record-walk/<hash(store
 * realpath)>/<hash(selection,limit)>/`. Deliberately OUTSIDE the record dir
 * (GP-20) and outside the project entirely — ephemeral cache, not artifact.
 */
function snapshotDirFor(recordDir: string, selectionKey: string, limit: number): string {
  return join(tmpdir(), 'ideate-record-walk', hashKey(realPathOrSelf(recordDir)), hashKey(`${selectionKey}${String(limit)}`));
}

/**
 * The freshness token: the newest record id, or `null` on an empty store.
 * `readViews({ limit: 1 })` parses exactly one record file — the cheap half
 * of the append-only invariant that "newest id" is a complete version stamp.
 */
function newestRecordId(store: RecordStore): string | null {
  return store.readViews({ limit: 1 })[0]?.id ?? null;
}

/**
 * ONE bounded page, produced by the production paging/projection/budget chain
 * verbatim — the exact sequence the CLI's JSON path runs per page. Used for
 * the snapshot build's walk AND for the live fallback, so the two cannot
 * drift: there is no second way a page is made.
 */
function livePage(store: RecordStore, scope: string | undefined, limit: number, cursor: string | undefined): RecordRowPage {
  const page = readRecordPage(store, {
    ...(scope === undefined ? {} : { scope }),
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  });
  const rows = page.records.map((view) => projectRecordRow(view, false));
  return boundRecordPage({ records: rows, next_cursor: page.next_cursor }, measurePrettyItemChars);
}

/** Load and VALIDATE a manifest; `undefined` on any absence, parse failure,
 *  version drift, shape violation, or selection/limit mismatch — every one of
 *  which simply means "rebuild". */
function loadManifest(dir: string, selectionKey: string, limit: number): WalkSnapshotManifest | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  if (raw['version'] !== SNAPSHOT_VERSION) return undefined;
  if (raw['selectionKey'] !== selectionKey || raw['limit'] !== limit) return undefined;
  if (!(typeof raw['freshnessToken'] === 'string' || raw['freshnessToken'] === null)) return undefined;
  if (typeof raw['pageCount'] !== 'number' || !Number.isInteger(raw['pageCount']) || raw['pageCount'] < 1) return undefined;
  const cursors: unknown = raw['cursors'];
  if (!Array.isArray(cursors) || cursors.length !== raw['pageCount']) return undefined;
  if (cursors[0] !== null) return undefined;
  if (!cursors.every((c) => c === null || typeof c === 'string')) return undefined;
  return raw as unknown as WalkSnapshotManifest;
}

/** Read one materialized page; `undefined` on any absence or shape violation
 *  (a raced rebuild, a tmp reaper mid-walk) — the caller rebuilds. */
function readPageFile(dir: string, pageIndex: number): RecordRowPage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, `${PAGE_FILE_PREFIX}${String(pageIndex)}.json`), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(raw)) return undefined;
  if (!Array.isArray(raw['records'])) return undefined;
  if (!(typeof raw['next_cursor'] === 'string' || raw['next_cursor'] === null)) return undefined;
  return raw as unknown as RecordRowPage;
}

/** The snapshot page index serving `cursor`, or `undefined` when the cursor
 *  is not part of this walk (`cursors[0]` — the no-cursor first page — is
 *  `null`, so a string cursor can never alias it). */
function pageIndexFor(manifest: WalkSnapshotManifest, cursor: string | undefined): number | undefined {
  if (cursor === undefined) return 0;
  const index = manifest.cursors.indexOf(cursor);
  return index >= 1 && index < manifest.pageCount ? index : undefined;
}

/**
 * Atomically install a snapshot: write every file to a sibling staging dir,
 * retire any previous dir whole, then rename staging into place. A concurrent
 * reader sees the COMPLETE old snapshot, nothing, or the COMPLETE new one —
 * never a mix (a manifest from one build and page files from another). A
 * concurrent builder that loses the rename keeps the winner's snapshot,
 * which is equivalent or fresher; the loser's staging is dropped.
 */
function installSnapshot(dir: string, files: ReadonlyMap<string, string>): void {
  const parent = dirname(dir);
  const nonce = `${String(process.pid)}-${Math.random().toString(36).slice(2)}`;
  const staging = join(parent, `.staging-${basename(dir)}-${nonce}`);
  const retired = join(parent, `.retired-${basename(dir)}-${nonce}`);
  try {
    // 0o700 / 0o600 throughout: page files carry record claims, scopes and kinds
    // (finding text can describe vulnerabilities), and on a shared Linux host
    // `os.tmpdir()` is the WORLD-visible /tmp — outside the project's own
    // permission boundary. The snapshot must not leak record contents to other
    // local users (macOS masks this with a per-user 0700 $TMPDIR; Linux does
    // not). A cache is only safe to leave on disk if it is no more readable
    // than the store it mirrors.
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: 0o700 });
    for (const [name, body] of files) {
      writeFileSync(join(staging, name), body, { mode: 0o600 });
    }
  } catch (err) {
    // Every operation above is the accelerator's OWN filesystem work — an
    // unwritable cache parent, a full disk, a read-only tmp, a quota fault —
    // and NONE of it may propagate: buildSnapshot already holds the walked
    // pages in memory and hands them to its caller regardless of whether this
    // function ever runs, so giving up here costs only the on-disk copy,
    // never the answer (the "may never change a correct answer" clause).
    // Warn loudly — the fail-loud mirror of P-45: machinery that promised to
    // degrade must not instead fail hard — and stop; there is nothing usable
    // in `staging` to swap in.
    //
    // Drop `staging` first. The write loop above can fail PART WAY THROUGH —
    // several page files already on disk when a quota or ENOSPC fault hits —
    // and `staging`'s name embeds a fresh pid/random nonce, so no later build
    // ever revisits this path to tidy it. Without this the partial directory
    // leaks permanently, and every retry under the same disk-pressure
    // condition leaks another, compounding the exact fault that caused it.
    // Best-effort and force: a second failure here must not replace the
    // warning we are about to emit with a throw.
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      // Nothing further to do — the disk that refused the write may equally
      // refuse the cleanup. The warning below still names the real fault.
    }
    warnInstall('build', err);
    return;
  }
  try {
    renameSync(dir, retired);
  } catch (err) {
    // No previous snapshot to retire — the common first-build case. Anything
    // else is unexpected: surface it rather than degrade silently.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') warnInstall('retire', err);
  }
  try {
    renameSync(staging, dir);
  } catch (err) {
    // A concurrent builder won the swap (rename onto a now-non-empty dir
    // fails): its snapshot is equivalent or fresher, so keep it and drop
    // ours. An UNEXPECTED failure (e.g. a root-owned stale tree after a sudo
    // run) would otherwise disable caching invisibly — warn so the lost
    // performance is at least visible, though the answer stays correct.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') warnInstall('install', err);
    rmSync(staging, { recursive: true, force: true });
  }
  rmSync(retired, { recursive: true, force: true });
}

/** One-line operator note for an UNEXPECTED install failure — the snapshot is
 *  an accelerator, so a failure costs performance, never correctness; the
 *  warning makes that cost visible instead of silent. */
function warnInstall(phase: string, err: unknown): void {
  process.emitWarning(`ideate record: walk snapshot ${phase} failed; falling back to a fresh walk (${errorMessage(err)})`, {
    code: 'IDEATE_RECORD_WALK_SNAPSHOT',
  });
}

/** `err.message` when there is one, the code otherwise — never the full object,
 *  which can carry paths a warning should not echo. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isObject(err) && typeof err['message'] === 'string') return err['message'];
  return String(err);
}

/**
 * Walk the selection to exhaustion IN THIS PROCESS — one warm WalkCache, so
 * the whole sequence costs one pass over the store — materialize every page,
 * and return them with the manifest. The freshness token is captured BEFORE
 * the walk (see the manifest note for why that direction is the safe one).
 */
function buildSnapshot(
  store: RecordStore,
  dir: string,
  selectionKey: string,
  scope: string | undefined,
  limit: number,
  freshnessToken: string | null,
): { manifest: WalkSnapshotManifest; pages: RecordRowPage[] } {
  const pages: RecordRowPage[] = [];
  const cursors: (string | null)[] = [null];
  let cursor: string | undefined;
  for (;;) {
    const page = livePage(store, scope, limit, cursor);
    pages.push(page);
    if (page.next_cursor === null) break;
    // Keyset paging over a finite, append-only store: each page carries at
    // least one row (the budget's liveness rule) and the cursor moves
    // strictly older, so this terminates in at most N iterations.
    cursors.push(page.next_cursor);
    cursor = page.next_cursor;
  }
  const manifest: WalkSnapshotManifest = {
    version: SNAPSHOT_VERSION,
    selectionKey,
    limit,
    freshnessToken,
    pageCount: pages.length,
    cursors,
  };
  const files = new Map<string, string>();
  pages.forEach((page, index) => {
    files.set(`${PAGE_FILE_PREFIX}${String(index)}.json`, JSON.stringify(page));
  });
  files.set(MANIFEST_FILE, JSON.stringify(manifest));
  installSnapshot(dir, files);
  return { manifest, pages };
}

/**
 * ONE page of the exhaustive-summary walk, served from the ephemeral
 * snapshot when fresh and built once when not — byte-identical to the direct
 * production paging of the same store state either way.
 *
 * Failure posture is always "fall back to the live bounded page": a foreign
 * (but well-formed) cursor, a torn snapshot, a raced rebuild, or the
 * accelerator's own build/install I/O failing (an unwritable cache
 * directory, a full disk, a quota fault) — every filesystem operation the
 * snapshot performs, while BUILDING it and while INSTALLING it, is contained
 * so a failure there degrades to the live page rather than propagating. The
 * snapshot may only ever make a correct answer FASTER; it may never change
 * one, and it may never turn a correct read into a hard failure. A malformed
 * cursor raises RecordSchemaError before any snapshot work, exactly as the
 * direct path does.
 */
export function readWalkSnapshotPage(store: RecordStore, options: WalkSnapshotPageOptions = {}): RecordRowPage {
  const limit = clampRecordReadLimit(options.limit ?? DEFAULT_RECORD_READ_LIMIT);
  // Typed-error parity with the direct path: malformed cursor → throw, never
  // an empty page, and never a snapshot build on behalf of a bad request.
  if (options.cursor !== undefined) decodeRecordCursor(options.cursor);
  const selectionKey = selectionKeyOf(options.scope);
  const dir = snapshotDirFor(store.recordDir, selectionKey, limit);
  const freshnessToken = newestRecordId(store);

  const manifest = loadManifest(dir, selectionKey, limit);
  if (manifest !== undefined && manifest.freshnessToken === freshnessToken) {
    const index = pageIndexFor(manifest, options.cursor);
    if (index === undefined) {
      // A FRESH snapshot that does not name this cursor: the cursor came from
      // a different selection/limit or an older store state. The store has
      // not changed since the build, so rebuilding could not add it — serve
      // the live bounded page, which answers any well-formed boundary.
      return livePage(store, options.scope, limit, options.cursor);
    }
    const page = readPageFile(dir, index);
    if (page !== undefined) return page;
    // Torn snapshot (a cleaner raced us between manifest and page): rebuild.
  }

  let built: { manifest: WalkSnapshotManifest; pages: RecordRowPage[] };
  try {
    built = buildSnapshot(store, dir, selectionKey, options.scope, limit, freshnessToken);
  } catch (err) {
    // Defense in depth around installSnapshot's own containment above: ANY
    // unexpected throw out of the build — not only the install writes —
    // must still answer correctly. Warn loudly, naming the real fault, and
    // serve the exact requested page via the SAME live-paging chain the
    // direct read (and the snapshot build itself) uses, so the answer is
    // identical to what an uncached read would have returned.
    //
    // Labelled distinctly from installSnapshot's own 'build' phase: reaching
    // HERE means the inner containment did not catch it, which is a different
    // diagnosis for whoever reads the warning — the fault was somewhere else
    // in the build, not in writing the cache.
    warnInstall('build-uncontained', err);
    return livePage(store, options.scope, limit, options.cursor);
  }
  const index = pageIndexFor(built.manifest, options.cursor);
  if (index !== undefined) {
    const page = built.pages[index];
    if (page !== undefined) return page;
  }
  // The cursor is not part of THIS store state's walk (minted before appends
  // shifted the boundaries): the live page is the correct bounded answer.
  return livePage(store, options.scope, limit, options.cursor);
}

/**
 * TEST-ONLY. The snapshot dir a given (record dir, scope, limit) triple maps
 * to — exported so cli tests can assert the snapshot lives under os.tmpdir()
 * (never the record dir, GP-20), inspect the manifest, and prove the
 * bypass paths write nothing. Deliberately NOT part of the read contract;
 * nothing outside a test should observe or depend on this location.
 */
export function walkSnapshotDirForTest(recordDir: string, scope?: string, limit?: number): string {
  return snapshotDirFor(recordDir, selectionKeyOf(scope), clampRecordReadLimit(limit ?? DEFAULT_RECORD_READ_LIMIT));
}
