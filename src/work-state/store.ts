// plugin/src/work-state/store.ts — the persistence core of the work-state
// contract.
//
// Covers the contract and local-mode equivalence (SQLite, WAL, busy-timeout).
// This module owns row<->type mapping and the storage PRIMITIVES only:
// insert, get, list, the metadata-update primitive (version bump), event
// append, and the per-item claim-token counter. Claim
// acquisition/renewal/completion semantics (compare-and-set, lease expiry,
// cycle detection) are OUT OF SCOPE — that is claims.ts and verbs.ts, built on
// top of these primitives.
//
// Gate-before-persist (mirrors record/store.ts): the free-text fields
// this layer accepts — `title`, an event's `note`, and the `rel` of every
// reference edge — pass through scanAndMask BEFORE any write. `spec` is
// deliberately NEVER gated: it is opaque, store-as-is, no code path may
// parse OR transform it (masking would be a transform). Edge ids are
// ULID-validated at the write chokepoint before persist, so a typo can never
// land as a silent dangling edge (the record store's exact posture).
//
// Forward-edge persistence (v3 schema): the `"references"` column stores
// ONLY the forward typed edge (`supersedes` primary). The reverse edge —
// `superseded_by` — is DERIVED on read by the view reads
// ({@link WorkStateStore.getItemView}/{@link WorkStateStore.listItemViews}),
// never stored: one stored direction, one mental model shared with the
// process-record store, and no forward/reverse drift is possible.
//
// Intentional narrowing beyond the contract: `title`, `spec`, and
// `spec_format` must be NON-EMPTY strings on insert. The contract is silent
// on minimum length; this layer treats an empty value as a caller bug.
// Presence-checked, never parsed — the opacity guarantee is untouched.
// Relax here if bare-task use ever matters; nothing downstream depends on
// non-emptiness.
//
// Reserved-field guard: `rank` is a reserved name. Any top-level `rank` key on
// a create/update-meta payload is rejected with a typed
// `WorkStateError('RESERVED_FIELD', ...)`. The other deliberately-absent
// fields (priority, estimates, sprints, labels, review states) simply have no
// place in the validated shape below — they are never read out of an input
// payload, so supplying them is a silent no-op rather than a stored field.
// Only `rank` gets the explicit, named rejection.
//
// Events table discipline: this file contains NO `UPDATE events` and NO
// `DELETE FROM events` statement — the only SQL touching `events` is the
// single INSERT in `insertEventRow` and the single SELECT in `events()`.
// That absence is what makes the events table append-only BY CONSTRUCTION,
// mechanically grep-falsifiable.

import type { DatabaseSync } from 'node:sqlite';

import { scanAndMask } from '../secret-gate/scan.js';
import type { Clock, UlidGenerator } from '../record/id.js';
import { createUlidGenerator, isUlid } from '../record/id.js';
import { openForRead, openForWrite } from './schema.js';
import { withBusyWrap, withWriteTransaction } from './tx.js';
import {
  DEFAULT_TENANT_ID,
  WorkStateError,
} from './types.js';
import type {
  ActorRef,
  AppendEventInput,
  Claim,
  NewWorkItemInput,
  UpdateMetaInput,
  WorkItem,
  WorkItemReference,
  WorkItemStatus,
  WorkStateEvent,
} from './types.js';

/**
 * Filter for {@link WorkStateStore.listItems} — selection only, no ranking.
 *
 * `parent_id` is the CONTAINMENT filter, and it is TRI-STATE — the
 * distinction between "key absent" and "key present with value null" is
 * load-bearing (mirrors `UpdateMetaInput.parent_id`; see types.ts):
 *   - ABSENT (key not on the filter): no containment filter — list everything
 *     matching tenant/status (the behavior before containment existed).
 *   - PRESENT as a string: CHILDREN-OF — only the direct children of that
 *     parent (`WHERE parent_id = ?`).
 *   - PRESENT as `null`: ROOTS-ONLY — only top-level items (`WHERE parent_id
 *     IS NULL`).
 * Direct children only (one level) — matches the board's existing direct-only
 * posture (`claimable`); no transitive/recursive query is added.
 */
export interface ListItemsFilter {
  tenant_id?: string;
  status?: WorkItemStatus;
  parent_id?: string | null;
}

/**
 * A work item enriched with its DERIVED reverse edges — `referenced_by[i]`
 * means "item `id` points at this one with `rel`" (so a `supersedes` forward
 * edge surfaces here as a `superseded_by`-style backlink on the superseded
 * item). Derived per read by {@link WorkStateStore.getItemView} and
 * {@link WorkStateStore.listItemViews}; never persisted — the board stores
 * ONLY the forward edge, mirroring record/store.ts's `ProcessRecordView`.
 */
export type WorkItemView = WorkItem & { referenced_by: WorkItemReference[] };

/** Gate one free-text field through the secret scanner before persist. */
function gate(text: string): string {
  return scanAndMask(text).content;
}

/** Gate every member of every reference edge before persist (see the
 *  gate-before-persist note in the file header). */
function gateReferences(references: readonly WorkItemReference[]): WorkItemReference[] {
  return references.map((ref) => ({ rel: gate(ref.rel), id: gate(ref.id) }));
}

/** Reject a reserved top-level field (`rank`) on a create/update payload. */
function assertNoReservedField(raw: Record<string, unknown>, context: string): void {
  if ('rank' in raw) {
    throw new WorkStateError(
      'RESERVED_FIELD',
      `work-state store: "rank" is a reserved field name and may not be supplied on a ${context} payload; encode any ordering hint inside "spec" instead`,
    );
  }
}

function requireObject(input: unknown, context: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkStateError('SCHEMA', `work-state store: a ${context} payload must be an object`);
  }
  return input as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new WorkStateError(
      'SCHEMA',
      `work-state store: field "${field}" must be a non-empty string; got ${value === undefined ? 'absent' : typeof value}`,
    );
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be a string when present`);
  }
  return value;
}

/**
 * Validate a `parent_id`-shaped field: a value whose domain legitimately
 * includes `null` (a real "root" value, NOT an "unchanged" sentinel — see
 * types.ts's `UpdateMetaInput.parent_id`). `null` passes through as `null`;
 * a string passes through as-is; anything else is a typed SCHEMA error.
 * Callers own the tri-state "key absent vs present" distinction (this helper
 * is only reached when the key IS present).
 */
function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be a string or null when present`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be an array of strings`);
  }
  return value as string[];
}

/**
 * Validate a `references` edge list (shape only — mirrors record/schema.ts's
 * validateReferences). Must be an array of `{rel, id}` objects with NON-EMPTY
 * strings: an empty `rel` or `id` is a malformed edge, not a valid empty
 * value. ULID well-formedness is checked separately at the write chokepoint
 * ({@link assertReferenceIdsAreUlids}) so the two failure classes stay
 * distinct, exactly the record store's split.
 */
function requireReferenceArray(value: unknown, field: string): WorkItemReference[] {
  if (!Array.isArray(value)) {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be an array of {rel, id}`);
  }
  return value.map((item, i): WorkItemReference => {
    const raw = requireObject(item, `${field}[${i}]`);
    const rel = requireNonEmptyString(raw['rel'], `${field}[${i}].rel`);
    const id = requireNonEmptyString(raw['id'], `${field}[${i}].id`);
    return { rel, id };
  });
}

/**
 * Validate every reference id as a well-formed ULID at the write chokepoint
 * (insertItem/updateMeta — every write transport funnels here), so a typo is
 * rejected with a typed SCHEMA error before it can persist as a silent
 * dangling edge. Mirrors record/store.ts's append-time check verbatim in
 * posture; target EXISTENCE is a separate, verb-level concern (dag.ts's
 * assertSupersedesTargetsExist).
 */
function assertReferenceIdsAreUlids(references: readonly WorkItemReference[], context: string): void {
  for (let i = 0; i < references.length; i++) {
    const ref = references[i];
    if (ref === undefined || !isUlid(ref.id)) {
      throw new WorkStateError(
        'SCHEMA',
        `work-state store: ${context} references[${String(i)}].id is not a well-formed ULID: ${JSON.stringify(ref?.id)}`,
      );
    }
  }
}

function validateActorRef(value: unknown, field: string): ActorRef {
  const raw = requireObject(value, field);
  const human = requireNonEmptyString(raw['human'], `${field}.human`);
  const agent = requireOptionalString(raw['agent'], `${field}.agent`);
  return agent === undefined ? { human } : { human, agent };
}

interface ValidatedNewWorkItemInput {
  tenant_id: string;
  title: string;
  spec: string;
  spec_format: string;
  depends_on: string[];
  /** The resolved CONTAINMENT parent: a parent id, or `null` for a
   *  root. Absent-or-null on the input both resolve to `null` here. */
  parent_id: string | null;
  /** Typed forward edges (supersedes primary); absent on the input resolves
   *  to `[]` here. Shape-validated; ids are ULID-checked at the chokepoint. */
  references: WorkItemReference[];
  created_by: ActorRef;
}

function validateNewWorkItemInput(input: unknown): ValidatedNewWorkItemInput {
  const raw = requireObject(input, 'create');
  assertNoReservedField(raw, 'create');
  return {
    tenant_id: requireOptionalString(raw['tenant_id'], 'tenant_id') ?? DEFAULT_TENANT_ID,
    title: requireNonEmptyString(raw['title'], 'title'),
    // `spec` is opaque: required-as-string, but never further inspected —
    // whatever bytes/text a tool supplies pass straight through unmodified.
    spec: requireNonEmptyString(raw['spec'], 'spec'),
    spec_format: requireNonEmptyString(raw['spec_format'], 'spec_format'),
    depends_on: raw['depends_on'] === undefined ? [] : requireStringArray(raw['depends_on'], 'depends_on'),
    // Containment parent: absent OR null both mean "create as a root".
    // Fully orthogonal to `depends_on` — never read against it here.
    parent_id: raw['parent_id'] === undefined ? null : requireNullableString(raw['parent_id'], 'parent_id'),
    references: raw['references'] === undefined ? [] : requireReferenceArray(raw['references'], 'references'),
    created_by: validateActorRef(raw['created_by'], 'created_by'),
  };
}

interface ValidatedUpdateMetaInput {
  title?: string;
  spec?: string;
  spec_format?: string;
  depends_on?: string[];
  /** Present iff the patch sets `parent_id`. ABSENT on this
   *  validated shape = leave unchanged; PRESENT (a string OR `null`) = the
   *  new value, where `null` clears the parent back to root. */
  parent_id?: string | null;
  /** Present iff the patch replaces the forward-edge list wholesale
   *  (`[]` clears every edge); ABSENT = unchanged — `depends_on`'s exact
   *  replace-semantics. */
  references?: WorkItemReference[];
}

function validateUpdateMetaInput(input: unknown): ValidatedUpdateMetaInput {
  const raw = requireObject(input, 'update_meta');
  assertNoReservedField(raw, 'update_meta');
  const out: ValidatedUpdateMetaInput = {};
  if (raw['title'] !== undefined) out.title = requireNonEmptyString(raw['title'], 'title');
  if (raw['spec'] !== undefined) out.spec = requireNonEmptyString(raw['spec'], 'spec');
  if (raw['spec_format'] !== undefined) out.spec_format = requireNonEmptyString(raw['spec_format'], 'spec_format');
  if (raw['depends_on'] !== undefined) out.depends_on = requireStringArray(raw['depends_on'], 'depends_on');
  // Tri-state: a `parent_id` key present with a string OR `null` is a
  // real set (`null` clears to root); a key absent (=== undefined) is left
  // unchanged. This is the one UpdateMeta field whose set value legitimately
  // includes `null` — see types.ts's `UpdateMetaInput.parent_id`.
  if (raw['parent_id'] !== undefined) out.parent_id = requireNullableString(raw['parent_id'], 'parent_id');
  if (raw['references'] !== undefined) out.references = requireReferenceArray(raw['references'], 'references');
  return out;
}

interface ValidatedAppendEventInput {
  item_id: string;
  actor: ActorRef;
  transition: string;
  claim_token?: number;
  note?: string;
  at: string;
}

function validateAppendEventInput(input: unknown, defaultAt: () => string): ValidatedAppendEventInput {
  const raw = requireObject(input, 'event');
  const item_id = requireNonEmptyString(raw['item_id'], 'item_id');
  const actor = validateActorRef(raw['actor'], 'actor');
  const transition = requireNonEmptyString(raw['transition'], 'transition');
  const claimTokenRaw = raw['claim_token'];
  if (claimTokenRaw !== undefined && typeof claimTokenRaw !== 'number') {
    throw new WorkStateError('SCHEMA', 'work-state store: field "claim_token" must be a number when present');
  }
  const note = requireOptionalString(raw['note'], 'note');
  const at = requireOptionalString(raw['at'], 'at') ?? defaultAt();
  return {
    item_id,
    actor,
    transition,
    ...(claimTokenRaw === undefined ? {} : { claim_token: claimTokenRaw }),
    ...(note === undefined ? {} : { note: gate(note) }),
    at,
  };
}

/** Row shape as returned by `SELECT * FROM items`. */
interface ItemRow {
  id: string;
  tenant_id: string;
  title: string;
  spec: string;
  spec_format: string;
  status: string;
  depends_on: string;
  /** The nullable CONTAINMENT column. A legacy read against a schema
   *  that predates the column would surface `undefined` — `rowToWorkItem`
   *  defaults that to `null` (a root). */
  parent_id: string | null;
  /** The forward-edge column (JSON array text). A legacy read against a
   *  pre-v3 schema (a below-current board opened read-only before the next
   *  write migrates it) would surface `undefined` — `rowToWorkItem` defaults
   *  that to `'[]'` (no edges), exactly `parent_id`'s defensive posture. */
  references: string;
  created_by_human: string;
  created_by_agent: string | null;
  created_at: string;
  updated_at: string;
  version: number | bigint;
  claim_holder_human: string | null;
  claim_holder_agent: string | null;
  claim_token: number | bigint | null;
  claim_acquired_at: string | null;
  claim_lease_expires: string | null;
}

function toNumber(value: number | bigint): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

function rowToWorkItem(row: ItemRow): WorkItem {
  const claim: Claim | null =
    row.claim_token === null
      ? null
      : {
          holder:
            row.claim_holder_agent === null
              ? { human: row.claim_holder_human as string }
              : { human: row.claim_holder_human as string, agent: row.claim_holder_agent },
          claim_token: toNumber(row.claim_token),
          acquired_at: row.claim_acquired_at as string,
          lease_expires: row.claim_lease_expires as string,
        };
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    title: row.title,
    spec: row.spec,
    spec_format: row.spec_format,
    status: row.status as WorkItemStatus,
    claim,
    depends_on: JSON.parse(row.depends_on) as string[],
    // Always present on a read (mirrors `claim`), `null` for a root.
    // `?? null` defends a legacy read where the column is absent.
    parent_id: row.parent_id ?? null,
    // Always present on a read (mirrors `depends_on`), `[]` for no edges.
    // `?? '[]'` defends a legacy read where the pre-v3 column is absent.
    references: JSON.parse(row.references ?? '[]') as WorkItemReference[],
    created_by:
      row.created_by_agent === null
        ? { human: row.created_by_human }
        : { human: row.created_by_human, agent: row.created_by_agent },
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: toNumber(row.version),
  };
}

interface EventRow {
  seq: number | bigint;
  item_id: string;
  actor_human: string;
  actor_agent: string | null;
  transition: string;
  claim_token: number | bigint | null;
  note: string | null;
  at: string;
}

function rowToEvent(row: EventRow): WorkStateEvent {
  return {
    item_id: row.item_id,
    actor: row.actor_agent === null ? { human: row.actor_human } : { human: row.actor_human, agent: row.actor_agent },
    transition: row.transition,
    ...(row.claim_token === null ? {} : { claim_token: toNumber(row.claim_token) }),
    ...(row.note === null ? {} : { note: row.note }),
    at: row.at,
  };
}

function getItemRow(db: DatabaseSync, id: string): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
}

/**
 * Build the reverse-edge map over EVERY item on the board: target id -> the
 * `{rel, id: referrer-id}` backlinks pointing at it. Scanned newest-created
 * first (the same order `listItems` emits), so each target's backlink list
 * reads newest-first, mirroring record/store.ts's readViews walk.
 *
 * The map is built from every row — NOT just the rows a list filter returns —
 * so a backlink is never missed just because the referring item didn't match
 * the filter (record/store.ts's exact completeness posture). Cost is one full
 * scan of a small board table; no index is added (GP-24's mechanical,
 * no-new-index posture).
 *
 * Legacy pre-v3 board (user_version < 3): the `"references"` column does not
 * exist yet, and a prepared SELECT naming it throws `no such column:
 * "references"` at PREPARE time — before any row is read, so a per-row
 * `?? '[]'` could never fire. View reads go through openForRead, which (by
 * design) does NOT migrate, so an unmigrated board would otherwise surface a
 * raw, untyped SQLite failure on a plain list/get. A pre-v3 board has no
 * edges by definition, so the guard returns an empty map; the migration rung
 * adds the column on the next write open. Same PRAGMA table_info existence
 * check schema.ts's migrateSchema uses for its guarded ADD COLUMN.
 */
function buildReferrerMap(db: DatabaseSync): Map<string, WorkItemReference[]> {
  const hasReferences = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some(
    (c) => c.name === 'references',
  );
  const referrers = new Map<string, WorkItemReference[]>();
  if (!hasReferences) return referrers; // legacy pre-v3 board — no edges by definition
  const rows = db
    .prepare('SELECT id, "references" FROM items ORDER BY created_at DESC, id DESC')
    .all() as unknown as { id: string; references: string }[];
  for (const row of rows) {
    for (const ref of JSON.parse(row.references ?? '[]') as WorkItemReference[]) {
      const list = referrers.get(ref.id);
      const back: WorkItemReference = { rel: ref.rel, id: row.id };
      if (list === undefined) referrers.set(ref.id, [back]);
      else list.push(back);
    }
  }
  return referrers;
}

/**
 * The one filtered-items SELECT, shared by `listItems` and `listItemViews`:
 * newest-created-first, optional tenant/status filters, and the tri-state
 * containment filter (see {@link ListItemsFilter}). `= NULL` cannot be
 * expressed via a bound param, so the roots-only case emits the literal
 * `parent_id IS NULL` clause with no param; the children-of case binds the
 * parent id. A `parent_id` key that is absent (or present-but-undefined)
 * applies no containment filter at all.
 */
function selectItemRows(db: DatabaseSync, filter?: ListItemsFilter): ItemRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.tenant_id !== undefined) {
    clauses.push('tenant_id = ?');
    params.push(filter.tenant_id);
  }
  if (filter?.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter !== undefined && 'parent_id' in filter) {
    const parentFilter = filter.parent_id;
    if (parentFilter === null) {
      clauses.push('parent_id IS NULL');
    } else if (parentFilter !== undefined) {
      clauses.push('parent_id = ?');
      params.push(parentFilter);
    }
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM items${where} ORDER BY created_at DESC, id DESC`).all(...params) as unknown as ItemRow[];
}

/** The single INSERT this module ever issues against `events`. A standalone
 *  function (not a class method) — it touches no store instance state — so
 *  both the class's own `appendEvent` and the internal-but-exported
 *  `appendEventRowOn` (below) share the exact one statement. */
function insertEventRow(db: DatabaseSync, event: ValidatedAppendEventInput): void {
  db.prepare(
    `INSERT INTO events (item_id, actor_human, actor_agent, transition, claim_token, note, at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.item_id,
    event.actor.human,
    event.actor.agent ?? null,
    event.transition,
    event.claim_token ?? null,
    event.note ?? null,
    event.at,
  );
}

/**
 * Append one immutable transition event on an ALREADY-OPEN connection, for a
 * caller that is running its own `BEGIN IMMEDIATE ... COMMIT` unit and needs
 * the event insert to commit atomically with the state transition it records
 * (every transition appends an immutable event — a crash between a
 * transition's own commit and a separately-connected event insert would
 * otherwise leave the transition unaudited). Internal-but-exported:
 * not part of `WorkStateStore`'s public surface (siblings import it
 * directly), but validation — including the secret gate on `note` — is
 * IDENTICAL to `appendEvent`'s; this is not a relaxed or partial path.
 * Callers own `db`'s lifecycle (open/transaction/close) entirely; this
 * function neither opens nor closes it, and neither begins nor commits/rolls
 * back the transaction.
 */
export function appendEventRowOn(db: DatabaseSync, input: unknown, defaultAt: () => string): WorkStateEvent {
  const validated = validateAppendEventInput(input, defaultAt);
  insertEventRow(db, validated);
  return {
    item_id: validated.item_id,
    actor: validated.actor,
    transition: validated.transition,
    ...(validated.claim_token === undefined ? {} : { claim_token: validated.claim_token }),
    ...(validated.note === undefined ? {} : { note: validated.note }),
    at: validated.at,
  };
}

/**
 * The work-state store. One instance per (session, database file); its
 * ULID generator carries the per-session entropy convention shared with the
 * process record store (record/id.ts).
 *
 * Every public method opens its own connection and closes it before
 * returning — see schema.ts's file header for the lazy-init rationale this
 * protects. `get`/`list`/`events` never create the database file; `insert`,
 * `updateMeta`, `appendEvent`, and `nextClaimToken` do (on first call).
 */
export class WorkStateStore {
  readonly #dbPath: string;
  readonly #clock: Clock;
  readonly #nextId: UlidGenerator;

  constructor(dbPath: string, clock: Clock) {
    this.#dbPath = dbPath;
    this.#clock = clock;
    this.#nextId = createUlidGenerator(clock);
  }

  /** The resolved database file path this store reads/writes. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /**
   * Insert a new work item. Assigns a fresh ULID id, `status: 'open'`,
   * `claim: null`, `version: 1`, and stamps `created_at`/`updated_at` from
   * the injected clock. Appends the immutable `create` event. `title` is
   * gated through the secret scanner before persist; `spec` is stored as-is
   * (never gated, never parsed).
   */
  insertItem(input: unknown): WorkItem {
    const validated = validateNewWorkItemInput(input);
    assertReferenceIdsAreUlids(validated.references, 'create');
    const db = openForWrite(this.#dbPath);
    try {
      const id = this.#nextId();
      const now = this.#clock().toISOString();
      const title = gate(validated.title);
      // Gate both members of every edge — same gate-before-persist posture as
      // `title`; rel tokens and ULIDs never match a secret pattern, so this is
      // a no-op in practice but keeps the invariant total (record/store.ts's
      // exact posture on its own references field).
      const references = gateReferences(validated.references);
      // The item insert and its `create` event commit as ONE atomic unit —
      // otherwise these would be two separate auto-committing statements on
      // the same connection, so a crash between them could leave an item with
      // no `create` event, violating the "every transition appends an
      // immutable event" invariant. The BEGIN IMMEDIATE/COMMIT/ROLLBACK
      // boilerplate lives in tx.ts's `withWriteTransaction`, which also
      // re-types an exhausted busy_timeout as `WorkStateError('BUSY', ...)`
      // instead of letting a raw node:sqlite lock error escape.
      withWriteTransaction(db, (db) => {
        db.prepare(
          `INSERT INTO items (
            id, tenant_id, title, spec, spec_format, status, depends_on, parent_id, "references",
            created_by_human, created_by_agent, created_at, updated_at, version,
            claim_token_counter, claim_holder_human, claim_holder_agent,
            claim_token, claim_acquired_at, claim_lease_expires
          ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL)`,
        ).run(
          id,
          validated.tenant_id,
          title,
          validated.spec,
          validated.spec_format,
          JSON.stringify(validated.depends_on),
          validated.parent_id,
          JSON.stringify(references),
          validated.created_by.human,
          validated.created_by.agent ?? null,
          now,
          now,
        );
        insertEventRow(db, {
          item_id: id,
          actor: validated.created_by,
          transition: 'create',
          at: now,
        });
      });
      const row = getItemRow(db, id);
      if (row === undefined) throw new WorkStateError('SCHEMA', 'work-state store: insert did not persist the row');
      return rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /** Fetch one work item by id, or `null` if it does not exist (or the
   *  database has never been written to). Never creates the database file. */
  getItem(id: string): WorkItem | null {
    const db = openForRead(this.#dbPath);
    if (db === null) return null;
    try {
      const row = getItemRow(db, id);
      return row === undefined ? null : rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /**
   * Like {@link getItem}, but the returned item carries its DERIVED reverse
   * edges in `referenced_by` — so a caller reading a superseded item sees what
   * replaced it without scanning the board itself. The backlink map is built
   * from EVERY item on the board (see {@link buildReferrerMap}), never
   * persisted. Never creates the database file.
   */
  getItemView(id: string): WorkItemView | null {
    const db = openForRead(this.#dbPath);
    if (db === null) return null;
    try {
      const row = getItemRow(db, id);
      if (row === undefined) return null;
      const referrers = buildReferrerMap(db);
      return { ...rowToWorkItem(row), referenced_by: referrers.get(row.id) ?? [] };
    } finally {
      db.close();
    }
  }

  /** List work items, newest-created-first, optionally filtered by tenant
   *  and/or status — SELECTION only, never ranking. Never creates the
   *  database file. */
  listItems(filter?: ListItemsFilter): WorkItem[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      return selectItemRows(db, filter).map(rowToWorkItem);
    } finally {
      db.close();
    }
  }

  /**
   * Like {@link listItems}, but each returned item carries its DERIVED
   * reverse edges in `referenced_by` — the list-twin of {@link getItemView},
   * mirroring record/store.ts's readViews. The backlink map is built over
   * EVERY item on the board, including ones the filter excludes from the
   * result, so a returned item's backlink is never missed just because the
   * referring item didn't match the filter. Never creates the database file.
   */
  listItemViews(filter?: ListItemsFilter): WorkItemView[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      const rows = selectItemRows(db, filter);
      const referrers = buildReferrerMap(db);
      return rows.map((row) => ({ ...rowToWorkItem(row), referenced_by: referrers.get(row.id) ?? [] }));
    } finally {
      db.close();
    }
  }

  /**
   * The metadata-update storage primitive (`update_meta`'s persistence
   * layer). Applies only the fields present on `patch`; bumps `version` by
   * exactly 1 and stamps `updated_at`. Throws `NOT_FOUND` if the item does
   * not exist, `VERSION_CONFLICT` if `expectedVersion` does not match the
   * item's current version. Cycle detection over `depends_on` is a verb-level
   * concern — not enforced here.
   */
  updateMeta(id: string, expectedVersion: number, patch: unknown): WorkItem {
    const validated = validateUpdateMetaInput(patch);
    if (validated.references !== undefined) assertReferenceIdsAreUlids(validated.references, 'update_meta');
    const db = openForWrite(this.#dbPath);
    try {
      const current = getItemRow(db, id);
      if (current === undefined) {
        throw new WorkStateError('NOT_FOUND', `work-state store: no item with id ${JSON.stringify(id)}`);
      }
      if (toNumber(current.version) !== expectedVersion) {
        throw new WorkStateError(
          'VERSION_CONFLICT',
          `work-state store: update_meta expected version ${String(expectedVersion)} but item ${id} is at version ${String(toNumber(current.version))}`,
        );
      }
      const now = this.#clock().toISOString();
      const nextTitle = validated.title === undefined ? current.title : gate(validated.title);
      const nextSpec = validated.spec === undefined ? current.spec : validated.spec;
      const nextSpecFormat = validated.spec_format === undefined ? current.spec_format : validated.spec_format;
      const nextDependsOn = validated.depends_on === undefined ? current.depends_on : JSON.stringify(validated.depends_on);
      // Tri-state: absent on the validated patch (=== undefined) leaves
      // the stored parent unchanged; present (a string OR null) is the new
      // value, null clearing to root. `?? null` on the current value defends a
      // legacy read whose column predates the migration. Orthogonal to
      // `depends_on` — this never reads or writes the dependency column.
      const nextParentId = validated.parent_id === undefined ? (current.parent_id ?? null) : validated.parent_id;
      // Wholesale replace (depends_on's exact semantics): absent leaves the
      // stored edge list unchanged; present — including `[]`, which clears
      // every edge — is the new full list, gated before persist like every
      // other free-text field. `?? '[]'` defends a legacy pre-v3 row.
      const nextReferences =
        validated.references === undefined ? (current.references ?? '[]') : JSON.stringify(gateReferences(validated.references));
      // The version predicate lives in the UPDATE itself (the check above
      // alone is a TOCTOU window — a concurrent update_meta between the SELECT
      // and this write would be silently overwritten). The pre-check stays for
      // the precise typed error; this WHERE clause is the actual guarantee.
      // This bare autocommit statement is wrapped in `withBusyWrap` (tx.ts) so
      // an exhausted busy_timeout surfaces as a typed `WorkStateError('BUSY',
      // ...)` rather than a raw node:sqlite lock error.
      const result = withBusyWrap(() =>
        db
          .prepare(
            `UPDATE items SET title = ?, spec = ?, spec_format = ?, depends_on = ?, parent_id = ?, "references" = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?`,
          )
          .run(nextTitle, nextSpec, nextSpecFormat, nextDependsOn, nextParentId, nextReferences, now, id, expectedVersion),
      );
      if (result.changes !== 1) {
        throw new WorkStateError(
          'VERSION_CONFLICT',
          `work-state store: update_meta lost a concurrent race on item ${id} (expected version ${String(expectedVersion)})`,
        );
      }
      const row = getItemRow(db, id);
      if (row === undefined) throw new WorkStateError('SCHEMA', 'work-state store: update_meta did not persist the row');
      return rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /**
   * Append one immutable transition event, opening (and committing) its OWN
   * connection. `note`, when present, is gated through the secret scanner
   * before persist. This is the standalone entry point for a caller that has
   * no already-open transaction of its own to fold the event into; a caller
   * that DOES (claims.ts, expiry.ts, verbs.ts's `transitionStatus`) uses
   * {@link appendEventRowOn} instead, so the event commits
   * atomically with the transition it records rather than on a second,
   * separate connection.
   */
  appendEvent(input: unknown): WorkStateEvent {
    const validated = validateAppendEventInput(input, () => this.#clock().toISOString());
    const db = openForWrite(this.#dbPath);
    try {
      // Bare autocommit INSERT, wrapped so an exhausted busy_timeout
      // surfaces as a typed `WorkStateError('BUSY', ...)`.
      withBusyWrap(() => insertEventRow(db, validated));
      return {
        item_id: validated.item_id,
        actor: validated.actor,
        transition: validated.transition,
        ...(validated.claim_token === undefined ? {} : { claim_token: validated.claim_token }),
        ...(validated.note === undefined ? {} : { note: validated.note }),
        at: validated.at,
      };
    } finally {
      db.close();
    }
  }

  /** All events for one item, oldest first — the full immutable audit trail.
   *  Never creates the database file. */
  events(itemId: string): WorkStateEvent[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
      const rows = db.prepare('SELECT * FROM events WHERE item_id = ? ORDER BY seq ASC').all(itemId) as unknown as EventRow[];
      return rows.map(rowToEvent);
    } finally {
      db.close();
    }
  }

  /**
   * Atomically increment and return the per-item claim-token counter. This
   * is the fencing-token monotonicity source: a counter column on
   * the item row, so a token is never reused even after a claim is released
   * or a lease expires and the claim fields are cleared. Building the actual
   * claim/renew/complete compare-and-set on top of this primitive is
   * claims.ts's scope.
   */
  nextClaimToken(id: string): number {
    const db = openForWrite(this.#dbPath);
    try {
      // Bare autocommit UPDATE...RETURNING, wrapped so an exhausted
      // busy_timeout surfaces as a typed `WorkStateError('BUSY', ...)`.
      const row = withBusyWrap(() =>
        db
          .prepare('UPDATE items SET claim_token_counter = claim_token_counter + 1 WHERE id = ? RETURNING claim_token_counter')
          .get(id) as { claim_token_counter: number | bigint } | undefined,
      );
      if (row === undefined) {
        throw new WorkStateError('NOT_FOUND', `work-state store: no item with id ${JSON.stringify(id)}`);
      }
      return toNumber(row.claim_token_counter);
    } finally {
      db.close();
    }
  }
}

export type { NewWorkItemInput, UpdateMetaInput, AppendEventInput };
