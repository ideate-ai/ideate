# Refinement Interview — Cycle 022 (Compiled)

**Date**: 2026-03-25
**Context**: Consolidate MCP artifact server Phases 2-5 into a single large cycle. Phase 1 (schema, indexer, watcher, migration) complete. tools.ts empty. Outpost deferred to post-3.0.

## Schema Design

Architect surveyed codebase (opus). Critical review of v6 schema identified anti-pattern: 12 independent typed tables + universal edges with no FK integrity. Research confirmed class table inheritance as the idiomatic SQL pattern for property graphs (MCP-Zero paper, SQL Server Graph Tables, Apache AGE, Wikidata).

User decision: refactor to base `nodes` table + 12 extension tables. Fresh rewrite (not incremental migration). Keep Drizzle ORM for injection safety. Hybrid query approach: Drizzle for CRUD, raw db.prepare() for recursive CTEs.

No FTS5, no semantic search, no embedding columns (YAGNI). Schema version bumps to 7.

## Tool Scope

User requested all 3 tiers for MVP (11 tools total). Ignore the README. Follow the SDLC phase tool mapping research for MCP roles around reporting, SDLC, and analytics.

7 tools from research inventory excluded with documented rationale (subsumed, YAGNI, or breaking changes).

User pre-conditions: (1) DAG queries via graph, (2) related artifact discovery, (3) utilize all captured data. These requirements added ideate_artifact_query as a graph-aware query tool with filter + traversal modes.

## Gap Analysis

Gap analyst (opus) identified 4 critical, 8 significant, 5 minor gaps. All resolved during interview:
- Critical: handleTool wiring (ToolContext interface), PRAGMA foreign_keys=ON, skill file updates (WI-191), work item decomposition
- Significant: excluded tool reconciliation, write tool sync SQLite update, archive atomicity, cross-type ID collision (type-prefixed IDs), deferred FK pragma, convergence parsing rules, test strategy, Drizzle vs raw SQL hybrid
- Minor: error responses, deleteStaleRows simplification, review_manifest side-effect, TYPE_TO_TABLE preservation, error handling pattern

## Phase Consolidation

User decision: single large cycle with one capstone. DAG has 4 layers. Tools split into tools/ directory for parallel file scope. 11 work items (WI-181-WI-191).
