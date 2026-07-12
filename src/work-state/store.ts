// plugin/src/work-state/store.ts — the persistence core of the work-state
// contract (WI-300).
//
// Spec: docs/spikes/v3-work-delegation.md §3 (the contract), §4 (local-mode
// equivalence — SQLite, WAL, busy-timeout). This module owns row<->type
// mapping and the storage PRIMITIVES only: insert, get, list, the
// metadata-update primitive (version bump), event append, and the per-item
// claim-token counter. Claim acquisition/renewal/completion semantics
// (compare-and-set, lease expiry, cycle detection) are OUT OF SCOPE — that is
// WI-301 (claim logic) and WI-302 (verbs), built on top of these primitives.
//
// Gate-before-persist (mirrors record/store.ts): the two free-text fields
// this layer accepts — `title` and an event's `note` — pass through
// scanAndMask BEFORE any write. `spec` is deliberately NEVER gated: it is
// opaque, store-as-is, no code path may parse OR transform it (masking would
// be a transform).
//
// Intentional narrowing beyond §3.1 (F-300-001 M1): `title`, `spec`, and
// `spec_format` must be NON-EMPTY strings on insert. The contract is silent
// on minimum length; this layer treats an empty value as a caller bug.
// Presence-checked, never parsed — the opacity guarantee is untouched.
// Relax here if bare-task use ever matters; nothing downstream depends on
// non-emptiness.
//
// Reserved-field guard (§3.1 ratification note, 2026-07-08): `rank` is a
// reserved name. Any top-level `rank` key on a create/update-meta payload is
// rejected with a typed `WorkStateError('RESERVED_FIELD', ...)`. The other
// deliberately-absent fields (priority, estimates, sprints, labels, review
// states) simply have no place in the validated shape below — they are never
// read out of an input payload, so supplying them is a silent no-op rather
// than a stored field. Only `rank` gets the explicit, named rejection the
// spec calls for.
//
// Events table discipline: this file contains NO `UPDATE events` and NO
// `DELETE FROM events` statement — the only SQL touching `events` is the
// single INSERT in `#insertEventRow` and the single SELECT in `events()`.
// That absence is what makes the events table append-only BY CONSTRUCTION,
// mechanically grep-falsifiable.

import type { DatabaseSync } from 'node:sqlite';

import { scanAndMask } from '../secret-gate/scan.js';
import type { Clock, UlidGenerator } from '../record/id.js';
import { createUlidGenerator } from '../record/id.js';
import { openForRead, openForWrite } from './schema.js';
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
  WorkItemStatus,
  WorkStateEvent,
} from './types.js';

/** Filter for {@link WorkStateStore.listItems} — selection only, no ranking. */
export interface ListItemsFilter {
  tenant_id?: string;
  status?: WorkItemStatus;
}

/** Gate one free-text field through the secret scanner before persist. */
function gate(text: string): string {
  return scanAndMask(text).content;
}

/** Reject a reserved top-level field (`rank`) on a create/update payload. */
function assertNoReservedField(raw: Record<string, unknown>, context: string): void {
  if ('rank' in raw) {
    throw new WorkStateError(
      'RESERVED_FIELD',
      `work-state store: "rank" is a reserved field name and may not be supplied on a ${context} payload (v3-work-delegation.md §3.1); encode any ordering hint inside "spec" instead`,
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

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new WorkStateError('SCHEMA', `work-state store: field "${field}" must be an array of strings`);
  }
  return value as string[];
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
    created_by: validateActorRef(raw['created_by'], 'created_by'),
  };
}

interface ValidatedUpdateMetaInput {
  title?: string;
  spec?: string;
  spec_format?: string;
  depends_on?: string[];
}

function validateUpdateMetaInput(input: unknown): ValidatedUpdateMetaInput {
  const raw = requireObject(input, 'update_meta');
  assertNoReservedField(raw, 'update_meta');
  const out: ValidatedUpdateMetaInput = {};
  if (raw['title'] !== undefined) out.title = requireNonEmptyString(raw['title'], 'title');
  if (raw['spec'] !== undefined) out.spec = requireNonEmptyString(raw['spec'], 'spec');
  if (raw['spec_format'] !== undefined) out.spec_format = requireNonEmptyString(raw['spec_format'], 'spec_format');
  if (raw['depends_on'] !== undefined) out.depends_on = requireStringArray(raw['depends_on'], 'depends_on');
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
 * The v3 work-state store. One instance per (session, database file); its
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
    const db = openForWrite(this.#dbPath);
    try {
      const id = this.#nextId();
      const now = this.#clock().toISOString();
      const title = gate(validated.title);
      db.prepare(
        `INSERT INTO items (
          id, tenant_id, title, spec, spec_format, status, depends_on,
          created_by_human, created_by_agent, created_at, updated_at, version,
          claim_token_counter, claim_holder_human, claim_holder_agent,
          claim_token, claim_acquired_at, claim_lease_expires
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL)`,
      ).run(
        id,
        validated.tenant_id,
        title,
        validated.spec,
        validated.spec_format,
        JSON.stringify(validated.depends_on),
        validated.created_by.human,
        validated.created_by.agent ?? null,
        now,
        now,
      );
      this.#insertEventRow(db, {
        item_id: id,
        actor: validated.created_by,
        transition: 'create',
        at: now,
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

  /** List work items, newest-created-first, optionally filtered by tenant
   *  and/or status — SELECTION only, never ranking. Never creates the
   *  database file. */
  listItems(filter?: ListItemsFilter): WorkItem[] {
    const db = openForRead(this.#dbPath);
    if (db === null) return [];
    try {
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
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
      const rows = db.prepare(`SELECT * FROM items${where} ORDER BY created_at DESC, id DESC`).all(...params) as unknown as ItemRow[];
      return rows.map(rowToWorkItem);
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
   * concern (WI-302) — not enforced here.
   */
  updateMeta(id: string, expectedVersion: number, patch: unknown): WorkItem {
    const validated = validateUpdateMetaInput(patch);
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
      db.prepare(
        `UPDATE items SET title = ?, spec = ?, spec_format = ?, depends_on = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
      ).run(nextTitle, nextSpec, nextSpecFormat, nextDependsOn, now, id);
      const row = getItemRow(db, id);
      if (row === undefined) throw new WorkStateError('SCHEMA', 'work-state store: update_meta did not persist the row');
      return rowToWorkItem(row);
    } finally {
      db.close();
    }
  }

  /**
   * Append one immutable transition event. `note`, when present, is gated
   * through the secret scanner before persist. This is the ONLY write path
   * to the `events` table besides `insertItem`'s own `create` event — there
   * is no update or delete counterpart anywhere in this module.
   */
  appendEvent(input: unknown): WorkStateEvent {
    const validated = validateAppendEventInput(input, () => this.#clock().toISOString());
    const db = openForWrite(this.#dbPath);
    try {
      this.#insertEventRow(db, validated);
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

  /** The single INSERT this module ever issues against `events`. */
  #insertEventRow(db: DatabaseSync, event: ValidatedAppendEventInput): void {
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
   * is the fencing-token monotonicity source (spec §4): a counter column on
   * the item row, so a token is never reused even after a claim is released
   * or a lease expires and the claim fields are cleared. Building the actual
   * claim/renew/complete compare-and-set on top of this primitive is
   * WI-301's scope.
   */
  nextClaimToken(id: string): number {
    const db = openForWrite(this.#dbPath);
    try {
      const row = db
        .prepare('UPDATE items SET claim_token_counter = claim_token_counter + 1 WHERE id = ? RETURNING claim_token_counter')
        .get(id) as { claim_token_counter: number | bigint } | undefined;
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
