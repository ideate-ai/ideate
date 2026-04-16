# GraphQL Schema Design for ideate-server

> External API contract for ideate-server. Defines queries, mutations, subscriptions,
> auth context, pagination, error handling, and federation boundaries.
> Produced as WI-545 during Phase 0 (PH-018) of the Platform Strategy project.
>
> Companion files:
> - [graphql-schema.graphql](./graphql-schema.graphql) -- Complete SDL file
> - [adapter-interface.md](./adapter-interface.md) -- StorageAdapter interface (WI-543)
> - [neo4j-schema.md](./neo4j-schema.md) -- Neo4j data model (WI-544)

---

## 1. Design Principles

The GraphQL schema is the external API contract for ideate-server. It aligns with the StorageAdapter interface but is not a one-to-one mapping. Key differences:

| Concern | StorageAdapter | GraphQL API |
|---|---|---|
| Auth | None -- adapter is trusted | Every operation scoped to authenticated org |
| Pagination | offset/limit | Cursor-based (Relay-style connections) |
| Error handling | Throws typed exceptions | GraphQL error extensions with error codes |
| Multi-tenancy | Implicit (adapter knows its scope) | Explicit org_id from JWT, enforced in resolvers |
| Naming | snake_case (TypeScript) | camelCase (GraphQL convention) |
| Batch reads | Map return | List return (GraphQL has no Map type) |
| Real-time | Not applicable | Subscriptions via WebSocket |

### 1.1 Naming Convention

GraphQL types and fields use camelCase per GraphQL convention. The StorageAdapter uses snake_case per TypeScript convention. The mapping is mechanical:

| StorageAdapter | GraphQL |
|---|---|
| `content_hash` | `contentHash` |
| `cycle_created` | `cycleCreated` |
| `edge_type` | `edgeType` |
| `token_budget` | `tokenBudget` |
| `seed_ids` | `seedIds` |

### 1.2 Enum Naming

GraphQL enums use UPPER_SNAKE_CASE. StorageAdapter string unions use lower_snake_case. The mapping:

| StorageAdapter | GraphQL |
|---|---|
| `"work_item"` | `WORK_ITEM` |
| `"depends_on"` | `DEPENDS_ON` |
| `"critical"` | `CRITICAL` |

---

## 2. Auth Context

### 2.1 Shape

```graphql
type AuthContext {
  userId: ID!          # Auth0 sub claim
  orgId: ID!           # Organization ID from JWT namespace
  roles: [UserRole!]!  # OWNER, ADMIN, MEMBER, VIEWER
  codebaseAccess: [ID!]  # null = all codebases (OWNER/ADMIN)
}
```

### 2.2 How It Works

1. The client sends an Auth0 JWT as a Bearer token in the `Authorization` header.
2. Server middleware validates the JWT, extracts claims, and constructs the `AuthContext`.
3. The `AuthContext` is injected into every resolver via the GraphQL context object.
4. Resolvers use `ctx.auth.orgId` to scope all Neo4j queries. No data from other organizations is ever returned.

### 2.3 Permission Model

| Role | Read artifacts | Write artifacts | Manage org | Manage billing |
|---|---|---|---|---|
| VIEWER | Yes | No | No | No |
| MEMBER | Yes | Yes | No | No |
| ADMIN | Yes | Yes | Yes | No |
| OWNER | Yes | Yes | Yes | Yes |

### 2.4 Codebase Access Control

MEMBER and VIEWER roles may be restricted to specific codebases via `codebaseAccess`. When `codebaseAccess` is null, the user has access to all codebases in the org (implicit for OWNER and ADMIN). When it is a non-null list, queries are further filtered to only include artifacts from those codebases.

### 2.5 Pluggability

The `AuthContext` shape is provider-agnostic. The current design targets Auth0 but the JWT-to-AuthContext mapping is isolated in middleware. Switching to Clerk, Cognito, or a custom provider requires changing only the middleware, not the schema or resolvers.

### 2.6 Development Mode

When `auth_token` is null in the remote config (or the `IDEATE_DEV_MODE` environment variable is set), the server skips JWT validation and uses a default AuthContext:

```typescript
const devAuth: AuthContext = {
  userId: "dev-user",
  orgId: "dev-org",
  roles: ["OWNER"],
  codebaseAccess: null,
};
```

This enables local development and testing without Auth0 infrastructure.

---

## 3. Query Design

### 3.1 Artifact Lookup

```graphql
# Single node by artifact ID
artifact(id: ID!, codebaseId: ID): ArtifactNode

# Multiple nodes by artifact IDs (batch)
artifacts(ids: [ID!]!, codebaseId: ID): [ArtifactNode!]!
```

Maps to `StorageAdapter.getNode()` and `StorageAdapter.getNodes()`. The `codebaseId` parameter is optional; when omitted, the server searches across all codebases the user has access to. The return type is the `ArtifactNode` interface, which concrete types (WorkItem, Finding, etc.) implement.

**DataLoader pattern**: The `artifacts` query and all relationship-field resolvers (e.g., `WorkItem.dependsOn`, `Phase.workItems`) use a request-scoped DataLoader keyed by `(orgId, codebaseId, artifactId)` to batch and deduplicate reads within a single GraphQL operation. This prevents N+1 queries when traversing the graph.

### 3.2 Filtered Queries

```graphql
artifactQuery(
  filter: NodeFilterInput
  first: Int = 50
  after: String
): ArtifactConnection!
```

Maps to `StorageAdapter.queryNodes()`. Uses cursor-based pagination (see Section 4). The `NodeFilterInput` mirrors the StorageAdapter's `NodeFilter` with the same fields: `type`, `status`, `domain`, `cycle`, `severity`, `phase`, `workItem`, `workItemType`.

**Default exclusion**: When querying work items without an explicit `status` filter, the server excludes nodes with status `done` or `obsolete`, matching the StorageAdapter behavior.

### 3.3 Graph Traversal

```graphql
graphQuery(
  query: GraphQueryInput!
  first: Int = 50
  after: String
): QueryResult!
```

Maps to `StorageAdapter.queryGraph()`. The `GraphQueryInput` mirrors the adapter's `GraphQuery` type. BFS traversal from an origin node, with direction, edge type, and depth controls.

### 3.4 Context Assembly (PPR)

```graphql
assembleContext(input: TraversalInput!): TraversalResult!
```

Maps to `StorageAdapter.traverse()`. This is the core PPR-based context assembly endpoint. The `TraversalInput` includes:

| Field | Type | Default | Description |
|---|---|---|---|
| `seedIds` | `[ID!]!` | (required) | PPR seed node artifact IDs |
| `alpha` | `Float` | Server config | PPR restart probability (0-1) |
| `maxIterations` | `Int` | Server config | Maximum PPR iterations |
| `convergenceThreshold` | `Float` | Server config | PPR convergence threshold |
| `edgeTypeWeights` | `JSON` | Server config | Per-edge-type weight overrides |
| `tokenBudget` | `Int` | Server config | Maximum token budget |
| `alwaysIncludeTypes` | `[NodeType!]` | Server config | Types to always include |

The `edgeTypeWeights` field is a JSON object mapping edge type names (e.g., `"DEPENDS_ON"`) to float weights. These override the default relationship `weight` properties stored in Neo4j during PPR traversal.

**Server-side execution**: PPR runs entirely on the server against Neo4j. The client never receives raw edge data. This prevents edge overfetching and ensures the PPR algorithm has access to the full graph without multiple round trips.

### 3.5 Domain State

```graphql
domainState(domains: [String!]): [DomainState!]!
```

Maps to `StorageAdapter.getDomainState()`. Returns the active policies, decisions, and open questions for each requested domain (or all domains if the parameter is omitted).

### 3.6 Status and Aggregation

```graphql
workspaceStatus(codebaseId: ID): WorkspaceStatus!
projectStatus(projectId: ID!): ProjectStatus
executionStatus(phaseId: ID): ExecutionStatus!
convergenceStatus(cycleNumber: Int!): ConvergenceData!
nodeCounts(filter: NodeFilterInput, groupBy: GroupByDimension!): [GroupCount!]!
```

These queries aggregate data for dashboards and status views. They map to the corresponding StorageAdapter methods (`countNodes`, `getConvergenceData`) and MCP tool handlers (`ideate_get_workspace_status`, `ideate_get_execution_status`).

### 3.7 Tenant Queries

```graphql
organization: Organization
codebases: [Codebase!]!
projects(status: String): [Project!]!
```

These queries provide tenant-level data that has no StorageAdapter equivalent (the adapter does not know about organizations or codebases as first-class concepts). They query Neo4j tenant nodes directly.

### 3.8 Artifact Context

```graphql
artifactContext(id: ID!): ArtifactNode
```

Mirrors `ideate_get_artifact_context`. Returns the full context for a single artifact: its own fields plus edges and related nodes pre-loaded by the resolver. Auth scope: MEMBER or above. Returns null when the artifact does not exist.

**Purpose**: Single-call convenience for agent resolvers that need a node and its immediate relationships without constructing a graph traversal query.

**Return type**: `ArtifactNode` interface. Callers use inline fragments to access type-specific fields. The resolver pre-populates relationship fields (e.g., `WorkItem.dependsOn`) via DataLoader so a single call retrieves the full context without N+1 queries.

### 3.9 Context Package

```graphql
contextPackage(codebaseId: ID): JSON!
```

Mirrors `ideate_get_context_package`. Returns the full project context as a JSON bundle: guiding principles, constraints, architecture document, active domain policies, and execution strategy. Auth scope: MEMBER or above.

**Purpose**: Provides agents with the complete steering context for a codebase in a single call, equivalent to reading all high-signal artifact types at once. The resolver aggregates the relevant artifact nodes and serializes them into the same JSON shape as the local MCP tool.

**Input**: Optional `codebaseId`; defaults to the primary codebase from the auth context. **Return type**: `JSON!` — the same schema as the local `ideate_get_context_package` response.

### 3.10 Config

```graphql
config(codebaseId: ID): JSON!
```

Mirrors `ideate_get_config`. Returns the project configuration for a codebase: agent budgets, model overrides, PPR settings, and phase configuration. Auth scope: MEMBER or above.

**Purpose**: Allows the RemoteAdapter to read config without a separate REST endpoint. The config is stored as a structured document in Neo4j per codebase.

**Input**: Optional `codebaseId`; defaults to primary codebase. **Return type**: `JSON!` — same schema as `config.json` in the local artifact directory. Includes `schemaVersion`, `agentBudgets`, `ppr`, and optional `modelOverrides` keys.

### 3.11 Review Manifest

```graphql
reviewManifest(cycleNumber: Int): JSON
```

Mirrors `ideate_get_review_manifest`. Returns the review manifest document for a given cycle number. Auth scope: MEMBER or above. Returns null when no manifest exists for the cycle.

**Purpose**: Provides the reviewer agent with the structured manifest that lists work items to review, their scopes, and any prior review context for the cycle.

**Input**: `cycleNumber` — if omitted, defaults to the current cycle. **Return type**: `JSON` — nullable; returns null when the manifest has not been created for the requested cycle.

### 3.12 Execution Status

```graphql
executionStatus(phaseId: ID): ExecutionStatus!
```

Mirrors `ideate_get_execution_status`. Returns work item counts by status and the list of items ready to start (all dependencies satisfied, status is `todo`). Auth scope: MEMBER or above.

**Purpose**: Drives the executor agent's work selection loop and dashboard progress indicators. The resolver queries work items filtered by phase (if provided), counts by status, and evaluates dependency satisfaction for the ready list.

**Input**: Optional `phaseId`; when omitted returns execution status across all phases. **Return type**: `ExecutionStatus` — includes `workItemCountsByStatus: [GroupCount!]!` and `readyToStart: [WorkItem!]!`.

### 3.13 Next ID

```graphql
nextId(type: NodeType!, cycle: Int): String!
```

Mirrors `ideate_get_next_id`. Maps to `StorageAdapter.nextId()`. Returns the next available artifact ID string for the given node type, formatted per the ideate ID convention (e.g., `WI-042`, `F-007`). Auth scope: MEMBER or above.

**Purpose**: Allows agents to pre-allocate IDs before writing artifacts, enabling deterministic batch operations. The server generates IDs atomically to prevent races in concurrent write scenarios.

**Input**: `type` — required node type. `cycle` — optional cycle number for cycle-scoped types (findings, journal entries). **Return type**: `String!` — the formatted artifact ID.

---

## 4. Pagination Strategy

### 4.1 Cursor-Based Pagination

All list queries that may return large result sets use Relay-style cursor-based pagination:

```graphql
type ArtifactConnection {
  edges: [ArtifactEdge!]!
  pageInfo: PageInfo!
}

type ArtifactEdge {
  cursor: String!
  node: ArtifactNode!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
  totalCount: Int!
}
```

### 4.2 Cursor Encoding

Cursors are opaque base64-encoded strings. Internally, they encode `(sortField, lastValue)` pairs. For artifact queries ordered by artifact ID, the cursor encodes the last artifact ID. For graph queries ordered by depth and artifact ID, the cursor encodes `(depth, artifactId)`.

### 4.3 Why Not Offset/Limit

The StorageAdapter uses offset/limit for simplicity in the local context. GraphQL uses cursors because:

- **Stable pagination**: Inserting or deleting artifacts does not shift pages.
- **Performance**: Cursor-based queries avoid the `SKIP N` performance degradation in Neo4j for large offsets.
- **Standard**: Relay-style connections are the established GraphQL pattern for paginated lists.

### 4.4 Which Queries Use Pagination

| Query | Pagination | Rationale |
|---|---|---|
| `artifactQuery` | Cursor-based | May return hundreds of artifacts |
| `graphQuery` | Cursor-based | Traversal results can be large |
| `artifact` / `artifacts` | None | ID-based lookup, bounded input |
| `assembleContext` | None | Token budget bounds the result |
| `domainState` | None | Domain count is small (typically < 10) |
| `workspaceStatus` | None | Single aggregate result |
| `nodeCounts` | None | Small aggregate result |
| `projects` | None | Typically < 20 projects per org |
| `codebases` | None | Typically < 50 codebases per org |

### 4.5 Default and Maximum Page Size

- Default `first`: 50
- Maximum `first`: 200 (server-enforced, matching current MCP tool limits)

---

## 5. Mutation Design

### 5.1 Node CRUD

```graphql
putNode(input: MutateNodeInput!): MutateNodeResult!
patchNode(input: UpdateNodeInput!): UpdateNodeResult!
deleteNode(id: ID!): DeleteNodeResult!
```

These map directly to `StorageAdapter.putNode()`, `patchNode()`, and `deleteNode()`. The server handles content hash computation, token counting, and edge extraction from node properties.

### 5.2 Batch Operations

```graphql
batchMutate(input: BatchMutateInput!): BatchMutateResult!
```

Maps to `StorageAdapter.batchMutate()`. The server validates DAG cycles and scope collisions before persisting. The entire operation is atomic: if validation fails, no nodes or edges are persisted. The `BatchMutateResult` includes per-item errors for validation failures.

### 5.3 Work Item Operations

```graphql
writeWorkItems(items: [WriteWorkItemInput!]!): BatchMutateResult!
updateWorkItems(updates: [UpdateWorkItemInput!]!): [UpdateNodeResult!]!
```

These are domain-specific mutations that mirror `ideate_write_work_items` and `ideate_update_work_items`. They provide typed inputs with validated fields rather than the generic `JSON` properties in `putNode`. Internally, they delegate to the same batch mutation logic.

### 5.4 Edge Management

```graphql
putEdge(input: EdgeInput!): Boolean!
removeEdges(sourceId: ID!, edgeTypes: [EdgeType!]!): Boolean!
```

Maps to `StorageAdapter.putEdge()` and `removeEdges()`. `putEdge` is idempotent: creating an edge that already exists is a no-op returning `true`.

### 5.5 Journal and Lifecycle

```graphql
appendJournal(input: JournalEntryInput!): MutateNodeResult!
archiveCycle(cycleNumber: Int!): Boolean!
```

These mirror the corresponding MCP tools. `archiveCycle` in remote mode changes artifact statuses rather than moving files (the file-move concept is a local-only concern).

### 5.6 Bootstrap Workspace

```graphql
bootstrapWorkspace(projectName: String): Boolean!
```

Mirrors `ideate_bootstrap_workspace`. Initializes the standard artifact directory structure for a codebase: creates the guiding principles document, constraints document, architecture document, overview, and execution strategy stubs. Auth scope: ADMIN or above.

**Purpose**: Called once when setting up a new codebase in the platform. Idempotent — re-running does not overwrite existing artifacts. Returns `true` on success, `false` if the workspace was already initialized.

**Input**: Optional `projectName` — used to populate the project name in generated stub documents. **Return type**: `Boolean!`.

### 5.7 Manage Autopilot State

```graphql
manageAutopilotState(action: String!, state: JSON): JSON!
```

Mirrors `ideate_manage_autopilot_state`. Gets or updates the autopilot state document for the current codebase. Auth scope: MEMBER or above.

**Purpose**: Autopilot stores its loop state (current phase, cycle counter, convergence history, DEFER flags) in a dedicated document so it can resume after interruption. In remote mode this document is stored in Neo4j rather than a local file.

**Input**: `action` — one of `"get"`, `"set"`, or `"reset"`. `state` — the new state JSON when `action` is `"set"`; ignored for `"get"` and `"reset"`. **Return type**: `JSON!` — the current state after applying the action.

### 5.8 Update Config

```graphql
updateConfig(patch: JSON!): JSON!
```

Mirrors `ideate_update_config`. Applies a partial patch (deep-merged) to the project configuration for the current codebase. Auth scope: ADMIN or above.

**Purpose**: Allows settings changes — agent budgets, model overrides, PPR weights — without replacing the full config. The server deep-merges the patch into the existing config, validates the result against the config schema, and persists the updated document.

**Input**: `patch: JSON!` — partial config object. Only the provided keys are updated; unspecified keys retain their current values. **Return type**: `JSON!` — the full updated config after merging.

### 5.9 Emit Event

```graphql
emitEvent(input: EmitEventInput!): MutateNodeResult!
```

Mirrors `ideate_emit_event`. Fires registered hooks for a named lifecycle event (e.g., cycle start, phase transition, autopilot decision). Auth scope: MEMBER or above.

**Purpose**: Provides a hook dispatch surface for lifecycle events. Events are not persisted — they dispatch to hook handlers registered at the workspace level for cross-cutting concerns (notifications, external integrations, audit logs).

**Input type**: `EmitEventInput` — fields: `eventType: String!`, `payload: JSON`, `cycle: Int`, `codebaseId: ID`. **Return type**: `MutateNodeResult!` — the created event node including its generated artifact ID.

---

## 6. Subscription Design

### 6.1 Transport

Subscriptions use WebSocket transport (graphql-ws protocol). The client authenticates via the `connectionParams` during the WebSocket handshake, providing the same JWT used for HTTP queries.

### 6.2 Events

| Subscription | Trigger | Use Case |
|---|---|---|
| `workItemStatusChanged` | Work item status mutation | Dashboard live updates |
| `newFinding` | Finding creation during review | Real-time review monitoring |
| `andonTriggered` | Proxy human decision with `ANDON` trigger | Human-in-the-loop alerts |
| `cycleLifecycle` | Cycle start, convergence, archive | Cycle progress tracking |
| `artifactChanged` | Any artifact mutation | Cache invalidation, collaboration |

### 6.3 Filtering

Each subscription accepts optional filter parameters to reduce noise:

- `workItemStatusChanged(projectId, phaseId)` -- filter to specific project or phase
- `newFinding(projectId, cycleNumber, minSeverity)` -- filter by severity threshold
- `andonTriggered(projectId)` -- filter to specific project
- `cycleLifecycle(projectId)` -- filter to specific project
- `artifactChanged(codebaseId, types)` -- filter by codebase and artifact type

### 6.4 Tenant Isolation

Subscriptions are scoped to the authenticated org. The server filters events by `orgId` before publishing to subscribers. No cross-org event leakage is possible.

### 6.5 Implementation Strategy

The server uses a pub/sub layer (Redis or in-memory for development) to distribute events from mutation resolvers to active subscriptions. Mutation resolvers publish events after successful persistence:

```
mutation resolver -> Neo4j write -> publish event -> subscription filter -> client
```

The pub/sub topic structure is `{orgId}:{eventType}` for tenant-scoped distribution.

---

## 7. Error Handling

### 7.1 GraphQL Error Extensions

All errors include structured extensions for programmatic handling:

```json
{
  "errors": [{
    "message": "Node not found: \"WI-999\"",
    "extensions": {
      "code": "NOT_FOUND",
      "details": { "id": "WI-999" }
    }
  }]
}
```

### 7.2 Error Code Mapping

StorageAdapter exceptions map to GraphQL error extension codes:

| StorageAdapter Exception | GraphQL Code | HTTP Status (REST equivalent) |
|---|---|---|
| `NotFoundError` | `NOT_FOUND` | 404 |
| `ImmutableFieldError` | `IMMUTABLE_FIELD` | 400 |
| `TypeMismatchError` | `TYPE_MISMATCH` | 400 |
| `CycleDetectedError` | `CYCLE_DETECTED` | 422 |
| `ScopeCollisionError` | `SCOPE_COLLISION` | 409 |
| `ConnectionError` | `CONNECTION_ERROR` | 503 |
| `MissingCycleError` | `MISSING_CYCLE` | 400 |
| Auth failure | `UNAUTHENTICATED` | 401 |
| Permission denied | `FORBIDDEN` | 403 |
| Rate limit exceeded | `RATE_LIMITED` | 429 |

### 7.3 Partial Success in Batch Operations

`batchMutate` and `writeWorkItems` return both `results` and `errors` arrays. The client can inspect per-item results to determine which operations succeeded. When validation fails (DAG cycle, scope collision), the entire batch fails atomically -- `results` is empty and `errors` contains the validation failures.

### 7.4 Null vs. Error Convention

- Nullable fields (e.g., `artifact(id)`) return `null` when the node does not exist. No error is raised.
- Non-nullable fields raise errors when they cannot be resolved.
- This matches the StorageAdapter convention where `getNode` returns null and `queryGraph` throws `NotFoundError` for missing origins.

---

## 8. N+1 Prevention and DataLoader Strategy

### 8.1 The Problem

GraphQL's nested resolution model creates N+1 query risks. For example, querying 50 work items with their `dependsOn` relationships would naively execute 51 Neo4j queries (1 for the list + 50 for dependencies).

### 8.2 DataLoader Solution

Every resolver that loads nodes uses a request-scoped DataLoader. The DataLoader batches individual `getNode(id)` calls into a single `getNodes(ids)` call per event loop tick.

DataLoader instances are created per-request in the GraphQL context factory:

```typescript
interface ResolverContext {
  auth: AuthContext;
  loaders: {
    node: DataLoader<string, ArtifactNode | null>;
    edges: DataLoader<string, Edge[]>;
    content: DataLoader<string, string>;
  };
}
```

### 8.3 DataLoader Keys

| Loader | Key | Batch Function |
|---|---|---|
| `node` | `artifactId` | `StorageAdapter.getNodes(ids)` |
| `edges` | `artifactId:direction` | Batch edge query grouped by direction |
| `content` | `artifactId` | Batch content read |

### 8.4 Relationship Resolvers

All relationship fields on artifact types use DataLoaders:

```typescript
// WorkItem.dependsOn resolver
async dependsOn(parent, args, ctx) {
  const edges = await ctx.loaders.edges.load(`${parent.artifactId}:outgoing`);
  const depIds = edges
    .filter(e => e.edgeType === 'DEPENDS_ON')
    .map(e => e.targetId);
  return ctx.loaders.node.loadMany(depIds);
}
```

### 8.5 Query Depth Limiting

To prevent abuse, the server enforces a maximum query depth of 10 levels. Queries exceeding this depth are rejected before execution. This also bounds the potential DataLoader cascade depth.

---

## 9. Federation Boundaries

### 9.1 Current Architecture: Monolith

The initial ideate-server is a monolith -- a single GraphQL service that owns all types and resolvers. This is appropriate for the current scale.

### 9.2 Identified Service Boundaries

When the monolith needs to split, these are the natural service boundaries based on data ownership and independent scaling needs:

| Service | Owns | Types | Rationale |
|---|---|---|---|
| **artifact-service** | Artifact CRUD, graph traversal, PPR, context assembly | ArtifactNode (all subtypes), Edge, TraversalResult, QueryResult | Core data model; scales with graph size |
| **tenant-service** | Organization, Codebase, auth, billing | Organization, Codebase, AuthContext | Scales with user count, not graph size |
| **metrics-service** | MetricsEvent, aggregation | MetricsEvent, MetricAggregate, MetricsResult | Write-heavy; independent retention policies |
| **event-service** | Subscriptions, event bus, hooks | All subscription types, EventResult | Real-time infra; different availability requirements |

### 9.3 Entity Extension Points

The schema is designed so that types can be extended across services using Apollo Federation `@key` directives:

```graphql
# artifact-service
type WorkItem @key(fields: "id") {
  id: ID!
  # ... all current fields
}

# metrics-service extends WorkItem with metrics
extend type WorkItem @key(fields: "id") {
  id: ID! @external
  metrics: MetricAggregate
}

# tenant-service provides Organization
type Organization @key(fields: "orgId") {
  orgId: ID!
  # ... all current fields
}

# artifact-service references Organization
extend type Organization @key(fields: "orgId") {
  orgId: ID! @external
  projects: [Project!]!
}
```

### 9.4 Federation Decision: Deferred

Federation adds operational complexity (gateway, service discovery, distributed tracing). The monolith handles the expected scale for Phases 2-4 of the roadmap. Federation should be evaluated when:

- A single type's resolver latency impacts unrelated queries
- MetricsEvent write volume requires independent scaling
- The development team grows beyond 3 people and service ownership becomes a coordination concern

### 9.5 Schema Stitching Avoidance

Apollo Federation is preferred over schema stitching. Federation's `@key` / `@external` / `@provides` directives make entity ownership explicit and avoid the fragility of schema stitching's type merging.

---

## 10. Mapping: MCP Tools to GraphQL Operations

Every MCP tool operation has a GraphQL equivalent. This table is the canonical mapping for implementing the RemoteAdapter:

| MCP Tool | GraphQL Operation | Notes |
|---|---|---|
| `ideate_get_artifact_context` | `query { artifactContext(id) }` | Resolver assembles context from node + edges |
| `ideate_get_context_package` | `query { contextPackage }` | Resolver aggregates principles, constraints, architecture |
| `ideate_get_config` | `query { config }` | Returns codebase-level config |
| `ideate_artifact_query` (filter mode) | `query { artifactQuery(filter, first, after) }` | Cursor pagination replaces offset/limit |
| `ideate_artifact_query` (graph mode) | `query { graphQuery(query, first, after) }` | Cursor pagination replaces offset/limit |
| `ideate_get_execution_status` | `query { executionStatus }` | |
| `ideate_get_review_manifest` | `query { reviewManifest(cycleNumber) }` | |
| `ideate_get_convergence_status` | `query { convergenceStatus(cycleNumber) }` | |
| `ideate_get_domain_state` | `query { domainState(domains) }` | |
| `ideate_get_workspace_status` | `query { workspaceStatus }` | |
| `ideate_append_journal` | `mutation { appendJournal(input) }` | |
| `ideate_archive_cycle` | `mutation { archiveCycle(cycleNumber) }` | Remote: status change, not file move |
| `ideate_write_work_items` | `mutation { writeWorkItems(items) }` | |
| `ideate_update_work_items` | `mutation { updateWorkItems(updates) }` | |
| `ideate_write_artifact` | `mutation { putNode(input) }` | Generic artifact write |
| `ideate_assemble_context` | `query { assembleContext(input) }` | Server-side PPR |
| `ideate_emit_event` | `mutation { emitEvent(input) }` | |
| `ideate_bootstrap_workspace` | `mutation { bootstrapWorkspace(projectName) }` | |
| `ideate_get_next_id` | `query { nextId(type, cycle) }` | |
| `ideate_manage_autopilot_state` | `mutation { manageAutopilotState(action, state) }` | |
| `ideate_update_config` | `mutation { updateConfig(patch) }` | |

---

## 11. Mapping: StorageAdapter to GraphQL Operations

| StorageAdapter Method | GraphQL Operation | Differences |
|---|---|---|
| `getNode(id)` | `query { artifact(id) }` | Returns null for missing (same) |
| `getNodes(ids)` | `query { artifacts(ids) }` | Returns list instead of Map |
| `readNodeContent(id)` | `artifact(id) { content }` | Content is a field on ArtifactNode |
| `putNode(input)` | `mutation { putNode(input) }` | Server computes hash/tokens (same) |
| `patchNode(input)` | `mutation { patchNode(input) }` | Same semantics |
| `deleteNode(id)` | `mutation { deleteNode(id) }` | Same semantics |
| `putEdge(edge)` | `mutation { putEdge(input) }` | Same idempotent semantics |
| `removeEdges(source, types)` | `mutation { removeEdges(sourceId, edgeTypes) }` | Same semantics |
| `getEdges(id, direction)` | `artifact(id) { edges(direction, types) }` | Nested field on ArtifactNode |
| `traverse(options)` | `query { assembleContext(input) }` | Same PPR semantics |
| `queryGraph(query, limit, offset)` | `query { graphQuery(query, first, after) }` | Cursor pagination replaces offset/limit |
| `queryNodes(filter, limit, offset)` | `query { artifactQuery(filter, first, after) }` | Cursor pagination replaces offset/limit |
| `nextId(type, cycle)` | `query { nextId(type, cycle) }` | Same semantics |
| `batchMutate(input)` | `mutation { batchMutate(input) }` | Same atomic semantics |
| `countNodes(filter, groupBy)` | `query { nodeCounts(filter, groupBy) }` | Same semantics |
| `getDomainState(domains)` | `query { domainState(domains) }` | Returns list instead of Map |
| `getConvergenceData(cycle)` | `query { convergenceStatus(cycleNumber) }` | Same semantics |
| `archiveCycle(cycleNumber)` | `mutation { archiveCycle(cycleNumber) }` | Remote: status change, not file move |
| `initialize()` | N/A | Server lifecycle, not a GraphQL operation |
| `shutdown()` | N/A | Server lifecycle, not a GraphQL operation |

---

## 12. Type System Design Decisions

### 12.1 Interface vs. Union for ArtifactNode

The schema uses an `interface ArtifactNode` rather than a `union ArtifactNode`. This allows shared fields (id, type, status, contentHash, etc.) to be queried without `... on` fragments. Concrete types implement the interface and add type-specific fields.

```graphql
# With interface -- common fields are directly queryable
query {
  artifactQuery(filter: { type: WORK_ITEM }) {
    edges {
      node {
        id
        artifactId
        status    # common field, no fragment needed
        ... on WorkItem {
          title   # type-specific field
          complexity
        }
      }
    }
  }
}
```

### 12.2 JSON Scalar for Flexible Properties

Some fields use the `JSON` scalar type instead of structured GraphQL types:

- `WorkItem.scope` -- Array of `{path, op}` objects. Structured type adds complexity without strong typing benefit.
- `Finding.fileRefs` -- Array of `{path, line?}` objects. Same rationale.
- `MetricsEvent.payload` -- Arbitrary metric data. Cannot be typed.
- `TraversalInput.edgeTypeWeights` -- Map of edge type to weight. GraphQL has no native Map type.
- `MutateNodeInput.properties` -- Generic node properties. Type varies by artifact type.

The trade-off is reduced schema-level validation for these fields. Server-side validation compensates.

### 12.3 Separate Mutation Inputs for Work Items

`WriteWorkItemInput` and `UpdateWorkItemInput` are separate from the generic `MutateNodeInput` because:

- They provide typed fields with proper enums (`WorkItemComplexity`, `WorkItemType`) instead of `JSON` properties.
- They match the MCP tool API shape, making the RemoteAdapter implementation straightforward.
- They can have independent validation rules (e.g., `title` is required for write but optional for update).

---

## 13. Rate Limiting and Query Complexity

### 13.1 Query Cost Analysis

The server uses query cost analysis to prevent expensive queries:

| Operation | Base Cost | Per-Item Cost |
|---|---|---|
| `artifact` | 1 | -- |
| `artifacts` | 1 | 1 per ID |
| `artifactQuery` | 5 | 1 per result |
| `graphQuery` | 10 | 2 per result (traversal cost) |
| `assembleContext` | 20 | -- (server controls result size via token budget) |
| Mutations | 10 | 5 per item in batch |
| Nested `edges` field | 2 | -- |
| Nested relationship fields (`dependsOn`, `phases`, etc.) | 3 | -- |

### 13.2 Cost Limits

- Maximum query cost per request: 1000
- Maximum query depth: 10 levels
- Maximum batch size: 100 items per `batchMutate` / `writeWorkItems`

### 13.3 Rate Limiting

Per-org rate limiting (not per-user) to prevent abuse while allowing automated agent workloads:

| Tier | Queries/min | Mutations/min |
|---|---|---|
| Free | 60 | 30 |
| Team | 600 | 300 |
| Enterprise | 6000 | 3000 |

---

## 14. Caching Strategy

### 14.1 Response Caching

Read-only queries that are idempotent (marked with `readOnlyHint: true` in MCP) are candidates for HTTP caching:

```
Cache-Control: private, max-age=30
```

Mutations and subscriptions are never cached.

### 14.2 Cache Invalidation

The `artifactChanged` subscription enables client-side cache invalidation. When a mutation occurs, the server publishes an `ArtifactChangeEvent` containing the artifact ID and type. Clients subscribed to this event can evict or refetch the affected cache entries.

### 14.3 Persisted Queries

For production deployments, the server supports Apollo-style automatic persisted queries (APQ). The RemoteAdapter sends a query hash on the first request; the server returns the cached response or requests the full query body. This reduces network payload for repeated operations.

---

## 15. Open Questions

1. **Full-text search as a query**: The Neo4j schema includes a full-text index. Should the GraphQL schema expose a `search(query: String!)` query? Currently deferred -- can be added without breaking changes.

2. **Autopilot state storage**: `manageAutopilotState` currently uses a local file. In remote mode, should this be a node in the graph or a separate key-value store?

3. **Config storage**: `config` and `updateConfig` currently read/write a local JSON file. In remote mode, should config be per-codebase, per-project, or per-organization?

4. **Subscription backpressure**: For high-throughput workloads (many agents writing metrics simultaneously), the `artifactChanged` subscription could overwhelm slow clients. Consider adding server-side buffering or debouncing.

5. **File upload for migration**: The migration tool needs to upload `.ideate/` directory contents to the server. Should this use a GraphQL mutation with base64-encoded content, or a separate REST endpoint for bulk upload?
