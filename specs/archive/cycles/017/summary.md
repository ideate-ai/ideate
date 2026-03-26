# Review Summary

## Overview

Cycle 017 completed all 10 planned work items with passing incremental reviews, but the capstone review identified six significant gaps across the migration script and one unmet acceptance criterion in the Drizzle ORM integration. The migration script (WI-157) is the primary problem area: it omits plan artifacts and interview files entirely, produces corrupt finding records (missing required fields), covers only 3 of 7+ review file types, and implements a journal layout that contradicts the WI-144 architectural specification. The `deleteStaleRows` function (WI-154) was not converted to Drizzle despite being explicitly specified in the work item notes, violating two acceptance criteria. All 101 tests pass.

## Critical Findings

None.

## Significant Findings

- [code-reviewer] `deleteStaleRows` in `indexer.ts:396-417` uses `db.prepare()` with string-interpolated table names, violating two WI-154 acceptance criteria: "deleteStaleRows uses Drizzle delete().where()" and "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts" — relates to: WI-154
- [code-reviewer] `migrateArchiveCycles` produces finding objects at `migrate-to-v3.ts:1034-1048` that omit `work_item` and `verdict`, both `NOT NULL` in the findings table DDL; indexed values are empty strings, corrupting all historical finding records — relates to: WI-157
- [gap-analyst] Plan artifact migration is absent from `runMigration`; `plan/architecture.md`, `plan/overview.md`, `plan/execution-strategy.md`, `plan/modules/*.md`, `steering/guiding-principles.md`, `steering/constraints.md`, and `steering/research/*.md` are not migrated — the `.ideate/` index has no plan or steering artifacts after migration — relates to: WI-146, WI-157
- [gap-analyst] Interview file migration is absent from `runMigration`; `steering/interview.md` and `steering/interviews/**/*.md` are not migrated to `.ideate/interviews/` despite being step 11 of the WI-146 specification — relates to: WI-146, WI-157
- [gap-analyst] `migrateJournal` writes per-entry YAML files to `cycles/{NNN}/journal/` (per notes/157.md), contradicting the flat `journal.yaml` array layout specified in `notes/143.md` and the JournalEntry schema in `notes/144.md`; three specs contradict each other — relates to: WI-144, WI-157
- [gap-analyst] `migrateArchiveCycles` covers only `code-quality.md`, `spec-adherence.md`, and `gap-analysis.md`; skips `decision-log.md`, `summary.md`, `review-manifest.md`, and all `archive/incremental/` files — the incremental review history is not migrated — relates to: WI-157

## Minor Findings

- [code-reviewer] `EDGE_TYPE_REGISTRY.addressed_by.source_types` includes `"domain_question"` but the `domainQuestions` Drizzle table has no `addressed_by` column; edge extraction still works via the `edges` table but column-based denormalization is absent, causing Phase 2 "open questions" queries via the column to return incorrect results — relates to: WI-152, WI-153
- [spec-reviewer] WI-144 criterion text at `plan/work-items.yaml` still lists `addresses` and `amends` as edge type names; WI-153 renamed these to `addressed_by` and `amended_by`; `specs/plan/notes/159.md` explicitly required this update but WI-159 did not apply it — relates to: WI-144, WI-159
- [spec-reviewer] `config.ts` exports `CURRENT_SCHEMA_VERSION = 2` (IdeateConfig JSON schema) and `schema.ts` exports `CURRENT_SCHEMA_VERSION = 3` (SQLite user_version); identical name, different versioning concerns, same package — a consumer importing from both encounters a name collision — relates to: WI-152
- [spec-reviewer] `plan/architecture.md` was not updated when WI-155 changed `IDEATE_SUBDIRS` from nested `archive/cycles` to flat `cycles/`; the architecture document is the primary reference for future work item authors — relates to: WI-155
- [spec-reviewer] `indexer.test.ts:47` creates `archive/cycles` as a fixture subdirectory inside `.ideate/`, inconsistent with the flat `cycles/` structure WI-155 established — relates to: WI-155, WI-158

## Suggestions

- [code-reviewer] `detectCycles` (indexer.ts:425-427) uses raw SQL; whether the WI-154 criterion "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts" applies to this read-only function is ambiguous — if interpreted strictly, it is an additional unmet criterion — relates to: WI-154
- [gap-analyst] The MCP server version is hardcoded to `"0.1.0"` in `index.ts` with no connection to `package.json` version or `CURRENT_SCHEMA_VERSION`; operators cannot determine the server version without reading the source code — relates to: cross-cutting

## Findings Requiring User Input

- **Journal migration layout (OQ-3)**: `migrateJournal` writes per-entry files to `cycles/{NNN}/journal/J-{NNN}-{seq}.yaml` (per notes/157.md). `notes/143.md` shows `journal.yaml` as a flat array at `.ideate/` root. `notes/144.md` JournalEntry schema also shows `entries:` array in `journal.yaml`. These three specs contradict each other. The user must decide which layout is authoritative before Phase 2 journal query tools are built. Choosing wrong requires a rework of either the migration function or the query tools.

- **detectCycles criterion scope (OQ-10)**: The WI-154 acceptance criterion states "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts." `detectCycles` uses raw SQL but does not interpolate identifiers — it uses a fixed CTE. The criterion text is unambiguous as written but D-063's rationale was write-path injection prevention. The user must decide whether read-path raw SQL is acceptable before the WI-154 follow-up work item is scoped. If the criterion applies to `detectCycles`, the Drizzle migration scope increases.

## Proposed Refinement Plan

Six significant findings require a refinement cycle before Phase 2 begins. The migration script is the primary problem area — it requires substantial additions (not patches). Estimated scope: 7-9 work items.

Recommended cycle 018 work items:

1. **deleteStaleRows Drizzle conversion** — convert `deleteStaleRows` to use Drizzle `db.delete(tableRef).where(notInArray(...))`. Resolve OQ-1 and OQ-10 (whether detectCycles also requires conversion) before writing the work item.

2. **migrateArchiveCycles: extract work_item and verdict** — add extraction of `work_item` (from review file context) and `verdict` (from `## Verdict:` line) to finding objects produced by `migrateArchiveCycles`.

3. **migratePlanArtifacts: add to runMigration** — implement migration functions for `plan/architecture.md`, `plan/overview.md`, `plan/execution-strategy.md`, `plan/modules/*.md`, `steering/guiding-principles.md`, `steering/constraints.md`, and `steering/research/*.md`.

4. **migrateInterviews: add to runMigration** — implement migration function for `steering/interview.md` and `steering/interviews/**/*.md`.

5. **migrateArchiveCycles: add remaining file types** — extend coverage to `decision-log.md`, `summary.md`, `review-manifest.md`, and `archive/incremental/*.md`.

6. **migrateJournal: resolve layout (requires OQ-3 user decision)** — after the user resolves OQ-3, either update `migrateJournal` to produce a flat `journal.yaml` array or update `notes/143.md` and `notes/144.md` to reflect the per-entry file layout.

7. **Spec cleanup: stale WI-144 criterion text, architecture.md directory layout, CURRENT_SCHEMA_VERSION naming** — three one-line fixes in work-items.yaml, architecture.md, and the two CURRENT_SCHEMA_VERSION constants.

8. **domainQuestions.addressed_by column** — add `addressed_by TEXT` to the `domainQuestions` Drizzle table and raw SQL DDL, or remove `"domain_question"` from `EDGE_TYPE_REGISTRY.addressed_by.source_types`.

User input required before `/ideate:refine`:
- OQ-3: Journal migration layout (per-entry vs flat)
- OQ-10: detectCycles raw SQL — is it in scope for WI-154 fix?
