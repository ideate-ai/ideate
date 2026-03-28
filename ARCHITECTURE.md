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
9. [Context Assembly Algorithm](#9-context-assembly-algorithm)
10. [Source files](#10-source-files)

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
.ideate/         # Ideate's own artifact directory (uses the same structure it creates)
```

### SDLC lifecycle

```
/ideate:init ──► /ideate:execute ──► /ideate:review ──► /ideate:refine
                                            │                  │
                                            └──────────────────┘
                                            (repeating cycles)

/ideate:autopilot = autonomous execute → review → refine loop
```

### Data flow

```
┌──────────────────────────────────────────────────────────────────┐
│                          Skill (Claude)                          │
│  /ideate:init  /ideate:execute  /ideate:review  /ideate:refine  │
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
  → create Server + register handlers
  → server.connect(StdioServerTransport)   # MCP available immediately
  → setImmediate:
      → rebuildIndex()    # Full YAML scan (deferred)
      → signalIndexReady()
      → artifactWatcher.watch()  # starts after rebuild completes
```

**Readiness gate**: tool calls arriving before the index rebuild completes block on the `indexReady` Promise (exported from tools/index.ts). Once `signalIndexReady()` is called after `rebuildIndex()` finishes, the gate opens and all pending tool calls proceed. If `rebuildIndex()` fails, the gate rejects and tool calls return errors.

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

The indexer converts the YAML artifact files under `.ideate/` into the SQLite index. It runs once at startup (`rebuildIndex()`) and incrementally via `indexFiles()`/`removeFiles()` when the file watcher detects changes.

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
  ├─ create Server + register request handlers
  │
  ├─ server.connect(StdioServerTransport)
  │   MCP transport is live — tool calls can arrive
  │
  └─ setImmediate:
      ├─ rebuildIndex()            full YAML scan (deferred)
      ├─ signalIndexReady()        opens the readiness gate
      └─ artifactWatcher.watch()   starts AFTER rebuild completes
```

**Readiness gate**: `server.connect()` is called before the index exists, so tool calls can arrive immediately. All tool handlers `await indexReady` — a Promise that blocks until `signalIndexReady()` fires after `rebuildIndex()` completes. If the rebuild fails, `signalIndexFailed(err)` rejects the Promise and all pending tool calls return errors.

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

### 17 tools in 8 categories

```
Context tools (3)
  ideate_get_work_item_context    — work item + notes + module spec + domain policies + research
  ideate_get_context_package      — architecture + principles + constraints + source code index
  ideate_assemble_context         — PPR-scored, token-budgeted context assembly from seed nodes

Query tools (1)
  ideate_artifact_query           — filter by type/domain/status/cycle + graph traversal

Execution tools (2)
  ideate_get_execution_status     — work item counts by status, dependency-resolved ready list
  ideate_get_review_manifest      — review manifest for a given cycle

Analysis tools (3)
  ideate_get_convergence_status   — open findings by severity, convergence verdict
  ideate_get_domain_state         — policies + decisions + questions for one or more domains
  ideate_get_project_status       — high-level summary: cycle, work item counts, recent journal

Write tools (5)
  ideate_append_journal           — append YAML journal entry + sync SQLite upsert
  ideate_archive_cycle            — create archive/cycles/NNN/ and write cycle summary
  ideate_write_work_items         — write/create work item YAML files + sync SQLite upsert
  ideate_update_work_items        — partial-update existing work items by id
  ideate_write_artifact           — write any artifact type to .ideate/ as YAML

Events tools (1)
  ideate_emit_event               — fire hooks registered for a given event name

Metrics tools (1)
  ideate_get_metrics              — aggregated metrics from metrics_events table

Config tools (1)
  ideate_get_config               — parsed .ideate/config.json with defaults applied
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
2. **On file change**: chokidar fires after 500ms debounce, triggers `indexFiles()` for changed files and `removeFiles()` for deleted files (incremental, not full rebuild)

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
artifactWatcher.watch(ideateDir)   ← called once after rebuildIndex completes
  ↓
watcher.on("change") → event: { changed: string[], deleted: string[] }
  → indexFiles(db, drizzleDb, changed)     ← upsert changed YAML files
  → removeFiles(db, drizzleDb, deleted)    ← delete nodes for removed files

SIGINT / SIGTERM
  → artifactWatcher.close()   ← clears all timers, closes all chokidar watchers
  → db.close()
  → process.exit(0)
```

The watcher emits batched change events with separate `changed` and `deleted` file lists. Only YAML files are processed; non-YAML changes are filtered out. This is incremental indexing -- individual files are upserted or removed rather than triggering a full `rebuildIndex()`.

Multiple directories can be watched concurrently. Each directory has its own `FSWatcher` and debounce timer stored in `Map<string, ...>` keyed by directory path.

---

## 9. Context Assembly Algorithm

### 9.1 Overview

The MCP artifact server assembles context via deterministic graph traversal from seed nodes. It does not use embedding-based search or similarity ranking. Context is assembled at query time by walking typed edges in the SQLite index, loading exactly the artifacts reachable by the prescribed traversal pattern, and truncating sections that exceed per-section line budgets.

Three tools handle context assembly:

- **`ideate_get_work_item_context`** — per-item context for execution workers: the work item itself, implementation notes, module spec, domain policies, and relevant research.
- **`ideate_get_context_package`** — base context shared across all workers: architecture document, guiding principles, constraints, and source code index.
- **`ideate_assemble_context`** — token-budgeted context assembly using Personalized PageRank (PPR) scoring from seed nodes.

Skills call these tools before spawning workers. The context package provides project-wide scaffolding. The work item context provides item-specific detail. The execute skill then further filters the context package into a per-batch digest (see Section 9.4).

The current approach reflects the graph-traversal-first direction from the PPR research (see `context-assembly-strategies.yaml`): explicit, typed edge traversal produces precise, predictable context at low latency. PPR and spreading activation are identified as future enhancements once the query-log infrastructure accumulates sufficient usage signal to calibrate edge weights adaptively.

### 9.2 ideate_get_work_item_context

Source: `mcp/artifact-server/src/tools/context.ts`, `handleGetWorkItemContext`.

The function accepts `work_item_id` via the MCP tool's `ToolContext` (which includes `ctx.ideateDir`). IDs are normalized to handle both `WI-185` and `185` forms.

**Assembly order** (sections joined with `---` dividers):

1. **Work item** — loaded from the `nodes` + `work_items` JOIN. Includes: id, title, status, complexity, domain, module, file path, cycle created, depends/blocks lists, scope entries (file paths and operations), and acceptance criteria.

2. **Implementation notes** — if the work item row has a `notes` field, the notes file is read from disk. Capped at 200 lines; shows truncation notice if exceeded.

3. **Module spec** — resolved by following the `belongs_to_module` edge from the work item. The query is:
   ```sql
   SELECT ms.* FROM edges e
   JOIN nodes n ON n.id = e.target_id
   JOIN module_specs ms ON ms.id = n.id
   WHERE e.source_id = ? AND e.edge_type = 'belongs_to_module'
   LIMIT 1
   ```
   If found, the section includes module name, scope, provides list, requires list, and boundary rules.

4. **Domain policies** — loaded by matching `domain_policies.domain = work_item.domain`. This is a direct column filter, not edge traversal. All policies for the domain are included, ordered by id. Each policy description is capped at 30 lines.

5. **Relevant research** — all `research_findings` rows are loaded and filtered by topic: entries whose `topic` contains the work item's domain name or module name (case-insensitive substring match) are included. If neither domain nor module is set, the first 3 research entries are included as a fallback. Research section has a global 150-line budget; entries that would exceed it are omitted with a count notice.

**Final truncation**: the assembled result is capped at 500 lines. If exceeded, the last section (research) is cut first by the line limit.

**Edge types followed**: `belongs_to_module` (outgoing, depth 1). Domain policies are found by column value match, not edge traversal. Research is found by topic substring match, not edge traversal.

**What is not included**: architecture document, guiding principles, constraints, source code index, other work items, cycle summaries, findings from prior reviews. These are either in the context package or excluded entirely for execution tasks.

### 9.3 ideate_get_context_package

Source: `mcp/artifact-server/src/tools/context.ts`, `handleGetContextPackage`.

The function uses `ctx.ideateDir` from the MCP tool's `ToolContext` and returns project-wide context. It does not accept a work item id — the same package is returned for all queries against a given artifact directory.

**Assembly order** (sections joined with `---` dividers):

1. **Architecture document** — found by `WHERE n.type = 'architecture' LIMIT 1`. If the document is 300 lines or fewer, it is included in full. If longer, a summary is extracted: all headings (`#`, `##`, `###`) and up to 3 non-empty lines following each heading are included, capped at 150 summary lines. The full document path is also emitted in the Full Document Paths section.

2. **Guiding principles** — all rows from `guiding_principles` joined with `nodes`, ordered by id. Each description is capped at 20 lines. All principles are included regardless of count.

3. **Constraints** — all rows from `constraints` joined with `nodes`, ordered by `category, id`. Each description is capped at 10 lines. Constraints are grouped under their category as subheadings.

4. **Source code index** — derived at query time by walking the filesystem (not the SQLite index). The project root is computed as `dirname(ideateDir)` (since `ideateDir` is `<project>/.ideate/`, one level up gives the project root). The directories `src`, `lib`, `agents`, `skills`, `scripts`, `mcp` are walked recursively (max depth 8) for `.ts`, `.js`, `.py` files. For each file, exports are extracted via regex patterns (TypeScript: `export function/const/class/interface/type/enum`, Python: `def`/`class` at module scope). Results are rendered as a Markdown table capped at 80 files.

5. **Full document paths** — all paths collected during assembly (architecture, principles, constraints) plus all `document_artifacts` rows from the DB, deduplicated. Formatted as a bullet list of label → path pairs.

**Final truncation**: capped at 800 lines.

**Edge types followed**: none. The context package is assembled entirely from type-based DB queries and filesystem walks.

**What is not included**: work item specs, domain policies, research findings, module specs, findings from prior reviews. These are assembled per-item by `ideate_get_work_item_context`.

### 9.4 Context digest (skill-side filtering)

Source: `skills/execute/SKILL.md`, Phase 4.5.

Before spawning workers, the execute skill creates a **context digest** — a filtered subset of the context package relevant to the current execution batch. The digest is ephemeral (never written to disk) and passed directly in the worker prompt.

**Composition rules**:

- The full `## Interface Contracts` section from `architecture.md` — always included in full, uncapped. Interface contracts span modules and must not be truncated regardless of length.
- Sections from `architecture.md` that mention any file path in the work item's `file_scope`.
- The component map entry for the relevant architecture component.
- All other content from the context package is capped at **150 lines total** for the digest. If over this limit, the component map entry is included first, then file-scope sections. If the interface contracts section alone exceeds 150 lines, only the interface contracts section is included.

Workers receive the digest plus paths to the full documents (`"Full architecture at {path} — read if you need detail beyond what the digest provides"`). This allows workers to access the full context on demand without it being pre-loaded into every worker prompt.

### 9.5 Minimum viable context by task type

Based on the context assembly research (`context-assembly-strategies.yaml`, Question 6).

| Task | Primary context | Secondary | Exclude |
|------|----------------|-----------|---------|
| Execute work item | Work item spec + dependencies' interface contracts + module spec + domain policies | Source code index | Research notes, full architecture, prior findings |
| Review completed work | Acceptance criteria + diff/changes + architecture constraints + domain policies | Recent findings (1-2 cycles) | All history, other work items, research notes |
| Plan changes (refine) | Latest cycle summary + all domain policies + open questions | Research relevant to change direction | Incremental reviews, prior work items, old interview transcripts |

**Note on research inclusion**: the current `handleGetWorkItemContext` includes research matching the work item's domain or module. The research paper identifies this as potentially over-inclusive for execution tasks — research should already be distilled into domain policies by the time execution begins. Research is most valuable during planning, not execution.

**Ordering within context**: the work item spec is placed first and domain policies last within `ideate_get_work_item_context` output. Both positions benefit from the primacy/recency effect documented in "Lost in the Middle" (TACL 2024), which shows LLM performance degrades when relevant information is placed in the middle of a long context.

### 9.6 Future direction

**Current approach**: deterministic graph traversal with hand-tuned inclusion rules. Edge following is typed but not weighted — `belongs_to_module` is always followed exactly once; domain policies are always loaded by column match. There is no adaptive component.

**Research direction**: the `context-assembly-strategies.yaml` research identifies Personalized PageRank (PPR) from seed nodes as the theoretically optimal traversal method for this use case. PPR from a work-item seed node naturally surfaces the module (direct edge, high weight), domain policies (two hops), and prior findings (three hops) in a single computation pass. Spreading activation achieves similar goals with a simulation-based approach that weights nodes reached by multiple short paths more highly than nodes reached by one long path.

**Edge-type weighting by task type** is a concrete near-term improvement. The research proposes hand-tuned weights (not empirically validated for this domain) that reflect the observation that `governed_by` (domain policies) has high value for all tasks, `depends_on` has high value for execution but lower for planning, and `informed_by` (research) has high value for planning but lower for execution.

**Adaptive weighting via query log analysis**: the `query-log.jsonl` infrastructure logs which artifacts were returned per query, but not which were used by the LLM in its output. Adding a `used_chunk_ids` field to log entries — populated after each task completion via citation parsing or text-overlap analysis — would provide the signal needed to calibrate edge weights from historical data rather than hand-tuning.

---

## 10. Source files

| File | Purpose |
|------|---------|
| `mcp/artifact-server/src/index.ts` | Server entry point, startup sequence, MCP request handlers |
| `mcp/artifact-server/src/schema.ts` | SQLite DDL (`createSchema`), edge type registry, artifact interfaces |
| `mcp/artifact-server/src/db.ts` | Drizzle ORM table definitions, `TYPE_TO_EXTENSION_TABLE` dispatch map |
| `mcp/artifact-server/src/indexer.ts` | `rebuildIndex`, row builders, edge extraction, cycle detection |
| `mcp/artifact-server/src/config.ts` | `getConfigWithDefaults`, `IdeateConfigJson`, `DEFAULT_AGENT_BUDGETS`, `DEFAULT_PPR_CONFIG` |
| `mcp/artifact-server/src/watcher.ts` | `ArtifactWatcher` class (chokidar wrapper with debounce) |
| `mcp/artifact-server/src/hooks.ts` | Hook registry loading, execution, variable substitution |
| `mcp/artifact-server/src/tools/index.ts` | `ToolContext`, TOOLS array (17 definitions), `handleTool` dispatcher |
| `mcp/artifact-server/src/tools/context.ts` | `handleGetWorkItemContext`, `handleGetContextPackage`, `handleAssembleContext` |
| `mcp/artifact-server/src/tools/query.ts` | `ideate_artifact_query` (filter mode + recursive CTE traversal) |
| `mcp/artifact-server/src/tools/execution.ts` | `ideate_get_execution_status`, `ideate_get_review_manifest` |
| `mcp/artifact-server/src/tools/analysis.ts` | `ideate_get_convergence_status`, `ideate_get_domain_state`, `ideate_get_project_status` |
| `mcp/artifact-server/src/tools/write.ts` | `ideate_append_journal`, `ideate_archive_cycle`, `ideate_write_work_items`, `ideate_update_work_items`, `ideate_write_artifact` |
| `mcp/artifact-server/src/tools/events.ts` | `ideate_emit_event` (hook dispatch) |
| `mcp/artifact-server/src/tools/metrics.ts` | `ideate_get_metrics` (agent/work_item/cycle aggregations) |
