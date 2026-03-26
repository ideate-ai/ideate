# Questions: Artifact Structure

## Q-4: Five work item number prefixes have duplicate files (055, 056, 059, 060, 061)
- **Question**: Work items 055, 056, 059, 060, and 061 each have two files in `specs/plan/work-items/` (e.g., `055-move-roles-system.md` and `055-move-roles-to-outpost.md`). Should superseded draft files be deleted, retaining only the executed version?
- **Source**: archive/cycles/001/gap-analysis.md IN1, archive/cycles/001/decision-log.md D7+OQ4
- **Impact**: The execute and brrr skills glob `plan/work-items/*.md` and match journal entries and review files by number prefix; duplicate prefixes create ambiguous ordering for five numbers on any future execution run.
- **Status**: open
- **Reexamination trigger**: Next attempt to run `/ideate:execute` or `/ideate:brrr` against these specs; gap analyst rated this "address now."

## Q-5: CLAUDE.md absent from the ideate repository root
- **Question**: Outpost received a `CLAUDE.md` as a first-class deliverable (WI-052 AC2). ideate has none. Should one be created covering plugin purpose, skill and agent directory layout, artifact directory convention, and development workflow?
- **Source**: archive/cycles/001/gap-analysis.md G2, archive/cycles/001/decision-log.md OQ3
- **Impact**: Developers opening ideate in Claude Code have no project-level context; the "dogfood" workflow (using ideate to improve itself) is degraded; violates GP-8 (Durable Knowledge Capture) at the project entry point.
- **Status**: resolved
- **Resolution**: CLAUDE.md now exists at the ideate repository root; cycle 003 gap-analysis references it as an existing file requiring updates.
- **Resolved in**: cycle 003

## Q-12: Ad-hoc migration scripts not removed despite interview intent
- **Question**: The refine-003 interview stated `scripts/migrate-to-cycles.sh` and `scripts/migrate-to-domains.sh` "will be removed." No work item was created and the scripts remain on disk. The README Migration section still documents `migrate-to-domains.sh`. Should they be removed in the next cycle?
- **Source**: archive/cycles/003/decision-log.md D6, OQ4; archive/cycles/003/gap-analysis.md MR1
- **Impact**: Stale scripts and documentation persist; user decision required to confirm removal intent and scope.
- **Status**: resolved
- **Resolution**: Both scripts deleted and artifact-conventions.md stale path references fixed by WI-091 in cycle 006.
- **Resolved in**: cycle 006

## Q-13: Schema version 1 structural invariants not defined
- **Question**: `manifest.json` documents `schema_version: 1` but no artifact enumerates which files, directories, and structural invariants constitute a v1-compliant artifact directory. Without this definition, migration scripts cannot determine what to upgrade.
- **Source**: archive/cycles/003/decision-log.md OQ5; archive/cycles/003/gap-analysis.md MR2, MI1
- **Impact**: The manifest's stated purpose (enabling targeted migration) is not achievable until v1 is defined.
- **Status**: open
- **Reexamination trigger**: When the first migration script is being written.

## Q-16: findings.by_reviewer.{reviewer}.suggestion has no consumer
- **Question**: The `suggestion` key was added to `by_reviewer` sub-objects during WI-093 rework for schema symmetry with `by_severity`. Should it be retained as-is, or should derivation rules explicitly document that `by_reviewer.suggestion` is populated but intentionally has no current consumer?
- **Source**: archive/cycles/006/decision-log.md D10, OQ3; archive/cycles/006/summary.md Minor M4
- **Impact**: No functional failure. Undocumented schema intent accumulates as technical debt: future implementers cannot determine whether the field is reliably populated or safely ignorable.
- **Status**: open
- **Reexamination trigger**: When a consumer of `by_reviewer` is being built, or when the derivation rules for quality_summary are next revised.

## Q-17: skills/refine/SKILL.md inline metrics schema omits the cycle field
- **Question**: Should `skills/refine/SKILL.md:373` add `"cycle": null` between `"phase"` and `"agent_type"` to match the canonical schema in `specs/artifact-conventions.md:719`?
- **Source**: archive/cycles/006/decision-log.md OQ4; archive/cycles/006/code-quality.md M4
- **Impact**: Refine skill entries written without a `cycle` field are bucketed as `(none)` by report.sh — a distinct bucket from entries that write `"cycle": null`. The per-cycle breakdown in report.sh may split a single logical bucket into two rows for any project that uses the refine skill.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; one-line fix to the inline schema example.

## Q-18: report.sh is absent from README.md and both plugin manifests
- **Question**: Should `README.md` include a section documenting `scripts/report.sh`, analogous to the existing Validation and Migration Tools section? Should the plugin manifests also reference it?
- **Source**: archive/cycles/006/gap-analysis.md MG3; archive/cycles/006/decision-log.md OQ7
- **Impact**: A user installing ideate has no documented path to discover the reporting script. The observability feature delivered by WI-094 is invisible at the user-facing entry point; the only reference is an internal citation in `specs/artifact-conventions.md`.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; additive README section, no design decision required.

## Q-20: review-manifest.md written to different locations by brrr vs standalone review
- **Question**: brrr writes review-manifest.md to `archive/incremental/review-manifest.md`; standalone review writes to `archive/cycles/{N}/review-manifest.md`. Should brrr copy the manifest to the cycle directory after reviewers complete so cycle directories are self-contained, or should the location difference be explicitly documented?
- **Source**: archive/cycles/003/code-quality.md M2; archive/cycles/003/decision-log.md OQ3
- **Impact**: brrr-produced cycle directories are not self-contained — the review manifest lives only in `archive/incremental/`. This creates confusion when inspecting cycle directories and may break consumers that expect the manifest at the cycle level.
- **Status**: resolved
- **Resolution**: v3 architecture stores findings under .ideate/cycles/{NNN}/findings/. Both brrr and standalone review write to the same location. The manifest location divergence no longer applies.
- **Resolved in**: cycle 027

## Q-21: report.sh fmt_ms(0) displays "0s" instead of "-" for missing timing data
- **Question**: `fmt_ms(0)` returns `"0s"` because the zero value passes the truthy check. Entries with missing `wall_clock_ms` default to 0 via fallback, so missing timing appears as "0s" rather than "-". Should `fmt_ms` treat 0 as missing data?
- **Source**: archive/cycles/004/code-quality.md M3; archive/cycles/004/decision-log.md OQ2
- **Impact**: Display ambiguity only — "0s" looks like a sub-second operation rather than absent data. No functional impact on report correctness.
- **Status**: resolved
- **Resolution**: WI-095 changed `fmt_ms` to treat 0 as missing data, returning "-" instead of "0s".
- **Resolved in**: cycle 005

## Q-22: metrics.jsonl section uses wrong heading level in artifact-conventions.md
- **Question**: The `metrics.jsonl` section added by WI-096 uses `####` heading level at `specs/artifact-conventions.md:710`, while every other top-level artifact section in the same document uses `###`. Should the heading be corrected to `###`?
- **Source**: archive/cycles/005/spec-adherence.md M1; archive/cycles/005/decision-log.md OQ1
- **Impact**: Document hierarchy is inconsistent. The `metrics.jsonl` section appears one level deeper than adjacent sections, which may confuse readers navigating by heading structure. No functional impact.
- **Status**: open
- **Reexamination trigger**: Next documentation-fix work item; single-line change.

## Q-23: metrics.jsonl agent-spawn example uses literal values instead of placeholders
- **Question**: `specs/artifact-conventions.md:720,724` shows `"cycle": null` and `"wall_clock_ms": 0` as literal values, while every other field in the same schema block uses `<placeholder>` notation. Should these be changed to `"cycle": "<N or null>"` and `"wall_clock_ms": <N>` to match the parameterized convention?
- **Source**: archive/cycles/005/gap-analysis.md MG2; archive/cycles/005/code-quality.md M1; archive/cycles/005/decision-log.md OQ3
- **Impact**: Readers scanning only the schema block may infer `cycle` is always null and `wall_clock_ms` is always 0 for agent-spawn entries. The semantics prose at line 768 clarifies intent, but the example is misleading in isolation.
- **Status**: open
- **Reexamination trigger**: Next documentation-fix work item; can be bundled with Q-22.

## Q-38: Watcher ignored pattern scoping — correct exclusion rule for .ideate/ hidden directory root
- **Question**: The chokidar `ignored: /(^|[/\\])\../` pattern in `watcher.ts:24` matches `.ideate/` itself, suppressing all file events. What is the correct scoped pattern? Options: (a) ignore only `index.db*` files (`/index\.db(-wal|-shm)?$/`); (b) function-form that checks `path.basename` starts with dot and is not the root artifact dir; (c) remove the pattern entirely and watch everything.
- **Source**: archive/cycles/016/code-quality.md C1; archive/cycles/016/spec-adherence.md S2; archive/cycles/016/gap-analysis.md G2; archive/cycles/016/decision-log.md Q1
- **Impact**: Without a fix, the incremental rebuild feature is non-functional for the entire server lifetime. Every deployment must be restarted to pick up YAML changes. Three independent reviewers flagged this.
- **Status**: resolved
- **Resolution**: WI-150 changed the pattern to `/index\.db(-wal|-shm)?$/`, silencing only SQLite database files. Three integration tests added for write/modify/delete events.
- **Resolved in**: cycle 017

## Q-39: Should rebuildIndex surface YAML parse failures as a files_failed counter in RebuildStats?
- **Question**: `rebuildIndex` silently continues on YAML parse failure and returns no `files_failed` or `parse_errors` field in `RebuildStats`. Callers (including the watcher callback) cannot distinguish "nothing changed" from "all files failed to parse." Should a `files_failed` counter be added?
- **Source**: archive/cycles/016/gap-analysis.md G3; archive/cycles/016/decision-log.md Q2
- **Impact**: A malformed YAML file causes its node to disappear from the index silently. Operators see `files_updated: 0` and cannot tell whether the rebuild succeeded or all files errored.
- **Status**: resolved
- **Resolution**: WI-152 added `files_failed` and `parse_errors` to `RebuildStats`.
- **Resolved in**: cycle 017

## Q-40: Schema migration path for existing index.db when DDL changes in Phase 2
- **Question**: `createSchema` uses `CREATE TABLE IF NOT EXISTS` throughout. When Phase 2 introduces DDL changes (new columns, new tables), existing `index.db` files will not be upgraded — the new DDL silently has no effect. Options: (a) delete-and-rebuild on schema version mismatch using SQLite `user_version` pragma; (b) versioned migration runners; (c) document "delete index.db to upgrade."
- **Source**: archive/cycles/016/gap-analysis.md G5; archive/cycles/016/decision-log.md Q3
- **Impact**: Becomes critical at the first Phase 2 DDL change. Phase 1 deployments will carry stale schema with no visible error. Option (a) is recommended by the gap analyst.
- **Status**: resolved
- **Resolution**: WI-152 implemented `user_version` pragma and exported `checkSchemaVersion` for DDL-mismatch detection.
- **Resolved in**: cycle 017

## Q-41: Migration script scope — one-time conversion tool or persistent utility?
- **Question**: The migration script currently produces an incomplete `.ideate/` directory (journal, archive cycles, and metrics steps are absent). If it is a one-time migration tool, it must be completed before production use. If it is an ongoing utility, it needs incremental mode and idempotency guarantees. Which is the intended model?
- **Source**: archive/cycles/016/decision-log.md Q4; archive/cycles/016/spec-adherence.md S1; archive/cycles/016/gap-analysis.md G1
- **Impact**: Determines the scope of cycle 017 completion work and whether the script should be designed for re-entrant use.
- **Status**: resolved
- **Resolution**: WI-172 added a JSDoc header to both `.ts` and `.js` files explicitly documenting the script as a one-time v2-to-v3 conversion tool. No idempotency guarantees required. See D-81.
- **Resolved in**: cycle 019

## Q-42: Should `deleteStaleRows` be converted to Drizzle before Phase 2 begins?
- **Question**: `deleteStaleRows` (indexer.ts:396-417) uses raw SQL with string-interpolated table names, violating two WI-154 acceptance criteria. Phase 2 write tools trigger stale-row deletion after each write. Should this conversion gate Phase 2?
- **Source**: archive/cycles/017/code-quality.md S1; archive/cycles/017/spec-adherence.md (WI-154 unmet criteria); archive/cycles/017/gap-analysis.md II1; archive/cycles/017/decision-log.md OQ-1
- **Impact**: The SQL identifier-injection safety goal of D-063/WI-154 is not fully achieved for the delete path. The "no string interpolation" guarantee that Phase 2 security relies on does not hold for deletes.
- **Status**: resolved
- **Resolution**: WI-160 converted `deleteStaleRows` to Drizzle. The function now uses Drizzle's `notInArray()` and typed table references instead of raw SQL string interpolation.
- **Resolved in**: cycle 018

## Q-43: Should `migrateArchiveCycles` extract `work_item` and `verdict` from source files?
- **Question**: Finding objects produced by `migrateArchiveCycles` omit `work_item` and `verdict`, both `NOT NULL` in the findings DDL. `verdict` is extractable from `## Verdict:` lines; `work_item` requires inferring from review file context. Should extraction logic be added?
- **Source**: archive/cycles/017/code-quality.md S2; archive/cycles/017/gap-analysis.md IG2; archive/cycles/017/decision-log.md OQ-2
- **Impact**: All pre-migration findings index with `work_item = ""` and `verdict = ""`. Phase 2 queries on historical findings by work item or verdict return no results.
- **Status**: resolved
- **Resolution**: WI-162 added extraction logic for `work_item` and `verdict` fields from source review files.
- **Resolved in**: cycle 018

## Q-44: Which journal migration layout is authoritative — per-entry files or flat journal.yaml?
- **Question**: `migrateJournal` writes per-entry files to `cycles/{NNN}/journal/` (per notes/157.md). `notes/143.md` shows `journal.yaml` as a flat array at `.ideate/` root. `notes/144.md` JournalEntry schema shows `entries:` array in `journal.yaml`. Three specs contradict each other. Which is intended?
- **Source**: archive/cycles/017/gap-analysis.md IG1; archive/cycles/017/decision-log.md OQ-3
- **Impact**: Phase 2 journal query tools built against the wrong layout assumption require rework. User decision required before Phase 2.
- **Status**: open
- **Reexamination trigger**: Before Phase 2 journal query tools are written; user decision required.

## Q-45: Should `migrateArchiveCycles` cover decision-log.md, summary.md, review-manifest.md, and archive/incremental/ files?
- **Question**: `migrateArchiveCycles` skips four of seven+ file types per cycle directory, including all incremental review files. The majority of structured review history is not migrated.
- **Source**: archive/cycles/017/gap-analysis.md IG3; archive/cycles/017/decision-log.md OQ-4
- **Impact**: Phase 2 tools surfacing historical findings will be missing the majority of the historical record (all incremental reviews). The WI-146 spec is ambiguous about scope.
- **Status**: resolved
- **Resolution**: WI-165 added migration for decision-log.md, summary.md, review-manifest.md, and archive/incremental/ files. WI-168 then registered the 10 previously-unregistered document types (including decision_log, cycle_summary, review_manifest) in the indexer via the document_artifacts table.
- **Resolved in**: cycle 018

## Q-46: Should plan artifact types be added to `runMigration`?
- **Question**: `runMigration` does not migrate `plan/architecture.md`, `plan/overview.md`, `plan/execution-strategy.md`, `plan/modules/*.md`, `steering/guiding-principles.md`, `steering/constraints.md`, or `steering/research/*.md`. These are steps 7 and 10 of the WI-146 notes spec.
- **Source**: archive/cycles/017/gap-analysis.md MR1; archive/cycles/017/decision-log.md OQ-5
- **Impact**: After migration, the `.ideate/` index has no plan artifacts. Phase 2 context assembly tools produce incomplete context packages.
- **Status**: resolved
- **Resolution**: WI-163 added `migratePlanArtifacts` and `migrateSteeringArtifacts` functions covering architecture, overview, execution-strategy, modules, guiding-principles, constraints, and research files.
- **Resolved in**: cycle 018

## Q-47: Should interview file migration be added to `runMigration`?
- **Question**: No migration function handles `steering/interview.md` or `steering/interviews/**/*.md`. This is step 11 of the WI-146 notes spec. The `.ideate/interviews/` subdirectory exists in `IDEATE_SUBDIRS` but nothing is migrated into it.
- **Source**: archive/cycles/017/gap-analysis.md MR2; archive/cycles/017/decision-log.md OQ-6
- **Impact**: Interview responses are not queryable via MCP tools after migration.
- **Status**: resolved
- **Resolution**: WI-164 added `migrateInterviews` handling both legacy `steering/interview.md` and per-cycle `steering/interviews/**/*.md` files.
- **Resolved in**: cycle 018

## Q-48: Stale `addresses`/`amends` edge type names in WI-144 criterion text
- **Question**: WI-144 criterion at `plan/work-items.yaml` still lists `addresses` and `amends` as edge type names. WI-153 renamed these to `addressed_by` and `amended_by`. `specs/plan/notes/159.md` explicitly required this update but WI-159 did not apply it. Should the criterion text be corrected?
- **Source**: archive/cycles/017/spec-adherence.md (WI-144 residual); archive/cycles/017/decision-log.md D-007, OQ-7
- **Impact**: Future spec-adherence reviews will continue flagging this criterion. One-line fix in `work-items.yaml`.
- **Status**: resolved
- **Resolution**: WI-166 (spec + doc cleanup) corrected stale edge type names and other spec inconsistencies.
- **Resolved in**: cycle 018

## Q-49: Architecture.md not updated for flat `cycles/` directory structure
- **Question**: `plan/architecture.md` still references the old nested `archive/cycles/` layout after WI-155 changed `IDEATE_SUBDIRS` to flat `cycles/`. Should the architecture document be updated?
- **Source**: archive/cycles/017/spec-adherence.md (WI-155 note); archive/cycles/017/gap-analysis.md IF1; archive/cycles/017/decision-log.md OQ-8
- **Impact**: Phase 2 work items planned against `architecture.md` will specify wrong paths for cycle-scoped artifacts.
- **Status**: resolved
- **Resolution**: WI-166 (spec + doc cleanup) updated architecture.md to reflect the flat cycles/ directory structure.
- **Resolved in**: cycle 018

## Q-50: `CURRENT_SCHEMA_VERSION` name collision between config.ts and schema.ts
- **Question**: `config.ts` exports `CURRENT_SCHEMA_VERSION = 2` (IdeateConfig JSON schema version) and `schema.ts` exports `CURRENT_SCHEMA_VERSION = 3` (SQLite `user_version`). Should these be renamed to `CONFIG_SCHEMA_VERSION` and `DB_SCHEMA_VERSION`?
- **Source**: archive/cycles/017/spec-adherence.md (naming consistency); archive/cycles/017/decision-log.md OQ-9
- **Impact**: No current runtime failure. A Phase 2 tool importing from both modules encounters a compilation error or shadows one constant.
- **Status**: resolved
- **Resolution**: WI-166 renamed the config.ts constant to `CONFIG_SCHEMA_VERSION`. The schema.ts constant retains `CURRENT_SCHEMA_VERSION`. Naming is asymmetric but no longer collides. See D-79.
- **Resolved in**: cycle 018

## Q-51: Does the "No interpolation" WI-154 criterion apply to `detectCycles`?
- **Question**: `detectCycles` (indexer.ts:425-427) uses raw SQL with a fixed CTE (no interpolated identifiers). The WI-154 criterion says "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts." The text is unambiguous as written, but D-063's rationale was write-path injection prevention. Does the criterion apply to read-only operations?
- **Source**: archive/cycles/017/spec-adherence.md (WI-154 note on detectCycles); archive/cycles/017/decision-log.md OQ-10
- **Impact**: If interpreted strictly, `detectCycles` is an additional unmet criterion. Ambiguity affects the scope of the WI-154 follow-up work item.
- **Status**: open
- **Reexamination trigger**: Before the `deleteStaleRows` follow-up work item is scoped; user decision required.

## Q-52: `domainQuestions` table missing `addressed_by` column
- **Question**: `EDGE_TYPE_REGISTRY.addressed_by.source_types` includes `"domain_question"`, but the `domainQuestions` Drizzle table has no `addressed_by` column. Edge extraction works via the `edges` table, but column-based denormalization is absent. Should the column be added, or should `domain_question` be removed from source_types?
- **Source**: archive/cycles/017/code-quality.md M1; archive/cycles/017/decision-log.md OQ-11
- **Impact**: Phase 2 tools querying "open questions" via `WHERE addressed_by IS NULL` on the `domainQuestions` table column return all questions as open, regardless of actual status.
- **Status**: resolved
- **Resolution**: WI-167 added the `addressed_by TEXT` column to the `domainQuestions` table in both Drizzle and raw-SQL DDL, bumped the schema version to 5, and added extraction tests. See D-80.
- **Resolved in**: cycle 018

## Q-53: ID uniqueness check across artifact types (carried from cycle 016 OQ-8)
- **Question**: Manually-assigned IDs in YAML files could collide across artifact types. The upsert pattern silently overwrites duplicate IDs with no error. Should a cross-type duplicate ID check be added to the rebuild pipeline, or should global ID uniqueness be documented as a convention?
- **Source**: archive/cycles/016/gap-analysis.md G4; archive/cycles/017/decision-log.md OQ-12
- **Impact**: Silent data loss during indexing when ID collisions occur. The collision is invisible to MCP tool consumers.
- **Status**: resolved
- **Resolution**: D-117 (cycle 022) established type-prefixed IDs (WI-, F-, P-, D-, Q-, GP-, C-) as a required format. The v7 schema's class table inheritance uses a single PK namespace; type prefixes prevent collisions by construction.
- **Resolved in**: cycle 022

## Q-54: Watcher debounce absent — burst file writes trigger N full rebuilds instead of 1
- **Question**: Each chokidar `change` event triggers a full `rebuildIndex()`. When multiple files are written in rapid succession (e.g., during migration or skill execution writing 10+ artifacts), each write fires a separate event. Should a trailing debounce (e.g., 500ms) be added to the watcher callback to coalesce burst writes into a single rebuild?
- **Source**: archive/cycles/018/code-quality.md S1; archive/cycles/018/decision-log.md OQ2
- **Impact**: Quadratic wall-clock time during batch writes. With 100+ artifacts, each rebuild touches hundreds of files. Execution skill and migration script both write many files in bursts.
- **Status**: resolved
- **Resolution**: WI-170 added a 500ms trailing debounce via `debounceTimers` map and `clearTimeout`/`setTimeout` in `ArtifactWatcher.onEvent()`. Configurable via `debounceMs` constructor param. See D-84.
- **Resolved in**: cycle 019

## Q-55: Hash-check loop performs up to 13 unindexed table scans per YAML file
- **Question**: For each YAML file, the rebuild loop iterates all 13 typed tables with `SELECT id, content_hash FROM {table} WHERE file_path = ?`. No typed table has a `file_path` index. Additionally, `db.prepare()` is called inside the inner loop, creating new prepared statements on every iteration. Should `file_path` indexes be added and statements pre-created?
- **Source**: archive/cycles/018/code-quality.md S2; archive/cycles/018/decision-log.md R1
- **Impact**: With 100 artifacts across tables, this is approximately 1300 unindexed queries per rebuild. The overhead compounds with watcher debounce absence (Q-54).
- **Status**: resolved
- **Resolution**: WI-171 added `idx_{table}_file_path` indexes on all 13 typed tables in `createSchema` and pre-created hash-check prepared statements before the file loop. See D-85.
- **Resolved in**: cycle 019

## Q-56: Drizzle table definitions diverge from raw-SQL DDL — missing constraints
- **Question**: The raw-SQL DDL defines `node_file_refs` with a composite PRIMARY KEY and `edges` with a UNIQUE constraint. The Drizzle table definitions omit both. Drizzle's `onConflictDoNothing()` and `onConflictDoUpdate()` rely on Drizzle metadata to infer conflict targets. Should Drizzle definitions be updated to declare these constraints, or should explicit `target` be passed to all `onConflict*` calls?
- **Source**: archive/cycles/018/code-quality.md S3; archive/cycles/018/decision-log.md OQ4, CR1
- **Impact**: Current runtime behavior is correct (SQLite enforces the raw-SQL constraints regardless). Risk is in future Drizzle version upgrades that rely on constraint metadata for conflict resolution.
- **Status**: resolved
- **Resolution**: WI-171 added `primaryKey()` to the `nodeFileRefs` Drizzle table and `unique()` to the `edges` Drizzle table. Definitions now mirror the raw-SQL DDL. See D-86.
- **Resolved in**: cycle 019

## Q-57: detectCycles BFS uses Array.shift() — O(n^2) for large graphs
- **Question**: Both the Kahn's topological sort and cycle-component BFS in `detectCycles` use `queue.shift()` which is O(n) per call. For a graph near the 10,000-node limit, overall complexity becomes O(n^2) instead of O(n + e). Should the queue be replaced with an index-pointer pattern?
- **Source**: archive/cycles/018/code-quality.md S4; archive/cycles/018/decision-log.md OQ7
- **Impact**: Performance degrades quadratically for large dependency graphs. Fix is a single-line change per BFS loop.
- **Status**: resolved
- **Resolution**: WI-171 replaced `Array.shift()` with a `let head = 0; const node = queue[head++]` index-pointer pattern in both BFS loops. Restores O(n + e) complexity. See D-87.
- **Resolved in**: cycle 019

## Q-58: migrate-to-v3.js dual-maintenance undocumented — flagged three consecutive times
- **Question**: The test suite imports from `migrate-to-v3.js`, not the TypeScript source. The `.js` file must be kept manually in sync with `.ts`. This was flagged in WI-162 (M2), WI-163 (M1), and cycle 018 gap analysis (II1/MI1, Significant) without resolution. Should a comment be added to the `.js` file header, or should a `pretest` script in package.json auto-compile `.ts` to `.js`?
- **Source**: archive/cycles/018/gap-analysis.md II1, MI1; archive/cycles/018/decision-log.md E5, OQ3, R3
- **Impact**: Any contributor adding a function to `.ts` without updating `.js` will produce unexplained test failures. The gap analyst rated this the highest-priority item for next cycle.
- **Status**: resolved
- **Resolution**: WI-172 (cycle 019) added detection; WI-174 (cycle 020) added the `build:migration` npm script and updated pretest warning text. Both the detection and recovery path are now in place. See D-88, D-91.
- **Resolved in**: cycle 020

## Q-59: interview_response type has no migration producer — table permanently empty
- **Question**: The `interview_responses` table has a full schema (Drizzle table, DDL, buildRow case, TYPE_TO_TABLE entry) with `domain_tag` and `cycle` fields, but no migration code produces records with `type: "interview_response"`. The `interview` type maps to `document_artifacts` (holistic blobs). Is `interview_response` a Phase 2 capability for structured per-domain indexing, or should the current interview-to-document_artifacts mapping be reconsidered?
- **Source**: archive/cycles/018/gap-analysis.md MR1; archive/cycles/018/decision-log.md OQ1
- **Impact**: The `interview_responses` table is permanently empty. Structured per-domain interview queries via MCP tools return zero results. User decision required.
- **Status**: resolved
- **Resolution**: WI-171 removed the `interview_responses` table entirely — DDL, Drizzle table definition, TypeScript interface, union member, and all dispatch entries. `CURRENT_SCHEMA_VERSION` bumped from 5 to 6. Any existing `index.db` at version 5 is deleted and rebuilt on next startup. See D-83.
- **Resolved in**: cycle 019

## Q-60: Source code index materially stale for config.ts and migrate-to-v3.ts
- **Question**: The architecture-level source code index omits 3 exports from config.ts and 9 functions from migrate-to-v3.ts, and lists a non-existent constant (`CURRENT_SCHEMA_VERSION` instead of `CONFIG_SCHEMA_VERSION` for config.ts). Should the source code index be regenerated, or should it be deprecated in favor of a different context assembly mechanism?
- **Source**: archive/cycles/018/spec-adherence.md D1, D2, U1, U2; archive/cycles/018/decision-log.md OQ5, CR2
- **Impact**: Agents consuming the source code index will not see 12 exported symbols and may re-implement equivalent logic. Every future agent planning work against these modules starts with an incorrect interface map.
- **Status**: resolved
- **Resolution**: WI-173 regenerated the source code index for five modules (config.ts, migrate-to-v3.ts, indexer.ts, schema.ts, watcher.ts). The `db.ts` row remains incomplete — see Q-64. See D-90.
- **Resolved in**: cycle 019

## Q-61: MCP server tools.ts is a stub — zero tools with no user-facing explanation
- **Question**: `tools.ts` exports `TOOLS = []` and `handleTool` throws unconditionally. The MCP server starts and accepts connections but advertises zero capabilities. There is no README, server description field, or `instructions` capability text explaining the Phase 2 roadmap. Should placeholder documentation be added?
- **Source**: archive/cycles/018/code-quality.md M4; archive/cycles/018/gap-analysis.md IR1; archive/cycles/018/decision-log.md OQ6, CR4
- **Impact**: A user registering `ideate-artifact-server` sees an empty tool list indistinguishable from a broken server. User decision required on when Phase 2 tool implementation begins.
- **Status**: resolved
- **Resolution**: Cycle 022 (D-108) consolidated Phases 2-5 into a single cycle, implementing 11 MCP tools across 5 tool group files. The server now advertises all 11 tools. The `tools/` directory replaces the former `tools.ts` stub.
- **Resolved in**: cycle 022

## Q-62: Migration script emits file_path: null for findings despite NOT NULL schema constraint
- **Question**: Both capstone and incremental finding builders in `migrate-to-v3.ts` emit `file_path: null` in YAML output. The `findings` table declares `file_path TEXT NOT NULL`. The indexer works around this via `buildCommonFields` falling back to the disk path. Should `file_path` be set to the relative output path in the migration builder?
- **Source**: archive/cycles/018/code-quality.md M9; archive/cycles/018/decision-log.md OQ8
- **Impact**: YAML artifact files are inconsistent with the schema contract. Direct YAML consumers (not going through the indexer) will see null where a path is expected.
- **Status**: resolved
- **Resolution**: WI-172 set `file_path: outRelPath` in both capstone and incremental finding builders in both `.ts` and `.js`. See D-89.
- **Resolved in**: cycle 019

## Q-63: `build:migration` npm script absent — documented recovery path for migrate-to-v3.js staleness fails
- **Question**: The `migrate-to-v3.js` header comment (added by WI-172) instructs contributors to run `npm run build:migration` to regenerate the `.js` file from `.ts`. The `pretest` staleness warning also references this command. Neither entry exists in `mcp/artifact-server/package.json`. Running the command produces `npm error Missing script: "build:migration"` immediately. Should the script be added?
- **Source**: archive/cycles/019/gap-analysis.md I2; archive/cycles/019/decision-log.md D-88, CR6
- **Impact**: Every contributor who follows the documented recovery path for dual-maintenance hits an immediate failure. Q-58's dual-maintenance risk remains unresolved at the recovery step. Highest-priority item for next refinement cycle.
- **Status**: resolved
- **Resolution**: WI-174 added `"build:migration"` to `package.json` scripts and updated the pretest warning text to reference `npm run build:migration`. See D-91.
- **Resolved in**: cycle 020

## Q-64: `db.ts` source code index row incomplete — two key exports absent
- **Question**: The architecture.md source code index row for `mcp/artifact-server/src/db.ts` omits `TYPE_TO_DRIZZLE_TABLE` (exported at `db.ts:235`) and `metricsEvents` (exported at `db.ts:171`). WI-173 updated five other module rows but did not address `db.ts`, which was also modified in WI-168 and WI-171. Should the `db.ts` row be updated?
- **Source**: archive/cycles/019/spec-adherence.md D1; archive/cycles/019/decision-log.md D-90, CR8
- **Impact**: Agents planning Phase 2 work against `db.ts` will not see two key exports and may re-implement equivalent logic.
- **Status**: resolved
- **Resolution**: WI-176 updated the architecture.md source code index row for `db.ts` to include `metricsEvents` and `TYPE_TO_DRIZZLE_TABLE`. See D-100.
- **Resolved in**: cycle 020

## Q-65: Stale 3-argument call sites in migrate tests
- **Question**: `migratePlanArtifacts`, `migrateSteeringArtifacts`, and `migrateInterviews` now accept two parameters after WI-172 removed `_ideateDir`. Approximately 10 test call sites in `migrate.test.ts` still pass a third argument (`ideateDir`) silently discarded by JavaScript. TypeScript does not flag this because tests import from the `.js` file. Should the stale arguments be removed?
- **Source**: archive/cycles/019/spec-adherence.md D2; archive/cycles/019/gap-analysis.md I1; archive/cycles/019/decision-log.md Q-65
- **Impact**: If a future refactor adds a third parameter with different semantics, these call sites will silently pass the wrong value and produce incorrect behavior without a type error.
- **Status**: resolved
- **Resolution**: WI-175 removed the third argument from all 13 stale call sites in `migrate.test.ts`. See D-98.
- **Resolved in**: cycle 020

## Q-66: Array-item branch in `toYaml` missing leading-whitespace guard
- **Question**: The scalar quoting path in `toYaml` (line 76) gained a `/^\s/.test(value)` guard in WI-172. The parallel array-item string path (line 110) checks only `\n`, `"`, `:`, and `#`. A string array item with leading whitespace produces unquoted output and invalid YAML. The same gap exists in `migrate-to-v3.js`. Should the guard be added?
- **Source**: archive/cycles/019/code-quality.md M2; archive/cycles/019/decision-log.md Q-66
- **Impact**: String array items with leading whitespace produce invalid YAML silently. The scalar path is covered; the array-item path is not.
- **Status**: resolved
- **Resolution**: WI-175 added `/^\s/.test(item)` to the array-item quoting condition at `migrate-to-v3.ts:110` and mirrored the change in `migrate-to-v3.js:146`. See D-92.
- **Resolved in**: cycle 020

## Q-67: `checkSchemaVersion` version-0 bypass untested; may accept legacy corrupt databases
- **Question**: `schema.ts:601` treats `user_version = 0` as "fresh DB — compatible" and returns `true` without deleting the file. This is correct for new SQLite files (SQLite sets `user_version = 0` by default), but a database created before the cycle 016 `user_version` mechanism was introduced would also have version 0 with real stale tables. No test exercises this path. Should a test be added and the known limitation documented?
- **Source**: archive/cycles/019/code-quality.md M3; archive/cycles/019/gap-analysis.md E1; archive/cycles/019/decision-log.md Q-67
- **Impact**: A pre-cycle-016 database with stale tables but `user_version = 0` would pass the version check and silently not be rebuilt. In practice, all active deployments have been rebuilt since cycle 016, so current risk is low. The untested path creates regression risk for future schema version bumps.
- **Status**: resolved
- **Resolution**: WI-177 added a test for the version-0 path using a `:memory:` database. The version-mismatch and version-current branches remain untested — see Q-70.
- **Resolved in**: cycle 020

## Q-68: Stale `.d.ts` and `.js.map` files on existing working trees not cleaned by `build:migration`
- **Question**: `scripts/migrate-to-v3.d.ts`, `scripts/migrate-to-v3.d.ts.map`, and `scripts/migrate-to-v3.js.map` exist on disk from a prior `tsc` invocation that lacked `--declaration false`. Running `npm run build:migration` suppresses `.d.ts` generation on new runs and `.gitignore` entries prevent future commits, but the stale files already on disk are never removed. Should a `prebuild:migration` step using `rmSync` delete them before compilation?
- **Source**: archive/cycles/020/code-quality.md M1; archive/cycles/020/decision-log.md Q-68
- **Impact**: Stale declaration files remain in contributors' working trees indefinitely. No correctness impact; creates noise in `git status` and may confuse IDE tooling resolving types from stale declarations rather than live source.
- **Status**: resolved
- **Resolution**: WI-178 added a `prebuild:migration` npm lifecycle script that deletes the three stale artifact files before each `build:migration` run. Each `rmSync` is wrapped in `try/catch` for idempotency. See D-102.
- **Resolved in**: cycle 021

## Q-69: `toYaml` array-item guard narrower than scalar guard — reserved scalars and indicator characters unguarded
- **Question**: The scalar quoting guard at `migrate-to-v3.ts:76` checks for reserved YAML scalar values (`true`, `false`, `null`, `~`) and YAML indicator characters (`{`, `}`, `[`, `]`, `|`, `>`, `*`, `&`) in addition to leading whitespace. The array-item guard added by WI-175 at line 110 covers only leading whitespace. Should the array-item condition be extended to full parity with the scalar guard?
- **Source**: archive/cycles/020/gap-analysis.md EC2; archive/cycles/020/decision-log.md Q-69
- **Impact**: Array items containing reserved scalars or YAML indicator characters may be emitted unquoted. Consumers parse `- true` as boolean, `- {key: val}` as an inline mapping, etc., rather than as strings. Migration is a one-time operation on known content; the gap persists for any future content triggering these cases.
- **Status**: resolved
- **Resolution**: WI-179 expanded the array-item quoting condition to 15 conditions, covering all scalar guard conditions. See D-103.
- **Resolved in**: cycle 021

## Q-70: `checkSchemaVersion` version-mismatch and version-current branches untested
- **Question**: WI-177 added a test for the version-0 (fresh DB) path. The version-mismatch path (`user_version` is non-zero and does not match `CURRENT_SCHEMA_VERSION`) and the version-current path (`user_version` matches `CURRENT_SCHEMA_VERSION`, returns `true`) have no tests. The version-current path is exercised on every server startup after a successful migration.
- **Source**: archive/cycles/020/gap-analysis.md EC1, IR1; archive/cycles/020/decision-log.md Q-70
- **Impact**: A regression in the mismatch path would skip WAL/SHM cleanup and database deletion, leaving the server on a mismatched schema. A regression in the version-current path would cause all post-migration startups to fail or misbehave.
- **Status**: resolved
- **Resolution**: WI-180 added two tests covering all three branches: version-mismatch (returns `false` and file deleted), version-current (returns `true`). The `checkSchemaVersion` describe block now has 3 tests. See D-104.
- **Resolved in**: cycle 021

## Q-73: Version-mismatch test does not call `db.close()` explicitly
- **Question**: `schema.test.ts:305` opens a `Database` handle and passes it to `checkSchemaVersion`. The function closes the handle internally on the stale-version path. The test relies on this internal side-effect for cleanup. If `checkSchemaVersion` is changed to not close the handle before deletion, the test leaks a file descriptor and leaves the DB file locked, causing the `finally` cleanup to fail.
- **Source**: archive/cycles/021/decision-log.md Q-73; archive/cycles/021/code-quality.md M2; archive/cycles/021/gap-analysis.md MG2
- **Impact**: Low — current behavior is correct. Risk materializes only if `checkSchemaVersion` implementation is changed to not close the handle internally. Latent fragility with no current failure.
- **Status**: open
- **Reexamination trigger**: Any future change to `checkSchemaVersion` that moves handle management to the caller; bundle with next `schema.test.ts` touch.

## Q-74: 11 of 15 new array-item quoting conditions have no tests
- **Question**: WI-179 expanded the array-item guard from 5 to 15 conditions. AC-3 required 4 representative tests, all of which are present and passing. The other 11 newly-activated conditions (`"false"`, `"null"`, `"yes"`, `"no"`, `"on"`, `"off"`, `startsWith("'")`, `startsWith(">")`, `startsWith("*")`, `startsWith("&")`, `startsWith("!")`, `startsWith("|")`) have no test. A silent regression in any one would not be caught.
- **Source**: archive/cycles/021/decision-log.md Q-74; archive/cycles/021/gap-analysis.md MG3
- **Impact**: Low — the 4 representative tests cover the structural pattern. A regression in a specific keyword or indicator character is unlikely but would be invisible to the test suite.
- **Status**: open
- **Reexamination trigger**: Any future touch to `migrate.test.ts` array-item quoting coverage; bundle additional condition tests at that time.

## Q-75: Recursive CTE cycle protection for non-depends_on edges
- **Question**: The recursive CTE in `query.ts:427-434` for graph traversal (depth > 1) uses `UNION ALL` without deduplication or visited-node tracking. For `depends_on` edges, cycles are prevented by Kahn's algorithm at index time. For other edge types (`relates_to`, `references`, `amended_by`, etc.), no cycle prevention exists. A bidirectional traversal on cyclic edges produces exponential duplicate rows up to the LIMIT cap.
- **Source**: archive/cycles/022/code-quality.md S1; archive/cycles/022/decision-log.md Q-75
- **Impact**: A `depth: 5` traversal with `direction: "both"` on a graph containing a `references` cycle between 3 nodes produces up to 243 rows instead of 3. The LIMIT (200) caps output but the query is O(branching^depth).
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; surgical fix — change `UNION ALL` to `UNION` in the recursive CTE.

## Q-76: Ambiguous column `id` in graph traversal ORDER BY
- **Question**: `query.ts:485` uses `ORDER BY depth, id`. When the base traversal SQL is wrapped in `SELECT * FROM (...)` for type/status filtering, the column `id` can be ambiguous if the subquery produces multiple columns named `id` from JOINs. SQLite resolves to the first `id` column, which may not be the intended `n.id`.
- **Source**: archive/cycles/022/code-quality.md S2; archive/cycles/022/decision-log.md Q-76
- **Impact**: Filtered depth > 1 traversals may produce incorrectly ordered results or an "ambiguous column name" SQLite error depending on query shape.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; surgical fix — alias `n.id AS node_id` in the CTE and use `node_id` in ORDER BY.

## Q-77: Architecture Section 9 source code index is stale
- **Question**: `specs/plan/architecture.md:573-584` still lists `tools.ts` as a single file. The actual implementation has `tools/index.ts` plus 5 group files (context.ts, query.ts, execution.ts, analysis.ts, write.ts). Six new source files are missing from the index. Should the table be updated?
- **Source**: archive/cycles/022/spec-adherence.md M2; archive/cycles/022/gap-analysis.md SG1; archive/cycles/022/decision-log.md Q-77
- **Impact**: Agents reading the architecture for orientation see deleted `tools.ts` and miss the 5 new tool group files. Context assembly tools that use this table report stale data.
- **Status**: resolved
- **Resolution**: Resolved by WI-221 which updates Section 9 source code index to list all tools/ files.
- **Resolved in**: cycle 027

## Q-78: No test for depth > 1 graph traversal
- **Question**: The tools test suite has tests for filter mode and error cases but no test exercises the recursive CTE path (depth > 1 with `related_to`). Both bugs in that path (Q-75 cycle protection, Q-76 ambiguous column) would have been caught by a depth > 1 test.
- **Source**: archive/cycles/022/gap-analysis.md MG1; archive/cycles/022/decision-log.md Q-78
- **Impact**: Both significant findings from cycle 022 are in untested code. A regression or further bugs in the recursive CTE path would be invisible to the test suite.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; add a test creating a 3-node chain and querying with depth > 1.

## Q-79: Write tools YAML serialization uses string concatenation
- **Question**: `handleWriteWorkItems` in `write.ts` uses string concatenation to build YAML output rather than the `yaml` library (already a dependency via indexer.ts). Work item criteria containing colons, quotes, or newlines could produce malformed YAML.
- **Source**: archive/cycles/022/code-quality.md M1; archive/cycles/022/decision-log.md Q-79
- **Impact**: Malformed YAML from special characters in criteria text would cause the indexer to skip the file silently. Low probability with typical criteria text but a latent correctness hole.
- **Status**: open
- **Reexamination trigger**: Next touch to `write.ts`; switch to `yaml` library serialization or add escaping.

## Q-80: context.ts walkDir follows symbolic links
- **Question**: The `walkDir` function in `context.ts` used to build the source code index does not check for symbolic links. In a monorepo with symlinked `node_modules` or workspace packages, it could traverse into unintended directories and inflate the source index.
- **Source**: archive/cycles/022/code-quality.md M2; archive/cycles/022/decision-log.md Q-80
- **Impact**: Source index may include files from symlinked directories, inflating context assembly results. No correctness bug in current single-project usage.
- **Status**: open
- **Reexamination trigger**: Next touch to `context.ts` or report of inflated source index in monorepo usage.
