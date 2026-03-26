## Verdict: Fail

The schema DDL itself is correctly structured, but the test suite that ships with this work item contains stale SQL that references columns dropped by this very work item (`source_type`, `target_type`, `node_type`), and expects per-extension-table `file_path` indexes that were not created. 50 tests fail on the current codebase.

---

## Critical Findings

### C1: Test suite fails — 50 tests fail after schema v7 DDL

- **File**: `src/__tests__/schema.test.ts:82-151`, `src/__tests__/indexer.test.ts` (all tests), `src/__tests__/watcher.test.ts:191`
- **Issue**: The test file for schema still inserts into `edges` using `source_type` and `target_type` columns (lines 84–87, 94–98, 113–114) and into `node_file_refs` using `node_type` (lines 135–137, 143–149). Both columns were explicitly dropped by this work item. Every `rebuildIndex` test fails with `SqliteError: no such column: content_hash` because `rebuildIndex` queries extension tables for `content_hash`, but post-v7 the extension tables no longer carry common columns — only the `nodes` base table does. The `indexer.ts` hash-check query on line 562 (`SELECT id, content_hash FROM ${table}`) must query `nodes`, not the extension table.
- **Impact**: The test suite is completely broken for `schema.test.ts`, `indexer.test.ts`, and `watcher.test.ts`. CI will fail on every push. The runtime `rebuildIndex` function is also broken in production: querying `content_hash` from an extension table (which no longer has that column) will throw a `SqliteError` and prevent the index from being rebuilt.
- **Suggested fix**:
  1. In `src/__tests__/schema.test.ts`: remove `source_type` and `target_type` from all `INSERT INTO edges` statements; remove `node_type` from all `INSERT INTO node_file_refs` statements. Insert a parent row into `nodes` first since the FK constraint now requires it, or disable FK enforcement for the test inserts (`PRAGMA foreign_keys = OFF`).
  2. In `src/indexer.ts` line 562: change the hash-check to query the `nodes` table: `SELECT id, content_hash FROM nodes WHERE file_path = ?`. Remove the per-table loop for this query — a single statement against `nodes` is correct under CTI.
  3. In `src/__tests__/indexer.test.ts` and `src/__tests__/watcher.test.ts`: update all `INSERT INTO edges` fixtures to omit `source_type`/`target_type`; update all `INSERT INTO node_file_refs` fixtures to omit `node_type`.

---

## Significant Findings

### S1: `db.ts` Drizzle schema not updated — still carries `source_type`, `target_type`, `node_type`

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/db.ts:201-217`
- **Issue**: The Drizzle ORM schema for `edges` still declares `source_type: text("source_type").notNull()` and `target_type: text("target_type").notNull()`, and `nodeFileRefs` still declares `node_type: text("node_type").notNull()`. These columns do not exist in the SQLite schema produced by `createSchema` in `schema.ts`. Any Drizzle-driven insert to `edges` or `nodeFileRefs` will fail at runtime with a column-not-found error. `indexer.ts` uses `upsertEdge` and `upsertFileRef` which call through Drizzle with these stale field definitions.
- **Impact**: Every write path through Drizzle for edges and file refs will throw at runtime; the index is unwritable in production.
- **Suggested fix**: Remove `source_type` and `target_type` from the `edges` table definition in `db.ts` (lines 202, 204). Remove `node_type` from `nodeFileRefs` (line 213). Update `upsertEdge` in `indexer.ts` (lines 289-305) to drop `source_type`/`target_type` from the `.values()` call. Update `upsertFileRef` (lines 307-318) to drop `node_type`.

### S2: `indexer.ts` `upsertEdge` and `upsertFileRef` pass dropped columns

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/indexer.ts:297-317`
- **Issue**: `upsertEdge` passes `source_type` and `target_type` to `drizzleDb.insert(dbSchema.edges).values(...)`, and `upsertFileRef` passes `node_type` to `drizzleDb.insert(dbSchema.nodeFileRefs).values(...)`. These columns were dropped in the schema DDL. This is distinct from S1 (which is the Drizzle schema definition); this is the call-site passing values for non-existent columns.
- **Impact**: All edge and file-ref insertions will fail at runtime, breaking index rebuilds.
- **Suggested fix**: In `upsertEdge`, remove `source_type: sourceType` and `target_type: targetType` from the `.values()` object and the function signature parameters (lines 291-293). In `upsertFileRef`, remove `node_type: nodeType` from `.values()` and the function signature (lines 308-310). Update all call sites in `extractEdges` (lines 351, 357) and `extractFileRefs` (line 385).

### S3: `schema.test.ts` schema version test uses hardcoded stale version number

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/__tests__/schema.test.ts:317`
- **Issue**: The test asserts `checkSchemaVersion` returns `true` when `user_version = 6`, but `CURRENT_SCHEMA_VERSION` is now 7. The test fails because `checkSchemaVersion` rejects version 6 as stale (correctly), then closes and deletes the DB file, and the return value is `false`. The test comment even says `// matches CURRENT_SCHEMA_VERSION` which is now wrong.
- **Impact**: Test fails, CI is broken for this specific assertion.
- **Suggested fix**: Change line 317 to `db.pragma("user_version = 7"); // matches CURRENT_SCHEMA_VERSION`.

### S4: `schema.test.ts` expects per-extension-table `file_path` indexes that do not exist

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/__tests__/schema.test.ts:192-199`
- **Issue**: The test asserts that each of the 12 extension tables has an index named `idx_{table}_file_path`. Under CTI, `file_path` is a column on `nodes`, not on extension tables. The schema does not create these indexes, and the test fails for all 12 extension tables.
- **Impact**: 12 test failures, CI broken.
- **Suggested fix**: Replace the per-extension-table `file_path` index test with a test that asserts `idx_nodes_file_path` exists on the `nodes` table (which `createSchema` does create on line 315 of `schema.ts`).

---

## Minor Findings

### M1: `schema.test.ts` stale comment in `checkSchemaVersion` stale-version test

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/__tests__/schema.test.ts:302`
- **Issue**: The comment reads `db.pragma("user_version = 5"); // stale — current is 6`. Current version is 7.
- **Suggested fix**: Change comment to `// stale — current is 7`.

### M2: `schema.test.ts` test description still says "removed in schema v6"

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/__tests__/schema.test.ts:67`
- **Issue**: The test description says `"does not create the interview_responses table (removed in schema v6)"` — this is accurate history, but "v6" is now two versions ago. Not a breaking issue but worth noting as history.
- **Suggested fix**: No change required unless the project convention is to track the removal version precisely. Leave as-is or update to `(removed prior to schema v7)`.

---

## Unmet Acceptance Criteria

- [ ] **Criterion 9: TypeScript interfaces updated (Edge, NodeFileRef)** — The `Edge` interface in `schema.ts` at line 277-283 is correct (no `source_type`/`target_type`). The `NodeFileRef` interface at line 289-292 is correct (no `node_type`). However, the Drizzle schema in `db.ts` (which is the live runtime type layer for inserts/selects) still declares both columns and is used by all write paths. The TypeScript interfaces in `schema.ts` are updated, but the runtime schema that actually drives SQL generation is not. The acceptance criterion is only half-met.

- [ ] **Criterion 6: edges table uses FK to nodes, no source_type/target_type** — The DDL in `schema.ts` is correct. However `db.ts` (line 202, 204) still declares `source_type` and `target_type` as non-null columns in the Drizzle schema, meaning the Drizzle layer will attempt to write these columns. This criterion is not fully satisfied end-to-end.

- [ ] **Criterion 7: node_file_refs uses FK to nodes, no node_type** — Same situation: DDL is correct, but `db.ts` line 213 still declares `node_type` as a non-null column. Criterion not satisfied end-to-end.
