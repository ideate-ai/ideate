# Gap Analysis — Cycle 002

**Scope**: WI-109 and WI-110 — final check before potential convergence for brrr run WI-102–110.

## Pre-Analysis: Known-Deferred Gaps

Loaded from `specs/domains/*/questions.md`. Checked all open questions against changed files (`skills/execute/SKILL.md`, `specs/plan/architecture.md`). No deferred gaps. Q-3, Q-4, Q-6, Q-7, Q-8, Q-13, Q-16, Q-17, Q-18 have no new evidence from this cycle's changed files — skipping. Q-14 and Q-15 are open (not deferred) and re-raised below as significant findings because they have been open since cycle 006 with no assigned work items.

## Missing Requirements from Interview

None.

All items from the refine-004 interview were addressed in WI-088 through WI-110. No interview requirement is unaddressed.

## Unhandled Edge Cases

None.

Both WI-109 and WI-110 are documentation-only fixes with no new runtime logic.

## Incomplete Integrations

### II1: Three agent definitions still reference stale `reviews/incremental/` path
- **Interface**: Incremental review context loading by capstone review agents
- **Producer**: `specs/archive/incremental/` (written by execute and brrr)
- **Consumer**: `agents/spec-reviewer.md:26`, `agents/gap-analyst.md:24`, `agents/journal-keeper.md:20`
- **Gap**: All three agent definitions direct the agent to read prior incremental reviews from `reviews/incremental/` — a path that has not existed since the archive migration. The correct path is `archive/incremental/`. This is Q-15 in the agent-system domain. The gap persists unchanged through this cycle.
- **Severity**: Significant — spec-reviewer deduplication and journal-keeper synthesis both depend on incremental review context. Every review cycle silently skips that context. The degradation compounds with each cycle.
- **Recommendation**: Fix in next cycle. Three one-line changes. Bundle with MI1 into a single work item or parallelize.

## Missing Infrastructure

### MI1: `skills/brrr/phases/review.md` does not emit quality_summary events
- **Category**: Observability/metrics
- **Gap**: `skills/review/SKILL.md` emits a `quality_summary` event to `metrics.jsonl` after each review cycle (added in WI-093). `skills/brrr/phases/review.md` is an independent reimplementation and was never updated. No quality_summary events are written for brrr-driven projects. The Quality Trends section of `scripts/report.sh` is permanently empty for brrr projects. This is Q-14 in the workflow domain, open since cycle 006.
- **Impact**: The observability feature from WI-093/WI-094 is non-functional for the primary execution path.
- **Severity**: Significant — the reporting tool's quality trends view is always empty for brrr projects.
- **Recommendation**: Fix in next cycle. Insertion point: after the journal-keeper step in `skills/brrr/phases/review.md`, using `last_cycle_findings` already in scope.

## Implicit Requirements

### IR1: spawn_session listed as primary path in plan and review skills (Q-3)
- **Gap**: `/ideate:plan` and `/ideate:review` present spawn_session as primary and Agent tool as fallback. Users without outpost see tool-not-found noise.
- **Severity**: Minor — runtime behavior is correct after fallback.
- **Recommendation**: Defer. Bundle into a documentation cleanup work item alongside Q-17 and Q-18.
