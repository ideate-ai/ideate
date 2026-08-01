// plugin/src/usage/store.ts — the append-only context-usage (citation) signal
// store: the queryable effectiveness DENOMINATOR the context-quality gate reads.
//
// Shape: one NDJSON file (`<usageDir>/citations.ndjson`), one signal per line.
// This mirrors telemetry's append-only NDJSON (counters.ts), NOT the record
// store's one-file-per-entry Markdown — a usage signal is structured
// measurement data, so a single append-only log with atomic O_APPEND writes is
// the right medium (two concurrent sessions never corrupt it; there is no
// read-modify-write).
//
// Append-only BY API ABSENCE (same discipline as record/store.ts): the
// exported surface is `record` (append one signal) + `query`/`usedItemIds`
// (read). There is deliberately NO update, NO delete, and NO rank/score — the
// store SELECTS by exact-match filter; any ranking is a consumer's job over the
// selected set, never the store's.
//
// Path resolution: the usage directory is INJECTED (like telemetry's state
// dir), not read from `.ideate.json`. This module adds no config key — the
// composition edge (usage/tools.ts) defaults it to `<projectRoot>/.ideate/usage`,
// keeping this module free of the config schema and byte-preserving for every
// existing `.ideate.json`.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Clock, UlidGenerator } from '../record/id.js';
import { createUlidGenerator } from '../record/id.js';
import { USAGE_KIND_USED_CONTEXT } from './schema.js';
import type { UsageSignal } from './schema.js';
import { UsageSchemaError, parseUsageSignal, serializeUsageSignal, validateUsageSignal } from './schema.js';

/** The NDJSON filename within the resolved usage directory. */
export const USAGE_LOG_FILENAME = 'citations.ndjson';

/**
 * Append input. The store assigns `id` and stamps `source.timestamp` from the
 * injected clock when absent; `kind` defaults to `used_context`. Every other
 * required field must be present (empty ids are rejected — see schema).
 */
export interface UsageInput {
  /** Defaults to {@link USAGE_KIND_USED_CONTEXT}. */
  kind?: string;
  item_id: string;
  seed_id?: string;
  manifest_id?: string;
  source: {
    capture_point: string;
    session_id: string;
    task_id?: string;
    /** Defaults to the store clock's current time (ISO-8601). */
    timestamp?: string;
  };
}

/** Exact-match SELECTION filter for {@link UsageStore.query} — no scoring. A
 *  signal is selected only when it matches EVERY provided field (AND). */
export interface UsageQuery {
  item_id?: string;
  seed_id?: string;
  manifest_id?: string;
  task_id?: string;
  session_id?: string;
  kind?: string;
}

/**
 * The v3 context-usage store. One instance per session/process; its ULID
 * generator carries per-session entropy (record/id.ts).
 *
 * The exported API is append + read. There is deliberately NO update, NO
 * delete, and NO rank — see the append-only note above.
 *
 * P-40 SIBLING-PARITY SWEEP (record/store.ts's WalkCache follow-up): `query`
 * holds no cross-call state — it is a bare `readFileSync` of the one NDJSON
 * log on every call, with no directory listing step to even split a memo
 * along (there is exactly one file). A foreign process's `record()` is
 * therefore visible on this instance's very next `query()` by construction
 * (pinned behaviorally by store.test.ts's "cross-process freshness" test).
 */
export class UsageStore {
  readonly #dir: string;
  readonly #file: string;
  readonly #clock: Clock;
  readonly #nextId: UlidGenerator;

  constructor(usageDir: string, clock: Clock, nextId?: UlidGenerator) {
    this.#dir = usageDir;
    this.#file = join(usageDir, USAGE_LOG_FILENAME);
    this.#clock = clock;
    this.#nextId = nextId ?? createUlidGenerator(clock);
  }

  /** The resolved NDJSON log path. */
  get logPath(): string {
    return this.#file;
  }

  /**
   * Append one usage signal. Assigns the id and stamps the timestamp when
   * absent, validates, then does a single atomic O_APPEND write. Returns the
   * signal exactly as persisted. Throws {@link UsageSchemaError} on invalid
   * input (an empty `item_id`, a malformed source) BEFORE any write.
   */
  record(input: UsageInput): UsageSignal {
    const id = this.#nextId();
    const timestamp = input.source.timestamp ?? this.#clock().toISOString();
    const signal = validateUsageSignal({
      id,
      kind: input.kind ?? USAGE_KIND_USED_CONTEXT,
      item_id: input.item_id,
      ...(input.seed_id === undefined ? {} : { seed_id: input.seed_id }),
      ...(input.manifest_id === undefined ? {} : { manifest_id: input.manifest_id }),
      source: { ...input.source, timestamp },
    });
    mkdirSync(this.#dir, { recursive: true });
    // `a`: O_APPEND — a single atomic write per line; concurrent sessions
    // interleave whole lines, never corrupt one. Append-only: there is no
    // other write path, no seek, no truncate.
    appendFileSync(this.#file, `${serializeUsageSignal(signal)}\n`, { encoding: 'utf8', flag: 'a' });
    return signal;
  }

  /**
   * Read signals matching `filter`, in append (chronological) order — the
   * ULID ids and O_APPEND order both give oldest-first for free. Lines that
   * fail to parse are skipped with a warning so a stray line never poisons a
   * read. Selection only: exact-match AND over the filter fields, no scoring.
   */
  query(filter: UsageQuery = {}): UsageSignal[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      return []; // no log yet == no signals
    }
    const out: UsageSignal[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      let signal: UsageSignal;
      try {
        signal = parseUsageSignal(line);
      } catch (err) {
        if (err instanceof UsageSchemaError) {
          process.emitWarning(`ideate usage: skipping unparseable citation line (${err.message})`, {
            code: 'IDEATE_USAGE_UNPARSEABLE',
          });
          continue;
        }
        throw err;
      }
      if (matchesFilter(signal, filter)) out.push(signal);
    }
    return out;
  }

  /**
   * The distinct delivered items that were USED under `filter`, in first-seen
   * order. This IS the effectiveness denominator: for a seed (task), the set
   * of items the worker actually used = the ground-truth "relevant" set the
   * context-quality metric computes recall against. `query({ seed_id })` then `usedItemIds` gives the
   * per-task denominator directly.
   */
  usedItemIds(filter: UsageQuery = {}): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const signal of this.query(filter)) {
      if (seen.has(signal.item_id)) continue;
      seen.add(signal.item_id);
      out.push(signal.item_id);
    }
    return out;
  }
}

/** Exact-match AND over the provided filter fields; missing fields match all. */
function matchesFilter(signal: UsageSignal, filter: UsageQuery): boolean {
  if (filter.item_id !== undefined && signal.item_id !== filter.item_id) return false;
  if (filter.seed_id !== undefined && signal.seed_id !== filter.seed_id) return false;
  if (filter.manifest_id !== undefined && signal.manifest_id !== filter.manifest_id) return false;
  if (filter.task_id !== undefined && signal.source.task_id !== filter.task_id) return false;
  if (filter.session_id !== undefined && signal.source.session_id !== filter.session_id) return false;
  if (filter.kind !== undefined && signal.kind !== filter.kind) return false;
  return true;
}
