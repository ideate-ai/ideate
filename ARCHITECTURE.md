# Ideate Architecture

Deep technical reference for the Ideate MCP artifact server. For installation and usage see [README.md](README.md).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [MCP Artifact Server](#2-mcp-artifact-server)
3. [Schema Design](#3-schema-design)
4. [Indexer Pipeline](#4-indexer-pipeline)
5. [Tool Architecture](#5-tool-architecture)
6. [Graph Model](#6-graph-model)
7. [YAML Source of Truth](#7-yaml-source-of-truth)
8. [File Watcher](#8-file-watcher)

---

## 1. System Overview

### Plugin structure

```
agents/          # Specialized agents invoked by skills
skills/          # User-invocable Claude Code skills
scripts/         # Utility scripts (validation, migration)
mcp/
  artifact-server/
    src/         # TypeScript source for the MCP server
    dist/        # Compiled output
specs/           # Ideate's own artifact directory (uses the same structure it creates)
```

### SDLC lifecycle

```
/ideate:plan ──► /ideate:execute ──► /ideate:review ──► /ideate:refine
                                            │                  │
                                            └──────────────────┘
                                            (repeating cycles)

/ideate:brrr = autonomous execute → review → refine loop
```

### Data flow

```
┌──────────────────────────────────────────────────────────────────┐
│                          Skill (Claude)                          │
│  /ideate:plan  /ideate:execute  /ideate:review  /ideate:refine  │
└────────────────────────────┬─────────────────────────────────────┘
                             │ MCP tool calls (mandatory — GP-8)
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│               ideate-artifact-server (MCP server)                │
│                                                                  │
│   ToolContext { db, drizzleDb, ideateDir }                       │
│                                                                  │
│   Read tools → SQLite query                                      │
│   Write tools → YAML file write → SQLite upsert                  │
└────────────────┬──────────────────────┬──────────────────────────┘
                 │ reads/queries        │ watches for changes
                 ▼                      ▼
┌───────────────────────┐   ┌───────────────────────────────────────┐
│  .ideate/index.db     │   │  .ideate/                             │
│  (SQLite runtime      │◄──│    work-items/*.yaml                  │
│   index — derived)    │   │    principles/*.yaml                  │
│                       │   │    constraints/*.yaml                 │
│  nodes                │   │    policies/*.yaml                    │
│  work_items           │   │    decisions/*.yaml                   │
│  findings             │   │    questions/*.yaml                   │
│  domain_policies      │   │    modules/*.yaml                     │
│  domain_decisions     │   │    cycles/*/journal/*.yaml            │
│  domain_questions     │   │    ...                                │
│  edges                │   └───────────────────────────────────────┘
│  node_file_refs       │              (YAML = source of truth)
│  ...                  │
└───────────────────────┘
```

Skills access artifacts exclusively through MCP tools. Direct file reads for artifacts are not permitted (GP-8). The SQLite index is a derived cache, rebuilt from YAML on startup and kept current by the file watcher.

---

## 2. MCP Artifact Server

The artifact server is a Node.js process that speaks the MCP stdio protocol. It provides a structured query interface over the artifact directory so skills can assemble context with focused SQL-backed lookups rather than dozens of individual file reads.

**Entry point**: `mcp/artifact-server/src/index.ts`

**Startup sequence**:

```
resolveArtifactDir()       # Find .ideate/ via env var or directory walk
  → open SQLite (WAL mode, foreign_keys = ON)
  → checkSchemaVersion()   # Delete and recreate DB if version mismatch
  → createSchema()         # CREATE TABLE IF NOT EXISTS (idempotent)
  → rebuildIndex()         # Full YAML scan
  → artifactWatcher.watch()# chokidar watcher on .ideate/
  → server.connect(StdioServerTransport)
```

**Artifact directory**: The server operates on `.ideate/` — a structured subdirectory of the project root containing YAML artifact files organized by type. The `.ideate/config.json` file marks the directory and stores the schema version.

**Database location**: `.ideate/index.db` — colocated with the artifacts it indexes. WAL mode and `busy_timeout = 5000` are set for concurrent access safety.

**FK integrity**: `PRAGMA foreign_keys = ON` is set at connection open and after schema-version-triggered recreation. Extension tables and the edges table both declare `ON DELETE CASCADE` so deleting a node from `nodes` removes all related rows automatically.

---

## 3. Schema Design

The schema uses class table inheritance: a single `nodes` base table holds the 8 common columns shared by all artifact types, and 12 extension tables each hold type-specific columns. Every extension table's `id` column is a foreign key referencing `nodes(id)` with `ON DELETE CASCADE`.

### nodes base table (8 columns)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Type-prefixed identifier (e.g. `WI-184`, `P-7`, `D-15`) |
| `type` | TEXT | YAML artifact type string |
| `cycle_created` | INTEGER | Cycle number when first created |
| `cycle_modified` | INTEGER | Cycle number of last modification |
| `content_hash` | TEXT | SHA-256 of raw YAML file content |
| `token_count` | INTEGER | Estimated token count (chars / 4) |
| `file_path` | TEXT | Absolute path to the source YAML file |
| `status` | TEXT | Artifact status (e.g. `pending`, `done`, `active`) |

Indexes: `idx_nodes_type` on `(type)`, `idx_nodes_file_path` on `(file_path)`.

### Extension tables (12 tables)

Each extension table has `id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE` as its only reference to the base table. Type-specific columns are NOT NULL only where required by business logic.

| Table | Artifact type(s) | Key columns |
|-------|-----------------|-------------|
| `work_items` | `work_item` | `title`, `complexity`, `scope` (JSON), `depends` (JSON), `blocks` (JSON), `criteria` (JSON), `module`, `domain` |
| `findings` | `finding` | `severity`, `work_item`, `file_refs` (JSON), `verdict`, `cycle`, `reviewer` |
| `domain_policies` | `domain_policy` | `domain`, `derived_from` (JSON), `established`, `amended`, `amended_by` |
| `domain_decisions` | `domain_decision` | `domain`, `cycle`, `supersedes`, `description`, `rationale` |
| `domain_questions` | `domain_question` | `domain`, `impact`, `source`, `resolution`, `resolved_in`, `addressed_by` |
| `guiding_principles` | `guiding_principle` | `name`, `description`, `amendment_history` (JSON) |
| `constraints` | `constraint` | `category`, `description` |
| `module_specs` | `module_spec` | `name`, `scope`, `provides` (JSON), `requires` (JSON), `boundary_rules` (JSON) |
| `research_findings` | `research_finding` | `topic`, `date`, `content`, `sources` (JSON) |
| `journal_entries` | `journal_entry` | `phase`, `date`, `title`, `work_item`, `content` |
| `metrics_events` | `metrics_event` | `event_name`, `timestamp`, `payload` (JSON) |
| `document_artifacts` | `decision_log`, `cycle_summary`, `review_manifest`, `architecture`, `overview`, `execution_strategy`, `guiding_principles`, `constraints`, `research`, `interview` | `title`, `cycle`, `content` |

The `document_artifacts` table is a catch-all for Markdown document artifacts: plan docs, cycle summaries, review manifests, and interview transcripts. All map to the same table regardless of their YAML `type` field.

### edges table

```sql
CREATE TABLE edges (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL,
  props     TEXT,                          -- JSON-encoded extra properties
  UNIQUE(source_id, target_id, edge_type)
)
```

Indexes: `idx_edges_source` on `(source_id, edge_type)`, `idx_edges_target` on `(target_id, edge_type)`.

### node_file_refs table

```sql
CREATE TABLE node_file_refs (
  node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  PRIMARY KEY (node_id, file_path)
)
```

Used for work items: each `scope` entry path is stored here so nodes can be found by the source files they touch.

### Type-prefixed IDs (P-31)

Artifact IDs include a type prefix to prevent cross-type collisions and aid readability:

| Prefix | Type |
|--------|------|
| `WI-NNN` | work_item |
| `P-N` | domain_policy |
| `D-N` | domain_decision |
| `Q-N` | domain_question |
| `GP-N` | guiding_principle |
| `C-N` | constraint |
| `J-NNN-NNN` | journal_entry |
| `F-...` | finding |

### Schema versioning

`PRAGMA user_version` stores `CURRENT_SCHEMA_VERSION` (currently `1`). On startup, `checkSchemaVersion()` reads the pragma and deletes the database file if the version does not match, triggering a clean rebuild. A version of `0` means a fresh (empty) database and is treated as compatible.

---

## 4. Indexer Pipeline

The indexer converts the YAML artifact files under `.ideate/` into the SQLite index. It runs once at startup (`rebuildIndex()`) and again whenever the file watcher fires.

### Startup sequence detail

```
index.ts startup
  │
  ├─ resolveArtifactDir()
  │   walks up the directory tree looking for .ideate/config.json
  │
  ├─ new Database(dbPath)
  │   WAL mode, busy_timeout = 5000, foreign_keys = ON
  │
  ├─ checkSchemaVersion()
  │   pragma user_version → if mismatch, delete DB files, reopen fresh
  │
  ├─ createSchema()
  │   CREATE TABLE IF NOT EXISTS (all tables, idempotent)
  │
  ├─ rebuildIndex()
  │   (see below)
  │
  └─ artifactWatcher.watch(ideateDir)
```

### rebuildIndex() pipeline

```
walkDir(.ideate/)
  → filter *.yaml / *.yml files
  → for each file:
      ├─ read content
      ├─ sha256(content)
      ├─ SELECT id, content_hash FROM nodes WHERE file_path = ?
      │   if hash matches → skip (add id to keepIds, continue)
      │   if hash differs or missing → proceed
      ├─ parseYaml(content)
      ├─ resolve extensionTable from TYPE_TO_EXTENSION_TABLE[doc.type]
      ├─ buildNodeRow()      → 8 common columns
      ├─ buildExtensionRow() → type-specific columns
      └─ upsertNode() + upsertExtension()
         + delete old edges/file_refs for this node
         + extractEdges()    → EDGE_TYPE_REGISTRY-driven edge upserts
         + extractFileRefs() → work_item scope → node_file_refs

→ deleteStaleRows()  (nodes not in keepIds → CASCADE removes extension rows, edges, refs)
→ detectCycles()     (Kahn's algorithm on depends_on edges — read-only, outside transaction)
```

### Two-phase FK design

Foreign key enforcement is toggled around the upsert phase to allow edges to reference identifiers (domain names, module IDs) that may not themselves be indexed nodes:

```
PRAGMA foreign_keys = OFF   ← set before transaction (SQLite does not allow inside transaction)

transaction:
  for each YAML file:
    upsertNode()
    upsertExtension()
    extractEdges()     ← edges may reference non-existent target IDs
    extractFileRefs()

PRAGMA foreign_keys = ON    ← re-enabled in finally block

transaction:
  deleteStaleRows()   ← ON DELETE CASCADE fires correctly here
```

### Hash-based skip

Before parsing, the indexer issues a single `SELECT id, content_hash FROM nodes WHERE file_path = ?`. If the stored hash matches the current SHA-256 of the file content, the file is skipped entirely and its ID is added to `keepIds`. This keeps incremental rebuilds fast when few files changed.

### Cycle detection

After the delete phase, `detectCycles()` runs outside any transaction on `depends_on` edges using Kahn's algorithm:

1. Build adjacency list and in-degree map from all `depends_on` edges
2. Initialize queue with all zero-in-degree nodes
3. Process queue; decrement in-degree of neighbors; enqueue those reaching zero
4. Nodes remaining with non-zero in-degree are in cycles
5. Group cycle nodes into connected components via BFS within the cycle subgraph
6. Return array of components (each component is an array of node IDs)

Limits: 10,000 nodes and 50,000 edges before an error is thrown.

---

## 5. Tool Architecture

### ToolContext

All tool handlers receive a single `ToolContext`:

```typescript
interface ToolContext {
  db: Database.Database;          // better-sqlite3 raw connection
  drizzleDb: BetterSQLite3Database<any>;  // Drizzle ORM wrapper
  ideateDir: string;              // absolute path to .ideate/
}
```

The raw `db` is used for recursive CTE queries and other SQL that Drizzle cannot express. `drizzleDb` is used for CRUD operations. Both operate on the same underlying SQLite file.

### 11 tools in 5 categories

```
Context tools
  ideate_get_work_item_context    — work item + notes + module spec + domain policies + research
  ideate_get_context_package      — architecture + principles + constraints + source code index

Query tools
  ideate_artifact_query           — filter by type/domain/status/cycle + graph traversal

Execution tools
  ideate_get_execution_status     — work item counts by status, dependency-resolved ready list
  ideate_get_review_manifest      — review manifest for a given cycle

Analysis tools
  ideate_get_convergence_status   — open findings by severity, convergence verdict
  ideate_get_domain_state         — policies + decisions + questions for one or more domains
  ideate_get_project_status       — high-level summary: cycle, work item counts, recent journal

Write tools
  ideate_append_journal           — append YAML journal entry + sync SQLite upsert
  ideate_archive_cycle            — create archive/cycles/NNN/ and write cycle summary
  ideate_write_work_items         — write/update work item YAML files + sync SQLite upsert
```

### Hybrid query pattern

Simple CRUD operations use Drizzle ORM for type safety and composability. Graph traversal and multi-table joins that require recursive CTEs fall back to parameterized raw SQL via `db.prepare()`:

```typescript
// Drizzle: simple lookups
drizzleDb.select().from(nodes).where(eq(nodes.type, 'work_item')).all()

// Raw SQL: recursive CTE traversal (query.ts)
WITH RECURSIVE traversal(node_id, edge_type, direction, depth) AS (
  SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
  UNION
  SELECT e.target_id, e.edge_type, 'outgoing', t.depth + 1
  FROM traversal t
  JOIN edges e ON e.source_id = t.node_id
  WHERE t.depth < ?
)
SELECT n.id, n.type, t.edge_type, t.direction, t.depth, n.status, n.file_path
FROM traversal t JOIN nodes n ON n.id = t.node_id
WHERE t.depth > 0
```

### Write tool pattern (GP-8)

Write tools follow YAML-first ordering: write the YAML file first, then synchronously upsert into SQLite. This ensures the YAML files remain the source of truth even if the process crashes between the two steps — the watcher will pick up the YAML file on next startup.

```
skill calls ideate_write_work_items
  → validate arguments
  → write YAML file to .ideate/work-items/{id}.yaml
  → upsertNode() + upsertExtension() + extractEdges()
  → return confirmation with file path
```

---

## 6. Graph Model

### Edge type registry

10 edge types are defined in `EDGE_TYPE_REGISTRY` in `schema.ts`. Each entry specifies allowed source types, allowed target types, and the YAML field that drives automatic extraction:

| Edge type | Source types | Target types | YAML field |
|-----------|-------------|-------------|------------|
| `depends_on` | `work_item` | `work_item` | `depends` |
| `blocks` | `work_item` | `work_item` | `blocks` |
| `belongs_to_module` | `work_item` | `module_spec` | `module` |
| `belongs_to_domain` | `work_item`, `domain_policy`, `domain_decision`, `domain_question` | domain name | `domain` |
| `derived_from` | `domain_policy` | `guiding_principle` | `derived_from` |
| `relates_to` | `finding` | `work_item` | `work_item` |
| `addressed_by` | `finding`, `domain_question` | `work_item` | `addressed_by` |
| `references` | (any) | (any) | null (set explicitly) |
| `amended_by` | `domain_policy` | `domain_policy` | `amended_by` |
| `supersedes` | `domain_decision` | `domain_decision` | `supersedes` |

During indexing, `extractEdges()` iterates the registry. For each edge type whose `yaml_field` is non-null and whose `source_types` includes the current node's type, it reads the corresponding YAML field and upserts edges for each value found (array or scalar).

### Traversal patterns

`ideate_artifact_query` supports three traversal modes when `related_to` is specified:

**Depth-1 (direct neighbors)**: single JOIN on `edges` table — no CTE required.

**Depth > 1 (recursive)**:

```sql
WITH RECURSIVE traversal(node_id, edge_type, direction, depth) AS (
  -- anchor: seed node at depth 0
  SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
  UNION
  -- recursive step (outgoing)
  SELECT e.target_id, e.edge_type, 'outgoing', t.depth + 1
  FROM traversal t JOIN edges e ON e.source_id = t.node_id
  WHERE t.depth < ?
  UNION
  -- recursive step (incoming)
  SELECT e.source_id, e.edge_type, 'incoming', t.depth + 1
  FROM traversal t JOIN edges e ON e.target_id = t.node_id
  WHERE t.depth < ?
)
SELECT n.id, n.type, t.edge_type, t.direction, t.depth, n.status, n.file_path
FROM traversal t JOIN nodes n ON n.id = t.node_id
WHERE t.depth > 0
```

`UNION` (not `UNION ALL`) deduplicates visited nodes, preventing infinite loops in cyclic graphs. Direction can be `outgoing`, `incoming`, or `both`.

**Query modes**: filter mode (type + field filters, no graph), traversal mode (`related_to` specified), or combined (both simultaneously — traversal results filtered by type).

### Summary fetching for traversal results

Because traversal queries return mixed artifact types, summaries are fetched in a second phase grouped by extension table. Items are grouped by their `type → table` mapping, then a single IN-clause query per table fetches summaries. This avoids per-row dynamic JOINs.

---

## 7. YAML Source of Truth

### GP-8 architecture

Guiding Principle 8 establishes that YAML files in `.ideate/` are the permanent record. The SQLite index is a derived cache. Skills must read and write artifacts through MCP tools — not by accessing files directly.

```
Write path:
  skill
    → MCP write tool (ideate_write_work_items / ideate_append_journal / ideate_archive_cycle)
    → write YAML file to .ideate/
    → synchronous SQLite upsert
    → return confirmation

Read path:
  skill
    → MCP read/query tool
    → SQLite query (fast, indexed)
    → structured response (markdown table or JSON)
```

### Why SQLite as cache

Direct YAML file reads require Glob + Read per file, O(N) in the number of artifacts. A SQLite index allows O(log N) lookups, multi-column filters, JOIN-based context assembly, and recursive graph traversal — all in a single round-trip to the MCP server.

The cache is invalidated at two points:
1. **On startup**: full `rebuildIndex()` scan
2. **On file change**: chokidar fires after 500ms debounce, triggers `rebuildIndex()`

### P-6 / P-26 / P-32: MCP as mandatory interface

MCP availability checks in skills apply only to external MCP servers (those not part of ideate). The ideate artifact server is a required component — skills must not fall back to direct file reads for artifact access.

---

## 8. File Watcher

The `ArtifactWatcher` class (`watcher.ts`) wraps chokidar and emits debounced `change` events when `.ideate/` content changes.

### Configuration

```typescript
chokidar.watch(artifactDir, {
  ignored: /index\.db(-wal|-shm)?$/,  // never watch the DB files themselves
  persistent: false,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 200,          // wait 200ms after last write
    pollInterval: 100,
  },
})
```

`index.db`, `index.db-wal`, and `index.db-shm` are excluded from watching to prevent feedback loops where SQLite's own WAL writes trigger re-indexing.

### Debounce

Each watched directory maintains one debounce timer (500ms default). Any file event (`add`, `change`, `unlink`) within 500ms of the previous event resets the timer. The `change` event fires once after the burst settles:

```
file write A  ──────┐
file write B  ───┐  │  debounce 500ms
file write C  ─┐ │  │  ──────────────►  emit "change"
               └─┴──┘
```

### Lifecycle

```
artifactWatcher.watch(ideateDir)   ← called once at server startup
  ↓
server.on("change") → rebuildIndex(db, drizzleDb, ideateDir)

SIGINT / SIGTERM
  → artifactWatcher.close()   ← clears all timers, closes all chokidar watchers
  → db.close()
  → process.exit(0)
```

Multiple directories can be watched concurrently. Each directory has its own `FSWatcher` and debounce timer stored in `Map<string, ...>` keyed by directory path.

---

## Source files

| File | Purpose |
|------|---------|
| `mcp/artifact-server/src/index.ts` | Server entry point, startup sequence, MCP request handlers |
| `mcp/artifact-server/src/schema.ts` | SQLite DDL (`createSchema`), edge type registry, artifact interfaces |
| `mcp/artifact-server/src/db.ts` | Drizzle ORM table definitions, `TYPE_TO_EXTENSION_TABLE` dispatch map |
| `mcp/artifact-server/src/indexer.ts` | `rebuildIndex`, row builders, edge extraction, cycle detection |
| `mcp/artifact-server/src/config.ts` | `.ideate/config.json` read/write, `resolveArtifactDir`, `createIdeateDir` |
| `mcp/artifact-server/src/watcher.ts` | `ArtifactWatcher` class (chokidar wrapper with debounce) |
| `mcp/artifact-server/src/tools/index.ts` | `ToolContext`, TOOLS array (11 definitions), `handleTool` dispatcher |
| `mcp/artifact-server/src/tools/context.ts` | `ideate_get_work_item_context`, `ideate_get_context_package` |
| `mcp/artifact-server/src/tools/query.ts` | `ideate_artifact_query` (filter mode + recursive CTE traversal) |
| `mcp/artifact-server/src/tools/execution.ts` | `ideate_get_execution_status`, `ideate_get_review_manifest` |
| `mcp/artifact-server/src/tools/analysis.ts` | `ideate_get_convergence_status`, `ideate_get_domain_state`, `ideate_get_project_status` |
| `mcp/artifact-server/src/tools/write.ts` | `ideate_append_journal`, `ideate_archive_cycle`, `ideate_write_work_items` |
