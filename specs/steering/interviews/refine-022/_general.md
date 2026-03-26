# Refine Interview — Cycle 022 (General)

**Date**: 2026-03-25
**Context**: Consolidate MCP artifact server Phases 2-5 into a single cycle. Phase 1 (schema, indexer, watcher, migration) is complete. tools.ts is empty — no MCP tools are exposed. The skills already check for two tools (ideate_get_work_item_context, ideate_get_context_package) and fall back to manual file reads.

**Q: What is the scope of this refinement?**
A: Tackle all remaining MCP artifact server phases (2-5) in a single pass. The DAG still applies — work items have dependency ordering — but there is one capstone review at the end instead of multiple small ones. Outpost/session-spawner work is deferred (comes after 3.0).

**Q: Schema refactor — the current 12-table concrete inheritance has no FK integrity on edges. Should we refactor?**
A: Yes. Refactor to class table inheritance (base `nodes` table + extension tables). Research confirms this is the idiomatic pattern for property graphs in SQL. The user is concerned about RI issues and wants to do it "the right way." Fresh rewrite, not incremental migration — the DB is a derived cache rebuilt from YAML.

**Q: How many extension tables?**
A: One per type (12 extension tables). Each with PK as FK to nodes(id) ON DELETE CASCADE. No FTS5, no semantic search (YAGNI). Drop source_type/target_type from edges, drop node_type from node_file_refs — redundant with base table JOIN.

**Q: Keep Drizzle ORM or go raw SQL?**
A: Keep Drizzle for injection safety. Hybrid approach: Drizzle for CRUD operations, raw db.prepare() for recursive CTEs and multi-table JOINs (graph traversal queries Drizzle doesn't handle naturally).

**Q: Which tools to build for 3.0 MVP?**
A: All 3 tiers (11 tools total). Ignore the README — follow the SDLC phase tool mapping research for tool roles. User requirements: (1) DAG queries via the graph, (2) find related artifacts across cycles, (3) utilize all captured data. This led to adding ideate_artifact_query as a graph-aware query tool.

**Q: Which tools were excluded from the 18-tool research inventory?**
A: 7 tools cut with rationale:
- ideate_artifact_index — subsumed by artifact_query
- ideate_source_index — runtime Glob, not DB-backed
- ideate_domain_policies — subsumed by get_domain_state
- ideate_artifact_semantic_search — YAGNI
- ideate_write_incremental_review (W3) — code-reviewer writes markdown fine
- ideate_write_domain_update (W4) — breaking change to curator agent
- ideate_initialize_artifact_dir (W6) — plan handles this with Write tool

**Q: How do write tools interact with the watcher?**
A: Write tools follow a two-step pattern: (1) write YAML file to disk, (2) synchronously upsert affected SQLite rows. The watcher fires ~500ms later but hash-based skip finds rows already current. Eliminates stale-read window.

**Q: How does handleTool get database access?**
A: ToolContext interface: { db, drizzleDb, ideateDir }. Created once at startup in index.ts, passed to every handleTool call. Tools are pure functions of (ctx, args) → string.

**Q: What about PRAGMA foreign_keys = ON?**
A: Added to index.ts startup immediately after connection open. Without it, all FK constraints are decorative. Critical requirement.

**Q: Should skill files be updated to use the new tools?**
A: Yes — included as a work item. All 9 new tools need MCP availability checks added to the skill files that consume them.

**Q: Cross-type ID collision in the nodes base table?**
A: Current YAML IDs are type-prefixed (WI-, F-, P-, D-, Q-, GP-, C-, etc.). Document this convention as required format. The nodes PK rejects collisions as a hard error — strictly better than the current silent overwrite.

**Q: ideate_archive_cycle atomicity?**
A: Three-phase: copy all → verify all → delete originals. If verify fails, no originals deleted. Return error listing failed copies.

**Q: ideate_get_convergence_status parsing rules?**
A: Implements exact Phase 6c sequence from brrr/SKILL.md: machine-parseable verdict line → section-content heuristics → unknown fallback.

**Q: Test strategy?**
A: Schema tests (FK/CASCADE), indexer tests (two-pass insert, stale delete), tool tests (11 tools × 2+ tests each). Existing config.test.ts and watcher.test.ts unchanged.

**Q: File scope for parallel tool implementation?**
A: Tools split into a tools/ directory with separate files per group. 5 tool groups: context.ts, query.ts, execution.ts, analysis.ts, write.ts. Each work item has non-overlapping file scope.
