# Decision Log — Cycle 002

## D1: Interface contracts cap exemption applied to standalone execute
**Decision**: WI-109 applied the interface contracts cap exemption from brrr/phases/execute.md to standalone execute/SKILL.md Phase 4.5.
**Rationale**: The cycle 001 review (S1) identified that WI-105 fixed brrr but left standalone execute with a truncation risk. Feature parity between brrr-driven and standalone execution is expected.
**Alternatives rejected**: Treating the asymmetry as intentional (rejected — both paths serve the same purpose and should behave consistently).
**Source**: WI-109, cycle 001 code-quality.md S1.

## D2: MaxTurns corrected to match agent file, not estimated value
**Decision**: WI-110 set architecture.md domain-curator MaxTurns: 25, matching agents/domain-curator.md frontmatter, rather than retaining the 30 that WI-108 estimated.
**Rationale**: The agent definition file is authoritative for runtime configuration. Architecture.md documents what exists; it should not invent different values.
**Alternatives rejected**: Updating domain-curator.md to 30 instead (rejected — no basis for 30; 25 is what the agent actually runs with).
**Source**: WI-110, cycle 001 spec-adherence.md D1.

## D3: Q-14 and Q-15 re-raised as significant — address in cycle 003
**Decision**: The gap-analyst re-raised Q-14 (brrr/phases/review.md missing quality_summary) and Q-15 (stale reviews/incremental/ path in three agent definitions) as significant findings after they persisted open since cycle 006 with no assigned work items.
**Rationale**: Both gaps silently degrade output quality on every review cycle. The compounding effect justifies escalation from "open question" to "significant finding requiring work item."
**Alternatives rejected**: Deferring again (rejected — both have been open since cycle 006 across multiple brrr runs).
**Source**: Cycle 002 gap-analysis.md II1, MI1.
