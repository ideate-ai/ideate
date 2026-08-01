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
// Forward-edge persistence (one mental model across all three stores): the
// `references` frontmatter field stores ONLY the forward typed edge
// (`supersedes` primary — a CROSS-item replacement naming a DIFFERENT item
// this one replaces, distinct from the WITHIN-item lifecycle of `status` +
// `history`). The reverse edge — `superseded_by` — is DERIVED on read by
// {@link SteeringStore.readViews}, never stored, so the two directions can
// never drift. Edge ids are validated at the write chokepoint before persist
// (well-formed steering id → typed SCHEMA; target existence → typed
// DANGLING_SUPERSEDES), so a typo can never land as a silent dangling edge —
// the record and work-state stores' exact posture, adapted to this store's
// caller-chosen stem ids (no ULIDs here).
//
// The steering directory is resolved here from a module default rather than a
// config block; the `steeringPath` constructor option is the seam a config
// resolver can feed.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scanAndMask } from '../secret-gate/scan.js';
import { encodeListCursor, parseListCursorPayload } from '../transport/keyset-page.js';
import type { ListItemsPage } from '../transport/keyset-page.js';
import type { Clock } from '../record/id.js';
import type { SteeringItem, SteeringReference, SteeringStatus } from './schema.js';
import { SteeringSchemaError, isSteeringId, parseSteeringItem, serializeSteeringItem, validateSteeringItem } from './schema.js';

/** Default steering directory, relative to the project root (probe default). */
export const DEFAULT_STEERING_PATH = '.ideate/steering/';

/**
 * The largest page {@link SteeringStore.readViewsPage} will ever return,
 * whatever a caller asks for. The DEFAULT page size deliberately does NOT live
 * here — it is a transport decision (steering/tools.ts), because an absent
 * `limit` must keep meaning "every matching item" for the in-repo sweep in
 * context/assemble-prototype.ts, which needs the WHOLE set to derive
 * `supersedes` backlinks. A default parked in this store would silently
 * truncate that sweep and destroy supersession detection.
 */
export const MAX_STEERING_READ_LIMIT = 500;

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
  /**
   * Optional typed FORWARD edges to other steering items (`supersedes`
   * primary — a cross-item replacement naming the item this one replaces).
   * ABSENT on amend = carry the prior edge list unchanged (mirrors `status`'s
   * default-to-prior rule); PRESENT — including `[]`, which clears every edge
   * — replaces the list wholesale. Every edge id is guarded at write time:
   * a well-formed steering id (typed SCHEMA) AND an existing item (typed
   * DANGLING_SUPERSEDES — existence only, deliberately NO cycle check: a
   * replacement edge is not a DAG, mirroring work-state/dag.ts's
   * assertSupersedesTargetsExist). The reverse edge is derived on read,
   * never supplied here.
   */
  references?: SteeringReference[];
}

/** Typed put failure classes. */
export type PutErrorCode =
  /** The input is missing a required field or carries a malformed id/status/edge. */
  | 'SCHEMA'
  /** A `references` edge targets an item that does not exist. */
  | 'DANGLING_SUPERSEDES'
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
  /**
   * Exact id filter — the by-id RETRIEVAL path, expressed as one more
   * SELECTION filter rather than a second verb (the steering surface stays at
   * two verbs). Matches at most one item, since the id is the filename stem.
   */
  id?: string;
  /** Case-insensitive substring matched against `domain`. */
  domain?: string;
  /** Exact status filter. */
  status?: SteeringStatus;
  /** Exact kind filter. */
  kind?: string;
}

/**
 * Keyset paging arguments for {@link SteeringStore.readViewsPage}.
 *
 * ABSENT `limit` = no bound at all: every selected item, `next_cursor: null`.
 * That is the contract the in-repo sweep (context/assemble-prototype.ts, via
 * {@link SteeringStore.readViews}) depends on; the DEFAULT page size is
 * applied at the transport, never here.
 */
export interface SteeringPageOptions {
  /** Page size. ABSENT = unbounded; present = clamped into `[1, MAX_STEERING_READ_LIMIT]`. */
  limit?: number;
  /** The opaque boundary returned as a previous page's `next_cursor`. */
  cursor?: string;
}

/** The decoded form of a steering page cursor: the `(updated_at, id)` boundary
 *  of the last row of the previous page, in this store's one stable order. */
export interface SteeringCursor {
  updated_at: string;
  id: string;
}

/**
 * Decode a steering page cursor, or throw `SteeringSchemaError` — THIS seam's
 * own typed error. The board's `WorkStateError` is deliberately unreachable
 * from here: steering does not import work-state (GP-26 narrow seams), so a
 * steering caller can never be handed another store's failure type.
 *
 * The mechanical half — canonical base64url + JSON — is the shared, neutral
 * {@link parseListCursorPayload} (transport/keyset-page.ts), which returns
 * rather than throws precisely so each seam can raise its own error. The
 * canonical round-trip check inside it is what stops a padded / wrong-alphabet
 * / short-group / non-canonical-tail string from decoding to a plausible
 * boundary and degrading into an empty page a caller reads as "no more items".
 *
 * The SHAPE check is this seam's own, because the tuple is: steering pages
 * over `(updated_at, id)` — its items are MUTABLE and every `put` restamps
 * `updated_at` — where the board and the record page over `created_at`.
 *
 * WHAT IS NOT GUARANTEED — the CONTENTS. A well-formed cursor naming a
 * boundary no item ever had decodes cleanly and simply selects nothing. That
 * is deliberate: the same "nothing after this boundary" answer is the correct
 * one at true exhaustion, so there is nothing to distinguish it from. Cursors
 * are OPAQUE — callers echo back a value this store minted.
 *
 * The offending value is NEVER echoed into the message (P-24): this text flows
 * out through the MCP error surface, which does not gate free text.
 */
export function decodeSteeringCursor(cursor: string): SteeringCursor {
  const parsed = parseListCursorPayload(cursor);
  if (!parsed.ok) {
    throw new SteeringSchemaError(
      'cursor',
      parsed.problem === 'not-canonical-base64url'
        ? 'steering store: "cursor" is not a valid page cursor (expected the opaque next_cursor from a previous steering_read page)'
        : 'steering store: "cursor" is not a valid page cursor (undecodable payload) — pass back the next_cursor from a previous steering_read page',
    );
  }
  const value = parsed.value;
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
    throw new SteeringSchemaError('cursor', 'steering store: "cursor" is not a valid page cursor (expected an encoded [updated_at, id] boundary)');
  }
  return { updated_at: value[0], id: value[1] };
}

/**
 * Clamp a caller-supplied page size into `[1, MAX_STEERING_READ_LIMIT]`.
 * Clamping, not rejecting, is deliberate for an out-of-range size (0, a
 * negative, or 9999 all yield a usable page); a NON-INTEGER limit is a
 * different failure class — a caller bug about the SHAPE of the argument, not
 * its magnitude — and stays a typed schema error. Mirrors the board's
 * `clampListLimit` in posture, not by import (GP-26).
 */
export function clampSteeringReadLimit(limit: number): number {
  if (!Number.isInteger(limit)) {
    // String(), not JSON.stringify(): NaN/Infinity both serialize to `null` as
    // JSON, which would name the wrong problem back to the caller.
    throw new SteeringSchemaError('limit', `steering store: "limit" must be an integer, got ${String(limit)}`);
  }
  if (limit < 1) return 1;
  return Math.min(limit, MAX_STEERING_READ_LIMIT);
}

/**
 * A steering item enriched with its DERIVED reverse edges — `referenced_by[i]`
 * means "item `id` points at this one with `rel`" (so a `supersedes` forward
 * edge surfaces here as a `superseded_by`-style backlink on the superseded
 * item). Derived per read by {@link SteeringStore.readViews}; never persisted —
 * the store writes ONLY the forward edge, mirroring record/store.ts's
 * `ProcessRecordView`.
 */
export type SteeringItemView = SteeringItem & { referenced_by: SteeringReference[] };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The LIGHT steering store. One instance per session/process. The exported
 * API is `put` (create-or-amend, the one mutable verb) + `read`/`readViews`
 * (unranked, selection-only; `readViews` additionally derives the
 * `referenced_by` backlinks — e.g. `superseded_by` — over every item). There
 * is deliberately NO hard delete and NO rank/score — deprecate via status;
 * rank in the assembler, not here.
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

    // EMPTY-STATEMENT GUARD (P-41, 2026-07-30): a steering item that PERSISTS
    // with no operative text is strictly worse than one that never shipped —
    // it reads to every downstream agent as "this rule was written and
    // checked" while carrying zero content (exactly what emptied 21 of 63
    // active rules in this project for 8 days via a migrator whose
    // `[a, b].filter(Boolean).join(': ')` silently degrades to `''` when
    // neither source field is present). This is the mechanical check GP-24
    // calls for: reject the property (no operative text) at the one write
    // chokepoint, rather than trust every caller to infer it.
    //
    // Deliberately at `put()`, NOT in schema.ts's `requireString` — that
    // validator also PARSES every existing on-disk file (including items
    // already degraded before this guard existed), and an already-blank item
    // must still be READABLE (so it can be found and restored) even though it
    // can no longer be WRITTEN. The empty check runs on the RAW input, before
    // gating: masking a secret never turns non-empty text into empty text, so
    // pre- and post-gate emptiness agree, but checking the raw value keeps
    // this guard legible without depending on the gate's behavior.
    if (typeof input?.statement !== 'string' || input.statement.trim().length === 0) {
      return {
        ok: false,
        code: 'SCHEMA',
        reason:
          'steering store: "statement" must be non-empty prose — an empty or whitespace-only statement would ship a rule/principle with no operative text; ' +
          `got ${input?.statement === undefined ? 'absent' : JSON.stringify(input.statement)}`,
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
    // Forward edges: ABSENT on amend carries the prior item's edges unchanged
    // (status's exact default-to-prior rule); PRESENT — including `[]` — is
    // the new full list. Shape-validated by validateSteeringItem FIRST (a
    // malformed edge list must surface as a typed SCHEMA failure, never a raw
    // throw — put's contract), gated after validation and before persist like
    // every other free-text field (rel tokens and stem ids never match a
    // secret pattern, so gating is a no-op in practice but keeps the invariant
    // total — the record and work-state stores' exact posture on their own
    // references fields).
    const rawReferences: unknown = input.references ?? prior?.references ?? [];

    let item: SteeringItem;
    try {
      const validated = validateSteeringItem({
        id: input.id, // already validated as a safe stem
        kind: gate(requireField(input.kind, 'kind')),
        domain: gate(input.domain ?? ''),
        status,
        updated_at: this.#clock().toISOString(),
        statement: gate(requireField(input.statement, 'statement')),
        history,
        references: rawReferences,
      });
      item = { ...validated, references: validated.references.map((ref) => ({ rel: gate(ref.rel), id: gate(ref.id) })) };
    } catch (err) {
      return { ok: false, code: 'SCHEMA', reason: errorMessage(err) };
    }

    // Reference guards at the write chokepoint (the store is the one write
    // path — every transport funnels here). Well-formedness FIRST (typed
    // SCHEMA), then EXISTENCE (typed DANGLING_SUPERSEDES), so the two failure
    // classes stay distinct — the record and work-state stores' exact split.
    // Existence only, deliberately no cycle sibling: a replacement edge is not
    // a sequencing DAG (an item may legitimately be superseded by something
    // that itself gets superseded).
    for (const ref of item.references) {
      if (!isSteeringId(ref.id)) {
        return {
          ok: false,
          code: 'SCHEMA',
          reason: `steering store: references id must be a filename-safe stem [A-Za-z0-9][A-Za-z0-9._-]*; got ${JSON.stringify(ref.id)}`,
        };
      }
    }
    const missing = item.references
      .filter((ref) => !this.#targetIsReadable(ref.id))
      .map((ref) => ref.id);
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'DANGLING_SUPERSEDES',
        reason: `steering store: references target nonexistent or unparseable item(s): ${missing.join(', ')}`,
      };
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
   *
   * P-40 SIBLING-PARITY SWEEP (record/store.ts's WalkCache follow-up): this
   * store holds no cross-call state to check for staleness — `#scanItems`
   * re-`readdirSync`s and re-parses every file on every call, so a foreign
   * write is visible on the very next read by construction (pinned
   * behaviorally by store.test.ts's "cross-process freshness" test). If a
   * FILE-CONTENTS memo is ever added here to speed up a hot path, the record
   * store's "cache contents, never the listing" split is NOT a free transfer:
   * that split is safe there only because record files are immutable
   * (`append()`'s `wx` exclusive-create — nothing ever rewrites a record
   * `.md`). Steering items are the opposite: every `put` OVERWRITES the
   * existing file in place (`w`) and restamps `updated_at`. A parsed-contents
   * memo keyed by id would go stale the moment ANY process amends that item,
   * which record's premise does not guard against — a steering memo would
   * need its own freshness check (e.g. mtime), not a copy of WalkCache.
   */
  read(options?: SteeringReadOptions): SteeringItem[] {
    return this.#select(this.#scanItems(), options);
  }

  /**
   * Like {@link read}, but each returned item carries its DERIVED reverse
   * edges in `referenced_by` — so a caller reading a superseded item sees what
   * replaced it without scanning the steering tree itself. The referrer map is
   * built from EVERY parseable item — including ones the selection filters
   * exclude from the result — so a backlink is never missed just because the
   * referring item didn't match the filter (record/store.ts readViews' exact
   * completeness posture). Built over the newest-first scan, so each target's
   * backlink list reads newest-first. Cost is one full scan of a handful of
   * small files; no index.
   */
  readViews(options?: SteeringReadOptions): SteeringItemView[] {
    const items = this.#scanItems();
    const referrers = new Map<string, SteeringReference[]>();
    for (const item of items) {
      for (const ref of item.references) {
        const list = referrers.get(ref.id);
        const back: SteeringReference = { rel: ref.rel, id: item.id };
        if (list === undefined) referrers.set(ref.id, [back]);
        else list.push(back);
      }
    }
    return this.#select(items, options).map((item) => ({ ...item, referenced_by: referrers.get(item.id) ?? [] }));
  }

  /**
   * One KEYSET PAGE of {@link readViews} — the same selection, the same derived
   * backlinks, bounded to `page.limit` items and resumable from an opaque
   * `next_cursor` over `(updated_at, id)`. An ABSENT `limit` means every
   * selected item and `next_cursor: null`, so the unbounded in-repo sweep is
   * still expressible here; the default page size belongs to the transport.
   *
   * BACKLINKS ARE PAGE-INDEPENDENT: `readViews` builds the referrer map from
   * EVERY parseable item before this method takes a slice, so an item's
   * `referenced_by` never depends on which page it landed on (the board's
   * "claimable is computed against the WHOLE board" posture).
   *
   * KEYSET, not OFFSET, and the predicate has MIXED DIRECTIONS because the
   * order does: `updated_at` DESC with `id` ASC as the tiebreak (see
   * {@link #scanItems}). Resuming after `cur` therefore means
   * `updated_at < cur.updated_at OR (updated_at == cur.updated_at AND id >
   * cur.id)` — the id arm points the OPPOSITE way from the timestamp arm, and
   * getting it backwards would silently skip or repeat every tied item. The
   * comparisons use exactly the comparator `#scanItems` sorts with
   * (`localeCompare` for ids), so the predicate and the order cannot disagree.
   *
   * THE CAVEAT, stated honestly: `updated_at` is MUTABLE — every `put`
   * restamps it — so unlike a `created_at` keyset this walk is NOT immune to
   * concurrent writes. Amending an item mid-walk moves it to the front of the
   * order, and an item that had not been reached yet can be pushed past the
   * cursor and missed by that walk. This is accepted deliberately: steering is
   * human-curated at roughly one edit per session, exhaustive walks are rare,
   * and keying on `id` instead would abandon the newest-first presentation the
   * skills and the context assembler rely on. A walk that must not miss an
   * amendment should be re-run.
   */
  readViewsPage(options?: SteeringReadOptions, page?: SteeringPageOptions): ListItemsPage<SteeringItemView> {
    // Argument validation FIRST, so a malformed limit/cursor is a typed
    // failure even on a steering tree that selects nothing — a bad argument
    // must not be swallowed by an empty result.
    const limit = page?.limit === undefined ? undefined : clampSteeringReadLimit(page.limit);
    const cursor = page?.cursor === undefined ? undefined : decodeSteeringCursor(page.cursor);

    const selected = this.readViews(options);
    const after =
      cursor === undefined
        ? selected
        : selected.filter(
            (item) => item.updated_at < cursor.updated_at || (item.updated_at === cursor.updated_at && item.id.localeCompare(cursor.id) > 0),
          );
    if (limit === undefined) return { items: after, next_cursor: null };
    const rows = after.slice(0, limit);
    const last = rows.at(-1);
    // `after.length > limit` is the "a next page exists" probe — the in-memory
    // twin of the board's `LIMIT n+1` extra row.
    return { items: rows, next_cursor: after.length > limit && last !== undefined ? encodeListCursor(last.updated_at, last.id) : null };
  }

  /**
   * All parseable items, newest-first by `updated_at` (id tie-break) — the one
   * full scan shared by {@link read} and {@link readViews}. Unparseable files
   * are skipped with a warning so one stray file can't poison the walk (nor
   * silently drop a backlink source without a trace).
   */
  #scanItems(): SteeringItem[] {
    const out: SteeringItem[] = [];
    for (const file of this.#listFiles()) {
      const filePath = join(this.#steeringDir, file);
      try {
        out.push(parseSteeringItem(readFileSync(filePath, 'utf8')));
      } catch (err) {
        process.emitWarning(`ideate steering: skipping unparseable item file ${filePath} (${errorMessage(err)})`, {
          code: 'IDEATE_STEERING_UNPARSEABLE',
        });
        continue;
      }
    }
    out.sort((a, b) => (a.updated_at === b.updated_at ? a.id.localeCompare(b.id) : a.updated_at < b.updated_at ? 1 : -1));
    return out;
  }

  /**
   * Existence-AND-readability check for a supersedes target: the file must
   * exist AND parse as a valid steering item. A bare `existsSync` would accept
   * a corrupted file (bad frontmatter) that every read then skips with an
   * IDEATE_STEERING_UNPARSEABLE warning — so a reader would follow a
   * replacement edge to an item that appears not to exist (the
   * misleading-reader outcome the dangling guard exists to prevent). Mirrors
   * work-state's getItem-resolves-only-readable-rows posture. A missing file
   * and an unparseable file both mean "not a readable target" here.
   */
  #targetIsReadable(id: string): boolean {
    const filePath = join(this.#steeringDir, `${id}${STEERING_EXTENSION}`);
    try {
      parseSteeringItem(readFileSync(filePath, 'utf8'));
      return true;
    } catch {
      return false;
    }
  }

  /** SELECTION only — exact id, domain substring, exact status, exact kind.
   *  Never ranks. */
  #select<T extends SteeringItem>(items: T[], options?: SteeringReadOptions): T[] {
    const domainFilter = options?.domain?.toLowerCase();
    return items.filter(
      (item) =>
        (options?.id === undefined || item.id === options.id) &&
        (domainFilter === undefined || item.domain.toLowerCase().includes(domainFilter)) &&
        (options?.status === undefined || item.status === options.status) &&
        (options?.kind === undefined || item.kind === options.kind),
    );
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
