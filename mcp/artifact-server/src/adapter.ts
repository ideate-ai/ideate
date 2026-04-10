// adapter.ts — StorageAdapter interface and supporting types
//
// This module defines the graph-native boundary between MCP tool handlers and
// storage. No YAML, SQLite, Drizzle, file-path, or filesystem types cross this
// boundary. The interface speaks exclusively in nodes, edges, traversals, and
// mutations.

// ---------------------------------------------------------------------------
// Node types
// ---------------------------------------------------------------------------

/** The set of artifact types in the graph. */
export type NodeType =
  | "work_item"
  | "finding"
  | "domain_policy"
  | "domain_decision"
  | "domain_question"
  | "guiding_principle"
  | "constraint"
  | "module_spec"
  | "research_finding"
  | "journal_entry"
  | "metrics_event"
  | "interview_question"
  | "proxy_human_decision"
  | "project"
  | "phase"
  // Document artifact subtypes
  | "decision_log"
  | "cycle_summary"
  | "review_manifest"
  | "review_output"
  | "architecture"
  | "overview"
  | "execution_strategy"
  | "guiding_principles"
  | "constraints"
  | "research"
  | "interview"
  | "domain_index";

/** All valid NodeType values for runtime validation. */
export const ALL_NODE_TYPES = [
  "work_item",
  "finding",
  "domain_policy",
  "domain_decision",
  "domain_question",
  "guiding_principle",
  "constraint",
  "module_spec",
  "research_finding",
  "journal_entry",
  "metrics_event",
  "interview_question",
  "proxy_human_decision",
  "project",
  "phase",
  "decision_log",
  "cycle_summary",
  "review_manifest",
  "review_output",
  "architecture",
  "overview",
  "execution_strategy",
  "guiding_principles",
  "constraints",
  "research",
  "interview",
  "domain_index",
] as const;

// Compile-time exhaustiveness: every NodeType must appear in ALL_NODE_TYPES.
// If a new NodeType member is added without updating ALL_NODE_TYPES, tsc emits:
// "Type 'true' is not assignable to type 'false'"
type _ExhaustiveNodeTypeCheck = Exclude<
  NodeType,
  typeof ALL_NODE_TYPES[number]
> extends never
  ? true
  : false;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _nodeTypesExhaustive: _ExhaustiveNodeTypeCheck = true;

/** Metadata common to every node. */
export interface NodeMeta {
  id: string;
  type: NodeType;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
}

/** A full node: metadata + type-specific properties as a flat record. */
export interface Node extends NodeMeta {
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Edge types
// ---------------------------------------------------------------------------

// EdgeType and EDGE_TYPES are canonically defined in schema.ts.
// Re-exported here for backwards compatibility with existing callers.
import type { EdgeType } from "./schema.js"; // Local import for use below; re-exported for callers below
import { EDGE_TYPES } from "./schema.js";
export type { EdgeType } from "./schema.js";
export { EDGE_TYPES } from "./schema.js";

/** All valid EdgeType values for runtime validation. Canonical source: EDGE_TYPES in schema.ts. */
export const ALL_EDGE_TYPES = EDGE_TYPES;

export interface Edge {
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Traversal types
// ---------------------------------------------------------------------------

export interface TraversalOptions {
  /** Seed node IDs for PPR or BFS traversal. */
  seed_ids: string[];
  /** PPR restart probability (0-1). */
  alpha?: number;
  /** Maximum PPR iterations. */
  max_iterations?: number;
  /** PPR convergence threshold. */
  convergence_threshold?: number;
  /** Per-edge-type weight overrides for PPR score propagation. */
  edge_type_weights?: Record<string, number>;
  /** Maximum token budget for context assembly. */
  token_budget?: number;
  /** Node types to always include regardless of PPR score. */
  always_include_types?: NodeType[];
  /** Maximum number of nodes to process in PPR. If graph exceeds this, returns empty result. Default: 10000. */
  max_nodes?: number;
}

export interface TraversalResult {
  /** Nodes ranked by relevance score, highest first. */
  ranked_nodes: Array<{
    node: Node;
    score: number;
    content: string;
  }>;
  /** Total tokens consumed by included nodes. */
  total_tokens: number;
  /** Top-N PPR scores for metadata/debugging. */
  ppr_scores: Array<{ id: string; score: number }>;
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface NodeFilter {
  type?: NodeType;
  status?: string;
  domain?: string;
  cycle?: number;
  severity?: string;
  phase?: string;
  work_item?: string;
  work_item_type?: string;
}

export interface GraphQuery {
  /** Start node for graph traversal. */
  origin_id: string;
  /** Maximum traversal depth. */
  depth?: number;
  /** Traverse outgoing, incoming, or both edge directions. */
  direction?: "outgoing" | "incoming" | "both";
  /** Restrict to specific edge types. */
  edge_types?: EdgeType[];
  /** Filter result nodes by type. */
  type_filter?: NodeType;
  /** Additional filters on result nodes. */
  filters?: NodeFilter;
}

export interface QueryResult {
  nodes: Array<{
    node: NodeMeta;
    summary: string;
    /** Present in graph queries. */
    edge_type?: EdgeType;
    direction?: "outgoing" | "incoming";
    depth?: number;
  }>;
  total_count: number;
}

// ---------------------------------------------------------------------------
// Mutation types
// ---------------------------------------------------------------------------

export interface MutateNodeInput {
  id: string;
  type: NodeType;
  properties: Record<string, unknown>;
  /** For cycle-scoped types, which cycle this belongs to. */
  cycle?: number;
}

export interface MutateNodeResult {
  id: string;
  status: "created" | "updated";
}

export interface UpdateNodeInput {
  id: string;
  /** Only the fields to change. Immutable fields (id, type, cycle_created) are rejected. */
  properties: Record<string, unknown>;
}

export interface UpdateNodeResult {
  id: string;
  status: "updated" | "not_found";
}

export interface DeleteNodeResult {
  id: string;
  status: "deleted" | "not_found";
}

// ---------------------------------------------------------------------------
// Batch types
// ---------------------------------------------------------------------------

export interface BatchMutateInput {
  nodes: MutateNodeInput[];
  /** Edges to create alongside the nodes. */
  edges?: Edge[];
}

export interface BatchMutateResult {
  results: MutateNodeResult[];
  /** Any validation errors (e.g., DAG cycles, scope collisions). */
  errors: Array<{ id: string; error: string }>;
}

// ---------------------------------------------------------------------------
// StorageAdapter interface
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  // -----------------------------------------------------------------------
  // Node CRUD
  // -----------------------------------------------------------------------

  /**
   * Retrieve a single node by ID.
   *
   * @returns The full node including properties, or null if not found.
   */
  getNode(id: string): Promise<Node | null>;

  /**
   * Retrieve multiple nodes by IDs in a single call.
   * Missing IDs are omitted from the result (no error).
   *
   * @returns Map of id -> Node for all found nodes.
   */
  getNodes(ids: string[]): Promise<Map<string, Node>>;

  /**
   * Read the full content of a node (the complete serialized artifact).
   * Returns the content as a serialized content string. The format is an
   * adapter implementation detail — callers treat it as opaque text.
   * Returns empty string if content is unavailable.
   */
  readNodeContent(id: string): Promise<string>;

  /**
   * Create or replace a node. The adapter handles all persistence
   * details internally.
   *
   * Content hash and token count are computed by the adapter, not the caller.
   *
   * @returns The ID and whether the node was created or updated.
   */
  putNode(input: MutateNodeInput): Promise<MutateNodeResult>;

  /**
   * Partially update an existing node's properties.
   * Only provided fields are changed. Immutable fields (id, type,
   * cycle_created) are rejected with an error.
   *
   * @returns Updated status or not_found.
   */
  patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult>;

  /**
   * Delete a node and its associated edges.
   *
   * @returns Deleted status or not_found.
   */
  deleteNode(id: string): Promise<DeleteNodeResult>;

  // -----------------------------------------------------------------------
  // Edge CRUD
  // -----------------------------------------------------------------------

  /**
   * Create an edge between two nodes. Idempotent: if the exact
   * (source, target, type) triple exists, this is a no-op.
   */
  putEdge(edge: Edge): Promise<void>;

  /**
   * Remove all edges from a given source node with the specified types.
   * Used during node updates to replace dependency sets atomically.
   */
  removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void>;

  /**
   * Get all edges originating from or targeting a node.
   *
   * @param direction - "outgoing" returns edges where source_id = id,
   *                    "incoming" where target_id = id,
   *                    "both" returns all.
   */
  getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]>;

  // -----------------------------------------------------------------------
  // Graph traversal
  // -----------------------------------------------------------------------

  /**
   * Execute a PPR-based graph traversal for context assembly.
   *
   * The implementation is invisible to callers:
   * - LocalAdapter runs PPR in-process via ppr.ts
   * - RemoteAdapter delegates to a server-side PPR endpoint
   *
   * Returns ranked nodes with content, respecting the token budget.
   */
  traverse(options: TraversalOptions): Promise<TraversalResult>;

  /**
   * Execute a graph query: BFS/DFS from an origin node, with filters.
   * Used by ideate_query for the related_to mode.
   */
  queryGraph(query: GraphQuery, limit: number, offset: number): Promise<QueryResult>;

  // -----------------------------------------------------------------------
  // Filtered queries
  // -----------------------------------------------------------------------

  /**
   * Query nodes by type and filters with pagination.
   * Used by ideate_query for the filter mode.
   */
  queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult>;

  /**
   * Generate the next available ID for a given node type.
   * Handles ID format conventions (WI-001, GP-01, etc.) internally.
   */
  nextId(type: NodeType, cycle?: number): Promise<string>;

  // -----------------------------------------------------------------------
  // Batch operations
  // -----------------------------------------------------------------------

  /**
   * Atomically create/update multiple nodes and edges.
   *
   * The adapter performs validation before persisting:
   * - DAG cycle detection on depends_on/blocks edges
   * - Scope collision detection across concurrent work items
   *
   * On validation failure, no nodes or edges are persisted.
   * On partial persistence failure, the adapter rolls back all changes.
   */
  batchMutate(input: BatchMutateInput): Promise<BatchMutateResult>;

  // -----------------------------------------------------------------------
  // Aggregation queries
  // -----------------------------------------------------------------------

  /**
   * Count nodes grouped by a dimension (status, type, domain, severity).
   * Used by analysis handlers (workspace status, convergence, domain state).
   */
  countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>>;

  /**
   * Retrieve domain state: active policies, decisions, and open questions
   * for the specified domains (or all domains if not specified).
   */
  getDomainState(
    domains?: string[]
  ): Promise<
    Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >
  >;

  /**
   * Get convergence status for a cycle: finding counts by severity,
   * principle violation verdict.
   */
  getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }>;

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Initialize the adapter. Called once at server startup.
   * LocalAdapter: initializes the local store, rebuilds the index, starts
   * the artifact watcher.
   * RemoteAdapter: establishes the remote connection and validates auth.
   */
  initialize(): Promise<void>;

  /**
   * Gracefully shut down the adapter.
   * LocalAdapter: flushes pending writes and stops the artifact watcher.
   * RemoteAdapter: closes the remote connection.
   */
  shutdown(): Promise<void>;

  /**
   * Archive completed work items and findings for the given cycle.
   * Must be called after a cycle review is finalized.
   *
   * LocalAdapter: transitions artifacts to archived state,
   * updates node location entries in the index to reflect new locations, and
   * removes stale index entries for moved artifacts.
   *
   * RemoteAdapter: calls the archiveCycle GraphQL mutation which transitions
   * artifact statuses from 'active' to 'archived' for the given cycle.
   *
   * Returns a human-readable summary string (e.g. "Archived cycle 3: 2 work
   * items, 4 incremental reviews moved."). On error the string begins with
   * "Error during cycle archival" rather than throwing, so callers can surface
   * the message to the user.
   *
   * Calling archiveCycle on a cycle that exists but has already been archived
   * is a no-op returning a "0 work items, 0 incremental reviews moved" message.
   */
  archiveCycle(cycle: number): Promise<string>;

  /**
   * Append a journal entry for the given skill invocation.
   *
   * Handles all persistence details (persistence and indexing, sequence
   * numbering) atomically in an exclusive transaction.
   *
   * @param args.skill      - Skill name (e.g. "execute", "review").
   * @param args.date       - ISO date string for the entry.
   * @param args.entryType  - Entry subtype label (e.g. "work-item-complete").
   * @param args.body       - Full entry body text.
   * @param args.cycle      - Cycle number; defaults to the current max cycle
   *                          when omitted.
   *
   * @returns The ID of the newly created journal entry node (e.g. "J-003-001").
   */
  appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): Promise<string>;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Base error for all adapter failures. */
export class StorageAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "StorageAdapterError";
  }
}

/** Node or edge not found. */
export class NotFoundError extends StorageAdapterError {
  constructor(id: string) {
    super(`Node not found: "${id}"`, "NOT_FOUND", { id });
    this.name = "NotFoundError";
  }
}

/** Attempted to change an immutable field. */
export class ImmutableFieldError extends StorageAdapterError {
  constructor(field: string) {
    super(
      `Cannot modify immutable field: "${field}"`,
      "IMMUTABLE_FIELD",
      { field }
    );
    this.name = "ImmutableFieldError";
  }
}

/** Node type does not match expected type for operation. */
export class TypeMismatchError extends StorageAdapterError {
  constructor(id: string, expected: string, actual: string) {
    super(
      `Type mismatch for "${id}": expected "${expected}", got "${actual}"`,
      "TYPE_MISMATCH",
      { id, expected, actual }
    );
    this.name = "TypeMismatchError";
  }
}

/** DAG cycle detected in dependency graph. */
export class CycleDetectedError extends StorageAdapterError {
  constructor(cycles: string[][]) {
    super(
      `DAG cycle detected: ${cycles.map((c) => c.join(" -> ")).join("; ")}`,
      "CYCLE_DETECTED",
      { cycles }
    );
    this.name = "CycleDetectedError";
  }
}

/** Scope collision between concurrent work items. */
export class ScopeCollisionError extends StorageAdapterError {
  constructor(collisions: Array<{ item_a: string; item_b: string; paths: string[] }>) {
    super(
      `Scope collision detected between work items`,
      "SCOPE_COLLISION",
      { collisions }
    );
    this.name = "ScopeCollisionError";
  }
}

/** Remote adapter connection or authentication failure. */
export class ConnectionError extends StorageAdapterError {
  constructor(message: string, cause?: Error) {
    super(message, "CONNECTION_ERROR", { cause: cause?.message });
    this.name = "ConnectionError";
  }
}

/** Required field missing for a cycle-scoped type. */
export class MissingCycleError extends StorageAdapterError {
  constructor(type: string) {
    super(
      `Cycle parameter required for type "${type}"`,
      "MISSING_CYCLE",
      { type }
    );
    this.name = "MissingCycleError";
  }
}

/** Validation error for invalid input parameters or transaction failures. */
export class ValidationError extends StorageAdapterError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>
  ) {
    super(message, code, details);
    this.name = "ValidationError";
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface AdapterConfig {
  backend: "local" | "remote";
  /** Local-mode configuration. */
  local?: {
    /** Root path for artifact storage. */
    artifact_dir: string;
  };
  /** Remote-mode configuration. */
  remote?: {
    /** GraphQL endpoint URL. */
    endpoint: string;
    /** Organization ID for multi-tenant isolation. */
    org_id: string;
    /** Codebase ID within the organization. */
    codebase_id: string;
    /** Auth token or token provider. */
    auth_token?: string | null;
    /** Token provider function for automatic token rotation. Called when a request fails with 401. */
    tokenProvider?: () => Promise<string | null>;
  };
}

