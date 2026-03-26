# Decision Log — Cycle 022

## Decisions Made This Cycle

### D108: Consolidate MCP artifact server Phases 2-5 into single cycle
**Date**: 2026-03-25
**Decision**: All remaining MCP artifact server work (schema refactor, 11 tools, tests, skill updates) in one cycle rather than four.
**Rationale**: Phases tightly coupled — schema refactor prerequisite for all tool implementation. Single capstone more efficient.

### D109: Schema refactored from concrete to class table inheritance (v6 → v7)
**Date**: 2026-03-25
**Decision**: Base `nodes` table + 12 extension tables with FK ON DELETE CASCADE. Drop source_type/target_type from edges, node_type from node_file_refs.
**Rationale**: Research confirmed class table inheritance as idiomatic for property graphs in SQL. Fresh rewrite — DB is derived cache.

### D110: Drizzle ORM retained with hybrid raw SQL for graph queries
**Date**: 2026-03-25
**Decision**: Drizzle for CRUD, raw db.prepare() for recursive CTEs and multi-table JOINs.
**Rationale**: Injection safety from Drizzle; graph traversal not expressible in Drizzle's query builder.

### D111: 11 tools for 3.0 MVP; 7 excluded with documented rationale
**Date**: 2026-03-25
**Decision**: Context assembly (2), graph query (1), execution status (2), analysis (3), write (3). Seven tools excluded (subsumed, YAGNI, breaking changes).
**Rationale**: Documented per-tool in overview.md.

### D112: Tools split into src/tools/ directory for parallel implementation
**Date**: 2026-03-25
**Decision**: tools/index.ts dispatcher + 5 group files (context.ts, query.ts, execution.ts, analysis.ts, write.ts).
**Rationale**: Non-overlapping file scope enables parallel execution (GP-4, C-6).

### D113: Write tools follow GP-8 — YAML first, then sync SQLite
**Date**: 2026-03-25
**Decision**: All write tools write YAML, then synchronously upsert SQLite rows.
**Rationale**: GP-8 mandates YAML as source of truth. Sync update eliminates stale-read window.

### D114: ToolContext interface for dependency injection
**Date**: 2026-03-25
**Decision**: `{ db, drizzleDb, ideateDir }` created once at startup, passed to every handleTool call.
**Rationale**: Avoids global state; enables clean testing.

### D115: PRAGMA foreign_keys = ON at startup
**Date**: 2026-03-25
**Decision**: Added to index.ts immediately after connection open.
**Rationale**: Without it, all FK constraints are decorative.

### D116: defer_foreign_keys replaced with foreign_keys = OFF in indexer
**Date**: 2026-03-25
**Decision**: Indexer uses FK OFF during bulk rebuild rather than defer_foreign_keys.
**Rationale**: defer_foreign_keys is a no-op when FK is already OFF. Direct approach is clearer.

### D117: Type-prefixed IDs as required format for cross-type collision prevention
**Date**: 2026-03-25
**Decision**: YAML artifact IDs use type prefixes (WI-, F-, P-, D-, Q-, GP-, C-). nodes PK rejects collisions as hard error.
**Rationale**: Class table inheritance uses single PK namespace.

## New Open Questions

### Q-75: Recursive CTE cycle protection for non-depends_on edges
**Domain**: artifact-structure
**Source**: code-quality S1 (query.ts:427-434)
**Impact**: depth > 1 traversal with direction "both" on cyclic edges produces exponential duplicate rows. LIMIT caps output but query is O(branching^depth).
**Status**: open

### Q-76: Ambiguous column `id` in graph traversal ORDER BY
**Domain**: artifact-structure
**Source**: code-quality S2 (query.ts:485)
**Impact**: Filtered depth > 1 traversals may produce wrong ordering or SQLite error.
**Status**: open

### Q-77: Architecture Section 9 source code index is stale
**Domain**: artifact-structure
**Source**: spec-adherence M2, gap-analysis SG1
**Impact**: Agents reading architecture see deleted tools.ts, miss 5 new tool group files.
**Status**: open

### Q-78: No test for depth > 1 graph traversal
**Domain**: artifact-structure
**Source**: gap-analysis MG1, cross-ref code-quality S1/S2
**Impact**: Both recursive CTE bugs would have been caught by such a test.
**Status**: open

### Q-79: Write tools YAML serialization uses string concatenation
**Domain**: artifact-structure
**Source**: code-quality M1 (write.ts)
**Impact**: Work item criteria with colons/quotes could produce malformed YAML.
**Status**: open

### Q-80: context.ts walkDir follows symlinks
**Domain**: artifact-structure
**Source**: code-quality M2 (context.ts)
**Impact**: Monorepo symlinks could inflate source index.
**Status**: open

## Cross-References

- **Q-75 + Q-76 + Q-78**: All three relate to the same recursive CTE in query.ts. Q-78 (missing test) is the root cause of Q-75 and Q-76 surviving to capstone review.
- **D116 + spec-adherence M1 + gap-analysis SG2**: defer_foreign_keys vs FK OFF mechanism substitution. Agreed by all reviewers as functionally equivalent.
- **D112 + Q-77**: The tools/ directory split (D112) created new files that were not reflected in architecture Section 9 (Q-77).
