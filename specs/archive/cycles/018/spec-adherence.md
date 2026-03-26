# Spec Adherence Review — Cycle 018

## Verdict: Pass

No principle violations or unmet acceptance criteria. Three architecture deviations noted (stale source code index entries, one deliberately omitted index). All 10 work items met their stated acceptance criteria.

## Architecture Deviations

### D1: Source code index lists stale export name for `config.ts`
- **Expected**: The shared context package's Source Code Index entry for `mcp/artifact-server/src/config.ts` lists `CURRENT_SCHEMA_VERSION` as a key export.
- **Actual**: WI-166 renamed this constant to `CONFIG_SCHEMA_VERSION`. The implementation at `config.ts:4` exports `CONFIG_SCHEMA_VERSION = 2`. The name `CURRENT_SCHEMA_VERSION` does not exist in `config.ts`.
- **Evidence**: `mcp/artifact-server/src/config.ts:4` — `export const CONFIG_SCHEMA_VERSION = 2;`. The source code index was not updated to reflect the WI-166 rename and will mislead agents that read it.

### D2: Source code index for `config.ts` omits three exported functions
- **Expected**: The source code index entry for `config.ts` lists five exports: `CURRENT_SCHEMA_VERSION, IdeateConfigJson, IdeateConfig, readIdeateConfig, findIdeateConfig`.
- **Actual**: `config.ts` also exports `resolveArtifactDir`, `createIdeateDir`, and `writeConfig`. All three are specified in `specs/plan/notes/143.md` and exercised in `config.test.ts:6-11`.
- **Evidence**: `mcp/artifact-server/src/config.ts:78,100,121` — three additional exported functions absent from the source code index.

### D3: WI-144 spec requires `idx_edges_composite` index; implementation omits it without spec update
- **Expected**: `specs/plan/notes/144.md:172-173` specifies `CREATE INDEX idx_edges_composite ON edges(source_id, target_id, edge_type)` as a required DDL statement.
- **Actual**: The index is not created. The UNIQUE constraint's implicit B-tree is substituted, which is technically equivalent. The reasoning is documented in-line but `notes/144.md` itself was not updated to reflect the decision.
- **Evidence**: `mcp/artifact-server/src/schema.ts:584` — `// idx_edges_composite omitted — UNIQUE(source_id, target_id, edge_type) already creates an implicit B-tree index on those columns.`

## Unmet Acceptance Criteria

None.

## Principle Violations

None.

## Principle Adherence Evidence

- **Principle 1 — Spec Sufficiency**: All 10 work items carry machine-verifiable acceptance criteria in `specs/plan/work-items.yaml:1589-1775` and detailed implementation notes in `specs/plan/notes/160.md` through `notes/169.md`. No criterion relies on executor judgment to resolve ambiguity.
- **Principle 2 — Minimal Inference at Execution**: `specs/plan/notes/160.md:28-35` specifies the exact Drizzle call pattern and sentinel value for `deleteStaleRows`; `specs/plan/notes/167.md:14-28` specifies the exact column name, type, and increment for `CURRENT_SCHEMA_VERSION`. Workers made no schema design decisions.
- **Principle 3 — Guiding Principles Over Implementation Details**: The `idx_edges_composite` omission (D3) was resolved by implementation-level reasoning (UNIQUE constraint equivalence) without user escalation, consistent with answering from principles rather than asking.
- **Principle 4 — Parallel-First Design**: WI-160 and WI-162 carry `depends: []` and are independent of each other, enabling parallel execution. WI-163–165 form a sequential chain only where strictly required by function availability. Evidence: `specs/plan/work-items.yaml:1587,1617`.
- **Principle 5 — Continuous Review**: All 10 work items have incremental reviews in `specs/archive/incremental/`. WI-161 and WI-165 both received initial Fail verdicts and were reworked before the next item proceeded. Evidence: `specs/archive/incremental/161-detectCycles-traversal-limit.md:1`, `specs/archive/incremental/165-migration-remaining-archive-types.md:22`.
- **Principle 6 — Andon Cord Interaction Model**: WI-165's initial Critical finding (decision_log/cycle_summary/review_manifest types unknown to indexer) was routed to the Andon cord rather than silently fixed in-scope, producing WI-168 as a properly bounded follow-up work item. Evidence: `specs/archive/incremental/165-migration-remaining-archive-types.md:22`.
- **Principle 7 — Recursive Decomposition**: The MCP artifact server is decomposed into distinct files with clear responsibilities (`config.ts`, `schema.ts`, `db.ts`, `indexer.ts`, `watcher.ts`, `tools.ts`). WI-160 through WI-169 each target a single file or tightly coupled pair without overlap. Evidence: scope entries in `specs/plan/work-items.yaml:1585-1776`.
- **Principle 8 — Durable Knowledge Capture**: `indexer.ts:543-660` reads YAML files and writes only to SQLite; no code path writes from SQLite back to YAML. The migration script writes YAML output only; it does not modify SQLite. The SQLite DB is deleted and rebuilt when `CURRENT_SCHEMA_VERSION` mismatches, confirming it is treated as a disposable cache. Evidence: `mcp/artifact-server/src/schema.ts:611-627` — `checkSchemaVersion` deletes the DB file on version mismatch.
- **Principle 9 — Domain Agnosticism**: Untestable for this cycle. All work items target infrastructure (SQLite schema, rebuild pipeline, migration script) with no domain-specific behavior.
- **Principle 10 — Full SDLC Ownership**: The cycle delivers runnable, tested code with 137 passing tests. The migration script provides a concrete upgrade path for existing artifact directories. Evidence: `specs/archive/incremental/169-module-spec-migration-fix.md:6`.
- **Principle 11 — Honest and Critical Tone**: WI-161's incremental review issued a Fail verdict despite all four acceptance criteria being technically met, because the new traversal-limit behavior was untested — the reviewer did not soften this. Evidence: `specs/archive/incremental/161-detectCycles-traversal-limit.md:1-3`.
- **Principle 12 — Refinement as Validation**: WI-165's Andon cord event demonstrates the refinement loop: a gap between migration output types and indexer's known types was discovered during execution and produced WI-168 as a new, properly scoped work item. Evidence: `specs/archive/incremental/165-migration-remaining-archive-types.md:22`, `specs/plan/work-items.yaml:1729`.

## Undocumented Additions

### U1: `config.ts` exports three functions not listed in the source code index
- **Location**: `mcp/artifact-server/src/config.ts:78-127`
- **Description**: `resolveArtifactDir`, `createIdeateDir`, and `writeConfig` are exported from `config.ts` and are fully specified in `specs/plan/notes/143.md` and tested in `config.test.ts`. They are documented at the work item level but absent from the architecture-level source code index.
- **Risk**: Agents consuming the source code index to understand the module's interface surface will not see these functions and may attempt to re-implement equivalent logic.

### U2: `migrate-to-v3.ts` exports nine functions not listed in the source code index
- **Location**: `scripts/migrate-to-v3.ts`
- **Description**: The source code index lists five exports (`MigrationContext, sha256, toYaml, buildArtifact, parsePrinciples`). The implementation additionally exports `parseWorkItemsYaml`, `migrateJournal`, `migrateArchiveCycles`, `migratePlanArtifacts`, `migrateSteeringArtifacts`, `migrateInterviews`, `migrateMetrics`, `MigrationOptions`, and `runMigration`. All nine are specified across WI-162 through WI-169 acceptance criteria. The source code index was assembled before these work items were implemented.
- **Risk**: Context packages assembled from the stale index misrepresent the migration script's interface.

## Naming/Pattern Inconsistencies

### N1: Asymmetric naming for two schema version constants in the same module boundary
- **Convention**: The pattern `*_SCHEMA_VERSION` is used for schema version constants in the artifact server.
- **Observation**: `mcp/artifact-server/src/config.ts:4` exports `CONFIG_SCHEMA_VERSION = 2` (governs `.ideate/config.json` schema); `mcp/artifact-server/src/schema.ts:8` exports `CURRENT_SCHEMA_VERSION = 5` (governs the SQLite database schema). Both are schema version guards within the same module boundary, but the naming uses different prefixes — `CONFIG_` on one and `CURRENT_` on the other. The names correctly distinguish the two schemas but the inconsistency is non-obvious without reading both files.
