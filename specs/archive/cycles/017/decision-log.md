# Decision Log — Cycle 017

## Prior-Cycle Decisions Referenced

Cycle 017 executes against decisions made during and immediately after cycle 016. See `specs/archive/cycles/016/decision-log.md` for planning decisions (D-006 through D-012) and `specs/domains/artifact-structure/decisions.md` for post-review architectural decisions (D-059 through D-063).

Key decisions this cycle executes against:

- **D-063**: Adopt Drizzle ORM to eliminate SQL identifier interpolation across all of `indexer.ts`
- **D-059**: `addressed_by`/`amended_by` as reversed-direction scalar fields on findings and policies
- **D-060**: Flat `cycles/` directory under `.ideate/` for cycle-scoped artifacts
- **D-061**: One file per artifact for merge-conflict safety
- **D-062**: `archive/cycles/{NNN}/` markdown eliminated; review outputs become YAML finding objects

---

## Planning Phase

### D-001: Cycle 017 scope defined as Phase 1 completion — 10 work items, no new features
- **When**: Planning — refine session (2026-03-24), producing WI-150 through WI-159
- **Decision**: Address all cycle 016 critical and significant review findings plus the post-review architectural decisions (D-059 through D-063). Scope bounded to bug fixes, schema enhancements, directory structure alignment, migration script completion, test expansion, and spec cleanup. No Phase 2 MCP tools and no skill integration.
- **Rationale**: Phase 2 depends on Phase 1 being correct. Cycle 016 identified defects (watcher non-functional, migration incomplete, startup crash path) that must be resolved before write tools are built against the index.
- **Implications**: After cycle 017, Phase 1 is nominally complete and Phase 2 (MCP write tools) can begin. Skills remain non-functional until Phase 4.
- **Source**: `specs/plan/overview.md`; journal.md 2026-03-24 (refine — v3 Phase 1 completion)

### D-002: deleteStaleRows Drizzle conversion explicitly included in WI-154 scope
- **When**: Planning — WI-154 notes specification (`specs/plan/notes/154.md`)
- **Decision**: The WI-154 notes spec explicitly listed `deleteStaleRows` as step 4 of the Drizzle conversion: "replace per-row DELETE with Drizzle `db.delete(tableRef).where(notInArray(tableRef.file_path, [...existingPaths]))`." This is a planned requirement with a specified implementation approach, not an edge case.
- **Rationale**: The WI-154 acceptance criterion "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts" is absolute. `deleteStaleRows` iterates `ALL_TYPED_TABLES` and interpolates table names as template literals — the same pattern D-063 was adopted to eliminate.
- **Implications**: The implementation's omission of this step is an unambiguous unmet requirement, not a scope interpretation question. See D-013 and OQ-1.
- **Source**: `specs/plan/notes/154.md` step 4; `specs/domains/artifact-structure/decisions.md` D-063

---

## Execution Phase

### D-003: Watcher ignored pattern changed from dotfile glob to index.db suffix match
- **When**: Execution — WI-150 (2026-03-24)
- **Decision**: Changed the chokidar `ignored` option from `/(^|[/\\])\../` (which silenced all paths inside `.ideate/`) to `/index\.db(-wal|-shm)?$/` (which silences only the SQLite database files). Three integration tests added for write/modify/delete YAML events.
- **Rationale**: Resolves cycle 016 critical finding C1. The old dotfile pattern matched `.ideate/` itself and all paths within it.
- **Implications**: Resolves cycle 016 OQ-1. The watcher now fires on YAML changes inside `.ideate/`. Phase 2 write-then-read patterns will function correctly.
- **Source**: journal.md 2026-03-24 (WI-150); `archive/cycles/016/code-quality.md` C1

### D-004: Startup error handling split into three distinct try/catch zones
- **When**: Execution — WI-151 (2026-03-24), with rework after incremental review
- **Decision**: Three separate try/catch blocks guard: (1) `resolveArtifactDir`, (2) `new Database` + pragmas + `createSchema`, (3) `rebuildIndex`. Each zone emits a stderr message and calls `process.exit(1)`. Initial implementation left `new Database()` and `createSchema()` unguarded; rework added them to zone 2.
- **Rationale**: A single outer try/catch cannot distinguish config-path failures from DB-open failures from rebuild failures. Separate zones produce actionable diagnostics for the MCP host.
- **Implications**: Resolves cycle 016 OQ-10. MCP host receives a readable error message rather than a raw stack trace on any startup failure.
- **Source**: journal.md 2026-03-24 (WI-151); `archive/cycles/016/code-quality.md` S2; `archive/cycles/016/gap-analysis.md` G7

### D-005: IDEATE_SUBDIRS updated to flat cycles/; architecture.md not updated
- **When**: Execution — WI-155 (2026-03-24)
- **Decision**: `IDEATE_SUBDIRS` in `config.ts` replaced `path.join("archive", "cycles")` with `"cycles"`. `config.test.ts` updated to match. `plan/architecture.md` was not updated and still references the old nested layout.
- **Rationale**: Implements D-060. The flat `cycles/` layout was specified in `specs/plan/notes/155.md`. Architecture document update was not in the WI-155 acceptance criteria.
- **Implications**: Creates a documentation-implementation divergence. Future work items authored against `architecture.md` will specify wrong paths for cycle-scoped artifacts. See OQ-8.
- **Source**: journal.md 2026-03-24 (WI-155); `specs/plan/notes/155.md`; `archive/cycles/017/gap-analysis.md` IF1

### D-006: Module-level mutable state refactored into MigrationContext; exported for test access
- **When**: Execution — WI-156 (2026-03-24)
- **Decision**: Six module-level `let` variables moved into a `MigrationContext` interface created inside `runMigration`. `MigrationContext` exported. All 38 migration tests pass without behavioral change.
- **Rationale**: Resolves cycle 016 S1 and OQ-6. Module-level state is unsafe if `runMigration` is ever invoked concurrently. A local context variable eliminates shared state entirely.
- **Implications**: Resolves cycle 016 OQ-6. Migration script is safe for concurrent test execution.
- **Source**: journal.md 2026-03-24 (WI-156); `archive/cycles/016/code-quality.md` S1

### D-007: WI-159 spec cleanup applied partially — edge type names in WI-144 criterion not updated
- **When**: Execution — WI-159 (2026-03-24)
- **Decision**: WI-159 applied three of four updates required by `specs/plan/notes/159.md`: the `idx_edges_composite` criterion in WI-144 updated; WI-149 scope entry path corrected; `notes/148.md` updated to add `work_item` to `belongs_to_domain` source_types. The fourth required update — changing `addresses`/`amends` to `addressed_by`/`amended_by` in the WI-144 edge type criterion text — was not applied.
- **Rationale**: Rationale for the omission not recorded. `specs/plan/notes/159.md` explicitly required this update.
- **Implications**: WI-144 criterion text remains stale with superseded edge type names. Future spec-adherence reviews will continue flagging it. See OQ-7.
- **Source**: journal.md 2026-03-24 (WI-159); `specs/plan/notes/159.md`; `archive/cycles/017/spec-adherence.md` (WI-144 residual)

### D-008: Schema bumped to version 3; addressed_by and amended_by columns added; CURRENT_SCHEMA_VERSION name collision introduced
- **When**: Execution — WI-152 (2026-03-24)
- **Decision**: `CURRENT_SCHEMA_VERSION` in `schema.ts` set to 3 (SQLite `user_version`). `addressed_by TEXT` added to `findings`. `amended_by TEXT` added to `domain_policies`. `files_failed` and `parse_errors` added to `RebuildStats`. `checkSchemaVersion` exported. Three new tests added. This creates a second export named `CURRENT_SCHEMA_VERSION` — `config.ts` already exports `CURRENT_SCHEMA_VERSION = 2` for the IdeateConfig JSON schema version.
- **Rationale**: Implements D-059. Resolves cycle 016 OQ-7 (files_failed counter) and OQ-9 (schema migration path via user_version pragma). The name collision is an incidental side effect of reusing the same constant name for two different versioning scopes.
- **Implications**: Resolves cycle 016 OQ-7 and OQ-9. The name collision is a minor clarity hazard — no runtime conflict today, but a consumer importing from both modules encounters it. See OQ-9.
- **Source**: journal.md 2026-03-24 (WI-152); `archive/cycles/016/gap-analysis.md` G3, G5

### D-009: Edge types addresses and amends renamed to addressed_by and amended_by; extractEdges unchanged
- **When**: Execution — WI-153 (2026-03-24)
- **Decision**: `EDGE_TYPES` constants `addresses` and `amends` renamed to `addressed_by` and `amended_by`. Registry entries updated with reversed direction and non-null `yaml_field` values. No changes to `extractEdges` needed — the function is fully registry-driven.
- **Rationale**: Implements D-059. Reversed-direction naming aligns the edge type name with the yaml_field, enabling auto-extraction. Replaces the prior `yaml_field: null` placeholder that prevented automatic edge production.
- **Implications**: Resolves cycle 016 OQ-11. Both edge types are now auto-extractable from YAML. Extraction tests added in WI-158. The WI-144 criterion text was not updated — see D-007 and OQ-7.
- **Source**: journal.md 2026-03-24 (WI-153); `specs/domains/artifact-structure/decisions.md` D-059

### D-010: migrateJournal writes per-entry files to cycles/{NNN}/journal/ — contradicts flat journal.yaml in notes/143 and notes/144
- **When**: Execution — WI-157 (2026-03-24)
- **Decision**: `migrateJournal` writes one YAML file per journal entry to `.ideate/cycles/{NNN}/journal/J-{NNN}-{seq}.yaml`, following `specs/plan/notes/157.md` exactly. This contradicts `specs/plan/notes/143.md` (shows `journal.yaml` at `.ideate/` root) and `specs/plan/notes/144.md` (JournalEntry schema shows an `entries:` array in `journal.yaml`).
- **Rationale**: The WI-157 executor followed the immediate work item's notes spec without checking the earlier architectural specs for contradictions. The contradiction was not caught during incremental review.
- **Implications**: Any code expecting `.ideate/journal.yaml` as a flat array will find nothing after migration. The design contract for journal access is undefined between the three conflicting specs. See OQ-3.
- **Source**: journal.md 2026-03-24 (WI-157); `specs/plan/notes/157.md`; `specs/plan/notes/143.md`; `specs/plan/notes/144.md`; `archive/cycles/017/gap-analysis.md` IG1

### D-011: migrateArchiveCycles covers 3 of 7+ review file types; finding objects produced without work_item or verdict
- **When**: Execution — WI-157 (2026-03-24)
- **Decision**: `migrateArchiveCycles` processes `code-quality.md`, `spec-adherence.md`, and `gap-analysis.md` from each archive cycle directory. Does not process `decision-log.md`, `summary.md`, `review-manifest.md`, or any file under `archive/incremental/`. Finding objects at lines 1034–1048 omit `work_item` and `verdict`, both of which are `NOT NULL` in the findings table DDL.
- **Rationale**: The WI-157 notes spec defined the file-to-reviewer mapping for three file types only and did not specify extraction of `work_item` or `verdict`. Neither omission was caught during incremental review.
- **Implications**: All migrated findings index with `work_item = ""` and `verdict = ""`. MCP queries filtering historical findings by work item or verdict return meaningless results. Decision logs, summaries, and all incremental reviews are not migrated. See OQ-2, OQ-4, and cross-references CR2 and CR3.
- **Source**: journal.md 2026-03-24 (WI-157); `archive/cycles/017/code-quality.md` S2; `archive/cycles/017/gap-analysis.md` IG2, IG3

### D-012: 8 edge extraction tests and 1 watcher integration test added; 101 tests pass
- **When**: Execution — WI-158 (2026-03-24)
- **Decision**: Edge extraction tests added for `blocks`, `belongs_to_module`, `belongs_to_domain`, `derived_from`, `relates_to`, `supersedes`, `addressed_by`, and `amended_by`. One watcher integration test added verifying the full chain from YAML write through watcher event to incremental rebuild.
- **Rationale**: Resolves cycle 016 D-018 (extraction tests deferred for all types except `depends_on`). `addressed_by` and `amended_by` tests are possible because WI-153 gave both types non-null `yaml_field` values.
- **Implications**: Edge extraction coverage is complete for all registered types.
- **Source**: journal.md 2026-03-24 (WI-158)

### D-013: Drizzle applied to upsert functions only; deleteStaleRows left as raw SQL; final wiring completed manually after agent rate limit
- **When**: Execution — WI-154 (2026-03-24), with rework
- **Decision**: `drizzle-orm` installed. `src/db.ts` created with 14 Drizzle table definitions. `upsertRow`, `upsertEdge`, `upsertFileRef`, and `extractFileRefs` converted to Drizzle. `rebuildIndex` signature updated. `deleteStaleRows` (lines 396–417) was not converted and retains `db.prepare(...)` with string-interpolated table names. `detectCycles` (lines 425–427) also retains raw SQL. Agent hit its rate limit mid-flight; final wiring completed manually.
- **Rationale**: Rationale for the `deleteStaleRows` omission not recorded. The WI-154 notes spec explicitly listed it as step 4 of the Drizzle conversion.
- **Implications**: Two WI-154 acceptance criteria are unmet. The SQL identifier-injection safety goal of WI-154 is not fully achieved for the delete path. The WI-154 incremental review issued Pass with 0 findings, missing the omission. All three capstone reviewers independently identified it. See OQ-1 and OQ-10, and cross-reference CR1.
- **Source**: journal.md 2026-03-24 (WI-154); `specs/plan/notes/154.md`; `archive/cycles/017/code-quality.md` S1; `archive/cycles/017/gap-analysis.md` II1

---

## Review Phase

### D-014: All three capstone reviewers issued Fail; all 10 incremental reviews issued Pass
- **When**: Review — cycle 017 capstone (2026-03-24)
- **Decision**: Code-quality: Fail — S1 (`deleteStaleRows` raw SQL), S2 (migration finding objects missing `work_item`/`verdict`), M1 (`addressed_by` source_type mismatch on `domainQuestions`), M2 (`user_version` pragma in transaction confirmed non-issue). Spec-adherence: Fail — two unmet WI-154 criteria; WI-144 stale edge type names; `CURRENT_SCHEMA_VERSION` name collision noted. Gap-analysis: Fail — MR1 (plan artifact migration absent), MR2 (interview migration absent), IG1 (journal layout divergence), IG2 (corrupt finding objects), IG3 (partial archive coverage), II1 (`deleteStaleRows`), IF1 (`architecture.md` stale). All 10 incremental reviews: Pass with 0/0/0 findings.
- **Rationale**: Not a decision — recorded as fact. The divergence between 10 incremental Pass verdicts and 3 capstone Fail verdicts on the same work items is notable. The `deleteStaleRows` gap was missed by the WI-154 incremental reviewer and independently caught by all three capstone reviewers via different lenses.
- **Implications**: Phase 1 is not complete as shipped. OQ-1 through OQ-6 and OQ-7 represent blockers for a correct Phase 2 foundation.
- **Source**: `archive/cycles/017/code-quality.md`; `archive/cycles/017/spec-adherence.md`; `archive/cycles/017/gap-analysis.md`

### D-015: detectCycles raw SQL — scope of "No interpolation" WI-154 criterion is ambiguous
- **When**: Review — cycle 017 spec-adherence (2026-03-24)
- **Decision**: The spec-adherence reviewer noted that `detectCycles` (lines 425–427) also uses raw SQL. `detectCycles` does not interpolate table names (it uses a fixed CTE). Whether the WI-154 criterion "anywhere in indexer.ts" covers read-only operations or is limited to write-path injection was not resolved.
- **Implications**: Ambiguity persists. Future spec-adherence reviews may flag `detectCycles` depending on the reviewer's interpretation. See OQ-10.
- **Source**: `archive/cycles/017/spec-adherence.md` (WI-154 note on `detectCycles`)

---

## Resolved Open Questions from Cycle 016

| Cycle 016 OQ | Resolution | Work Item |
|---|---|---|
| OQ-1: Watcher ignored pattern silences .ideate/ | Resolved — pattern now targets `index.db` files only | WI-150 |
| OQ-3: idx_edges_composite criterion update | Partially resolved — criterion text updated; edge type name update not applied (see OQ-7 below) | WI-159 |
| OQ-4: WI-149 scope entry path | Resolved — scope entry corrected | WI-159 |
| OQ-5: notes/148.md work_item source type | Resolved — `notes/148.md` updated | WI-159 |
| OQ-6: Module-level mutable state | Resolved — `MigrationContext` refactor complete | WI-156 |
| OQ-7: files_failed counter for parse errors | Resolved — `files_failed` and `parse_errors` added to `RebuildStats` | WI-152 |
| OQ-9: Schema migration path for index.db | Resolved — `user_version` pragma set; `checkSchemaVersion` exported | WI-152 |
| OQ-10: Startup crash with no diagnostic | Resolved — three try/catch zones with stderr message and `process.exit(1)` | WI-151 |
| OQ-11: addresses/amends extraction mechanism | Resolved — reversed-direction fields with non-null `yaml_field` defined | WI-153 |

Carried forward (renumbered below):

| Cycle 016 OQ | Carry-forward |
|---|---|
| OQ-2: Missing migration steps | Partially addressed by WI-157 (journal/archive/metrics); plan artifacts and interviews still absent (see OQ-5, OQ-6 below) |
| OQ-8: ID uniqueness check across artifact types | Not addressed — no work item covered this (see OQ-12 below) |

---

## Open Questions

### OQ-1: Should deleteStaleRows be converted to Drizzle before Phase 2 begins?
- **Question**: `deleteStaleRows` (indexer.ts:396–417) violates two WI-154 acceptance criteria. Should this gate Phase 2?
- **Source**: Code-quality S1; spec-adherence unmet WI-154 criteria; gap-analysis II1; `specs/plan/notes/154.md` step 4
- **Impact**: The SQL identifier-injection safety goal of WI-154 is not fully achieved for the delete path. Phase 2 write tools trigger stale-row deletion after each write.
- **Who answers**: Technical investigation — the fix is specified in notes/154.md. The question is scheduling.
- **Consequence of inaction**: Two WI-154 criteria remain permanently unmet. The "no string interpolation" guarantee that Phase 2 security relies on does not hold for the delete path.

### OQ-2: Should migrateArchiveCycles extract work_item and verdict from source files?
- **Question**: Finding objects produced by `migrateArchiveCycles` omit `work_item` and `verdict`. Both are `NOT NULL` in the findings DDL. Should extraction logic be added?
- **Source**: Code-quality S2; gap-analysis IG2
- **Impact**: All pre-migration findings index with `work_item = ""` and `verdict = ""`. Phase 2 queries on historical findings by work item or verdict return no results.
- **Who answers**: Technical investigation — `verdict` extractable from `## Verdict:` line; `work_item` requires inferring from review file context.
- **Consequence of inaction**: Migration permanently produces semantically empty finding history.

### OQ-3: Which journal migration layout is authoritative — per-entry files or flat journal.yaml?
- **Question**: `migrateJournal` writes per-entry files to `cycles/{NNN}/journal/` (per notes/157.md). `notes/143.md` shows `journal.yaml` as a flat array at `.ideate/` root. `notes/144.md` JournalEntry schema shows `entries:` array in `journal.yaml`. Three specs contradict each other. Which is intended?
- **Source**: Gap-analysis IG1; `specs/plan/notes/143.md`; `specs/plan/notes/144.md`; `specs/plan/notes/157.md`
- **Impact**: Phase 2 journal query tools built against the wrong layout assumption require rework.
- **Who answers**: User decision — must decide before Phase 2 journal query tools are written.
- **Consequence of inaction**: Phase 2 tools are built against an undefined contract.

### OQ-4: Should migrateArchiveCycles cover decision-log.md, summary.md, review-manifest.md, and archive/incremental/ files?
- **Question**: `migrateArchiveCycles` skips four of seven+ file types per cycle directory, including all incremental review files.
- **Source**: Gap-analysis IG3
- **Impact**: The majority of structured review history (all incremental reviews) is not migrated. Phase 2 tools surfacing historical findings will be missing most of the historical record.
- **Who answers**: User decision — the WI-146 spec is ambiguous about scope.
- **Consequence of inaction**: Migration permanently discards incremental review history.

### OQ-5: Should plan artifact types be added to runMigration?
- **Question**: `runMigration` does not migrate `plan/architecture.md`, `plan/overview.md`, `plan/execution-strategy.md`, `plan/modules/*.md`, `steering/guiding-principles.md`, `steering/constraints.md`, or `steering/research/*.md`. These are steps 7 and 10 of the WI-146 notes spec.
- **Source**: Gap-analysis MR1; `specs/plan/notes/146.md` steps 7, 10
- **Impact**: After migration, the `.ideate/` index has no plan artifacts. Phase 2 context assembly tools produce incomplete context packages.
- **Who answers**: Technical investigation — the fix requires new migration functions.
- **Consequence of inaction**: Phase 2 tools produce context packages missing all planning and steering artifacts.

### OQ-6: Should interview file migration be added to runMigration?
- **Question**: No migration function handles `steering/interview.md` or `steering/interviews/**/*.md`. This is step 11 of the WI-146 notes spec.
- **Source**: Gap-analysis MR2; `specs/plan/notes/146.md` step 11
- **Impact**: Interview responses are not queryable via MCP tools after migration.
- **Who answers**: Technical investigation — low complexity; interviews become YAML documents in `.ideate/interviews/`.
- **Consequence of inaction**: Historical interviews are permanently excluded from the index.

### OQ-7: Should the stale addresses/amends edge type names in WI-144 criterion text be corrected?
- **Question**: The WI-144 criterion still names `addresses` and `amends`. WI-153 renamed these; `specs/plan/notes/159.md` explicitly required this update; WI-159 did not apply it.
- **Source**: Spec-adherence WI-144 residual finding; gap-analysis notes; `specs/plan/notes/159.md`
- **Impact**: Future spec-adherence reviews will flag this criterion. The criterion falsely describes the implementation.
- **Who answers**: Technical investigation — one-line fix in `work-items.yaml`.
- **Consequence of inaction**: Every future spec-adherence review flags this criterion.

### OQ-8: Should architecture.md be updated to reflect the WI-155 directory change?
- **Question**: `plan/architecture.md` still describes the old nested `archive/cycles/` layout.
- **Source**: Spec-adherence WI-155 implementation note; gap-analysis IF1
- **Impact**: Phase 2 work items planned against `architecture.md` will specify wrong directory paths for cycle-scoped artifacts.
- **Who answers**: Technical investigation — update one section in `architecture.md`.
- **Consequence of inaction**: Phase 2 work items specify wrong artifact paths.

### OQ-9: Should CURRENT_SCHEMA_VERSION be renamed to avoid the two-module collision?
- **Question**: `config.ts` exports `CURRENT_SCHEMA_VERSION = 2` (IdeateConfig JSON schema version) and `schema.ts` exports `CURRENT_SCHEMA_VERSION = 3` (SQLite `user_version`). Should these be renamed to `CONFIG_SCHEMA_VERSION` and `DB_SCHEMA_VERSION`?
- **Source**: Spec-adherence naming consistency finding
- **Impact**: No current runtime failure. A Phase 2 tool importing from both modules gets a compilation error or shadows one constant.
- **Who answers**: Technical investigation — rename and update all import sites.
- **Consequence of inaction**: The collision becomes a bug when Phase 2 tools check both schema versions.

### OQ-10: Does the "No interpolation" WI-154 criterion apply to detectCycles?
- **Question**: `detectCycles` uses raw SQL but does not interpolate table names. The WI-154 criterion says "anywhere in indexer.ts." Does it cover read-only operations or only write-path injection?
- **Source**: Spec-adherence WI-154 note on `detectCycles`
- **Impact**: If interpreted strictly, `detectCycles` is an additional unmet item alongside `deleteStaleRows`.
- **Who answers**: User decision — the spec text is unambiguous as written, but D-063's rationale was write-path safety.
- **Consequence of inaction**: Ambiguity persists. Future spec-adherence reviewers may reach different conclusions.

### OQ-11: Should domain_question be removed from addressed_by source_types, or should the domainQuestions table gain an addressed_by column?
- **Question**: `EDGE_TYPE_REGISTRY.addressed_by.source_types` includes `"domain_question"`, but the `domainQuestions` Drizzle table has no `addressed_by` column. Edge extraction works via the `edges` table, but the column-based denormalization is absent.
- **Source**: Code-quality M1
- **Impact**: Phase 2 tools that query "open questions" via `WHERE addressed_by IS NULL` on the `domainQuestions` table column will return all questions as open, regardless.
- **Who answers**: Technical investigation — add the column or remove the source type.
- **Consequence of inaction**: Phase 2 "open questions" queries against the `domainQuestions` table return incorrect results.

### OQ-12 (carried from cycle 016 OQ-8): Should there be an ID uniqueness check across artifact types?
- **Question**: Manually-assigned IDs in YAML files could collide across artifact types. The upsert pattern silently overwrites duplicate IDs with no error.
- **Source**: Cycle 016 gap-analysis G4
- **Impact**: Silent data loss during indexing when ID collisions occur. The collision is invisible to MCP tool consumers.
- **Who answers**: Technical investigation — add a cross-type duplicate ID check to the rebuild pipeline, or document that IDs must be globally unique by convention.
- **Consequence of inaction**: Silent data loss occurs when ID collisions happen.

---

## Cross-References

### CR1: deleteStaleRows raw SQL — unmet WI-154 criterion independently flagged by all three reviewers
- **Code review**: S1 — `db.prepare(...)` with string-interpolated table names at lines 400 and 406; criterion "No interpolation anywhere in indexer.ts" is unmet.
- **Spec review**: Two unmet WI-154 criteria — the specific `deleteStaleRows` Drizzle criterion and the broader "No interpolation" criterion are both unmet.
- **Gap analysis**: II1 — `deleteStaleRows` bypasses Drizzle; incomplete Drizzle migration missed by the WI-154 incremental review.
- **Connection**: All three reviewers identified the same gap independently. The WI-154 notes spec (`specs/plan/notes/154.md` step 4) explicitly required the conversion. The incremental review issued Pass with 0 findings, indicating the reviewer did not examine `deleteStaleRows`. The combined picture makes this the highest-confidence unresolved item in cycle 017. See OQ-1.

### CR2: Migration finding objects missing required fields — corrupt index data confirmed end-to-end
- **Code review**: S2 — `migrateArchiveCycles` at lines 1034–1048 omits `work_item` and `verdict`; `buildRow` substitutes empty strings.
- **Spec review**: No related finding.
- **Gap analysis**: IG2 — same defect from the schema perspective; confirms empty-string substitution in `buildRow`.
- **Connection**: Code-quality and gap-analysis describe the same defect from complementary angles. Together they confirm end-to-end corruption: structurally valid YAML, no indexer error, semantically empty fields in the database. No WI-157 acceptance criterion required these fields in migration output. See OQ-2.

### CR3: Migration script coverage — three related gaps in the same incomplete runMigration
- **Code review**: No related finding.
- **Spec review**: No related finding.
- **Gap analysis**: MR1 (plan artifacts absent), MR2 (interviews absent), IG3 (`migrateArchiveCycles` covers 3 of 7+ file types) — all three describe missing coverage in `runMigration`.
- **Connection**: All three are symptoms of a single root cause: `runMigration` was implemented against the WI-157 notes spec without checking WI-146 notes spec steps 7–12 for completeness. After migration, the index is missing all plan/steering artifacts (MR1), all interview history (MR2), and the majority of structured review history (IG3). Phase 2 context assembly will silently produce incomplete results across all three dimensions. See OQ-4, OQ-5, OQ-6.

### CR4: Stale spec text — WI-159 incomplete cleanup leaves two residual stale items
- **Code review**: No related finding.
- **Spec review**: WI-144 residual — `addresses`/`amends` edge type names not updated despite WI-153 rename; `specs/plan/notes/159.md` explicitly required this.
- **Gap analysis**: Notes section confirms WI-159 updated the `idx_edges_composite` criterion but stopped before applying the edge type name update in the same criterion block.
- **Connection**: Both reviewers noted the same incomplete edit in WI-159. The fix is a single-line change; the risk is ongoing false-positive spec failures and misleading criterion text for future workers. See OQ-7.
