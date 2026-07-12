// plugin/src/work-state/types.ts — the work-state contract types (WI-300).
//
// Spec: docs/spikes/v3-work-delegation.md §3.1 (WorkItem, ActorRef), §3.2
// (Claim, fencing tokens), §3.3 (status model). This module carries the
// CONTRACT SHAPE ONLY — no persistence, no validation logic (that lives in
// store.ts, which converts these types to/from SQLite rows).
//
// Deliberately ABSENT from every interface below (§3.1): priority,
// estimates, sprints, labels, review states, approval chains. `rank` is a
// reserved name (ratification decision, 2026-07-08) — not part of v1; tools
// may encode anything they need inside `spec`. The store-level guard that
// rejects a top-level `rank` on create/update payloads lives in store.ts.
//
// `blocked` is deliberately NOT a member of WorkItemStatus: §3.3 is explicit
// that "blocked" is DERIVED (an `open` item with unresolved `depends_on` is
// simply not claimable) and storing it would invite state-sync bugs. Only
// the four stored statuses exist here.

/** The local-mode default tenant (single-IC boards have exactly one). */
export const DEFAULT_TENANT_ID = 'local';

/**
 * Stored status values (§3.3). `blocked` is derived, never stored — see the
 * file header note.
 */
export type WorkItemStatus = 'open' | 'in_progress' | 'done' | 'cancelled';

/**
 * Every actor is a human principal, optionally acting through a named agent
 * (`{ human: "dan", agent: "dan/worker-3" }`). Agents are never principals on
 * their own — accountability always resolves to a person (§3.1).
 */
export interface ActorRef {
  human: string;
  agent?: string;
}

/**
 * A server-authoritative lease with a fencing token (§3.2). `claim_token` is
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
 * One work item (§3.1). `spec` is OPAQUE: no code path in this module or
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
  /** Free-form hint, e.g. "superpowers/plan-v2", "speckit/spec". */
  spec_format: string;
  status: WorkItemStatus;
  claim: Claim | null;
  /** IDs of items that must be `done` before this one is claimable. */
  depends_on: string[];
  created_by: ActorRef;
  /** ISO-8601 timestamp. */
  created_at: string;
  /** ISO-8601 timestamp. */
  updated_at: string;
  /** Optimistic-concurrency token for metadata edits (update_meta). */
  version: number;
}

/** One immutable transition event (§3.3). Events are append-only by construction. */
export interface WorkStateEvent {
  item_id: string;
  actor: ActorRef;
  /** Open vocabulary: create | claim | renew | release | complete | cancel |
   *  reopen | orphan-recovery | … — verb definitions live in WI-301/WI-302. */
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
 * {@link DEFAULT_TENANT_ID}; `depends_on` defaults to `[]`. `status`,
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
  created_by: ActorRef;
}

/**
 * Input to `update_meta`'s underlying storage primitive. Only metadata
 * fields are editable this way — status/claim transitions are NOT metadata
 * edits and go through the (WI-301/WI-302) transition primitives instead.
 * Every field is optional: only the fields supplied are changed.
 */
export interface UpdateMetaInput {
  title?: string;
  spec?: string;
  spec_format?: string;
  depends_on?: string[];
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
 * work-state/ (F-301-001 S1). Before this fix, `WorkStateError` (this file),
 * `ClaimEngineError` (claims.ts), `VerbError` (verbs.ts), and `DagError`
 * (dag.ts) were four structurally-identical classes — same `name`/`code`/
 * `message` shape, no shared ancestor — so a caller wanting to catch "any
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
   *  (F-308-001 M1: the two classes need to be branchable). */
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
   *  surfaced from tx.ts's shared transaction helper (WI-307, closing
   *  capstone S3 / F-304-001 S1). Wrap-only: this package never retries on
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
