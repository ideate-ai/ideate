# Decision Log — Cycle 016

## Planning Phase

### D-001: Clean-slate reimplementation with no v1 design assumptions
- **When**: Planning — initial interview (2026-03-08)
- **Decision**: Reimplement ideate from scratch. No design assumptions carried forward from v1.
- **Rationale**: v1 accumulated design debt and implicit assumptions that would constrain the new system.
- **Implications**: Every component had to be specified from first principles.

### D-002: Specs must be sufficient for LLM execution without subjective decisions
- **When**: Planning — initial interview (2026-03-08)
- **Decision**: The sufficiency test is that any reasonable question is answerable from the specs, and two independent LLMs should produce equivalent output.
- **Implications**: All work items must include machine-verifiable acceptance criteria. Ambiguous work items are rejected at planning time.

### D-003: Progressive decomposition: architecture → modules → work items
- **When**: Planning — initial interview (2026-03-08)
- **Decision**: Decompose planning output in three stages.
- **Implications**: The architect agent runs before the decomposer. Module specs are a required intermediate artifact.

### D-004: Andon cord interaction model — minimal post-planning user interaction
- **When**: Planning — initial interview (2026-03-08)
- **Decision**: After planning, user interaction is limited to unresolvable issues only.
- **Implications**: Guiding principles must be comprehensive enough to resolve common execution decisions.

### D-005: External MCP session-spawner in scope
- **When**: Planning — initial interview (2026-03-08)
- **Decision**: Include an MCP session-spawner for recursive self-invocation.
- **Alternatives considered**: CLI headless mode, Agent SDK direct invocation — rejected.
- **Implications**: Later extracted to the outpost project (cycle 008).

### D-006: v3 architecture — YAML source of truth, SQLite runtime index
- **When**: Planning — refine-016 session (2026-03-23)
- **Decision**: Rebuild the MCP artifact server with YAML files as source of truth and SQLite as a gitignored runtime index rebuilt on startup.
- **Rationale**: Token efficiency — reading large markdown files is expensive. Structured YAML with SQLite indexing enables precise, machine-parseable data access.
- **Implications**: Five-phase implementation. Skills break during phases 1–3. Phase 1 is foundation only — no MCP tools until Phase 2.

### D-007: Hard cutover — no coexistence between specs/ and .ideate/ formats
- **When**: Planning — refine-017 interview (2026-03-23)
- **Decision**: Migration converts once. The new .ideate/ format is the source of truth immediately after migration. No compatibility shim.
- **Alternatives considered**: Coexistence period — rejected.
- **Implications**: Between Phase 1 and Phase 4, the system is in a broken state. This is explicitly accepted.

### D-008: Remove existing 7 MCP read tools entirely, recreate intentionally in later phases
- **When**: Planning — refine-017 interview (2026-03-23)
- **Decision**: The 7 read tools are deleted in Phase 1 and recreated from scratch in Phase 2.
- **Rationale**: The old tools encode markdown format assumptions. Rewriting would carry those assumptions forward.

### D-009: .ideate/ directory is type-organized, not phase-organized
- **When**: Planning — refine-017 interview (2026-03-23)
- **Decision**: Type-organized subdirectories (work-items/, findings/, policies/) instead of phase-organized layout (steering/, plan/, archive/).
- **Implications**: Migration script must reorganize files, not just convert format.

### D-010: YAML everywhere — no markdown bodies in artifact files
- **When**: Planning — refine-017 interview (2026-03-23)
- **Decision**: All artifact files are pure YAML. Human-readable output is produced on demand by conversion tools.

### D-011: Journal remains a flat YAML file, not database-only
- **When**: Planning — refine-017 interview (2026-03-23)
- **Decision**: journal.yaml is a flat append-only file. SQLite is a derived index, not source of truth.

### D-012: Archive keeps cycle-organized structure (archive/cycles/{NNN}/)
- **When**: Planning — refine-017 interview (2026-03-23)
- **Decision**: Review artifacts stay in archive/cycles/{NNN}/ subdirectories. Cross-cycle queries use SQLite.

---

## Execution Phase

### D-013: .ideate/ discovery uses walk-up-from-CWD pattern (replaces .ideate.json)
- **When**: Execution — WI-143 (2026-03-24)
- **Decision**: Walk-up-from-CWD discovery kept but modified to look for `.ideate/config.json`.
- **Implications**: Any deployment using `.ideate.json` must migrate. Config schema changes to `schema_version: 2`.

### D-014: idx_edges_composite explicit named index removed — UNIQUE constraint is sufficient
- **When**: Execution — WI-144 incremental review finding M3 (2026-03-24)
- **Decision**: Explicit named index omitted. UNIQUE(source_id, target_id, edge_type) creates an equivalent implicit index.
- **Implications**: WI-144 acceptance criterion as written is technically unmet. Criterion text should be updated.

### D-015: `references` edge type added beyond spec — accepted as intentional
- **When**: Execution — WI-144 incremental review finding M4 (2026-03-24)
- **Decision**: Generic `references` edge type added to registry. Accepted and kept.
- **Implications**: Edge type registry contains one undocumented type.

### D-016: Archive cycles, interviews, and metrics.jsonl migration deferred from WI-146
- **When**: Execution — WI-146 incremental review finding S4 (2026-03-24)
- **Decision**: Archive cycle conversion, interview migration, and metrics.jsonl copy not implemented. Accepted as "not in the AC text" during incremental review.
- **Implications**: The spec-reviewer (S1) and gap-analyst (G1) independently identified this as a significant unmet requirement. Three of fifteen acceptance criteria unmet. Migration run produces incomplete .ideate/ directory. **Decision is contested.**

### D-017: `belongs_to_domain` source_types extended to include `work_item`
- **When**: Execution — WI-148 incremental review finding S1 (2026-03-24)
- **Decision**: `work_item` added as source type for `belongs_to_domain`, beyond the three types in the WI-148 notes spec.
- **Rationale**: Work items with a domain field were producing no edge, which is clearly wrong.
- **Implications**: plan/notes/148.md is stale and should be updated.

### D-018: Edge extraction tests deferred for all edge types except depends_on
- **When**: Execution — WI-148 incremental review finding M2 (2026-03-24)
- **Decision**: Test coverage for edge extraction limited to `depends_on`. Other 9 types deferred.
- **Implications**: `addresses` and `amends` edge types (yaml_field: null, no extraction mechanism) are untested.

### D-019: migrate.test.ts placed in mcp/artifact-server/src/__tests__/ instead of declared scope path
- **When**: Execution — WI-149 (2026-03-24)
- **Decision**: Test file co-located with vitest test infrastructure rather than at scripts/migrate-to-v3.test.ts.
- **Implications**: WI-149 formal scope entry in work-items.yaml is stale.

---

## Review Phase

### D-020: Code quality verdict: Fail (watcher non-functional, migration concurrency unsafe)
- **When**: Review — cycle 016 code-quality.md
- **Decision**: Code-reviewer issued Fail: C1 (watcher ignored pattern silences all .ideate/ events), S1 (module-level mutable state unsafe for concurrent execution).
- **Implications**: C1 and watcher gap (G2/spec-adherence S2) must be resolved before Phase 2.

### D-021: Spec adherence verdict: Fail (five unmet acceptance criteria)
- **When**: Review — cycle 016 spec-adherence.md
- **Decision**: Spec-reviewer issued Fail citing five unmet criteria across WI-144, WI-145, and WI-146.

---

## Open Questions

### OQ-1: Should the watcher ignored pattern be fixed before Phase 2 begins?
- **Source**: Code-reviewer C1; spec-reviewer S2; gap-analyst G2
- **Impact**: Phase 2 write tools will silently operate against a stale index. Write-then-read patterns will fail with no error. Three reviewers independently flagged this — highest-priority defect in the cycle.
- **Consequence of inaction**: Every write tool in Phase 2 is invisible to the index until server restart.

### OQ-2: Are the three missing migration steps in scope for a follow-up work item?
- **Source**: Spec-reviewer S1; gap-analyst G1; WI-146 incremental review S4; plan/notes/146.md steps 8, 11, 12
- **Impact**: Running migration produces .ideate/ with no historical archive data, no interview records, no metrics events. Phase 2 MCP tools querying these tables return empty results for all historical data.
- **Who answers**: User decision — determine whether notes spec or formal AC governs scope.

### OQ-3: Should the WI-144 acceptance criterion for idx_edges_composite be updated?
- **Source**: Spec-reviewer M1; WI-144 incremental review M3
- **Impact**: Criterion as written is permanently false. Future spec reviews will continue flagging it.
- **Resolution**: Update criterion text in work-items.yaml to accept the implicit index.

### OQ-4: Should the WI-149 scope entry in work-items.yaml be updated to the actual file path?
- **Source**: Spec-reviewer M3
- **Resolution**: Update work-items.yaml — one-line fix.

### OQ-5: Should plan/notes/148.md be updated to include `work_item` as a source type for belongs_to_domain?
- **Source**: Spec-reviewer M2; WI-148 incremental review S1
- **Resolution**: Update plan/notes/148.md — documentation only.

### OQ-6: Does the module-level mutable state in migrate-to-v3.ts need refactoring before parallel test execution?
- **Source**: Code-reviewer S1; WI-149 incremental review M1
- **Impact**: If vitest is configured with `--pool=threads`, state leaks between calls with no error raised.

### OQ-7: Should rebuildIndex propagate a structured error signal when YAML files fail to parse?
- **Source**: Gap-analyst G3
- **Impact**: Malformed YAML files cause nodes to silently disappear from the index.
- **Resolution**: Add `files_failed` counter and `parse_errors: string[]` to `RebuildStats`.

### OQ-8: Should there be an ID uniqueness check across artifact types?
- **Source**: Gap-analyst G4
- **Impact**: Manually-assigned duplicate IDs silently overwrite each other during upsert.

### OQ-9: Should there be a documented schema migration path for existing index.db files?
- **Source**: Gap-analyst G5
- **Impact**: Phase 2 deployments on Phase 1 databases will silently run against Phase 1 schema. New tables and columns will not exist.
- **Resolution**: Document "delete index.db to upgrade schema" or add schema version pragma check.

### OQ-10: Should startup gracefully handle a missing or unreadable .ideate/ directory?
- **Source**: Code-reviewer S2; gap-analyst G7
- **Impact**: Misconfigured invocations crash with raw stack traces. MCP host receives no usable diagnostic.
- **Resolution**: Wrap startup in try/catch with user-readable error message and `process.exit(1)`.

### OQ-11: Should `addresses` and `amends` edge types have an extraction mechanism defined for Phase 2?
- **Source**: Gap-analyst G6; WI-148 incremental review M2
- **Impact**: Edge types are defined and registered but have no production path to the database. Cross-domain traceability queries cannot be answered by Phase 2 tools.

---

## Cross-References

### CR1: Watcher ignored pattern — functional defect with spec violation
- **Code review**: C1 — chokidar `ignored: /(^|[/\\])\../` matches all paths inside `.ideate/`
- **Spec review**: S2 — WI-145 criterion "watcher.ts triggers incremental rebuild on YAML file changes in .ideate/" functionally unmet
- **Gap analysis**: G2 — incremental rebuild absent; server holds startup snapshot only
- **Connection**: All three reviewers independently identified the same root defect via different lenses. Highest-priority defect in the cycle. Any Phase 2 write-then-read pattern will fail silently.

### CR2: Missing migration steps — scope conflict between notes spec and formal AC
- **Spec review**: S1 — three of fifteen WI-146 acceptance criteria unmet (archive cycles, journal, metrics)
- **Gap analysis**: G1 — same three steps absent; historical data empty in Phase 2 MCP results
- **Connection**: The notes spec (plan/notes/146.md) explicitly lists these as migration steps. The formal AC checklist does not. The incremental reviewer deferred them as "not in the AC text." The capstone reviewers counted them as unmet. This is a structural conflict between two sources of truth for WI-146 scope.

### CR3: Module-level mutable state — severity disagreement between reviewers
- **Code review**: S1 — elevated to Significant; any future async call path corrupts state
- **WI-149 incremental review**: M1 — noted as Minor; safe for sequential use
- **Connection**: Severity disagreement reflects different risk models. Code-reviewer's framing (forward-looking, any concurrent caller) is more conservative. Resolution should address the higher framing.

### CR4: Startup error handling — crash dump at two distinct points
- **Code review**: S2 — `resolveArtifactDir` at module top level; unhandled rejection on missing config
- **Gap analysis**: G7 — `rebuildIndex` at startup; unreadable directory crashes with no fallback
- **Connection**: Both findings describe crash-with-no-diagnostic at startup but at different points. A complete fix addresses both: config resolution (earlier) and index rebuild (later).

### CR5: Schema migration path absent — Phase 2 deployment risk
- **Gap analysis**: G5 — `CREATE TABLE IF NOT EXISTS` does not upgrade existing schema; no version table
- **Connection**: No corresponding code or spec finding. Consequence is concrete: Phase 2 deployments on Phase 1 databases run against Phase 1 schema silently. Recommended resolution: document the "delete index.db" procedure or add a `user_version` pragma check at startup.
