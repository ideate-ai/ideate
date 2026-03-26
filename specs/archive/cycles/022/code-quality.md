# Code Quality Review — Cycle 022

## Verdict: Pass

All 207 tests pass. TypeScript builds clean. The v7 schema refactor and 11 MCP tools are functional. Two significant findings identified in the graph query tool's recursive CTE implementation.

## Critical Findings

None.

## Significant Findings

### S1: Recursive CTE in query.ts has no cycle protection for non-depends_on edge types
- **File**: `mcp/artifact-server/src/tools/query.ts:427-434`
- **Issue**: The recursive CTE for graph traversal (depth > 1) uses `UNION ALL` without deduplication or visited-node tracking. For `depends_on` edges, cycles are prevented by Kahn's algorithm at index time. For other edge types (`relates_to`, `references`, `amended_by`, etc.), no cycle prevention exists. A bidirectional traversal (`direction: "both"`) on cyclic edges will loop until the depth limit (max 10), producing duplicate rows with exponential growth.
- **Impact**: A `depth: 5` traversal with `direction: "both"` on a graph containing a `references` cycle between 3 nodes produces 3^5 = 243 rows instead of 3. The LIMIT cap (200) prevents unbounded output but the query itself is O(branching^depth).
- **Suggested fix**: Change `UNION ALL` to `UNION` in the recursive CTE to deduplicate visited nodes. Alternatively, track visited node IDs in the CTE (SQLite supports path-string accumulation: `WHERE visited NOT LIKE '%' || node_id || '%'`). The `UNION` approach is simpler and sufficient at this scale.

### S2: Ambiguous column name `id` in graph traversal ORDER BY
- **File**: `mcp/artifact-server/src/tools/query.ts:485`
- **Issue**: `ORDER BY depth, id` — when the base traversal SQL is wrapped in `SELECT * FROM (...)` for type/status filtering, the column `id` in the ORDER BY can be ambiguous if the subquery produces multiple columns named `id` (e.g., from the nodes table JOIN). SQLite resolves this as the first `id` column, which may not be `n.id`.
- **Impact**: Affects depth > 1 traversals when combined with type or status filters. May produce incorrectly ordered results or an "ambiguous column name" error depending on the specific query shape.
- **Suggested fix**: Use a column alias in the base CTE query (`SELECT n.id AS node_id, ...`) and reference `node_id` in the ORDER BY.

## Minor Findings

### M1: write.ts handleWriteWorkItems uses string concatenation for YAML output
- **File**: `mcp/artifact-server/src/tools/write.ts`
- **Issue**: The work items YAML writer appends entries by reading the existing file, string-concatenating new YAML entries, and writing back. This does not use a YAML library for serialization, risking malformed YAML if item values contain special characters (colons, quotes, newlines in criteria text).
- **Suggested fix**: Use the `yaml` library (already a dependency via indexer.ts) to serialize new entries, or ensure all string values are properly quoted.

### M2: tools/context.ts source code index walker follows symlinks
- **File**: `mcp/artifact-server/src/tools/context.ts`
- **Issue**: The `walkDir` function used to build the source code index does not check for symbolic links. In a monorepo with symlinked node_modules or workspace packages, it could traverse into unintended directories.
- **Suggested fix**: Add `entry.isSymbolicLink()` check in the directory walk.

## Unmet Acceptance Criteria

None.

## Dynamic Testing

```
Test Files  6 passed (6)
     Tests  207 passed (207)
  Duration  5.40s
```

TypeScript build: clean (no errors).
