// plugin/src/record/store.ts — the single shared write/read core of the v3
// process record (WI-271).
//
// Spec: docs/design/v3-architecture.md §2.1 (one Markdown file per record,
// ULID filename stems, date-sharded `record.path/YYYY/MM/{id}.md`) and §2.2
// (reads go straight to the sharded files — NO index ships, no cache);
// docs/spikes/v3-boundary-contract.md §4.2 (the three-property guard) and
// §6.2 (the four contract fields). Both capture transports — the MCP
// `record_append` handler and the hook-invoked CLI — write through this one
// implementation.
//
// The three-property guard (§4.2), enforced here BY API ABSENCE:
// - Project-local: the store resolves exactly one project's record path (via
//   config/ideate-config.ts's recordPath — THE single resolver; this module
//   never computes `<root>/<record.path>` itself).
// - Append-only: there is NO update, NO delete. Files are opened with `wx`
//   (exclusive create), so no code path can overwrite an existing record. A
//   correction is a NEW record referencing the superseded id. The §4.2
//   extraordinary-redaction exception is a documented MANUAL procedure —
//   deliberately, this store exposes no verb for it.
// - Never curated or ranked: `read` performs SELECTION only (substring
//   match, newest-first file order, a limit cap). No scoring, no decay, no
//   promotion — no rank/score function exists anywhere in this API.
//
// Gate-before-persist: EVERY text field (frontmatter values and prose body)
// passes through the secret gate's scanAndMask BEFORE any filesystem write.
// There is no code path that persists ungated content — the masked record is
// the only thing ever serialized.
//
// Redaction telemetry routing (WI-271 design note): scan.ts's `onRedaction`
// is specced to feed capture telemetry, but TelemetryCounters is a CLOSED
// five-counter set ("There is no sixth" — telemetry/counters.ts) with no
// redaction counter, and this work item may not modify telemetry's files.
// Misrouting redactions through `capture_fired` (a pseudo capture point) or
// `capture_write_failed` (a redaction is a SUCCESSFUL gate action, not a
// failure) would pollute both dashboards. The honest wiring chosen here:
// each redaction emits a process warning (code IDEATE_RECORD_REDACTION,
// naming the pattern and count — NEVER the content) and the per-pattern
// tally is returned on the append result, so callers/tests observe it. The
// dedicated counter lands when the telemetry counter set grows one.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { IdeateConfigV3 } from '../config/ideate-config.js';
import { recordPath } from '../config/ideate-config.js';
import { scanAndMask } from '../secret-gate/scan.js';
import type { Redaction } from '../secret-gate/scan.js';
import type { TelemetryCounters } from '../telemetry/counters.js';
import type { Clock, UlidGenerator } from './id.js';
import { createUlidGenerator, isUlid, parseUlidTimestamp } from './id.js';
import type { ProcessRecord, RecordSource } from './schema.js';
import { RecordSchemaError, parseRecord, serializeRecord, validateRecord } from './schema.js';

/**
 * Record-ish append input. The store assigns `id` when absent and stamps
 * `source.timestamp` from the injected clock when absent; every other field
 * must be PRESENT (empty string is a valid value — absence is a schema
 * error, per boundary contract §6.2).
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
  content: string;
}

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
 * The v3 process-record store. One instance per session/process; its ULID
 * generator carries the per-session entropy of architecture §2.1.
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

  constructor(config: IdeateConfigV3, projectRoot: string, telemetry: TelemetryCounters, clock: Clock) {
    this.#config = config;
    this.#projectRoot = projectRoot;
    this.#telemetry = telemetry;
    this.#clock = clock;
    this.#nextId = createUlidGenerator(clock);
  }

  /** The resolved record directory — always via config's single resolver. */
  get recordDir(): string {
    return recordPath(this.#config, this.#projectRoot);
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
          // See the redaction-telemetry routing note in the file header:
          // logged, tallied on the result — no counter exists yet to fire.
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
      content: gate(record.content),
    };

    // Shard from the ULID's embedded timestamp: `record.path/YYYY/MM/{id}.md`.
    const minted = parseUlidTimestamp(masked.id);
    const year = String(minted.getUTCFullYear()).padStart(4, '0');
    const month = String(minted.getUTCMonth() + 1).padStart(2, '0');
    const shardDir = join(this.recordDir, year, month);
    const filePath = join(shardDir, `${masked.id}${RECORD_EXTENSION}`);

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
    return { ok: true, record: masked, path: filePath, redactions };
  }

  /**
   * Read records straight off the sharded files, newest first — no index,
   * no cache (architecture §2.2). The date sharding plus ULID filename sort
   * give reverse-chronological order for free: walk year dirs descending,
   * month dirs descending, filenames descending.
   *
   * `scope` is a SELECTION filter (simple substring match against scope /
   * kind / source fields), never a ranking; `limit` caps the count. Files
   * that fail to parse are skipped with a warning — a stray file must not
   * poison every read.
   */
  read(options?: ReadOptions): ProcessRecord[] {
    const scopeFilter = options?.scope?.toLowerCase();
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;
    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new RangeError(`record store: limit must be a non-negative integer, got ${String(options.limit)}`);
    }

    const out: ProcessRecord[] = [];
    if (limit === 0) return out;

    for (const year of this.#listDir(this.recordDir, YEAR_DIR)) {
      for (const month of this.#listDir(join(this.recordDir, year), MONTH_DIR)) {
        const shardDir = join(this.recordDir, year, month);
        const files = this.#listFiles(shardDir);
        for (const file of files) {
          const filePath = join(shardDir, file);
          let record: ProcessRecord;
          try {
            record = parseRecord(readFileSync(filePath, 'utf8'));
          } catch (err) {
            process.emitWarning(
              `ideate record: skipping unparseable record file ${filePath} (${errorMessage(err)})`,
              { code: 'IDEATE_RECORD_UNPARSEABLE' },
            );
            continue;
          }
          if (scopeFilter !== undefined && !matchesScope(record, scopeFilter)) continue;
          out.push(record);
          if (out.length >= limit) return out;
        }
      }
    }
    return out;
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
