# Decision Log — Cycle 003

## Planning Phase

### D1: Use manifest.json as the artifact directory schema version mechanism
- **When**: refine-003 interview, 2026-03-13
- **Decision**: Add `manifest.json` at the root of every artifact directory containing `{"schema_version": 1}`.
- **Rationale**: Two prior breaking schema changes were resolved with ad-hoc scripts. A persistent version marker enables future migration scripts to detect the schema version and apply targeted upgrades.

### D2: Scope versioning to the artifact directory schema only
- **When**: refine-003 interview, Q2
- **Decision**: Skills are not versioned and do not enforce version compatibility at invocation time.
- **Rationale**: Skills don't need migration or quality gates yet. Keeping scope narrow reduces cycle complexity.

### D3: Start at schema_version 1 (fresh start)
- **When**: refine-003 interview, Q4
- **Decision**: Current artifact directory schema is v1. Prior migrations are not retroactively numbered.
- **Rationale**: User framing indicates fresh start; version numbers represent forward-looking migrations.

### D4: No runtime enforcement — manifest is informational only
- **When**: refine-003 interview, Q5
- **Decision**: No skill checks or enforces `schema_version` at runtime. Migration scripts read the manifest; the workflow does not.

### D5: Scope cycle 003 to three files only
- **When**: refine-003 overview, Scope section
- **Decision**: Only `specs/artifact-conventions.md`, `skills/plan/SKILL.md`, `specs/manifest.json` in scope. README.md, CLAUDE.md, architecture.md explicitly excluded.
- **Implications**: Three documentation artifacts with artifact directory structure diagrams remain inconsistent after this cycle (OQ1–OQ3).

### D6: Migration script removal deferred
- **When**: refine-003 overview, Out of scope
- **Decision**: `scripts/migrate-to-cycles.sh` and `scripts/migrate-to-domains.sh` not removed in cycle 003.
- **Implications**: Interview stated scripts "will be removed." No work item was created. Scripts remain on disk (OQ4).

### D7: WI-074 and WI-075 are parallelizable
- **When**: refine-003 overview
- **Decision**: Non-overlapping file scopes enable parallel execution, consistent with GP-4.

---

## Execution Phase

### D8: Fix pre-existing stale directory diagram during WI-074
- **When**: WI-074 incremental review, 2026-03-13
- **Decision**: The legacy `reviews/incremental/` and `reviews/final/` entries in the `artifact-conventions.md` directory structure diagram were corrected to `archive/` + `domains/` during WI-074 rework.
- **Implications**: Diagram is now current. Review Artifacts section headings (lines ~357–641) still use stale paths — outside WI-074 scope (OQ6).

---

## Review Phase

### D9: Cycle verdict Fail — documentation propagation gaps
- **When**: Cycle 003 capstone
- **Decision**: Code-quality reviewer issued Fail despite all acceptance criteria passing. Fail is based on S1 and S2 (README.md and architecture.md omissions) — cross-cutting gaps outside stated work item scope.

---

## Open Questions

### OQ1: README.md artifact directory diagram omits manifest.json
- **Source**: Code-quality S1; Gap-analysis II1, IR1
- **Impact**: Users bootstrapping from README will not create `manifest.json`; migration scripts will fail silently.
- **Priority**: High — one-line fix, no design decision required.

### OQ2: CLAUDE.md artifact structure diagram omits manifest.json
- **Source**: Gap-analysis II2, IR1
- **Impact**: Agents operating on the ideate repository receive stale directory context, may omit `manifest.json` when scaffolding.
- **Priority**: High — one-line fix.

### OQ3: Architecture.md permissions table omits manifest.json
- **Source**: Code-quality S2 (Significant); Gap-analysis II3 (Minor/defer)
- **Impact**: No normative phase-access record for manifest.json in architecture contract.
- **Priority**: Low — defer; artifact-conventions.md is authoritative for reviewers.

### OQ4: Ad-hoc migration scripts not removed (user decision required)
- **Source**: Gap-analysis MR1; refine-003 interview
- **Impact**: Interview stated scripts will be removed. They remain present. README Migration section still documents `migrate-to-domains.sh`.
- **Who answers**: User — confirm intent and scope of removal.

### OQ5: Schema version 1 is not defined
- **Source**: Gap-analysis MR2, MI1
- **Impact**: Manifest's stated purpose (enable targeted migration) cannot be fulfilled without a v1 definition.
- **Priority**: Defer until first migration script is written.

### OQ6: Review Artifacts section headings in artifact-conventions.md use stale reviews/ paths
- **Source**: Code-quality M1; Spec-adherence D1, N1
- **Impact**: Internal inconsistency in artifact-conventions.md — diagram correct, section headings stale.
- **Priority**: Low — pre-existing, address in next conventions-touching work item.

---

## Cross-References

**CR1** — README.md omission: Code-quality S1 + Gap-analysis II1/IR1 agree on same file/lines/fix → OQ1 is highest-priority finding this cycle.

**CR2** — CLAUDE.md omission: Gap-analysis II2 only (other reviewers did not scope to CLAUDE.md); structurally identical to CR1 → OQ2.

**CR3** — Architecture.md permissions gap: Code-quality S2 (Significant) vs. Gap-analysis II3 (Minor/defer). Not contradictory — gap-analysis explicitly defers rather than dismisses → OQ3 can be deferred.

**CR4** — Stale section headings in artifact-conventions.md: Code-quality M1 + Spec-adherence D1/N1 agree (pre-existing); Gap-analysis silent → OQ6, low priority.
