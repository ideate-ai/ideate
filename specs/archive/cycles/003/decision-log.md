# Decision Log — Cycle 003

**Brrr run**: WI-102 through WI-112 (Cycles 1–3 of the Cycle A quality/structural-risk brrr run)
**This cycle scope**: WI-111 and WI-112 (brrr Cycle 3)
**Date**: 2026-03-22

---

## Planning Phase

### D1: Cycle A (quality + structural risks) separated from Cycle B (token efficiency)
- **When**: refine-008 interview, 2026-03-21
- **Decision**: All 5 quality improvements and 3 structural risks (WI-102–108) addressed in one brrr run. Token efficiency improvements deferred to a separate Cycle B.
- **Rationale**: Splitting avoids regressions and keeps each cycle's scope bounded.
- **Implications**: Cycle B token efficiency work remains unscheduled.

### D2: Andon behavior made mode-relative
- **When**: refine-008 interview, 2026-03-21
- **Decision**: In brrr, proxy-human deferrals are logged visibly without interrupting the loop. In standalone execute, the existing interrupt-and-ask behavior is unchanged.
- **Rationale**: brrr is designed for autonomy; interrupting for deferrals contradicts the autonomous loop design.
- **Implications**: WI-105 implements the mode-relative rule in `skills/brrr/phases/execute.md`.

### D3: Domain-curator to use RAG semantic search before writing new policies
- **When**: refine-008 interview, 2026-03-21
- **Decision**: Domain-curator uses MCP semantic search to detect near-duplicate policies before writing new entries to the domain layer.
- **Implications**: WI-103 adds deferred-gap tagging to domain-curator and gap-analyst.

### D4: WI-111 and WI-112 created from Cycle 2 review findings (Q-14 and Q-15 escalated)
- **When**: brrr Cycle 2 refinement, 2026-03-22
- **Decision**: Q-14 (missing quality_summary in brrr review phase) and Q-15 (stale `reviews/incremental/` path) escalated from open questions to work items.
- **Rationale**: Both gaps had persisted through multiple cycles. A third deferral was not acceptable.

---

## Execution Phase

### D5: WI-111 confirmed as no-op — Q-15 already resolved
- **When**: Execution — WI-111, 2026-03-22
- **Decision**: Worker found all three agent files already used `archive/incremental/`. No changes made. WI-111 Pass, zero findings.
- **Implications**: Q-15 is closed.

### D6: WI-112 rework — `skill` field set to `"review"` instead of `"brrr"` for schema parity
- **When**: Execution — WI-112 rework, 2026-03-22
- **Decision**: The quality_summary event emitted by `skills/brrr/phases/review.md` uses `"skill":"review"` rather than `"skill":"brrr"`.
- **Rationale**: Documented in `archive/incremental/112-brrr-review-quality-summary.md` as "for schema parity" with `skills/review/SKILL.md`.
- **Alternatives considered**: Using `"skill":"brrr"` as specified by `artifact-conventions.md:735`.
- **Implications**: This decision contradicts `artifact-conventions.md:735`. Gap-analyst flagged as significant finding II1. Q-14 remains open. See CR1.

---

## Review Phase

### D7: Cycle 003 not converged — one significant gap finding
- **When**: Cycle 003 capstone review, 2026-03-22
- **Decision**: Two minor findings (M1, M2 in code-quality.md) and one significant gap (II1 in gap-analysis.md) carried forward. Condition A fails (significant_count=1). Cycle 4 will execute a fix work item.

---

## Open Questions

### OQ1: quality_summary `skill` field value contradicts canonical spec
- **Question**: `skills/brrr/phases/review.md:235` emits `"skill":"review"` but `specs/artifact-conventions.md:735` specifies brrr-driven events must use `"skill":"brrr"`.
- **Source**: gap-analysis.md II1 (cycle 003)
- **Impact**: `scripts/report.sh` quality trend attribution is silently wrong for any project mixing brrr and standalone review runs.
- **Who answers**: Technical — one-word fix at `skills/brrr/phases/review.md:235`. No design decision required.

### OQ2: `### Suggestion` heading pattern has no producer in code-reviewer output format
- **Question**: `skills/brrr/phases/review.md:212,216` counts `### Suggestion` headings, but `agents/code-reviewer.md` defines only `### C`, `### S`, `### M`. Should suggestion be hardcoded to 0, or should a `## Suggestions` section be added to the code-reviewer format?
- **Source**: code-quality.md M1 (cycle 003)
- **Impact**: `by_reviewer.code-reviewer.suggestion` is structurally impossible to be non-zero.

### OQ3: `review-manifest.md` ends up in different locations for brrr vs standalone review
- **Question**: brrr writes the manifest to `archive/incremental/review-manifest.md`; standalone review writes to `archive/cycles/{N}/review-manifest.md`. brrr cycle directories are not self-contained.
- **Source**: code-quality.md M2 (cycle 003)
- **Who answers**: Technical — either copy the manifest to the cycle directory, or document the difference explicitly.

---

## Carry-Forward Open Questions

- **Q-3** (spawn_session as primary path in plan/execute/review): `specs/domains/workflow/questions.md`
- **Q-6** (proxy-human confidence level case inconsistency): `specs/domains/agent-system/questions.md`
- **Q-7** (brrr fallback entry heading format for proxy-human-log.md): `specs/domains/agent-system/questions.md`
- **Q-8** (no sub-subagents — recursive decomposition requires external tooling): `specs/domains/agent-system/questions.md`
- **Q-13** (schema version 1 structural invariants not defined): `specs/domains/artifact-structure/questions.md`
- **Q-16** (findings.by_reviewer.suggestion has no consumer): `specs/domains/artifact-structure/questions.md`
- **Q-17** (skills/refine/SKILL.md inline metrics schema omits the cycle field): `specs/domains/artifact-structure/questions.md`
- **Q-18** (report.sh absent from README.md and plugin manifests): `specs/domains/artifact-structure/questions.md`

---

## Cross-References

### CR1: Q-14 status — partially resolved, re-opened as OQ1
- WI-112 incremental review returned Pass with zero findings — did not flag the `skill` field contradiction.
- Capstone gap-analyst caught it as II1 (significant).
- Fix required: replace `"review"` with `"brrr"` at `skills/brrr/phases/review.md:235`. Q-14 remains open until verified.

### CR2: Q-15 status — confirmed resolved by WI-111 no-op
- All three WI-111 acceptance criteria satisfied. Files already used correct path.
- Q-15 closed.

### CR3: Suggestion count derivation — OQ2 and pre-existing Q-16
- OQ2: missing producer (code-reviewer cannot emit `### Suggestion` headings per its output format).
- Q-16: missing consumer (no downstream tool reads `by_reviewer.suggestion`).
- Together these suggest the suggestion sub-field in `by_reviewer` may be vestigial — added for schema symmetry but neither reliably produced nor consumed.
