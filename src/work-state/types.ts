// plugin/src/work-state/types.ts — the work-state contract types.
//
// Covers WorkItem and ActorRef, the Claim and its fencing tokens, and the
// status model. This module carries the CONTRACT SHAPE ONLY — no persistence,
// no validation logic (that lives in store.ts, which converts these types
// to/from SQLite rows).
//
// Deliberately ABSENT from every interface below: priority, estimates,
// sprints, labels, review states, approval chains. `rank` is a reserved name
// — not part of v1; tools may encode anything they need inside `spec`. The
// store-level guard that rejects a top-level `rank` on create/update payloads
// lives in store.ts.
//
// `blocked` is deliberately NOT a member of WorkItemStatus: the status model
// is explicit
// that "blocked" is DERIVED (an `open` item with unresolved `depends_on` is
// simply not claimable) and storing it would invite state-sync bugs. Only
// the four stored statuses exist here.

/** The local-mode default tenant (single-IC boards have exactly one). */
export const DEFAULT_TENANT_ID = 'local';

/**
 * A typed edge from this item to another item it references. `rel` is an
 * OPEN vocabulary — `supersedes` (the primary case: a replacement naming the
 * item it replaces), and freely `refutes` | `answers` | `relates-to` | …
 * `id` is the ULID of the referenced (pre-existing) item. Backlinks — the
 * reverse edge, e.g. `superseded_by` — are DERIVED on read (store.ts's
 * view reads), never stored: only the forward edge is persisted, so the two
 * directions can never drift. Defined locally rather than reusing
 * record/schema.ts's `RecordReference`: the shapes coincide, but the record
 * type's contract is append-only-specific while this edge is mutable via
 * `update_meta` — two stores, two local types, one mental model.
 */
export interface WorkItemReference {
  rel: string;
  id: string;
}

/**
 * Stored status values. `blocked` is derived, never stored — see the
 * file header note.
 */
export type WorkItemStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

/**
 * Every actor is a human principal, optionally acting through a named agent
 * (`{ human: "alice", agent: "alice/worker-3" }`). Agents are never
 * principals on their own — accountability always resolves to a person.
 */
export interface ActorRef {
  human: string;
  agent?: string;
}

/**
 * A server-authoritative lease with a fencing token. `claim_token` is
 * strictly monotonic PER WORK ITEM — its source of truth is a counter column
 * on the item row (store.ts), not a derivation from the event log, so it
 * survives claim deletion/reclamation.
 */
export interface Claim {
  holder: ActorRef;
  claim_token: number;
  /** ISO-8601 timestamp. */
  acquired_at: string;
  /** ISO-8601 timestamp. */
  lease_expires: string;
}

/**
 * One work item. `spec` is OPAQUE: no code path in this module or
 * store.ts may parse it — it is stored and returned exactly as given
 * (bytes/text passthrough). `spec_format` is a free-form hint for humans,
 * not logic.
 */
export interface WorkItem {
  /** Server-issued ULID (plugin/src/record/id.ts generator, reused). */
  id: string;
  /** Team/board scope. Local mode uses {@link DEFAULT_TENANT_ID} throughout. */
  tenant_id: string;
  /** One line, human-readable. */
  title: string;
  /** Opaque tool-specific payload — never parsed, never interpreted. */
  spec: string;
  /** Free-form hint, e.g. "plan/outline", "speckit/spec". */
  spec_format: string;
  status: WorkItemStatus;
  claim: Claim | null;
  /** IDs of items that must be `done` before this one is claimable. */
  depends_on: string[];
  /**
   * CONTAINMENT edge: the id of the item this one belongs to (its
   * parent), or `null` when this item is a ROOT (a top-level item, or a
   * "phase" itself). ALWAYS present on a read (mirrors how `claim` is always
   * present, `null` when absent). Fully ORTHOGONAL to `depends_on`: `parent_id`
   * is CONTAINMENT (what larger unit this belongs to), `depends_on` is
   * SEQUENCING (what must be done first). Structured contract data, NOT part of
   * the opaque `spec`.
   */
  parent_id: string | null;
  /**
   * Typed FORWARD edges to other items (open `rel` vocabulary, `supersedes`
   * primary). Always present on a read (mirrors `depends_on`), `[]` when the
   * item names no other item. The reverse edge (`superseded_by`) is DERIVED
   * on read, never stored — see store.ts's view reads. Structured contract
   * data, NOT part of the opaque `spec`.
   */
  references: WorkItemReference[];
  created_by: ActorRef;
  /** ISO-8601 timestamp. */
  created_at: string;
  /** ISO-8601 timestamp. */
  updated_at: string;
  /** Optimistic-concurrency token for metadata edits (update_meta). */
  version: number;
}

/** One immutable transition event. Events are append-only by construction. */
export interface WorkStateEvent {
  item_id: string;
  actor: ActorRef;
  /** Open vocabulary: create | claim | renew | release | complete | cancel |
   *  reopen | orphan-recovery | … — verb definitions live in claims.ts/verbs.ts. */
  transition: string;
  /** Present on claim-fenced transitions (claim/renew/release/complete). */
  claim_token?: number;
  /** Free-text note — completion summary, handoff note, etc. */
  note?: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/**
 * Input to create a new work item. `tenant_id` defaults to
 * {@link DEFAULT_TENANT_ID}; `depends_on` and `references` default to `[]`. `status`,
 * `claim`, `id`, `version`, `created_at`, `updated_at` are never accepted
 * here — the store assigns them (`status` always starts `open`, `claim`
 * always starts `null`, `version` always starts `1`).
 */
export interface NewWorkItemInput {
  tenant_id?: string;
  title: string;
  spec: string;
  spec_format: string;
  depends_on?: string[];
  /**
   * Optional CONTAINMENT parent. ABSENT or `null` both mean "create
   * as a ROOT" (no parent). A non-null string is the parent item's id, guarded
   * by dag.ts's parent-existence + ancestor-cycle checks at write time.
   */
  parent_id?: string | null;
  /**
   * Optional typed forward edges (e.g. a `supersedes` edge naming the item
   * this one replaces). Absent defaults to `[]`. Every edge id is guarded at
   * write time: well-formed ULID (store.ts) AND an existing item (dag.ts's
   * supersedes guard — existence only, never a cycle check: a replacement
   * edge is not a sequencing DAG).
   */
  references?: WorkItemReference[];
  created_by: ActorRef;
}

/**
 * Input to `update_meta`'s underlying storage primitive. Only metadata
 * fields are editable this way — status/claim transitions are NOT metadata
 * edits and go through the claim/verb transition primitives instead.
 * Every field is optional: only the fields supplied are changed.
 */
export interface UpdateMetaInput {
  title?: string;
  spec?: string;
  spec_format?: string;
  depends_on?: string[];
  /**
   * Optional CONTAINMENT parent re-assignment. This field follows the
   * UpdateMetaInput convention that ABSENT = unchanged, but — UNLIKE the other
   * fields here (`title`/`spec` are non-empty-required and cannot be nulled) —
   * `parent_id`'s domain legitimately includes `null`, so BOTH presence forms
   * are meaningful:
   *   - ABSENT (key not in the patch): parent is left UNCHANGED.
   *   - PRESENT as a string: SET/MOVE the parent to that id (guarded by
   *     parent-existence + ancestor-cycle checks in dag.ts).
   *   - PRESENT as `null`: CLEAR the parent back to ROOT (a real set value,
   *     NOT an "unchanged" sentinel).
   * The wire adapter in tools.ts must distinguish "key absent" from "key
   * present with null" to preserve this distinction.
   */
  parent_id?: string | null;
  /**
   * Replace the typed forward-edge list wholesale (mirrors `depends_on`'s
   * replace-semantics): ABSENT = unchanged; PRESENT (including `[]`, which
   * clears every edge) = the new full list. This is how a `supersedes` edge
   * is set, moved, or cleared after creation.
   */
  references?: WorkItemReference[];
}

/** Input to append one immutable event row. `at` defaults to the store clock. */
export interface AppendEventInput {
  item_id: string;
  actor: ActorRef;
  transition: string;
  claim_token?: number;
  note?: string;
  at?: string;
}

/**
 * Common base for every typed, loud failure raised anywhere under
 * work-state/. Without it, `WorkStateError` (this file), `ClaimEngineError`
 * (claims.ts), `VerbError` (verbs.ts), and `DagError` (dag.ts) would be four
 * structurally-identical classes — same `name`/`code`/`message` shape, no
 * shared ancestor — so a caller wanting to catch "any
 * work-state failure" in one `instanceof` check had no type to catch. Each
 * subclass keeps its own `name`, its own narrow `code` union, and its own
 * file; this base adds nothing but the shared shape and the catchable type.
 */
export class WorkStateModuleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Typed work-state failure classes. */
export type WorkStateErrorCode =
  /** A required field was absent, malformed, or of the wrong shape. */
  | 'SCHEMA'
  /** The board.db FILE's stamped schema version is incompatible with this
   *  plugin (newer, or older-with-no-migration-ladder) — a file-level
   *  failure independent of any request payload, distinct from 'SCHEMA'
   *  (the two classes need to be branchable). */
  | 'SCHEMA_VERSION'
  /** A reserved top-level field (`rank`) was supplied on a payload. */
  | 'RESERVED_FIELD'
  /** No item exists with the given id. */
  | 'NOT_FOUND'
  /** `update_meta`'s expected version did not match the item's current version. */
  | 'VERSION_CONFLICT'
  /** A write was blocked by another connection past the configured
   *  `busy_timeout` (schema.ts's `BUSY_TIMEOUT_MS`) — SQLite's own
   *  SQLITE_BUSY/SQLITE_LOCKED, or a message matching /locked|busy/i,
   *  surfaced from tx.ts's shared transaction helper. Wrap-only: this
   *  package never retries on
   *  top of the engine's own busy_timeout retry — see tx.ts's file header
   *  for why a retry-on-top is deliberately a caller's decision, not this
   *  layer's. */
  | 'BUSY';

/** Typed, loud work-state failure — thrown, never silently swallowed. */
export class WorkStateError extends WorkStateModuleError {
  override readonly name = 'WorkStateError';
  override readonly code: WorkStateErrorCode;

  constructor(code: WorkStateErrorCode, message: string) {
    super(code, message);
    this.code = code;
  }
}
