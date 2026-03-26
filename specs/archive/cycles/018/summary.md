# Review Summary — Cycle 018

## Overview

The codebase is functionally complete for its Phase 1 scope: 137 tests pass, all 10 work items (WI-160 through WI-169) met their acceptance criteria, and the YAML-backed SQLite indexer correctly handles all 21 registered artifact types including the 10 newly registered document types from WI-168. Four performance/maintenance issues in the rebuild pipeline compound as artifact counts grow, and the migrate-to-v3.js dual-maintenance requirement has been flagged three consecutive times without resolution.

## Critical Findings

None.

## Significant Findings

- [code-reviewer] No watcher debounce — each file in a burst write triggers a separate full rebuildIndex call; N files written → N rebuilds instead of 1 — relates to: cross-cutting (execution performance under batch writes)
- [code-reviewer] Hash-check loop performs up to 13 unindexed table scans per file, with db.prepare() called inside the inner loop — relates to: cross-cutting (rebuildIndex performance)
- [code-reviewer] Drizzle table definitions for `node_file_refs` and `edges` omit the composite PRIMARY KEY and UNIQUE constraint declared in the raw-SQL DDL — runtime behavior is correct today but Drizzle version upgrades could silently break upserts — relates to: cross-cutting (artifact-structure)
- [code-reviewer] `detectCycles` BFS uses `Array.shift()` (O(n) per call) — overall complexity degrades to O(n²) for large graphs near the 10,000-node limit — relates to: cross-cutting
- [gap-analyst] migrate-to-v3.js dual-maintenance is undocumented — no comment, pretest script, or CI enforcement requires .js to stay in sync with .ts; flagged across WI-162 (M2), WI-163 (M1), and this cycle without resolution — relates to: cross-cutting (build infrastructure)

## Minor Findings

- [code-reviewer] `deleteStaleRows` accepts an unused `db: Database.Database` parameter — relates to: WI-160
- [code-reviewer] `TYPE_TO_TABLE` in indexer.ts duplicates `TYPE_TO_DRIZZLE_TABLE` in db.ts with no sync guard — relates to: WI-168
- [code-reviewer] Empty-ID sentinel `['']` in `deleteStaleRows` relies on no artifact ever having an empty string ID — relates to: WI-160
- [code-reviewer] `tools.ts` exports `TOOLS = []` and `handleTool` throws unconditionally — connecting MCP clients see an empty tool list with no explanation — relates to: cross-cutting (Phase 1 stub state)
- [code-reviewer] `PRAGMA foreign_keys = ON` is set but no FK constraints exist — relates to: cross-cutting
- [code-reviewer] WAL/SHM files not cleaned up on schema version mismatch — relates to: cross-cutting
- [code-reviewer] `walkDir` silently swallows directory read errors with no warning logged — relates to: cross-cutting
- [code-reviewer] `tokenCount` heuristic (length / 4) is undocumented — column name implies precision the value does not have — relates to: cross-cutting
- [code-reviewer] Migration script sets `file_path: null` for findings despite `NOT NULL` schema constraint — indexer works around this but YAML artifacts are inconsistent with schema — relates to: WI-162/WI-163
- [spec-reviewer] Source code index entry for `config.ts` lists the renamed constant `CURRENT_SCHEMA_VERSION` (no longer exists — renamed to `CONFIG_SCHEMA_VERSION` in WI-166) — relates to: WI-166
- [spec-reviewer] Source code index for `config.ts` omits `resolveArtifactDir`, `createIdeateDir`, `writeConfig` — relates to: WI-143
- [spec-reviewer] `idx_edges_composite` omitted without updating notes/144.md spec — relates to: WI-144
- [spec-reviewer] Source code index for `migrate-to-v3.ts` omits 9 exported functions added in WI-162 through WI-169 — relates to: WI-162–WI-169
- [spec-reviewer] Asymmetric naming: `CONFIG_SCHEMA_VERSION` (config.ts) vs `CURRENT_SCHEMA_VERSION` (schema.ts) — both are schema version guards in the same module boundary — relates to: WI-166
- [gap-analyst] `interview_response` type has no migration producer — `interview_responses` table will remain permanently empty — relates to: WI-144/WI-168
- [gap-analyst] `detectCycles` limit tests insert 50,001 rows in-process — no injectable limit mechanism for lightweight unit coverage — relates to: WI-161
- [gap-analyst] `rebuildIndex` cycle detection runs after the transaction commits — structural race window with concurrent writes — relates to: cross-cutting
- [gap-analyst] `toYaml` does not escape strings that start with whitespace — latent data corruption for unusual source content — relates to: cross-cutting
- [gap-analyst] `migrateArchiveCycles` `cycleSeq` resets per cycle — potential finding ID collisions if two review files produce findings with the same severity prefix and number — relates to: WI-162
- [gap-analyst] `migratePlanArtifacts` and `migrateSteeringArtifacts` duplicate `writeOutput` logic inline — relates to: WI-163
- [gap-analyst] `migrateSteeringArtifacts` dry-run test does not cover the guiding-principles branch — relates to: WI-163
- [gap-analyst] Legacy `steering/interview.md` migration path has no test — relates to: WI-164
- [gap-analyst] MCP server advertises zero tools with no README or description explaining Phase 2 roadmap — relates to: cross-cutting (IR1)
- [gap-analyst] `extractSection` with empty section body is untested — relates to: WI-169

## Suggestions

None.

## Findings Requiring User Input

- **`interview_response` type intent**: The `interview_responses` table has a full schema (Drizzle table, DDL, buildRow case, TYPE_TO_TABLE entry) but no migration producer generates records with this type. The `interview` type currently maps to `document_artifacts` (holistic blobs). The `interview_response` type was designed for structured per-domain interview data with `domain_tag` and `cycle` fields. Is `interview_response` a Phase 2 capability (structured indexing to be built later), or should the current interview-to-document_artifacts mapping be reconsidered? The answer determines whether the existing `interview_responses` table is correct-but-dormant or an unresolved design conflict. **Impact if unresolved**: the table remains empty indefinitely; any future consumer that queries it gets zero rows; the distinction between holistic interview blobs and structured per-domain data is lost.

- **MCP tools Phase 2 timeline**: `tools.ts` is a stub with no tools and no client-visible explanation. The architecture specifies 18 tools for Phase 2. When should Phase 2 tool implementation begin, and should placeholder documentation (server description, instructions capability) be added in the interim? **Impact if unresolved**: users who register the server expecting tools see an empty list indistinguishable from a broken server.

## Proposed Refinement Plan

The review identified 0 critical and 5 significant findings. A refinement cycle is recommended to address them.

**Areas to address**:

1. **Watcher debounce** (code S1) — Add a 500ms trailing debounce to the watcher callback in `src/index.ts` and `src/watcher.ts`. The rebuild is already idempotent; this change is safe and directly impacts every brrr/execute cycle that writes multiple artifacts in bursts.

2. **rebuildIndex performance** (code S2) — Add `CREATE INDEX IF NOT EXISTS idx_{table}_file_path ON {table}(file_path)` for each typed table. Pre-create the 13 prepared statements outside the file loop. Both changes affect `src/indexer.ts` and `src/schema.ts`.

3. **Drizzle/DDL constraint alignment** (code S3) — Add composite primary key declaration to `nodeFileRefs` and unique constraint to `edges` in `src/db.ts`, or pass explicit `target` parameters to all `onConflict*` calls. Affects `src/db.ts` only.

4. **detectCycles O(n²) fix** (code S4) — Replace `queue.shift()` with an index-pointer pattern in both BFS loops in `src/indexer.ts`. Single-line change per loop.

5. **migrate-to-v3.js sync documentation** (gap II1/MI1) — Add a comment at the top of `scripts/migrate-to-v3.js` stating it must be kept in sync with `migrate-to-v3.ts`, or add a `pretest` script in `package.json` that compiles `.ts` to `.js` automatically.

**Estimated scope**: 4–5 small work items, all targeting existing files. No architectural changes required. Items 1–4 affect the MCP server only; item 5 affects the migration script infrastructure.

**Next step**: `/ideate:refine specs/` to plan these 5 items plus the two user-decision questions.
