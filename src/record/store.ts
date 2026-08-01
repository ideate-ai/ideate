// plugin/src/record/store.ts — the single shared write/read core of the
// process record.
//
// One Markdown file per record, ULID filename stems, date-sharded
// `record.path/YYYY/MM/{id}.md`. Reads go straight to the sharded files — NO
// PERSISTED index ships: the files on disk are always the sole source of
// truth, nothing derived is ever written to disk, and the shard/file layout
// this module documents is unchanged by any of what follows (see
// `readViews`'s WalkCache note below for the one EPHEMERAL exception: an
// in-process, per-instance memo of record FILES already read and parsed by
// THIS instance. It is never a memo of a DIRECTORY LISTING — the listing is
// re-taken fresh on every call — so a write, from this instance or from
// another process sharing the same on-disk store, is visible on the very
// next call; only the (immutable, append-only) file contents are ever
// reused. It never touches anything OTHER than this instance's own memory
// and never survives a process boundary). Both capture transports — the MCP
// `record_append` handler and the hook-invoked CLI — write through this one
// implementation.
//
// The three-property guard, enforced here BY API ABSENCE:
// - Project-local: the store resolves exactly one project's record path (via
//   config/ideate-config.ts's recordPath — THE single resolver; this module
//   never computes `<root>/<record.path>` itself).
// - Append-only: there is NO update, NO delete. Files are opened with `wx`
//   (exclusive create), so no code path can overwrite an existing record. A
//   correction is a NEW record referencing the superseded id. The
//   extraordinary-redaction exception is a documented MANUAL procedure —
//   deliberately, this store exposes no verb for it.
// - Never curated or ranked: `read` performs SELECTION only (substring
//   match, exact id, a keyset boundary in the id's own total order,
//   newest-first file order, a limit cap). No scoring, no decay, no
//   promotion — no rank/score function exists anywhere in this API. Paging is
//   selection too: walking a stable order is not ordering by relevance
//   (GP-27).
//
// Gate-before-persist: EVERY text field (frontmatter values and prose body)
// passes through the secret gate's scanAndMask BEFORE any filesystem write.
// There is no code path that persists ungated content — the masked record is
// the only thing ever serialized.
//
// Redaction telemetry routing: the telemetry counter set has a dedicated
// counter (`redactions`), so scan.ts's
// `onRedaction` now routes PRIMARILY to telemetry.redactionApplied (per
// pattern, per session) — the dashboard read. The process warning (code
// IDEATE_RECORD_REDACTION, naming the pattern and count — NEVER the
// content) is KEPT as a secondary, human-visible signal: it is what the
// hook transport forwards to the host's stderr, so a redaction is visible
// at the moment it happens, not only on the next dashboard read. The
// per-pattern tally also stays on the append result for callers/tests.
// (Misrouting through `capture_fired` or `capture_write_failed` remains
// forbidden: a redaction is a SUCCESSFUL gate action, not a capture event
// or a failure.)
//
// Capture-time id-lint (correction 01KYV387QKRP3V330WAS6DX95K, `append`'s own
// comment has the field-by-field detail): AFTER gating, every genuinely
// free-form prose field is scanned for ULID-shaped tokens that resolve
// against neither this store nor the board (transport/id-lint.ts's
// `lintFreeText`, given the cross-store resolver injected at construction —
// transport/id-resolver.ts is the one module allowed to know about both
// stores, so this one stays exactly as ignorant of the board as it always
// was). WARN, not reject: `unresolvedIds` rides the `AppendResult` (mirroring
// `redactions`) and a process warning is the secondary, in-the-moment signal
// — the write still succeeds either way. A correction record's whole job is
// sometimes to quote a dead id on purpose; rejecting would block exactly the
// record that repairs the trail.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IdeateConfigV3 } from '../config/ideate-config.js';
import { recordPath } from '../config/ideate-config.js';
import { scanAndMask } from '../secret-gate/scan.js';
import type { Redaction } from '../secret-gate/scan.js';
import type { TelemetryCounters } from '../telemetry/counters.js';
import { lintFreeText } from '../transport/id-lint.js';
import type { IdResolver, UnresolvedId } from '../transport/id-lint.js';
import type { Clock, UlidGenerator } from './id.js';
import { createUlidGenerator, isUlid, parseUlidTimestamp } from './id.js';
import type { ProcessRecord, RecordReference, RecordSource } from './schema.js';
import { RecordSchemaError, parseRecord, serializeRecord, validateRecord } from './schema.js';

/**
 * Record-ish append input. The store assigns `id` when absent and stamps
 * `source.timestamp` from the injected clock when absent; every other field
 * must be PRESENT (empty string is a valid value — absence is a schema
 * error).
 */
export interface RecordInput {
  /** Optional pre-minted ULID (e.g. from the other capture transport). */
  id?: string;
  kind: string;
  claim: string;
  verification_anchor: string;
  scope: string;
  source: {
    capture_point: string;
    session_id: string;
    task_id?: string;
    /** Defaults to the store clock's current time (ISO-8601). */
    timestamp?: string;
  };
  /** Typed forward edges to other records (e.g. `supersedes`). Defaults to `[]`. */
  references?: RecordReference[];
  content: string;
}

/**
 * A record enriched with its DERIVED reverse edges — `referenced_by[i]` means
 * "record `id` points at this one with `rel`" (so a `supersedes` forward edge
 * surfaces here as a `supersedes` backlink on the superseded record). Derived
 * per read by {@link RecordStore.readViews}; never persisted.
 */
export type ProcessRecordView = ProcessRecord & { referenced_by: RecordReference[] };

/** Typed append failure classes. */
export type AppendErrorCode =
  /** The input is missing a required field or carries a malformed id. */
  | 'SCHEMA'
  /** The filesystem write (mkdir or file create) failed. */
  | 'WRITE';

/**
 * Append outcome. Failures are RETURNED, never thrown: capture must not
 * become a workflow failure for the host (mirrors telemetry's posture).
 */
export type AppendResult =
  | {
      ok: true;
      /** The record exactly as persisted (post-gate, id/timestamp assigned). */
      record: ProcessRecord;
      /** Absolute path of the written file. */
      path: string;
      /** Secret-gate tally for this record (see redaction routing note). */
      redactions: Redaction[];
      /**
       * Capture-time id-lint tally (correction 01KYV387QKRP3V330WAS6DX95K):
       * every ULID-shaped token found in this record's free text that did
       * NOT resolve against either store, in first-seen order across fields.
       * Empty on the common case. WARN, never reject — see id-lint.ts's own
       * header for why (a correction record's whole job is to quote a dead
       * id). `resolution: 'unknown'` means the check could not be answered
       * (P-45 — never conflated with a clean resolve).
       */
      unresolvedIds: UnresolvedId[];
    }
  | { ok: false; code: AppendErrorCode; reason: string };

/** Selection options for {@link RecordStore.read} — selection, not ranking. */
export interface ReadOptions {
  /**
   * Case-insensitive substring matched against each record's `scope`,
   * `kind`, and `source` fields (capture_point, session_id, task_id). A
   * record is selected when ANY of them matches. No scoring of any kind.
   */
  scope?: string;
  /**
   * EXACT-match id selector — the by-id fetch. Deliberately NOT folded into
   * `scope`'s substring haystack: an id is either the record you asked for or
   * it is not, and a substring match over ids would make a truncated or
   * mistyped id silently return a different record. At most one record can
   * match, since the id is the filename stem.
   */
  id?: string;
  /**
   * KEYSET boundary: select only records STRICTLY OLDER than this id
   * (`record.id < before_id`). The ULID id is a total order over the store —
   * it embeds its own mint time, and the shard directory is derived from that
   * same embedded time (see {@link RecordStore.append}) — so "older" is exactly
   * "lexicographically smaller", and one id is a complete page boundary.
   * Callers hand this in ALREADY DECODED: the opaque cursor and its typed
   * errors belong to the transports (record/read-page.ts), not the store.
   */
  before_id?: string;
  /** Maximum number of records returned (newest first). */
  limit?: number;
}

const RECORD_EXTENSION = '.md';
const YEAR_DIR = /^\d{4}$/;
const MONTH_DIR = /^\d{2}$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Per-instance memo of record FILES `readViews` has already read and parsed
 * for its `id`-unset (scope/`before_id`) path — the one that must read every
 * record above a page's boundary to keep backlinks complete (see
 * `readViews`'s docstring). WHY this exists: measured against this
 * project's own record (1,598 entries), a full exhaustive `record_read` walk
 * (`limit: 100`) took 1,598/100 ≈ 16 page calls, and each one — with no
 * memo — re-opened and re-parsed every file above its own boundary, so the
 * walk's total cost was quadratic in the record count (O(n²/limit) file
 * reads).
 *
 * The memo is split deliberately into two costs that behave very
 * differently, and only one of them is ever cached:
 * - The DIRECTORY LISTING (which shard dirs and filenames currently exist)
 *   is NEVER cached — `readViews` re-lists the whole tree, fresh, on EVERY
 *   call (see `#idsNewestFirst`). Listing directories is cheap relative to
 *   reading files (a handful of `readdirSync` calls vs. one `readFileSync` +
 *   parse per record) — but cheap PER RECORD, not free: `#listDir`/`#listFiles`
 *   filter, map and sort each shard's entries, so one call costs O(total record
 *   count) and a page-to-exhaustion walk repeats it once per page. That residual
 *   is real and measured: per-doubling cost ratios climb 2.10x / 2.26x / 2.53x
 *   at N=400..3200, where true O(n) would sit flat at 2.0x. So this split buys a
 *   large CONSTANT-FACTOR win on the dominant term (file reads), NOT an
 *   asymptotic one — do not read "cheap" here as O(1). Removing the remaining
 *   superlinear term needs a cross-process index, which is a ratified-decision
 *   question rather than a local change. And re-listing is what makes a record written by
 *   ANOTHER process — the hook-invoked CLI writing while an MCP session's
 *   long-lived store instance is warm, the case this store's two transports
 *   exist to support — visible on this instance's very next call. A prior
 *   design cached the listing itself (a paused generator over a snapshot
 *   taken once); that made a foreign write silently invisible for the rest
 *   of the process's life, which is the regression this split fixes.
 * - The FILE CONTENTS (`parsedById`) and the derived forward-edge index
 *   (`referrers`) built from them ARE cached, permanently, because a record
 *   file is immutable once written (append-only, exclusive `wx` create — see
 *   `append`): a file this instance has already opened and parsed never
 *   needs opening again, cross-process write or not. There is no generation
 *   counter and nothing here is ever invalidated wholesale — `parsedById`
 *   only ever grows, and each entry's referrer contribution is added exactly
 *   once, at the moment that id is first parsed (a reference always points
 *   at an OLDER, i.e. already-scanned-by-then, record — see
 *   `RecordReference` — so the contribution is complete the instant it is
 *   made and never changes again).
 *
 * NOT a cursor cache: nothing here is keyed by, or looked up via, an opaque
 * `next_cursor` token — a caller that presents a cursor this instance has
 * never seen (a fresh process, a different store) gets exactly the same
 * correct answer, just without the file-read speedup, because the cache is
 * consulted purely as an optimization over this instance's OWN prior file
 * reads, never as a requirement for decoding what the cursor means.
 */
/**
 * UNBOUNDED GROWTH — MEASURED, ACCEPTED FOR NOW (P-40 sibling-parity sweep,
 * the record store's own deferred minor, decided here rather than fixed):
 * `parsedById`/`referrers` never evict, so a long-lived instance (the MCP
 * context memoizes one `RecordStore` per server session) retains every
 * record it has ever read for the rest of that session. Measured against
 * this project's own live store (`.ideate-record/`, 2,382 records, ~10 MB on
 * disk) via a full `readViews({})` walk on a fresh instance, with the
 * returned array discarded and only the instance's own retained heap
 * observed (`node --expose-gc`, forced GC before/after): the WalkCache's
 * retained footprint is ~9.3 MB (~4 KB/record) — negligible next to any
 * process's baseline memory, and a second full walk added no further growth
 * (confirming the cache reaches a steady state rather than climbing per
 * call). Extrapolated linearly, a 25,000-record store (~10x this project's
 * current size) would retain on the order of ~100 MB, still well inside an
 * ordinary long-lived server process's budget. ACCEPT as-is: no eviction is
 * added by this sweep. Re-measure before accepting again at an order of
 * magnitude larger store, or if a long-running MCP session's actual RSS is
 * ever observed to be dominated by this cache rather than assumed.
 *
 * The byte figure above is a snapshot, not something this repo re-checks on
 * every run — heap measurement varies with GC timing, Node version, and
 * concurrent load, so asserting it in a test would be a flaky guard (worse
 * than none: it trains people to ignore red). What IS mechanically pinned,
 * in store.test.ts's "WalkCache growth is structural" describe block via
 * the {@link RecordStore.walkCacheEntryCountForTest} test-only accessor, is
 * the DETERMINISTIC property that "growth is linear and reaches steady
 * state" actually means: the memo holds exactly one entry per record this
 * instance has read, and a second identical walk adds no further entries.
 * That test fails for the right reason if the memo is ever made to grow per
 * CALL instead of per RECORD; it does not, and is not meant to, re-derive
 * the 9.3 MB/2,382-record figure itself. Re-run the byte measurement by hand
 * (see the paragraph above for the method) if that number itself needs
 * reconfirming.
 */
interface WalkCache {
  /** Every record this instance has read and parsed, keyed by id. Permanent:
   *  a file's contents never change once written, so an entry never goes
   *  stale and is never evicted. */
  parsedById: Map<string, ProcessRecord>;
  /** Full-store forward-edge index, contributed by each record exactly once,
   *  at the moment `parsedById` first gains its entry. */
  referrers: Map<string, RecordReference[]>;
}

/** Add `record`'s forward references to `referrers` as reverse (backlink)
 *  entries — the one piece of bookkeeping every parse of a record performs,
 *  wherever that parse happens (a fresh `readViews` file read, or an
 *  `append` warming the memo with the record it just wrote). */
function addReferrerContribution(referrers: Map<string, RecordReference[]>, record: ProcessRecord): void {
  for (const ref of record.references) {
    const list = referrers.get(ref.id);
    const back: RecordReference = { rel: ref.rel, id: record.id };
    if (list === undefined) referrers.set(ref.id, [back]);
    else list.push(back);
  }
}

/**
 * The process-record store. One instance per session/process; its ULID
 * generator carries the per-session entropy.
 *
 * The exported API is append + read. There is deliberately NO update, NO
 * delete, and NO rank — see the three-property guard note above.
 */
export class RecordStore {
  readonly #config: IdeateConfigV3;
  readonly #projectRoot: string;
  readonly #telemetry: TelemetryCounters;
  readonly #clock: Clock;
  readonly #nextId: UlidGenerator;
  /** Cross-store id-lint resolver (transport/id-resolver.ts composes the
   *  real one) — OPTIONAL and trailing so every existing constructor call
   *  keeps compiling unchanged; every PRODUCTION composition root wires a
   *  real one (record/tools.ts, cli/ideate-record.ts,
   *  work-state/completion-record.ts). Absent is treated as "every candidate
   *  resolves 'unknown'" by id-lint.ts's `lintFreeText` — never as "nothing
   *  to check" (P-45). */
  readonly #resolveId: IdResolver | undefined;
  /** The current memo, or `undefined` before the first `readViews({..})` call
   *  that needs one; see {@link WalkCache} — never invalidated, only extended. */
  #walkCache: WalkCache | undefined;

  constructor(config: IdeateConfigV3, projectRoot: string, telemetry: TelemetryCounters, clock: Clock, resolveId?: IdResolver) {
    this.#config = config;
    this.#projectRoot = projectRoot;
    this.#telemetry = telemetry;
    this.#clock = clock;
    this.#nextId = createUlidGenerator(clock);
    this.#resolveId = resolveId;
  }

  /** The resolved record directory — always via config's single resolver. */
  get recordDir(): string {
    return recordPath(this.#config, this.#projectRoot);
  }

  /**
   * O(1) record-id existence check — the record half of the cross-store
   * id-lint resolver (transport/id-resolver.ts). A single `existsSync` on
   * the shard path computed from `id`'s own embedded timestamp
   * (the same private `#shardDirAndPath` `append` uses) — never a directory walk, and never a
   * `readViews`/`read` call (see this file's header on WalkCache's known
   * superlinear cost). A malformed (non-ULID) `id` cannot name a record, so
   * it answers `false` rather than throwing.
   */
  hasRecord(id: string): boolean {
    if (!isUlid(id)) return false;
    return existsSync(this.#shardDirAndPath(id).filePath);
  }

  /**
   * TEST-ONLY. The number of records currently memoized in this instance's
   * {@link WalkCache} (`#walkCache.parsedById.size`), or `0` before any
   * `readViews` call has populated one. Exists solely so store.test.ts can
   * mechanically pin the WalkCache doc comment's structural growth claim —
   * one memo entry per record READ, never per CALL, reaching a steady state
   * on a repeat walk — without asserting a byte figure (which would vary
   * with GC timing/Node version and flake). Deliberately NOT part of the
   * store's read/append contract; nothing outside a test should ever
   * observe or depend on this number.
   */
  get walkCacheEntryCountForTest(): number {
    return this.#walkCache?.parsedById.size ?? 0;
  }

  /**
   * Gate, then persist, one record. Runs scanAndMask over ALL text fields
   * before any filesystem write; assigns the id if absent; writes to the
   * `YYYY/MM` shard derived from the id's own timestamp (so the shard is a
   * pure function of the filename stem); fires `capture_fired` on success.
   * On ANY failure fires `capture_write_failed` and RETURNS a typed failure.
   */
  append(input: RecordInput): AppendResult {
    // Best-effort telemetry attribution, safe even against malformed input.
    const point =
      typeof input?.source?.capture_point === 'string' && input.source.capture_point.length > 0
        ? input.source.capture_point
        : 'unknown';
    const sessionId =
      typeof input?.source?.session_id === 'string' && input.source.session_id.length > 0
        ? input.source.session_id
        : 'unknown';

    let record: ProcessRecord;
    let id: string;
    try {
      if (input?.id !== undefined && !isUlid(input.id)) {
        throw new RecordSchemaError('id', `record store: provided id is not a well-formed ULID: ${JSON.stringify(input.id)}`);
      }
      id = input?.id ?? this.#nextId();
      const timestamp = input?.source?.timestamp ?? this.#clock().toISOString();
      record = validateRecord({ ...input, id, source: { ...input?.source, timestamp } });
      // Validate reference ids as ULIDs at the write chokepoint. Done AFTER
      // validateRecord (which confirms the {rel, id} shape) so a shape error
      // surfaces as its own SCHEMA failure, and done here — not in
      // validateReferences — so the READ path (parseRecord → validateRecord)
      // stays lenient: a record already on disk with a malformed reference id
      // is still readable (its prose/other fields aren't lost), it merely has
      // a dangling edge. Rejecting at write time prevents the typo from ever
      // persisting; every write transport (MCP, CLI, migration) funnels here.
      for (let i = 0; i < record.references.length; i++) {
        const ref = record.references[i];
        if (ref === undefined || !isUlid(ref.id)) {
          throw new RecordSchemaError(
            `references[${i}].id`,
            `record store: reference id is not a well-formed ULID: ${JSON.stringify(ref?.id)}`,
          );
        }
      }
    } catch (err) {
      const reason = errorMessage(err);
      this.#telemetry.captureWriteFailed(point, sessionId, reason);
      return { ok: false, code: 'SCHEMA', reason };
    }

    // GATE BEFORE PERSIST: mask every text field. Nothing below this block
    // ever touches the pre-gate strings again.
    const redactions: Redaction[] = [];
    const gate = (text: string): string => {
      const result = scanAndMask(text, {
        onRedaction: (pattern, count) => {
          redactions.push({ pattern, count });
          // Primary signal: the dedicated sixth counter (see the
          // redaction-telemetry routing note in the file header).
          this.#telemetry.redactionApplied(pattern, count, sessionId);
          // Secondary signal: a process warning, kept so the hook transport
          // can surface the redaction on the host's stderr in the moment.
          process.emitWarning(
            `ideate record: secret gate masked ${String(count)} match(es) of ${pattern} before persisting record ${id}`,
            { code: 'IDEATE_RECORD_REDACTION' },
          );
        },
      });
      return result.content;
    };
    const source: RecordSource = {
      capture_point: gate(record.source.capture_point),
      session_id: gate(record.source.session_id),
      timestamp: gate(record.source.timestamp),
      ...(record.source.task_id === undefined ? {} : { task_id: gate(record.source.task_id) }),
    };
    const masked: ProcessRecord = {
      id: record.id, // store-minted or ULID-validated; never free text
      kind: gate(record.kind),
      claim: gate(record.claim),
      verification_anchor: gate(record.verification_anchor),
      scope: gate(record.scope),
      source,
      // Gate both members of every edge — same gate-before-persist posture as
      // every other text field; ULIDs and rel tokens never match a secret
      // pattern, so this is a no-op in practice but keeps the invariant total.
      references: record.references.map((ref) => ({ rel: gate(ref.rel), id: gate(ref.id) })),
      content: gate(record.content),
    };

    // CAPTURE-TIME ID-LINT (correction 01KYV387QKRP3V330WAS6DX95K): scan the
    // genuinely free-form PROSE fields for ULID-shaped tokens that resolve
    // against neither store. Deliberately NOT every gated field:
    //   - `kind` and `references[].rel` are controlled vocabulary, not prose
    //     a citation would land in.
    //   - `source.capture_point` is a system-derived tag ('mcp:record_append').
    //   - `source.session_id` is ULID-SHAPED BY CONSTRUCTION (record/tools.ts
    //     and cli/ideate-record.ts both stamp `mcp-<ULID>`/`cli-<ULID>`) — the
    //     concrete false-positive this lint must not report on: it is a
    //     session identifier, never a citation, and would warn on EVERY
    //     record if included. Pinned in store.test.ts.
    //   - `source.timestamp` is a structured ISO-8601 string, not prose.
    //   - `references[].id` is out of scope by the item's own non-goal. Note
    //     for the record: this store's write chokepoint validates a
    //     reference id's ULID FORMAT only (isUlid, above) — unlike the
    //     board's dag.ts, it has no existence check for a reference target,
    //     so a well-formed-but-nonexistent references[].id can persist
    //     today. That is a real, pre-existing gap, but it is a DIFFERENT
    //     mechanism (dangling-edge validation) than this lint (free-text
    //     citation scanning) and this item's non-goal excludes references
    //     either way, so it is intentionally left untouched here.
    // `id` (the record's own, freshly assigned/validated) is never scanned:
    // it is an identifier, not free text a person wrote.
    const lintTexts = [masked.claim, masked.verification_anchor, masked.scope, masked.content];
    if (masked.source.task_id !== undefined) lintTexts.push(masked.source.task_id);
    const unresolvedIds = lintFreeText(lintTexts, this.#resolveId);
    for (const unresolved of unresolvedIds) {
      process.emitWarning(
        unresolved.resolution === 'unknown'
          ? `ideate record: id-lint could not verify ${unresolved.id} cited in record ${id} — no cross-store resolver was available (P-45: treat as unverified, not as fine)`
          : `ideate record: id-lint found ${unresolved.id} cited in record ${id} that does not resolve as a record or a work item — if this is a correction quoting a dead id on purpose, no action is needed`,
        { code: unresolved.resolution === 'unknown' ? 'IDEATE_RECORD_ID_LINT_UNAVAILABLE' : 'IDEATE_RECORD_UNRESOLVED_ID' },
      );
    }

    // Shard from the ULID's embedded timestamp: `record.path/YYYY/MM/{id}.md`.
    const { shardDir, filePath } = this.#shardDirAndPath(masked.id);

    try {
      mkdirSync(shardDir, { recursive: true });
      // `wx`: exclusive create — the medium enforces append-only; an
      // existing record can never be overwritten through this store.
      writeFileSync(filePath, serializeRecord(masked), { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      const reason = errorMessage(err);
      this.#telemetry.captureWriteFailed(point, sessionId, reason);
      return { ok: false, code: 'WRITE', reason };
    }

    this.#telemetry.captureFired(point, sessionId);
    // Warm the memo (see WalkCache) with the record just written, if one
    // exists: we already hold the exact bytes now on disk, so there is no
    // reason to make the next `readViews` call re-open the file it re-lists.
    // Nothing is invalidated — the memo is never stale, only ever extended —
    // and this is purely an optimization: skipping this warm entirely would
    // still be correct, just one file read short of free, because `readViews`
    // re-lists the directory tree (never a cached listing) on every call.
    if (this.#walkCache !== undefined && !this.#walkCache.parsedById.has(masked.id)) {
      this.#walkCache.parsedById.set(masked.id, masked);
      addReferrerContribution(this.#walkCache.referrers, masked);
    }
    return { ok: true, record: masked, path: filePath, redactions, unresolvedIds };
  }

  /** The `record.path/YYYY/MM/{id}.md` shard directory and file path for
   *  `id` — a pure function of the id alone (see the file-export contract in
   *  the file header), shared by {@link append} (which creates it) and
   *  {@link #getParsed} (which reads it, never re-deriving it from a
   *  directory listing it already has the id from). */
  #shardDirAndPath(id: string): { shardDir: string; filePath: string } {
    const minted = parseUlidTimestamp(id);
    const year = String(minted.getUTCFullYear()).padStart(4, '0');
    const month = String(minted.getUTCMonth() + 1).padStart(2, '0');
    const shardDir = join(this.recordDir, year, month);
    return { shardDir, filePath: join(shardDir, `${id}${RECORD_EXTENSION}`) };
  }

  /**
   * Read records straight off the sharded files, newest first — no index,
   * no cache. The date sharding plus ULID filename sort
   * give reverse-chronological order for free: walk year dirs descending,
   * month dirs descending, filenames descending.
   *
   * `scope` is a SELECTION filter (simple substring match against scope /
   * kind / source fields), never a ranking; `id`/`before_id` select by exact
   * id and by keyset boundary; `limit` caps the count. Files that fail to
   * parse are skipped with a warning — a stray file must not poison every read.
   *
   * `id` and `before_id` are answered from the FILENAME, before any file is
   * opened: the filename stem IS the record id, so a read that names one id
   * costs a directory listing plus ONE file read rather than a full parse of
   * the store. (The parsed record's own `id` is re-checked below, so a
   * hand-edited file whose frontmatter disagrees with its name cannot answer
   * as some other record.)
   */
  read(options?: ReadOptions): ProcessRecord[] {
    const scopeFilter = this.#scopeFilter(options);
    const limit = this.#limit(options);
    const selectId = options?.id;
    const beforeId = options?.before_id;
    const out: ProcessRecord[] = [];
    if (limit === 0) return out;
    const wanted = (id: string): boolean =>
      (selectId === undefined || id === selectId) && (beforeId === undefined || id < beforeId);
    for (const record of this.#recordsNewestFirst(wanted)) {
      if (!wanted(record.id)) continue;
      if (scopeFilter !== undefined && !matchesScope(record, scopeFilter)) continue;
      out.push(record);
      // An id is unique, so the one match ends the walk — no point listing the
      // rest of the store to find a second record that cannot exist.
      if (out.length >= limit || selectId !== undefined) return out;
    }
    return out;
  }

  /**
   * Like {@link read}, but each returned record carries its DERIVED reverse
   * edges in `referenced_by` — so a caller reading a superseded record sees it
   * was superseded without having to scan forward itself.
   *
   * A reference target is always OLDER than its referrer (you can only
   * reference an id that already exists), so walking newest-first guarantees
   * every referrer of a returned record has already been seen by the time
   * that record is emitted. The referrer map is built from EVERY scanned
   * record — including ones the scope filter excludes from the result — so a
   * backlink is never missed just because the referring record didn't match
   * the filter. Completeness is therefore bounded only by `limit`: records
   * past the cap aren't returned, and their referrers (newer) were already
   * scanned, so no returned record loses a backlink.
   *
   * THE SAME ARGUMENT IS WHAT MAKES PAGING SAFE, and it is also what this
   * method may NOT optimize away. Under `before_id` every emitted record is
   * OLDER than the boundary while its referrers are NEWER — i.e. on an EARLIER
   * page — so the walk still starts at the newest record and reads everything
   * above the boundary purely to build the referrer map. A backlink from a
   * record on another page therefore still appears; page 4 of a walk shows the
   * same `referenced_by` the unpaged read would have. Filename-level skipping
   * (which {@link read} uses for both selectors) is admissible here ONLY for
   * the `id` selector, and only DOWNWARD: a record older than the requested one
   * can neither be it nor reference it, so those files are never opened. Kept
   * as its own branch below, entirely separate from the WalkCache path, since
   * it is already bounded and touching it would only add risk.
   *
   * The `id`-unset (scope/`before_id`) path is the one an exhaustive page-to-
   * exhaustion walk actually drives, and it is the one {@link WalkCache} memo-
   * izes: "read everything above the boundary" is unavoidable (weakening it
   * is the backlink-completeness violation this store exists to prevent — see
   * the paragraph above), but redoing every FILE READ from scratch on every
   * one of a walk's pages is not. This instance remembers every record it has
   * already opened and parsed and never re-reads a file it already has, so a
   * walk's total file-read cost across ALL its pages becomes proportional to
   * the record count once, not once per page.
   *
   * The DIRECTORY LISTING, in contrast, is deliberately NOT memoized — every
   * call re-lists the whole shard tree fresh (see `#idsNewestFirst`), so a
   * record written between two calls, by this instance's own `append` or by
   * another process sharing the same on-disk store, is picked up on the very
   * next call rather than silently staying invisible for the rest of this
   * instance's life. See {@link WalkCache} for why splitting the memo this
   * way — cache the (expensive) file reads, never the (cheap) listing —
   * keeps both properties at once.
   */
  readViews(options?: ReadOptions): ProcessRecordView[] {
    const scopeFilter = this.#scopeFilter(options);
    const limit = this.#limit(options);
    const selectId = options?.id;
    const beforeId = options?.before_id;
    if (limit === 0) return [];

    if (selectId !== undefined) {
      const mustRead = (id: string): boolean => id >= selectId;
      const referrers = new Map<string, RecordReference[]>();
      for (const record of this.#recordsNewestFirst(mustRead)) {
        addReferrerContribution(referrers, record);
        if (record.id !== selectId) continue;
        // An id is unique: this is the only record that can ever match, so
        // this is the walk's last useful iteration either way. Mirror
        // `read`'s AND of every selector (scope, id, before_id) before
        // answering — the id-fastpath above must narrow the result, never
        // widen it past what the unindexed `read` sibling would return for
        // the identical options.
        if (beforeId !== undefined && !(record.id < beforeId)) return [];
        if (scopeFilter !== undefined && !matchesScope(record, scopeFilter)) return [];
        return [{ ...record, referenced_by: referrers.get(record.id) ?? [] }];
      }
      return [];
    }

    const cache = this.#walkCache ?? (this.#walkCache = { parsedById: new Map(), referrers: new Map() });
    const out: ProcessRecordView[] = [];
    for (const id of this.#idsNewestFirst()) {
      const record = this.#getParsed(cache, id);
      if (record === undefined) continue; // unparseable file — skipped, already warned
      if (beforeId !== undefined && !(record.id < beforeId)) continue;
      if (scopeFilter !== undefined && !matchesScope(record, scopeFilter)) continue;
      out.push({ ...record, referenced_by: cache.referrers.get(record.id) ?? [] });
      if (out.length >= limit) return out;
    }
    return out;
  }

  /** Return `id`'s parsed record from the memo, reading and parsing the file
   *  only on a cache miss — the file-read half of {@link WalkCache}. Adds the
   *  record's forward-reference contribution to `cache.referrers` at the
   *  same moment it is first parsed (never again — see WalkCache). `undefined`
   *  on an unparseable file, warned exactly as {@link #recordsNewestFirst}
   *  does, so a stray file cannot poison this walk either. */
  #getParsed(cache: WalkCache, id: string): ProcessRecord | undefined {
    const cached = cache.parsedById.get(id);
    if (cached !== undefined) return cached;
    const { filePath } = this.#shardDirAndPath(id);
    let record: ProcessRecord;
    try {
      record = parseRecord(readFileSync(filePath, 'utf8'));
    } catch (err) {
      process.emitWarning(
        `ideate record: skipping unparseable record file ${filePath} (${errorMessage(err)})`,
        { code: 'IDEATE_RECORD_UNPARSEABLE' },
      );
      return undefined;
    }
    cache.parsedById.set(id, record);
    addReferrerContribution(cache.referrers, record);
    return record;
  }

  /**
   * Every record id across the whole store, newest-first — a pure directory
   * LISTING (`readdirSync` on the year dirs, the month dirs, and each shard's
   * filenames), never a file open. This is the operation {@link readViews}
   * re-runs on every call so a foreign write is never missed (see
   * {@link WalkCache}); it is cheap relative to a file read precisely because
   * it never touches file contents.
   */
  *#idsNewestFirst(): Generator<string> {
    for (const year of this.#listDir(this.recordDir, YEAR_DIR)) {
      for (const month of this.#listDir(join(this.recordDir, year), MONTH_DIR)) {
        for (const file of this.#listFiles(join(this.recordDir, year, month))) {
          yield file.slice(0, -RECORD_EXTENSION.length);
        }
      }
    }
  }

  /** Normalized, validated lower-cased scope filter (undefined = no filter). */
  #scopeFilter(options?: ReadOptions): string | undefined {
    return options?.scope?.toLowerCase();
  }

  /** Normalized, validated limit (Infinity = no limit); throws on a bad value. */
  #limit(options?: ReadOptions): number {
    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new RangeError(`record store: limit must be a non-negative integer, got ${String(options.limit)}`);
    }
    return options?.limit ?? Number.POSITIVE_INFINITY;
  }

  /**
   * Walk the sharded record files newest-first, yielding each parsed record —
   * no index, no cache. Year dirs descending, month dirs
   * descending, ULID filenames descending give reverse-chronological order for
   * free. Unparseable files are skipped with a warning so one stray file can't
   * poison the walk. Shared by {@link read} and {@link readViews}.
   *
   * `mustRead` is an optional FILENAME-level predicate over the record id
   * (the filename stem): a file it rejects is never opened. It is a cost
   * optimization only — every caller re-checks its selectors against the
   * PARSED record — so passing nothing yields the whole store, and passing an
   * over-eager predicate can only cost reads, never correctness.
   */
  *#recordsNewestFirst(mustRead?: (id: string) => boolean): Generator<ProcessRecord> {
    for (const year of this.#listDir(this.recordDir, YEAR_DIR)) {
      for (const month of this.#listDir(join(this.recordDir, year), MONTH_DIR)) {
        const shardDir = join(this.recordDir, year, month);
        for (const file of this.#listFiles(shardDir)) {
          if (mustRead !== undefined && !mustRead(file.slice(0, -RECORD_EXTENSION.length))) continue;
          const filePath = join(shardDir, file);
          try {
            yield parseRecord(readFileSync(filePath, 'utf8'));
          } catch (err) {
            process.emitWarning(
              `ideate record: skipping unparseable record file ${filePath} (${errorMessage(err)})`,
              { code: 'IDEATE_RECORD_UNPARSEABLE' },
            );
          }
        }
      }
    }
  }

  /** Descending-sorted subdirectory names matching `pattern`; [] if unreadable. */
  #listDir(dir: string, pattern: RegExp): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && pattern.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Descending-sorted `{ulid}.md` filenames in a shard; [] if unreadable. */
  #listFiles(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(RECORD_EXTENSION) && isUlid(e.name.slice(0, -RECORD_EXTENSION.length)))
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}

/** Plain substring SELECTION across scope/kind/source — no scoring, ever. */
function matchesScope(record: ProcessRecord, needle: string): boolean {
  const haystacks = [
    record.scope,
    record.kind,
    record.source.capture_point,
    record.source.session_id,
    record.source.task_id ?? '',
  ];
  return haystacks.some((h) => h.toLowerCase().includes(needle));
}
