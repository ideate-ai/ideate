# Spec Adherence Review — Cycle 001

**Scope**: WI-102 through WI-108 — quality and structural risk improvements.

## Verdict: Fail

One architecture deviation: `specs/plan/architecture.md` WI-108 added a domain-curator row specifying `MaxTurns: 30`, but the agent file (`agents/domain-curator.md`) and the brrr review phase spawn both use `maxTurns: 25`. The architecture document introduced by this cycle is inconsistent with the agent and skill that implement it.

## Architecture Deviations

### D1: domain-curator MaxTurns inconsistency between architecture.md and agent file
- **Expected**: `specs/plan/architecture.md` (added by WI-108): domain-curator row specifies `MaxTurns: 30`
- **Actual**: `agents/domain-curator.md:10`: `maxTurns: 25`; `skills/brrr/phases/review.md:189`: `MaxTurns: 25`
- **Evidence**: `specs/plan/architecture.md` → domain-curator row contains `MaxTurns: 30`. `agents/domain-curator.md` line 10 says `maxTurns: 25`. `skills/brrr/phases/review.md` line 189 spawns domain-curator with `MaxTurns: 25`.
- **Assessment**: WI-108 introduced this inconsistency when writing the new domain-curator definition block. The value 30 was estimated rather than confirmed from the agent file. The authoritative value is the agent file (25). The architecture.md row should say `MaxTurns: 25`.

## Unmet Acceptance Criteria

None. All per-work-item acceptance criteria verified via incremental reviews (all 7 items pass). D1 is a documentation inconsistency introduced during WI-108 execution.

## Principle Violations

**Principle Violation Verdict**: Pass

None.

The MaxTurns inconsistency (D1) is a documentation error, not a principle violation. No guiding principle is contradicted.

## Principle Adherence Evidence

- **P1 (Spec Sufficiency)**: WI-102 ensures the verdict line instruction is unambiguous prose outside the template — two LLM runs will produce the same verdict line format. P1 strengthened.
- **P2 (Minimal Inference at Execution)**: WI-103 eliminates ambiguity for gap-analyst re: deferred gaps — the agent can now follow the token match mechanically. WI-107 eliminates "load all incremental reviews" decision.
- **P4 (Parallel-First Design)**: All 7 work items had non-overlapping file scope, executed in parallel. Confirmed via incremental reviews.
- **P5 (Continuous Review)**: All 7 items have incremental reviews. Five items required rework; rework was reviewed before comprehensive review ran.
- **P6 (Andon Cord)**: No Andon events in this cycle. All items resolvable from specs.
- **P8 (Durable Knowledge Capture)**: WI-104 ensures domain-curator runs in brrr cycles, not just standalone review. The domains/ layer is now maintained across all review paths.
- **P11 (Honest and Critical Tone)**: Rework reviews stated defects directly and precisely. No softening.

## Undocumented Additions

None. All changes documented by work items in `plan/work-items.yaml` and `plan/notes/`.

## Naming/Pattern Inconsistencies

None.
