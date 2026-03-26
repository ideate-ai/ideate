# Code Quality Review — Cycle 018

**Scope**: `mcp/artifact-server/src/` (all source files) and `scripts/migrate-to-v3.ts`
**Test suite**: 5 files, 137 tests — all passed (`npx vitest run`)

## Verdict: Pass (with caveats)

No correctness bugs found in the happy path. The codebase works correctly for its current use case. However, several performance issues in `rebuildIndex` will compound as artifact counts grow, and the Drizzle ORM integration has structural gaps between the raw-SQL schema and Drizzle metadata that will cause maintenance friction.

---

## Critical Findings

None.

---

## Significant Findings

### S1: No watcher debounce — burst file changes trigger redundant full rebuilds

- **File**: `src/index.ts:64-70`, `src/watcher.ts:29-38`
- **Issue**: Each chokidar `change` event triggers a full `rebuildIndex()`. When multiple files are written in rapid succession (e.g. during a migration or skill execution writing 10+ artifacts), each write fires a separate event after the 200ms `awaitWriteFinish` threshold. Since better-sqlite3 is synchronous and Node.js is single-threaded, these execute serially — but every rebuild re-scans all YAML files, re-hashes, and re-checks 13 tables per file. For N files written in a burst, this is N full rebuilds instead of 1.
- **Impact**: Quadratic wall-clock time during batch writes. With 100+ artifacts, each rebuild already touches hundreds of files.
- **Suggested fix**: Debounce the watcher callback (e.g. 500ms trailing debounce). The rebuild is already idempotent, so coalescing events is safe.

### S2: Hash-check loop performs up to 13 unindexed table scans per file

- **File**: `src/indexer.ts:577-588`
- **Issue**: For each YAML file, the rebuild loop iterates `ALL_TYPED_TABLES` (13 tables) and runs `SELECT id, content_hash FROM {table} WHERE file_path = ?`. There is no index on `file_path` for any typed table — each query is a full table scan. With 100 artifacts spread across tables, this is ~1300 unindexed queries per rebuild.
- **Additionally**: `db.prepare()` is called inside the inner loop, creating a new prepared statement on every iteration. better-sqlite3 caches these internally by SQL string, but the overhead of map lookups on 13 different SQL strings × N files is unnecessary.
- **Suggested fix**: (a) Add `CREATE INDEX IF NOT EXISTS idx_{table}_file_path ON {table}(file_path)` for each typed table. (b) Pre-create the 13 prepared statements outside the file loop and reuse them.

### S3: Drizzle table definitions diverge from raw-SQL schema

- **File**: `src/db.ts:223-227` (nodeFileRefs), `src/db.ts:213-221` (edges)
- **Issue**: The raw-SQL schema in `schema.ts` defines:
  - `node_file_refs` with `PRIMARY KEY (node_id, file_path)` — the Drizzle definition has no primary key at all
  - `edges` with `UNIQUE(source_id, target_id, edge_type)` — the Drizzle definition has no unique constraint

  Because `createSchema` uses raw `db.exec()` to create tables, the constraints exist at the SQLite level and runtime behavior is correct. But Drizzle's `onConflictDoNothing()` and `onConflictDoUpdate()` calls rely on Drizzle's metadata to infer conflict targets. Today this works by accident (SQLite sees the constraint regardless), but Drizzle version upgrades or query builder changes could break the implicit resolution.
- **Suggested fix**: Add the composite primary key and unique constraint to the Drizzle table definitions using `primaryKey()` and `.unique()` respectively. Alternatively, pass explicit `target` to all `onConflict*` calls.

### S4: `detectCycles` BFS uses `Array.shift()` — O(n^2) for large graphs

- **File**: `src/indexer.ts:493-503` (Kahn's algorithm), `src/indexer.ts:520-530` (component BFS)
- **Issue**: Both the Kahn's topological sort and the cycle-component BFS use `queue.shift()` which is O(n) per call due to array element shifting. For a graph near the 10,000-node limit, the overall complexity becomes O(n^2) instead of the expected O(n + e).
- **Suggested fix**: Use an index pointer (`let head = 0; const node = queue[head++]`) instead of `shift()`. No external library needed.

---

## Minor Findings

### M1: `deleteStaleRows` accepts an unused `db` parameter

- **File**: `src/indexer.ts:417`
- **Issue**: The `db: Database.Database` parameter is never used — all operations go through `drizzleDb`. Passed at line 640 as a dead argument.
- **Suggested fix**: Remove the parameter from both signature and call site.

### M2: `TYPE_TO_TABLE` in indexer.ts duplicates `TYPE_TO_DRIZZLE_TABLE` in db.ts

- **File**: `src/indexer.ts:29-52`, `src/db.ts:246-269`
- **Issue**: Both maps cover the same 21 type strings. No compile-time or runtime check ensures they stay in sync. Adding a new type to one map but not the other would cause silent misbehavior: hash lookups would miss (triggering unnecessary re-parses) or upserts would fail.
- **Suggested fix**: Derive `TYPE_TO_TABLE` from `TYPE_TO_DRIZZLE_TABLE` using each table's `._.name` property, or add a startup assertion that both key sets are equal.

### M3: Empty-ID sentinel `['']` in `deleteStaleRows`

- **File**: `src/indexer.ts:418`
- **Issue**: When `keepIds` is empty, `['']` is used as sentinel to avoid passing an empty array to `notInArray()` (which would generate invalid SQL). This correctly deletes all rows — but relies on the assumption that no artifact ID is ever the empty string.
- **Suggested fix**: Guard with an explicit length check and skip the query when `keepIds` is empty, using a `DELETE FROM` without a WHERE clause instead.

### M4: `tools.ts` is a stub — MCP server advertises zero tools

- **File**: `src/tools.ts:1-7`
- **Issue**: `TOOLS` is an empty array and `handleTool` throws unconditionally. The MCP server starts and listens but offers no capabilities. This is presumably intentional (tools are provided by a different mechanism or pending implementation), but a client connecting to this server sees an empty tool list.
- **Note**: The `ideate-artifact-server` MCP entry in the system reminder shows 7 tools (`ideate_artifact_index`, `ideate_artifact_query`, etc.), suggesting these tools exist elsewhere and are registered through a different path, or this is a TODO.

### M5: `PRAGMA foreign_keys = ON` is set but no foreign keys exist

- **File**: `src/schema.ts:309`
- **Issue**: `createSchema` enables the foreign_keys pragma, but no table in the schema uses `REFERENCES` or `FOREIGN KEY`. The pragma has no effect.
- **Suggested fix**: Remove the pragma, or add actual FK constraints if referential integrity is desired (e.g. `edges.source_id REFERENCES` a typed table).

### M6: WAL/SHM files not cleaned up on schema version mismatch

- **File**: `src/schema.ts:619-623`
- **Issue**: When `checkSchemaVersion` detects a stale DB, it calls `db.close()` then `fs.unlinkSync(dbPath)`. This removes `index.db` but leaves `index.db-wal` and `index.db-shm` files on disk. While these are harmless (SQLite ignores orphaned WAL files when creating a new DB), they're unnecessary clutter.
- **Suggested fix**: Also unlink `${dbPath}-wal` and `${dbPath}-shm` (with the same try/catch).

### M7: `walkDir` silently swallows directory read errors

- **File**: `src/indexer.ts:73-77`
- **Issue**: If `fs.readdirSync` throws (e.g. permission denied on a subdirectory), the error is caught and the directory is silently skipped. No warning is logged. An artifact directory with incorrect permissions would produce an incomplete index with no diagnostic output.
- **Suggested fix**: Log a warning when a directory can't be read.

### M8: `tokenCount` heuristic is undocumented

- **File**: `src/indexer.ts:62-64`
- **Issue**: `Math.floor(content.length / 4)` is a rough approximation (1 token ≈ 4 characters). This is adequate for relative sizing but could be off by 2-3x for YAML with many short keys. The function name and column name (`token_count`) suggest precision that isn't delivered.
- **Note**: Not a bug — just worth documenting the approximation so consumers don't treat the value as authoritative.

### M9: Migration script sets `file_path: null` for findings despite `NOT NULL` schema constraint

- **File**: `scripts/migrate-to-v3.ts:1051`, `scripts/migrate-to-v3.ts:1195`
- **Issue**: Both capstone and incremental finding builders emit `file_path: null` in YAML output. The `findings` table declares `file_path TEXT NOT NULL`. The indexer works around this because `buildCommonFields` falls back to the disk path. However, the YAML artifact itself is inconsistent with the schema contract.
- **Suggested fix**: Set `file_path` to the relative output path in the migration builder.

---

## Unmet Acceptance Criteria

None. All work items (160-169) pass their acceptance criteria.

---

## Dynamic Testing

```
$ npx vitest run
 ✓ src/__tests__/schema.test.ts (15 tests) 18ms
 ✓ src/__tests__/config.test.ts (24 tests) 28ms
 ✓ src/__tests__/migrate.test.ts (62 tests) 88ms
 ✓ src/__tests__/indexer.test.ts (32 tests) 418ms
 ✓ src/__tests__/watcher.test.ts (4 tests) 1900ms

 Test Files  5 passed (5)
      Tests  137 passed (137)
```

No failures. No flaky tests observed in this run (though watcher tests use hardcoded `setTimeout` delays that could be fragile in slow CI environments).
