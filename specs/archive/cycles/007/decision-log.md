# Decision Log — Cycle 007

**Brrr cycle**: 3
**Work items**: WI-098, WI-099, WI-100
**Date**: 2026-03-21

---

## Planning Phase

### D1: Amend Principle 1 (Spec Sufficiency) to require UI/UX coverage
- **When**: refine-006 planning session, 2026-03-21
- **Decision**: Extended P1 to require explicit coverage of UI/UX — visual identity, interaction design, user flows, and accessibility — at the same spec rigor as technical decisions.
- **Rationale**: Current guiding principles did not mandate UX-level specification, leaving a gap that could allow executor-level inference on user-facing decisions.
- **Implications**: Future planning sessions must produce UX specs before execution begins; reviewers may flag their absence as a principle violation.

### D2: Amend Principle 2 (Minimal Inference at Execution) to include UX decisions in planning
- **When**: refine-006 planning session, 2026-03-21
- **Decision**: Expanded the enumerated list of decisions that must be resolved during planning to include user experience patterns and visual identity decisions.
- **Rationale**: Companion to D1. P2 enumerates categories of decisions off-limits for executor inference; adding UX/visual identity closes the gap.
- **Implications**: Architects and decomposers are now bound to specify UX decisions before handoff to execution.

### D3: Address SG1 (brrr review phase missing quality_summary emission) in WI-098
- **When**: refine-006 planning session, 2026-03-21
- **Decision**: Quality Trends in `report.sh` is always empty for brrr-driven projects. Fix by adding `### Emit Quality Summary` section to `skills/brrr/phases/review.md`.
- **Rationale**: brrr is the primary use case for multi-cycle autonomous runs; the telemetry gap makes the primary reporting feature non-functional for most users.
- **Implications**: After WI-098, `metrics.jsonl` will contain `quality_summary` events for brrr-driven review cycles.

### D4: Address SG2 (stale agent definition paths) in WI-099
- **When**: refine-006 planning session, 2026-03-21
- **Decision**: Fix three agent definitions referencing `reviews/incremental/` → `archive/incremental/`.
- **Rationale**: Stale path causes agents to silently find nothing, breaking deduplication (spec-reviewer), context loading (gap-analyst), and cross-cycle synthesis (journal-keeper).
- **Implications**: Incremental review context is loadable on the next cycle for all three agents.

### D5: Bundle five minor documentation findings into WI-100
- **When**: refine-006 planning session, 2026-03-21
- **Decision**: Heading level fix, two placeholder notation corrections, missing `"cycle"` field in refine SKILL.md, and README.md report.sh discoverability combined into one work item.
- **Rationale**: All five are mechanical, non-overlapping within a single work item, no behavioral impact.
- **Implications**: WI-100 creates a partial fix for the `"cycle"` field inconsistency — only `skills/refine/SKILL.md` is updated. The remaining three skill files (`plan`, `execute`, `review`) retain the inconsistency (see OQ1).

### D6: Execute WI-098, WI-099, WI-100 in parallel
- **When**: refine-006 planning session, 2026-03-21
- **Decision**: All three work items have non-overlapping file scope and no dependencies; run concurrently per P4.

### D7: Derive quality_summary severity counts from last_cycle_findings, not by re-parsing summary.md
- **When**: refine-006 planning session, WI-098 design
- **Decision**: Severity counts for the brrr quality_summary event are derived from the `last_cycle_findings` dict already in scope rather than by re-parsing a summary.md file (which brrr does not produce).
- **Rationale**: `last_cycle_findings` is already populated at the point of emission; no additional file dependency needed.

---

## Execution Phase

### D8: Rework WI-098 — update artifact-conventions.md schema to document "brrr" as valid skill value
- **When**: WI-098 incremental review, 2026-03-21
- **Decision**: The initial implementation was reworked to also update `specs/artifact-conventions.md:735` to document `"<review|brrr>"` as the valid set of `skill` field values in the quality_summary schema.
- **Rationale**: Incremental review found a significant gap: the canonical schema only documented `"review"`. Adding emission to brrr without updating the schema left the spec inconsistent with behavior.
- **Implications**: Canonical schema now correctly describes all emitters. WI-099 and WI-100 required no rework.

---

## Review Phase

### D9: Cycle 007 verdict Pass — 0 critical, 0 significant, 3 minor
- **When**: Cycle 007 capstone, 2026-03-21
- **Decision**: All three reviewers issued Pass. All 16 acceptance criteria satisfied; no architecture deviations or principle violations. Three minor findings deferred to next documentation pass.

---

## Open Questions

### OQ1: plan, execute, and review SKILL.md inline schemas still missing "cycle" field
- **Question**: Should `skills/plan/SKILL.md:730`, `skills/execute/SKILL.md:575`, and `skills/review/SKILL.md:643` have `"cycle":null` added between the `"phase"` and `"agent_type"` fields?
- **Source**: Code-quality M1 (cycle 007)
- **Impact**: After WI-100, `refine` is fixed but the other three are not, creating internal inconsistency among skill files. Agent spawns from these three skills emit log events with no `cycle` field, sorting into an undefined bucket in downstream analysis.
- **Who answers**: Technical — one-line fix per file, no design decision required. Bundle into next documentation pass.
- **Consequence of inaction**: Internal inconsistency among skill files grows more visible as the schema stabilizes. Report bucketing silently mishandles events from plan, execute, and review.

### OQ2: report.sh Quality Trends empty-state message names only /ideate:review
- **Question**: Should `scripts/report.sh:365` empty-state message be updated to name both `/ideate:review` and `/ideate:brrr`?
- **Source**: Gap-analysis II1 (cycle 007)
- **Impact**: Users running brrr-only projects who encounter an empty Quality Trends section receive incorrect guidance directing them to run `/ideate:review` rather than waiting for the next brrr cycle. Applies only to the zero-data transient state.
- **Who answers**: Technical — one-line text change, bundle into next documentation pass.

### OQ3: No documented rationale for quality_summary being review-phase-only
- **Question**: Should `specs/artifact-conventions.md` include a sentence noting that `quality_summary` is emitted only by review-phase orchestrators and explaining why?
- **Source**: Gap-analysis IR1 (cycle 007)
- **Impact**: A future maintainer has no written guidance on this scoping decision. Risk of incorrectly emitting or omitting quality_summary in a new phase.
- **Who answers**: Technical — one sentence addition, bundle into next documentation pass.

---

## Cross-References

### CR1: Partial "cycle" field fix creates new internal inconsistency
- **Code review**: M1 — three skill files missing `"cycle"` field after WI-100 fixed only `refine`
- **Spec review**: No finding — verified WI-100 against its stated acceptance criteria (refine only)
- **Gap analysis**: No finding — did not examine the other skill files
- **Connection**: WI-100's scope listed only `skills/refine/SKILL.md` for the `"cycle"` field fix. The code-quality reviewer identified that the same fix is needed in three other skill files outside that scope. The result: before WI-100 all four skills were consistently missing `"cycle"`; after WI-100 they are inconsistently split. No single reviewer was positioned to catch this in full — the code-quality reviewer identified it by looking beyond the work item's stated scope, which is the intended value of a capstone review. OQ1 tracks the resolution.
