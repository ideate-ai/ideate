# StorageAdapter Architecture Overview

> System architecture, data flow, refactoring plan, and migration path for the StorageAdapter extraction.
> Produced as WI-543 during Phase 0 (PH-018) of the Platform Strategy project.
> Companion to [adapter-interface.md](./adapter-interface.md).

---

## 1. System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  MCP Tool Handlers (business logic, validation, formatting)     │
│                                                                  │
│  tools/write.ts    tools/context.ts    tools/query.ts            │
│  tools/analysis.ts tools/index.ts      tools/metrics.ts          │
│  tools/events.ts                                                  │
│  (Note: only storage-heavy handlers are shown above)              │
│                                                                  │
│  Responsibilities that STAY here:                                │
│  - Input validation and argument parsing                         │
│  - Business rules (DAG validation results, scope collision       │
│    interpretation, convergence logic)                            │
│  - Response formatting (markdown tables, YAML output)            │
│  - Token budgeting decisions                                     │
│  - Source code indexing (file system scan for code context)       │
└──────────────────────┬───────────────────────────────────────────┘
                       │
                       │  StorageAdapter interface
                       │  (nodes, edges, traversals, mutations)
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
┌─────────────────────┐   ┌──────────────────────┐
│  LocalAdapter        │   │  RemoteAdapter        │
│                     │   │                      │
│  ┌───────────────┐  │   │  ┌────────────────┐  │
│  │ YAML I/O      │  │   │  │ GraphQL Client │  │
│  │ (read/write   │  │   │  │ (Apollo, urql, │  │
│  │  .ideate/)    │  │   │  │  or fetch)     │  │
│  └───────────────┘  │   │  └────────────────┘  │
│  ┌───────────────┐  │   │  ┌────────────────┐  │
│  │ SQLite/Drizzle│  │   │  │ Auth0 Token    │  │
│  │ (index.db)    │  │   │  │ Management     │  │
│  └───────────────┘  │   │  └────────────────┘  │
│  ┌───────────────┐  │   │                      │
│  │ ppr.ts        │  │   │  PPR: delegates to   │
│  │ (in-process)  │  │   │  server-side endpoint │
│  └───────────────┘  │   │                      │
│  ┌───────────────┐  │   └──────────────────────┘
│  │ indexer.ts    │  │             │
│  │ (rebuild,     │  │             ▼
│  │  incremental) │  │   ┌──────────────────────┐
│  └───────────────┘  │   │  ideate-server        │
│  ┌───────────────┐  │   │  (GraphQL API)        │
│  │ db-helpers.ts │  │   │  ┌────────────────┐  │
│  │ (upsert,      │  │   │  │ Neo4j          │  │
│  │  query helpers)│  │   │  └────────────────┘  │
│  └───────────────┘  │   │  ┌────────────────┐  │
│  ┌───────────────┐  │   │  │ Server PPR     │  │
│  │ watcher.ts    │  │   │  └────────────────┘  │
│  │ (file change  │  │   └──────────────────────┘
│  │  detection)   │  │
│  └───────────────┘  │
└─────────────────────┘
```

---

## 2. Data Flow

### 2.1 Local Mode — Write Path

```
Tool handler: handleWriteArtifact(ctx, args)
  │
  ├── Validate input (type, id, required fields)          ← stays in handler
  ├── Build node properties from args                     ← stays in handler
  │
  └── adapter.putNode({ id, type, properties, cycle })    ← adapter call
        │
        LocalAdapter internally:
        ├── Compute content_hash from properties
        ├── Serialize to YAML
        ├── Write YAML file to .ideate/{type_dir}/{id}.yaml
        ├── Compute token_count from serialized content
        ├── BEGIN EXCLUSIVE TRANSACTION
        │   ├── Upsert nodes table row
        │   ├── Upsert extension table row (work_items, findings, etc.)
        │   └── Insert edges (implicit from properties)
        ├── COMMIT
        └── On failure: delete YAML file, rethrow
```

### 2.2 Local Mode — Read/Context Path

```
Tool handler: handleAssembleContext(ctx, args)
  │
  ├── Parse seed_ids, token_budget, include_types         ← stays in handler
  ├── Load PPR config from config.json                    ← stays in handler
  │
  └── adapter.traverse({                                  ← adapter call
  │     seed_ids, alpha, max_iterations,
  │     token_budget, always_include_types
  │   })
  │     │
  │     LocalAdapter internally:
  │     ├── Run computePPR(drizzleDb, seedIds, options)
  │     ├── Query node metadata for PPR results
  │     ├── Partition into always-include and ranked
  │     ├── Greedily assemble within token budget
  │     ├── Read YAML content for each included node
  │     └── Return TraversalResult
  │
  └── Format response (group by type, build markdown)     ← stays in handler
```

### 2.3 Local Mode — Query Path

```
Tool handler: handleArtifactQuery(ctx, args)
  │
  ├── Parse type, filters, related_to, depth, pagination  ← stays in handler
  │
  ├── if related_to:
  │   └── adapter.queryGraph(                             ← adapter call
  │         { origin_id, depth, direction, edge_types,
  │           type_filter, filters },
  │         limit, offset
  │       )
  │
  ├── else:
  │   └── adapter.queryNodes(filter, limit, offset)       ← adapter call
  │
  └── Format response (markdown table)                    ← stays in handler
```

### 2.4 Remote Mode — Write Path

```
Tool handler: handleWriteArtifact(ctx, args)
  │
  ├── Validate input                                      ← stays in handler
  ├── Build node properties                               ← stays in handler
  │
  └── adapter.putNode({ id, type, properties, cycle })    ← adapter call
        │
        RemoteAdapter internally:
        └── mutation PutNode($input: MutateNodeInput!) {
              putNode(input: $input) {
                id
                status
              }
            }
            Server handles: hash, storage, indexing, edge creation
```

### 2.5 Remote Mode — Traversal Path

```
Tool handler: handleAssembleContext(ctx, args)
  │
  ├── Parse arguments                                     ← stays in handler
  │
  └── adapter.traverse(options)                           ← adapter call
        │
        RemoteAdapter internally:
        └── query Traverse($options: TraversalInput!) {
              traverse(options: $options) {
                ranked_nodes { node { id type properties } score content }
                total_tokens
                ppr_scores { id score }
              }
            }
            Server runs PPR against Neo4j, returns ranked results
```

---

## 3. Refactoring Plan

### 3.1 Inventory: tools/write.ts (1289 lines)

#### handleAppendJournal (lines 71-172)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 89-94 | Query max cycle from SQLite | Storage | `countNodes` or `queryNodes` |
| 98-99 | Ensure journal directory exists | Storage | `putNode` (internal) |
| 106-109 | Count journal entries for cycle (next seq) | Storage | `nextId` |
| 116-126 | Build YAML object | Business logic | stays |
| 128-131 | Serialize and write YAML file | Storage | `putNode` |
| 134-154 | Compute hash, upsert node + extension row | Storage | `putNode` |

**Refactored call**: `adapter.putNode({ id: computed, type: "journal_entry", properties: entryObj })`

The adapter internally handles sequence numbering, YAML serialization, and SQLite upserts. Alternatively, the handler calls `adapter.nextId("journal_entry")` first, then `adapter.putNode()`.

#### handleArchiveCycle (lines 178-327)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 193-208 | Read findings directory, list files | Storage | New: adapter-internal archive operation |
| 216-239 | Parse YAML to find work item refs | Storage | `readNodeContent` + business logic |
| 241-306 | Copy files, verify hashes, delete originals | Storage | New: archive/move operation |
| 311-321 | Delete/update SQLite rows for moved files | Storage | `deleteNode` + `patchNode` |

**Refactored call**: New `archiveCycle(cycle: number)` method on the adapter, or a sequence of `deleteNode` / `patchNode` calls. This is an operation that is inherently local-mode-specific (file archival). The remote adapter would handle archival differently (status change, not file move).

**Design note**: Archive is a candidate for a local-only extension method rather than a core adapter interface method, since remote mode has no concept of file archival.

#### handleWriteWorkItems (lines 350-665)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 366-369 | Query max work item ID | Storage | `nextId` |
| 372-379 | Assign IDs to items | Business logic | stays (or `nextId` per item) |
| 382-427 | DAG cycle detection (temp edges + detect) | Storage | `batchMutate` validation |
| 429-489 | Scope collision detection | Business logic | `batchMutate` validation |
| 511-566 | Write YAML files (Phase 1) | Storage | `batchMutate` |
| 573-645 | SQLite upserts in transaction (Phase 2) | Storage | `batchMutate` |
| 646-664 | Cleanup on failure | Storage | `batchMutate` (internal) |

**Refactored call**:
```
const result = await adapter.batchMutate({
  nodes: items.map(item => ({
    id: item.id ?? undefined,  // adapter assigns if missing
    type: "work_item",
    properties: { title, complexity, scope, depends, ... }
  })),
  edges: []  // adapter extracts implicit edges from depends/blocks
});
```

The handler retains: input validation, response formatting. The adapter handles: ID generation, DAG validation, scope collision, two-phase write, rollback.

#### handleWriteArtifact (lines 737-1054)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 746-764 | Validate type, redirect work_item/journal | Business logic | stays |
| 768-769 | Resolve file path, ensure directory | Storage | `putNode` (internal) |
| 774-793 | Build YAML object, compute hash/tokens | Storage | `putNode` (internal) |
| 810-811 | Write YAML file (Phase 1) | Storage | `putNode` |
| 820-1040 | Type-specific SQLite upserts (Phase 2) | Storage | `putNode` |
| 1041-1051 | Cleanup on failure | Storage | `putNode` (internal) |

**Refactored call**: `adapter.putNode({ id, type, properties: content, cycle })`

The entire 300-line type-dispatch switch statement moves inside the LocalAdapter. The handler becomes ~20 lines: validate, call putNode, return success message.

#### handleUpdateWorkItems (lines 1079-1289)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 1099-1117 | Read existing YAML, check existence | Storage | `getNode` |
| 1119-1138 | Read cycle number from domain index | Storage | adapter-internal |
| 1140-1176 | Merge fields, recompute hash | Storage | `patchNode` (internal) |
| 1178-1182 | Write updated YAML | Storage | `patchNode` |
| 1209-1260 | SQLite upserts + edge replacement | Storage | `patchNode` |
| 1261-1279 | Rollback on failure | Storage | `patchNode` (internal) |

**Refactored call**: For each update:
```
await adapter.patchNode({
  id: update.id,
  properties: { status, title, complexity, ... }
});
```

### 3.2 Inventory: tools/context.ts (1405 lines)

#### handleGetArtifactContext (lines 235-280)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 253-260 | Look up node by ID (with normalization) | Storage | `getNode` |
| 270-279 | Dispatch by type | Business logic | stays |

**Refactored call**: `const node = await adapter.getNode(normalizedId)`

#### handleWorkItemContextById -> handleGetWorkItemContext (lines 499-808)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 517-525 | JOIN nodes + work_items query | Storage | `getNode` |
| 539-585 | Format work item section | Business logic | stays |
| 591-607 | Read and format notes | Business logic | stays (uses `node.properties.notes`) |
| 613-622 | Query module spec via edge | Storage | `queryGraph` or `getEdges` + `getNode` |
| 668-703 | Query domain policies by domain | Storage | `queryNodes` with domain filter |
| 710-790 | Query research findings by topic | Storage | `queryNodes` with topic filter |

**Refactored approach**: The handler calls `adapter.getNode(id)` to get the work item, then `adapter.getEdges(id, "outgoing")` to find module edges, then `adapter.queryNodes({ type: "domain_policy", domain })` for policies. All formatting stays in the handler.

#### handlePhaseContext (lines 292-408)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 306-313 | Query phase extension row | Storage | `getNode` |
| 350-360 | Query work items by phase | Storage | `queryNodes` with phase filter |
| 389-404 | Read YAML for success criteria | Storage | `readNodeContent` |

#### handleGenericArtifactContext (lines 411-493)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 435-442 | Read YAML content | Storage | `readNodeContent` |
| 453-469 | Query edges both directions | Storage | `getEdges` |

#### handleGetContextPackage (lines 815-1149)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 828-838 | Query architecture document | Storage | `queryNodes` with type filter |
| 886-892 | Query guiding principles | Storage | `queryNodes({ type: "guiding_principle" })` |
| 919-926 | Query constraints | Storage | `queryNodes({ type: "constraint" })` |
| 967-975 | Query active project | Storage | `queryNodes({ type: "project", status: "active" })` |
| 1026-1034 | Query active phase | Storage | `queryNodes({ type: "phase", status: "active" })` |
| 1066-1131 | Source code index (file system scan) | Business logic | stays (not storage) |

**Design note**: The source code index section scans the project's source files for export declarations. This is business logic specific to the context package tool and does not touch the artifact graph. It stays in the handler.

#### handleAssembleContext (lines 1201-1405)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 1222-1223 | Load PPR config | Business logic | stays |
| 1246-1251 | Run PPR | Storage | `traverse` |
| 1265-1274 | Query node metadata for PPR results | Storage | `traverse` (returns nodes) |
| 1280-1316 | Partition and sort by PPR score | Storage | `traverse` (returns ranked) |
| 1327-1346 | Greedy token budget assembly | Storage | `traverse` (respects budget) |
| 1360-1381 | Read artifact content, build markdown | Business logic | stays (uses `traverse` result) |

**Refactored call**: The entire PPR + budgeting + content loading collapses into a single `adapter.traverse(options)` call. The handler formats the returned `TraversalResult` into markdown.

### 3.3 Inventory: tools/query.ts (789 lines)

#### handleGetNextId (lines 26-80)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 55-65 | Query max ID for cycle-scoped types | Storage | `nextId` |
| 69-78 | Query max ID for standard types | Storage | `nextId` |

**Refactored call**: `const id = await adapter.nextId(type, cycle)`

#### runFilterMode (lines 263-384)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 270-384 | Build dynamic SQL, execute query, count | Storage | `queryNodes` |

**Refactored call**: `adapter.queryNodes(filter, limit, offset)`

#### runGraphMode (lines 390-601)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 400-415 | Verify seed node, dispatch by depth | Storage | `queryGraph` |
| 423-477 | Depth-1 edge query | Storage | `queryGraph` (depth=1) |
| 479-554 | Recursive CTE traversal | Storage | `queryGraph` (depth>1) |
| 556-601 | Execute traversal with filters, pagination | Storage | `queryGraph` |

**Refactored call**: `adapter.queryGraph(query, limit, offset)`

#### buildSummaryMap (lines 608-644)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 608-644 | Fetch summaries by joining extension tables | Storage | `queryGraph` / `queryNodes` (summary in result) |

The adapter includes summary computation in query results, eliminating the need for a separate summary fetch.

#### handleArtifactQuery (lines 679-789)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 683-718 | Parse and validate arguments | Business logic | stays |
| 720-762 | Route to graph mode, format table | Business logic + Storage | handler + `queryGraph` |
| 763-788 | Route to filter mode, format table | Business logic + Storage | handler + `queryNodes` |

### 3.4 Inventory: tools/analysis.ts (696 lines)

#### handleGetConvergenceStatus (lines 94-210)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 108-119 | Query cycle_summary rows by cycle | Storage | `getConvergenceData` |
| 124-155 | Resolve content (DB or file) | Storage | `getConvergenceData` |
| 158-162 | Parse principle verdict | Business logic | stays |
| 165-185 | Query finding counts by severity | Storage | `getConvergenceData` |
| 187-209 | Compute convergence, format output | Business logic | stays |

**Refactored call**: `const data = await adapter.getConvergenceData(cycleNumber)`. The handler runs `parsePrincipleVerdict` on the returned content and formats the output.

#### handleGetDomainState (lines 216-334)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 224-228 | Read cycle number from domain index file | Storage | `readNodeContent("domain-index")` or adapter method |
| 230-271 | Query policies, decisions, questions | Storage | `getDomainState` |
| 273-333 | Group by domain, format output | Business logic | stays |

**Refactored call**: `const state = await adapter.getDomainState(domains)`. The handler formats the returned map into markdown.

#### buildProjectView (lines 340-433)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 341-348 | Query active project | Storage | `queryNodes({ type: "project", status: "active" })` |
| 363-371 | Query active phase for project | Storage | `queryNodes({ type: "phase", status: "active" })` |
| 375-381 | Count work items by status for phase | Storage | `countNodes({ phase }, "status")` |
| 402-430 | Query horizon phases | Storage | `getNode` per phase ID |

#### buildPhaseView (lines 435-533)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 437-463 | Query active phase | Storage | `queryNodes({ type: "phase", status: "active" })` |
| 481-493 | Query work items for phase | Storage | `queryNodes({ type: "work_item", phase })` |
| 514-523 | Query dependency edges between phase items | Storage | `getEdges` or `queryGraph` |

#### handleGetWorkspaceStatus (lines 539-696)

| Line Range | Operation | Classification | Adapter Method |
|---|---|---|---|
| 551-555 | Read cycle number from domain index | Storage | adapter method or `readNodeContent` |
| 558-564 | Count work items by status | Storage | `countNodes({ type: "work_item" }, "status")` |
| 587-597 | Count findings by severity for cycle | Storage | `countNodes({ type: "finding", cycle }, "severity")` |
| 600-608 | Count open questions by domain | Storage | `countNodes({ type: "domain_question", status: "open" }, "domain")` |
| 654-661 | Query active project | Storage | `queryNodes({ type: "project", status: "active" })` |
| 675-682 | Query active phase | Storage | `queryNodes({ type: "phase", status: "active" })` |

### 3.5 Summary: Modules That Move Behind the Adapter

| Current Module | Becomes | Reason |
|---|---|---|
| `db-helpers.ts` | LocalAdapter internal | All upsert/query helpers are storage implementation |
| `indexer.ts` | LocalAdapter internal | YAML-to-SQLite indexing is local storage concern |
| `ppr.ts` | LocalAdapter internal | PPR is the local implementation of `traverse()` |
| `schema.ts` (createSchema) | LocalAdapter internal | SQLite schema is local storage concern |
| `watcher.ts` | LocalAdapter internal | File watching is local storage concern |

| Current Module | Stays External | Reason |
|---|---|---|
| `config.ts` | Server initialization | Config drives adapter selection, not adapter internals |
| `server.ts` | Server initialization | Creates adapter, wires to MCP transport |
| `tools/*.ts` | MCP tool handlers | Business logic, validation, formatting |
| `db.ts` (Drizzle schema) | LocalAdapter internal | Drizzle table definitions are storage concern |

---

## 4. Config.json Extension

### 4.1 Current Schema (version 3)

```json
{
  "schema_version": 3,
  "project_name": "ideate",
  "agent_budgets": { ... },
  "model_overrides": { ... },
  "circuit_breaker_threshold": 5,
  "default_appetite": 6,
  "spawn_mode": "subagent",
  "ppr": {
    "alpha": 0.15,
    "max_iterations": 50,
    "convergence_threshold": 1e-6,
    "edge_type_weights": { ... },
    "default_token_budget": 50000
  }
}
```

### 4.2 Extended Schema (version 4)

```json
{
  "schema_version": 4,
  "project_name": "ideate",
  "agent_budgets": { ... },
  "model_overrides": { ... },
  "circuit_breaker_threshold": 5,
  "default_appetite": 6,
  "spawn_mode": "subagent",
  "ppr": {
    "alpha": 0.15,
    "max_iterations": 50,
    "convergence_threshold": 1e-6,
    "edge_type_weights": { ... },
    "default_token_budget": 50000
  },
  "backend": "local",
  "remote": {
    "endpoint": "https://api.ideate.dev/graphql",
    "org_id": "org-abc123",
    "codebase_id": "cb-xyz789",
    "auth_token": null
  }
}
```

### 4.3 TypeScript Interface Extension

```typescript
export interface IdeateConfigJson {
  schema_version: number;
  project_name?: string;
  agent_budgets?: Record<string, number>;
  model_overrides?: Record<string, string>;
  circuit_breaker_threshold?: number;
  default_appetite?: number;
  spawn_mode?: SpawnMode;
  ppr?: {
    alpha?: number;
    max_iterations?: number;
    convergence_threshold?: number;
    edge_type_weights?: Record<string, number>;
    default_token_budget?: number;
  };
  /** Storage backend selection. Default: "local". */
  backend?: "local" | "remote";
  /** Remote backend configuration. Required when backend is "remote". */
  remote?: {
    /** GraphQL endpoint URL for the ideate-server. */
    endpoint: string;
    /** Organization ID for multi-tenant isolation. */
    org_id: string;
    /** Codebase ID within the organization. */
    codebase_id: string;
    /** Auth0 bearer token. Null means unauthenticated (dev mode). */
    auth_token?: string | null;
  };
}
```

### 4.4 Defaults and Validation

| Field | Default | Validation |
|---|---|---|
| `backend` | `"local"` | Must be `"local"` or `"remote"` |
| `remote.endpoint` | (none) | Required when `backend === "remote"`. Must be a valid URL. |
| `remote.org_id` | (none) | Required when `backend === "remote"`. Non-empty string. |
| `remote.codebase_id` | (none) | Required when `backend === "remote"`. Non-empty string. |
| `remote.auth_token` | `null` | Optional. When null, auth is skipped (local dev / testing). |

### 4.5 Migration

The schema version bumps from 3 to 4. The migration (in `migrations.ts`) is additive:
- Add `"backend": "local"` if absent (no behavior change for existing users)
- No `remote` block is added (only created when user configures remote mode)

Existing `config.json` files with `schema_version: 3` continue to work because `backend` defaults to `"local"` when absent.

---

## 5. Migration Path

### 5.1 Phase 1: Interface Definition (current — WI-543)

- Define the StorageAdapter TypeScript interface (this document)
- Document refactoring plan (this document)
- No code changes to existing handlers

### 5.2 Phase 2: LocalAdapter Extraction (PR-002, PH-019)

Recommended work item decomposition:

**WI-551: Create StorageAdapter interface and LocalAdapter scaffold**
- Create `src/adapter.ts` with the interface
- Create `src/local-adapter.ts` with stub implementations
- Wire `createAdapter` into server.ts initialization
- All stubs delegate to existing code paths (no behavior change)

**WI-552: Extract write operations behind LocalAdapter**
- Move `putNode` logic from handleWriteArtifact into LocalAdapter
- Move `batchMutate` logic from handleWriteWorkItems into LocalAdapter
- Move `patchNode` logic from handleUpdateWorkItems into LocalAdapter
- Handler code reduced to: validate -> adapter call -> format response
- Risk: highest — 1000+ lines of interleaved YAML/SQLite logic

**WI-553: Extract read/query operations behind LocalAdapter**
- Move `getNode`, `getNodes`, `readNodeContent` into LocalAdapter
- Move `queryNodes`, `queryGraph` from query.ts into LocalAdapter
- Move `nextId` from handleGetNextId into LocalAdapter
- Move `countNodes`, `getDomainState`, `getConvergenceData` into LocalAdapter

**WI-554: Extract traversal (PPR) behind LocalAdapter**
- Move `traverse` (wrapping computePPR + token budgeting + content loading)
- handleAssembleContext becomes: parse args -> adapter.traverse -> format
- handleGetContextPackage uses adapter queries instead of raw SQL

**WI-555: Extract edge operations behind LocalAdapter**
- Move `putEdge`, `removeEdges`, `getEdges` into LocalAdapter
- Update handlers that query edges directly

**WI-556: Contract tests for StorageAdapter**
- Write adapter-level tests using the LocalAdapter
- Tests exercise the interface, not the implementation
- These tests will be reused for RemoteAdapter validation

### 5.3 Phase 3: Config Extension

**WI-557: Add backend config to config.json**
- Bump schema_version to 4
- Add migration in migrations.ts
- Add backend/remote fields to IdeateConfigJson
- Wire config into adapter factory (createAdapter)

### 5.4 Extraction Strategy

The recommended extraction order minimizes risk:

1. **Scaffold first** (WI-551): Create the interface and adapter with pass-through stubs. Every handler continues to work identically. This is a zero-risk step.

2. **Write path second** (WI-552): The write path is the most complex (two-phase, rollback, DAG validation). Extract it early so the pattern is established.

3. **Read/query path third** (WI-553): These are simpler (read-only, no transactions). Many operations are one-line SQL queries that become one-line adapter calls.

4. **Traversal fourth** (WI-554): PPR is already well-encapsulated in ppr.ts. The main work is wiring it through the adapter interface.

5. **Edge operations last** (WI-555): Edge operations are small and scattered. They are best extracted after the node operations are stable.

6. **Contract tests throughout** (WI-556): Write tests alongside each extraction step, not as a separate phase.

### 5.5 Verification Strategy

Each extraction step must satisfy:

1. **All existing MCP tools produce identical output** for the same input. This can be verified by running the ideate review cycle against itself before and after each step.

2. **No new dependencies are introduced** in tool handler files. After extraction, tool handlers should import only from `adapter.ts` (the interface), not from `db-helpers.ts`, `indexer.ts`, `ppr.ts`, or `schema.ts`.

3. **The LocalAdapter passes all contract tests** that will later be reused for RemoteAdapter.

---

## 6. ToolContext Evolution

### 6.1 Current ToolContext

```typescript
interface ToolContext {
  db: Database.Database;        // raw better-sqlite3 handle
  drizzleDb: DrizzleDb;         // Drizzle ORM wrapper
  ideateDir: string;            // path to .ideate/ directory
}
```

### 6.2 Target ToolContext

```typescript
interface ToolContext {
  adapter: StorageAdapter;      // single entry point for all storage
  ideateDir: string;            // retained for source code indexing (non-storage)
}
```

The `db` and `drizzleDb` fields are removed from ToolContext. They become internal state of the LocalAdapter. Tool handlers never touch SQLite directly.

The `ideateDir` field is retained because some tool handlers use it for non-storage purposes (e.g., deriving the project source root for the source code index in handleGetContextPackage). In remote mode, `ideateDir` would still point to a local directory for source code scanning, even though artifact storage is remote.

---

## 7. Open Questions

1. **Archive operation (resolved)**: `archiveCycle(cycle: number): Promise<void>` is a core StorageAdapter interface method with backend-specific semantics. LocalAdapter performs artifact moves and index updates; RemoteAdapter calls the archiveCycle GraphQL mutation to transition statuses. See adapter-interface.md Section 4.7.

2. **Metrics emit (resolved)**: `handleEmitMetric` (in tools/metrics.ts) is a no-op shim retained for backward compatibility — emission was soft-deprecated in WI-790 (see D-211); the tool stays registered to avoid breaking existing skill code, but no new rows are written to `metrics_events`. `handleEmitEvent` (in tools/events.ts) still writes event records via the putNode pattern. The original question of whether metrics should follow a fast-path is moot under soft-deprecation; it returns when replacement telemetry is designed in PH-047-candidate.

3. **Source code index**: handleGetContextPackage scans the filesystem for source files. This is not artifact storage — it is project context. Should the adapter own source code scanning, or should it remain a handler concern?

4. **File watcher**: The current watcher.ts detects YAML changes and triggers incremental re-indexing. In remote mode, there is no local YAML to watch. The watcher is purely a LocalAdapter concern. Confirmed: it moves behind the adapter.
