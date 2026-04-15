# StorageAdapter Interface Contract

**Version:** 3.0  
**Last Updated:** 2026-04-06  
**Applies To:** LocalAdapter, RemoteAdapter

This document specifies the contract for the `StorageAdapter` interface, which defines the graph-native boundary between MCP tool handlers and storage. All implementations must adhere to this contract.

## Overview

The `StorageAdapter` interface provides a consistent API for graph operations regardless of the underlying storage backend. The interface speaks exclusively in nodes, edges, traversals, and mutations.

## Architecture Principles

1. **Graph-Native Boundary**: No storage-format-specific types (file paths, filesystem types, ORM objects) cross this boundary
2. **Adapter Equivalence**: LocalAdapter and RemoteAdapter must behave identically from the caller's perspective
3. **Validation-First**: All inputs are validated before operations; validation errors use standardized codes

## Implementation Constraints

The following invariants apply to all MCP tool handlers (files under `tools/`). They were established by RF-clean-interface-proposal §1 and enforced by WI-804.

1. **No concrete adapter imports in tool handlers.** Tool handler files must not import `LocalAdapter`, `RemoteAdapter`, or any storage implementation class directly. The only permitted import is the `StorageAdapter` interface (and its associated types) from `adapter.ts`. Handler code accesses storage exclusively through `ctx.adapter`.

2. **No `ctx.db` / `ctx.drizzleDb` access in tool handlers.** Tool handlers must not read or write `ToolContext.db` (the raw better-sqlite3 handle) or `ToolContext.drizzleDb` (the Drizzle ORM wrapper). Both fields are removed from `ToolContext` in the target architecture (see `architecture-overview.md` §6.2). Any remaining access to these fields in a handler is a violation of this constraint and must be migrated to an adapter method.

---

## Interface Methods

### Node CRUD Operations

#### `getNode(id: string): Promise<Node | null>`

Retrieve a single node by ID.

**Parameters:**
- `id`: The unique identifier of the node

**Returns:**
- The full node including properties, or `null` if not found

**Validation:**
- `id` must be a non-empty string

**Error Codes:**
- `INVALID_NODE_ID`: id is empty or not a string

**Error Handling:**
- Returns `null` for non-existent nodes (no error thrown)

---

#### `getNodes(ids: string[]): Promise<Map<string, Node>>`

Retrieve multiple nodes by IDs in a single call.

**Parameters:**
- `ids`: Array of node IDs to retrieve

**Returns:**
- Map of id → Node for all found nodes
- Missing IDs are omitted (no error)

---

#### `readNodeContent(id: string): Promise<string>`

Read the full content of a node (the complete serialized artifact).

**Parameters:**
- `id`: The unique identifier of the node

**Returns:**
- Content as serialized text (opaque to callers)
- Empty string if content unavailable

---

#### `putNode(input: MutateNodeInput): Promise<MutateNodeResult>`

Create or replace a node. The adapter handles all persistence details internally.

**Parameters:**
- `input.id`: Node identifier (required)
- `input.type`: Node type from `NodeType` union (required)
- `input.properties`: Type-specific properties as flat record (required)
- `input.cycle`: Cycle number for cycle-scoped types (optional)

**Returns:**
- `{ id, status: "created" | "updated" }`

**Validation:**
- `id` must be non-empty string
- `type` must be a valid `NodeType`
- `properties` must be a non-null object
- `cycle` required for cycle-scoped types

**Error Codes:**
- `INVALID_NODE_ID`: id is missing or not a non-empty string
- `INVALID_NODE_TYPE`: type is missing or not a valid NodeType
- `MISSING_NODE_PROPERTIES`: properties is missing or null
- `TRANSACTION_FAILED`: Database transaction failed

---

#### `patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult>`

Partially update an existing node's properties.

**Parameters:**
- `input.id`: Node identifier (required)
- `input.properties`: Only fields to change (required)

**Returns:**
- `{ id, status: "updated" | "not_found" }`

**Validation:**
- `id` must be a non-empty string
- Immutable fields (`id`, `type`, `cycle_created`) are rejected with error

**Error Codes:**
- `INVALID_NODE_ID`: id is missing or not a non-empty string
- `IMMUTABLE_FIELD`: properties contains an immutable field (`id`, `type`, or `cycle_created`)
- `TRANSACTION_FAILED`: Database transaction failed

---

#### `deleteNode(id: string): Promise<DeleteNodeResult>`

Delete a node and its associated edges.

**Parameters:**
- `id`: Node identifier

**Returns:**
- `{ id, status: "deleted" | "not_found" }`

**Validation:**
- `id` must be a non-empty string

**Error Codes:**
- `INVALID_NODE_ID`: id is empty or not a string
- `TRANSACTION_FAILED`: Database transaction failed
- `FILESYSTEM_ERROR`: artifact removal failed

**Error Handling:**
- When id is empty or not a string: `INVALID_NODE_ID` with message `'Node id must be a non-empty string'`
- When artifact removal fails: `FILESYSTEM_ERROR` with message `'deleteNode failed: artifact removal failed: <err>'`
- When the primary delete operation fails and artifact restore succeeds: `TRANSACTION_FAILED` with message `'operation failed: <primary err>'`
- When both the primary delete operation and artifact restore fail: `TRANSACTION_FAILED` with message `'operation failed: <primary err>; cleanup also failed: <restore err>'`

---

### Edge CRUD Operations

#### `putEdge(edge: Edge): Promise<void>`

Create an edge between two nodes.

**Parameters:**
- `edge.source_id`: Source node ID
- `edge.target_id`: Target node ID
- `edge.edge_type`: Type from `EdgeType` union
- `edge.properties`: Edge properties

**Behavior:**
- Idempotent: if the exact (source, target, type) triple exists, this is a no-op

**Validation:**
- All required fields must be present
- `edge_type` must be valid `EdgeType`

**Error Codes:**
- `MISSING_EDGE_SOURCE`: source_id is empty or missing
- `MISSING_EDGE_TARGET`: target_id is empty or missing
- `MISSING_EDGE_TYPE`: edge_type is not provided
- `INVALID_EDGE_TYPE`: edge_type is not a recognized EdgeType value
- `TRANSACTION_FAILED`: Database transaction failed

---

#### `removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void>`

Remove all edges from a given source node with the specified types.

**Parameters:**
- `source_id`: Source node ID
- `edge_types`: Array of edge types to remove

**Use Case:**
- Used during node updates to replace dependency sets atomically

**Validation:**
- `source_id` must be a non-empty string
- Each element of `edge_types` must be a valid `EdgeType`
- An empty `edge_types` array is a no-op (returns immediately without touching storage)

**Error Codes:**
- `INVALID_NODE_ID`: source_id is empty or not a string
- `INVALID_EDGE_TYPE`: edge_types contains an invalid EdgeType value
- `TRANSACTION_FAILED`: Database transaction failed

---

#### `getEdges(id: string, direction: "outgoing" | "incoming" | "both"): Promise<Edge[]>`

Get all edges originating from or targeting a node.

**Parameters:**
- `id`: Node identifier
- `direction`: "outgoing" (edges where source_id = id), "incoming" (edges where target_id = id), or "both"

**Returns:**
- Array of edge objects with full properties

---

### Graph Traversal Operations

#### `traverse(options: TraversalOptions): Promise<TraversalResult>`

Execute a PPR-based graph traversal for context assembly.

**Parameters:**
- `options.seed_ids`: Seed node IDs for PPR (required, non-empty array of strings)
- `options.alpha`: PPR restart probability 0-1 (default: 0.15)
- `options.max_iterations`: Maximum PPR iterations (default: 100)
- `options.convergence_threshold`: PPR convergence threshold (default: 1e-6)
- `options.edge_type_weights`: Per-edge-type weight overrides
- `options.token_budget`: Maximum token budget for context assembly (default: 50000)
- `options.always_include_types`: Node types to always include regardless of PPR score
- `options.max_nodes`: Post-sort result-count cap (optional, default: unlimited). After `computePPR` ranks all reachable nodes by score, only the top `max_nodes` results are returned to the caller. This does NOT limit iteration — `computePPR` walks the entire graph regardless of `max_nodes`. The cap was previously described as a graph-size abort; that behavior was removed in WI-789. See D-210.

**Returns:**
- `ranked_nodes`: Nodes ranked by relevance score, highest first
- `total_tokens`: Total tokens consumed by included nodes
- `ppr_scores`: Top-N PPR scores for metadata/debugging

**Validation:**
- `seed_ids` must be an array (not null, undefined, string, number, object)
- `seed_ids` must not be empty
- Each `seed_id` must be a string
- `always_include_types` elements must be valid `NodeType`

**Error Codes:**
- `INVALID_SEED_IDS`: seed_ids is not an array
- `EMPTY_SEED_IDS`: seed_ids array is empty
- `INVALID_SEED_ID`: seed_ids contains non-string element
- `INVALID_ALWAYS_INCLUDE_TYPE`: always_include_types contains invalid node type
- `INVALID_TOKEN_BUDGET`: token_budget is negative (valid range: 0 to Infinity)
- `INVALID_ALPHA`: alpha is not a number in range (0, 1)
- `INVALID_MAX_ITERATIONS`: max_iterations is not a positive integer
- `INVALID_CONVERGENCE_THRESHOLD`: convergence_threshold is not a positive number
- `INVALID_MAX_NODES`: max_nodes is a negative integer (valid range: 0 to Infinity)

**Implementation Note:**
- LocalAdapter runs PPR in-process via `ppr.ts`
- RemoteAdapter delegates to a server-side PPR endpoint

> **Note (RemoteAdapter limitation)**: RemoteAdapter.traverse() does not currently expose edge type weight customization. Edge type weights are fixed server-side at the values configured in the server's PPR implementation. To customize weights, a future RemoteAdapter enhancement would need to expose them as GraphQL variables. LocalAdapter allows weight customization via the `edge_type_weights` parameter.

---

#### `queryGraph(query: GraphQuery, limit: number, offset: number): Promise<QueryResult>`

Execute a graph query: BFS/DFS from an origin node, with filters.

**Parameters:**
- `query.origin_id`: Start node for traversal (required)
- `query.depth`: Maximum traversal depth
- `query.direction`: "outgoing" | "incoming" | "both"
- `query.edge_types`: Restrict to specific edge types
- `query.type_filter`: Filter result nodes by type
- `query.filters`: Additional filters on result nodes
- `limit`: Maximum results to return (must be non-negative integer)
- `offset`: Number of results to skip (must be non-negative integer)

**Validation:**
- `limit` must be a non-negative integer
- `offset` must be a non-negative integer

**Error Codes:**
- `INVALID_LIMIT`: limit is negative or non-integer
- `INVALID_OFFSET`: offset is negative or non-integer

---

### Filtered Query Operations

#### `queryNodes(filter: NodeFilter, limit: number, offset: number): Promise<QueryResult>`

Query nodes by type and filters with pagination.

**Parameters:**
- `filter.type`: Filter by node type
- `filter.status`: Filter by status
- `filter.domain`: Filter by domain
- `filter.cycle`: Filter by cycle
- `filter.severity`: Filter by severity
- `filter.phase`: Filter by phase
- `filter.work_item`: Filter by work item
- `filter.work_item_type`: Filter by work item type
- `limit`: Maximum results (must be non-negative integer)
- `offset`: Results to skip (must be non-negative integer)

**Validation:**
- `limit` must be a non-negative integer
- `offset` must be a non-negative integer

**Error Codes:**
- `INVALID_LIMIT`: limit is negative or non-integer
- `INVALID_OFFSET`: offset is negative or non-integer

---

#### `getMetricsEvents(filter?: NodeFilter): Promise<MetricsEventRow[]>`

Fetch all metrics event rows matching the optional filter.

**Parameters:**
- `filter` (optional): Node filter criteria. Supported fields:
  - `cycle`: matched against `node.cycle_created`
  - `agent_type`: matched inside the payload JSON field
  - `work_item`: matched inside the payload JSON field (exact match)
  - `phase`: matched inside the payload JSON field

**Returns:**
- Array of `MetricsEventRow` objects ordered by `timestamp ASC, id ASC`

**Remote behavior:** Fetches all `metrics_event` nodes via two round-trips (`queryNodes` + `getNodes`), then applies all filters (including `cycle`) in TypeScript. This is an O(n) scan; cycle-filter SQL pushdown is local-only.

---

#### `nextId(type: NodeType, cycle?: number): Promise<string>`

Generate the next available ID for a given node type.

**Parameters:**
- `type`: Node type
- `cycle`: Cycle number for cycle-scoped types

**Returns:**
- Formatted ID string (e.g., "WI-001", "J-001-001")

**Validation:**
- `type` must be one of the supported ID-generation types: `journal_entry`, `work_item`, `finding`
- `cycle` must be a non-negative integer if provided

**Error Codes:**
- `INVALID_NODE_TYPE`: type is not a supported ID-generation type
- `INVALID_CYCLE`: cycle is not a non-negative integer

---

### Batch Operations

#### `batchMutate(input: BatchMutateInput): Promise<BatchMutateResult>`

Atomically create/update multiple nodes and edges.

**Parameters:**
- `input.nodes`: Array of nodes to mutate (required, non-empty)
- `input.edges`: Edges to create alongside nodes (optional)

**Returns:**
- `results`: Array of `{ id, status: "created" | "updated" }`
- `errors`: Array of `{ id, error }` (validation errors only; empty on success)

**Validation (performed before persistence):**
- At least one node must be provided (`EMPTY_BATCH`)
- Each node must have `id` field (`MISSING_NODE_ID`)
- Each node must have `type` field (`MISSING_NODE_TYPE`)
- Each node must have `properties` field (`MISSING_NODE_PROPERTIES`)
- `type` must be valid `NodeType` (`INVALID_NODE_TYPE`)
- Each edge must have `source_id` (`MISSING_EDGE_SOURCE`)
- Each edge must have `target_id` (`MISSING_EDGE_TARGET`)
- Each edge must have `edge_type` (`MISSING_EDGE_TYPE`)
- `edge_type` must be valid `EdgeType` (`INVALID_EDGE_TYPE`)
- DAG cycle detection on `depends_on`/`blocks` edges
- Scope collision detection across concurrent work items

**Error Codes:**
- `EMPTY_BATCH`: Empty nodes array
- `MISSING_NODE_ID`: Node missing required 'id' field
- `MISSING_NODE_TYPE`: Node missing required 'type' field
- `MISSING_NODE_PROPERTIES`: Node missing required 'properties' field
- `INVALID_NODE_TYPE`: Invalid node type
- `MISSING_EDGE_SOURCE`: Edge missing required 'source_id' field
- `MISSING_EDGE_TARGET`: Edge missing required 'target_id' field
- `MISSING_EDGE_TYPE`: Edge missing required 'edge_type' field
- `INVALID_EDGE_TYPE`: Invalid edge type
- `CYCLE_DETECTED`: DAG cycle detected in dependency graph
- `SCOPE_COLLISION`: Scope collision between work items
- `TRANSACTION_FAILED`: Database transaction failed

**Behavior:**
- On validation failure: no nodes or edges are persisted
- On partial persistence failure: adapter rolls back all changes

---

### Aggregation Queries

#### `countNodes(filter: NodeFilter, group_by: "status" | "type" | "domain" | "severity"): Promise<{ key: string; count: number }[]>`

Count nodes grouped by a dimension.

**Parameters:**
- `filter`: Node filter criteria
- `group_by`: Dimension to group results by

**Returns:**
- Array of `{ key, count }` objects

---

#### `getDomainState(domains?: string[]): Promise<Map<string, DomainState>>`

Retrieve domain state: active policies, decisions, and open questions.

**Parameters:**
- `domains`: Array of domain names to filter (optional, all if not specified)

**Returns:**
- Map of domain name → `{ policies[], decisions[], questions[] }`

---

#### `getConvergenceData(cycle: number): Promise<ConvergenceData>`

Get convergence status for a cycle.

**Parameters:**
- `cycle`: Cycle number

**Returns:**
- `findings_by_severity`: Record of severity → count
- `cycle_summary_content`: String or null

---

### Lifecycle Operations

#### `initialize(): Promise<void>`

Initialize the adapter.

**LocalAdapter:**
- Initializes the local store
- Rebuilds the index
- Starts the artifact watcher

**RemoteAdapter:**
- Establishes the remote connection
- Validates authentication

---

#### `shutdown(): Promise<void>`

Gracefully shut down the adapter.

**LocalAdapter:**
- Flushes pending writes
- Stops the artifact watcher

**RemoteAdapter:**
- Closes the remote connection

---

#### `archiveCycle(cycle: number): Promise<string>`

Archive completed work items and findings for the given cycle.

**Parameters:**
- `cycle`: Cycle number to archive

**Returns:**
- Human-readable summary (e.g., "Archived cycle 3: 2 work items, 4 findings")
- On error: string begins with "Error during cycle archival"

**Behavior:**
- Calling on already-archived cycle is a no-op

---

#### `appendJournalEntry(args: { skill: string; date: string; entryType: string; body: string; cycle: number }): Promise<string>`

Append a journal entry for the given skill invocation.

**Parameters:**
- `args.skill`: Skill name (e.g., "execute", "review")
- `args.date`: ISO date string
- `args.entryType`: Entry subtype label
- `args.body`: Full entry body text
- `args.cycle`: Cycle number

**Returns:**
- ID of the newly created journal entry node

**Error Codes:**
- `TRANSACTION_FAILED`: Database transaction failed

---

#### `indexFiles(paths: string[]): Promise<void>`

Incrementally index specific file paths into the SQLite index. Called by the artifact watcher on add/change events.

**Parameters:**
- `paths`: Absolute file paths to index. Non-YAML paths are silently ignored.

**Returns:**
- `Promise<void>`

**Remote behavior:** No-op on `RemoteAdapter`; the remote index is maintained server-side.

---

#### `removeFiles(paths: string[]): Promise<void>`

Remove file paths from the SQLite index. Called by the artifact watcher on unlink events.

**Parameters:**
- `paths`: Absolute file paths to remove from the index.

**Returns:**
- `Promise<void>`

**Remote behavior:** No-op on `RemoteAdapter`; the remote index is maintained server-side.

---

## Error Types

### `StorageAdapterError`

Base error class for all adapter failures.

**Properties:**
- `message`: Human-readable error message
- `code`: Error code string
- `details`: Additional error context

**Codes:**
- `PARSE_ERROR`: Node content or cycle index data could not be parsed as JSON. This is a data integrity error (stored data is corrupt), not a caller input error.

### `NotFoundError extends StorageAdapterError`

Node or edge not found.

**Code:** `NOT_FOUND`

### `ImmutableFieldError extends StorageAdapterError`

Attempted to change an immutable field.

**Code:** `IMMUTABLE_FIELD`

### `TypeMismatchError extends StorageAdapterError`

Node type does not match expected type.

**Code:** `TYPE_MISMATCH`

### `CycleDetectedError extends StorageAdapterError`

DAG cycle detected in dependency graph.

**Code:** `CYCLE_DETECTED`

### `ScopeCollisionError extends StorageAdapterError`

Scope collision between concurrent work items.

**Code:** `SCOPE_COLLISION`

### `ConnectionError extends StorageAdapterError`

Remote adapter connection or authentication failure.

**Code:** `CONNECTION_ERROR`

### `MissingCycleError extends StorageAdapterError`

Required cycle parameter missing for cycle-scoped type.

**Code:** `MISSING_CYCLE`

### `ValidationError extends StorageAdapterError`

Validation error for invalid input parameters or transaction failures.

**Constructor:**
```typescript
constructor(
  message: string,
  codeOrField: string,
  detailsOrValue: Record<string, unknown> | unknown
)
```

**Code Logic:**
- If `codeOrField` is `TRANSACTION_FAILED` → code = `TRANSACTION_FAILED`
- If `codeOrField` ends with `_ERROR` → code = `codeOrField`
- If `codeOrField` starts with `INVALID_` or `EMPTY_` or `MISSING_` → code = `codeOrField`
- Otherwise → code = `VALIDATION_ERROR`

**Codes:**
- `TRANSACTION_FAILED`: Database transaction failure
- `VALIDATION_ERROR`: Generic validation failure (legacy; prefer specific codes)
- `INVALID_NODE_ID`: node id is missing or not a non-empty string
- `INVALID_NODE_TYPE`: node type is missing or invalid
- `MISSING_NODE_PROPERTIES`: node properties is missing or null
- `INVALID_SEED_IDS`: seed_ids is not an array
- `EMPTY_SEED_IDS`: seed_ids array is empty
- `INVALID_SEED_ID`: seed_ids contains non-string element
- `INVALID_ALWAYS_INCLUDE_TYPE`: always_include_types contains invalid type
- `INVALID_TOKEN_BUDGET`: token_budget is negative (valid range: 0 to Infinity)
- `INVALID_ALPHA`: alpha is not a number in range (0, 1)
- `INVALID_MAX_ITERATIONS`: max_iterations is not a positive integer
- `INVALID_CONVERGENCE_THRESHOLD`: convergence_threshold is not a positive number
- `INVALID_MAX_NODES`: max_nodes is a negative integer (valid range: 0 to Infinity)
- `INVALID_LIMIT`: limit is invalid
- `INVALID_OFFSET`: offset is invalid
- `INVALID_CYCLE`: cycle is not a non-negative integer
- `EMPTY_BATCH`: batch mutation has no nodes
- `MISSING_NODE_ID`: node missing id field
- `MISSING_NODE_TYPE`: node missing type field
- `MISSING_NODE_PROPERTIES`: node missing properties field
- `MISSING_EDGE_SOURCE`: edge missing source_id
- `MISSING_EDGE_TARGET`: edge missing target_id
- `MISSING_EDGE_TYPE`: edge missing edge_type
- `INVALID_EDGE_TYPE`: edge has invalid edge_type
- `FILESYSTEM_ERROR`: artifact removal failed

---

## Type Definitions

### NodeType

```typescript
type NodeType =
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
```

### EdgeType

```typescript
type EdgeType =
  | "depends_on"
  | "blocks"
  | "belongs_to_module"
  | "belongs_to_domain"
  | "derived_from"
  | "relates_to"
  | "addressed_by"
  | "references"
  | "amended_by"
  | "supersedes"
  | "triggered_by"
  | "governed_by"
  | "informed_by"
  | "belongs_to_project"
  | "belongs_to_phase"
  | "belongs_to_cycle";
```

### Node

```typescript
interface Node {
  id: string;
  type: NodeType;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
  properties: Record<string, unknown>;
}
```

---

## Equivalence Requirements

LocalAdapter and RemoteAdapter must behave identically in the following aspects:

1. **Validation Order**: Validation must occur in the same sequence
2. **Error Messages**: Error messages must be equivalent (not necessarily identical)
3. **Error Codes**: Error codes must match exactly
4. **Return Types**: Return types must be structurally equivalent
5. **Null Handling**: Null vs undefined handling must be consistent
6. **Empty Results**: Empty arrays vs null must be consistent

**Test Coverage:**
- `tests/adapters/adapter-equivalence.test.ts`
- `tests/adapters/seed-ids-validation.test.ts`
- `tests/adapters/always-include-types-validation.test.ts`
- `tests/adapters/local-adapter-validation.test.ts`
- `tests/adapters/remote-adapter-validation.test.ts`

---

## Implementation Notes

> **Note**: The details in this section describe how specific adapter implementations work internally. They are NOT part of the interface contract and callers must not depend on them.

### LocalAdapter Implementation Notes

- **Write semantics**: Writes are atomic; partial writes are rolled back
- **File watching**: Watches the artifact directory for external changes and rebuilds the index automatically

### RemoteAdapter Implementation Notes

- **Transport**: HTTP to a GraphQL endpoint
- **Batching**: Uses per-request DataLoader batching for efficient node lookups
- **Connection**: Supports token rotation for long-lived sessions

> **Note (RemoteAdapter only)**: Methods that must fetch the current cycle before executing (putNode, patchNode, getNode, getNodes) may throw a plain `Error` (not a `StorageAdapterError` subclass) for infrastructure failures such as GraphQL network errors. Callers of RemoteAdapter should catch both `StorageAdapterError` and the base `Error` class.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.0 | 2026-04-06 | Added comprehensive validation layer and error codes |
| 2.0 | 2026-03-20 | Added PPR-based context assembly |
| 1.0 | 2026-03-01 | Initial interface definition |
