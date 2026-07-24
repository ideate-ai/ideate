// plugin/src/steering/store.ts — the LIGHT steering store core.
//
// A lean, MUTABLE steering surface beside record/ and work-state/. It persists
// a handful of steering items (guiding principles + policies) as one
// Markdown/YAML file per item under a resolved steering directory, mirroring
// record/store.ts's on-disk form.
//
// Two structural departures from record/store.ts:
//
//   1. MUTABLE, not append-only. The record store opens files with `wx`
//      (exclusive create) so no write can ever overwrite — that is the
//      append-only guard enforced by the medium. Steering EVOLVES: policies
//      amend, guiding principles re-scope, items deprecate. `put` overwrites in
//      place (`w`), appending the prior version to `history` so no state is
//      silently lost. There is no hard delete — deprecate by flipping `status`.
//
//   2. FLAT id-keyed files, not date-sharded ULIDs. A steering item's id is
//      stable and caller-chosen (`GP-01`, `POL-auth-1`) and IS the filename
//      stem, so amending an item rewrites the SAME file. Records are
//      immutable events sharded by mint time; steering items are mutable
//      entities keyed by identity.
//
// Preserved from record/store.ts: the secret gate runs over EVERY text field
// BEFORE any filesystem write (gate-before-persist), and `read` performs
// SELECTION only — substring/field filters, never scoring or ranking. Ranking
// over the selected set is the assembler's job, never this store's.
//
// The steering directory is resolved here from a module default rather than a
// config block; the `steeringPath` constructor option is the seam a config
// resolver can feed.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scanAndMask } from '../secret-gate/scan.js';
import type { Clock } from '../record/id.js';
import type { SteeringItem, SteeringStatus } from './schema.js';
import { SteeringSchemaError, isSteeringId, parseSteeringItem, serializeSteeringItem, validateSteeringItem } from './schema.js';

/** Default steering directory, relative to the project root (probe default). */
export const DEFAULT_STEERING_PATH = '.ideate/steering/';

const STEERING_EXTENSION = '.md';

/**
 * Create-or-amend input for {@link SteeringStore.put}. `updated_at` is stamped
 * from the injected clock; `history` is managed by the store (prior state is
 * appended on amend), never supplied by the caller.
 */
export interface SteeringPutInput {
  id: string;
  kind: string;
  domain?: string;
  status?: SteeringStatus;
  statement: string;
}

/** Typed put failure classes. */
export type PutErrorCode =
  /** The input is missing a required field or carries a malformed id/status. */
  | 'SCHEMA'
  /** The filesystem write (mkdir or file write) failed. */
  | 'WRITE';

/**
 * Put outcome. Failures are RETURNED, never thrown (mirrors the record
 * store's posture): a steering write must not become a workflow failure.
 */
export type PutResult =
  | {
      ok: true;
      /** The item exactly as persisted (post-gate, history updated). */
      item: SteeringItem;
      /** Absolute path of the written file. */
      path: string;
      /** True when this write amended an existing item (vs created a new one). */
      amended: boolean;
    }
  | { ok: false; code: PutErrorCode; reason: string };

/** Selection options for {@link SteeringStore.read} — selection, not ranking. */
export interface SteeringReadOptions {
  /** Case-insensitive substring matched against `domain`. */
  domain?: string;
  /** Exact status filter. */
  status?: SteeringStatus;
  /** Exact kind filter. */
  kind?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The LIGHT steering store. One instance per session/process. The exported
 * API is `put` (create-or-amend, the one mutable verb) + `read` (unranked,
 * selection-only). There is deliberately NO hard delete and NO rank/score —
 * deprecate via status; rank in the assembler, not here.
 */
export class SteeringStore {
  readonly #steeringDir: string;
  readonly #clock: Clock;

  constructor(projectRoot: string, clock: Clock, options?: { steeringPath?: string }) {
    this.#steeringDir = resolve(projectRoot, options?.steeringPath ?? DEFAULT_STEERING_PATH);
    this.#clock = clock;
  }

  /** The resolved steering directory. */
  get steeringDir(): string {
    return this.#steeringDir;
  }

  /**
   * Gate, then persist, one steering item — create-or-amend. Runs scanAndMask
   * over EVERY text field before any filesystem write; stamps `updated_at`
   * from the injected clock. On amend (the file already exists), the prior
   * version is pushed onto `history` (newest-first) so no state is lost;
   * status defaults to the prior status on amend, `active` on create. On ANY
   * failure RETURNS a typed failure (never throws).
   */
  put(input: SteeringPutInput): PutResult {
    // Validate the id up front — it is the filename stem, so a malformed id
    // must never reach the filesystem.
    if (typeof input?.id !== 'string' || !isSteeringId(input.id)) {
      return {
        ok: false,
        code: 'SCHEMA',
        reason: `steering store: id must be a filename-safe stem [A-Za-z0-9][A-Za-z0-9._-]*; got ${JSON.stringify(input?.id)}`,
      };
    }

    const filePath = join(this.#steeringDir, `${input.id}${STEERING_EXTENSION}`);

    // Load the prior version, if any, to build the amendment trail.
    let prior: SteeringItem | undefined;
    try {
      prior = parseSteeringItem(readFileSync(filePath, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A corrupt/unparseable existing file is a hard failure — never
        // clobber it blind, never lose its content silently.
        return { ok: false, code: 'SCHEMA', reason: `steering store: existing item ${input.id} is unreadable: ${errorMessage(err)}` };
      }
    }

    // GATE BEFORE PERSIST: mask every text field. Nothing below touches the
    // pre-gate strings again.
    const gate = (text: string): string => scanAndMask(text).content;

    const history = prior === undefined ? [] : [{ at: prior.updated_at, status: prior.status, statement: prior.statement }, ...prior.history];
    const status = input.status ?? prior?.status ?? 'active';

    let item: SteeringItem;
    try {
      item = validateSteeringItem({
        id: input.id, // already validated as a safe stem
        kind: gate(requireField(input.kind, 'kind')),
        domain: gate(input.domain ?? ''),
        status,
        updated_at: this.#clock().toISOString(),
        statement: gate(requireField(input.statement, 'statement')),
        history,
      });
    } catch (err) {
      return { ok: false, code: 'SCHEMA', reason: errorMessage(err) };
    }

    try {
      mkdirSync(this.#steeringDir, { recursive: true });
      // `w`: create-or-overwrite — steering is MUTABLE (the key departure from
      // the record store's `wx`). The prior version is preserved in `history`.
      writeFileSync(filePath, serializeSteeringItem(item), { encoding: 'utf8', flag: 'w' });
    } catch (err) {
      return { ok: false, code: 'WRITE', reason: errorMessage(err) };
    }

    return { ok: true, item, path: filePath, amended: prior !== undefined };
  }

  /**
   * Read steering items straight off the files — no index, no cache. Applies
   * SELECTION filters only (domain substring, exact status, exact kind); never
   * scores or ranks. Returned newest-first by `updated_at` (id tie-break) for
   * deterministic order. Files that fail to parse are skipped with a warning —
   * a stray file must not poison every read.
   */
  read(options?: SteeringReadOptions): SteeringItem[] {
    const domainFilter = options?.domain?.toLowerCase();
    const out: SteeringItem[] = [];

    for (const file of this.#listFiles()) {
      const filePath = join(this.#steeringDir, file);
      let item: SteeringItem;
      try {
        item = parseSteeringItem(readFileSync(filePath, 'utf8'));
      } catch (err) {
        process.emitWarning(`ideate steering: skipping unparseable item file ${filePath} (${errorMessage(err)})`, {
          code: 'IDEATE_STEERING_UNPARSEABLE',
        });
        continue;
      }
      if (domainFilter !== undefined && !item.domain.toLowerCase().includes(domainFilter)) continue;
      if (options?.status !== undefined && item.status !== options.status) continue;
      if (options?.kind !== undefined && item.kind !== options.kind) continue;
      out.push(item);
    }

    out.sort((a, b) => (a.updated_at === b.updated_at ? a.id.localeCompare(b.id) : a.updated_at < b.updated_at ? 1 : -1));
    return out;
  }

  /** `{id}.md` filenames in the steering dir; [] if the dir is absent/unreadable. */
  #listFiles(): string[] {
    try {
      return readdirSync(this.#steeringDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(STEERING_EXTENSION) && isSteeringId(e.name.slice(0, -STEERING_EXTENSION.length)))
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}

/** Require a string field present (empty allowed) at the store boundary. */
function requireField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SteeringSchemaError(field, `steering store: field "${field}" must be present as a string (empty allowed); got ${value === undefined ? 'absent' : typeof value}`);
  }
  return value;
}
