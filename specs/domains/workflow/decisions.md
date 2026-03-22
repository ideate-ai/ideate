# Decisions: Workflow

## D-1: Five-skill SDLC structure (plan / execute / review / refine / brrr)
- **Decision**: Ideate exposes five user-invocable skills covering the full lifecycle from idea to convergence; brrr is the autonomous loop mode added in cycle 1.
- **Rationale**: The interview established that the tool should take a project from spec creation to user-testable output; brrr was added to provide a fully autonomous mode where the user can step away (interview 2026-03-10).
- **Assumes**: Claude Code plugin format supports five skill definitions; skills invoke agents but do not call each other as sub-commands.
- **Source**: plan/architecture.md §3, specs/plan/work-items/037-brrr-skill.md
- **Status**: settled

## D-2: brrr convergence requires zero critical/significant findings AND zero guiding-principle violations simultaneously
- **Decision**: A brrr cycle is declared converged only when the review produces zero critical and zero significant findings and a focused spec-reviewer pass returns "No violations found" for all guiding principles.
- **Rationale**: The user specified "zero violations — it needs to be perfect" during the 2026-03-10 interview; minor findings are explicitly acceptable.
- **Assumes**: The principles-checker spec-reviewer is invoked with a narrow, well-defined prompt (not the full review scope).
- **Source**: specs/plan/work-items/037-brrr-skill.md AC7, specs/steering/interview.md (2026-03-10)
- **Status**: settled

## D-3: Refine appends/updates steering docs — it never silently deletes
- **Decision**: The refine skill appends new content or marks deprecated content; guiding principles are never silently removed; existing entries are never deleted without an explicit deprecation record.
- **Rationale**: Durable knowledge capture (GP-8) requires the artifact directory to be the authoritative record; silent deletion breaks traceability across refinement cycles.
- **Source**: plan/architecture.md §8 (steering/guiding-principles.md semantics), specs/plan/work-items/011-artifact-conventions.md
- **Status**: settled

## D-4: brrr proxy-human Andon path uses native Agent tool, not spawn_session
- **Decision**: brrr Phase 6a invokes proxy-human via the Agent tool with `subagent_type: "proxy-human"` rather than the outpost spawn_session MCP tool; a fallback is documented for environments where the Agent tool is unavailable.
- **Rationale**: After the ideate/outpost split, ideate does not ship session-spawner; the Agent tool is always available in Claude Code and eliminates the MCP dependency for a core SDLC operation (archive/cycles/001/decision-log.md D2).
- **Source**: archive/cycles/001/decision-log.md D2, specs/plan/work-items/057-update-brrr-proxy-human-invocation.md
- **Status**: settled

## D-19: brrr/phases/review.md is an independent reimplementation of review orchestration, not a delegate
- **Decision**: `skills/brrr/phases/review.md` reimplements review orchestration in full; it does not delegate to `skills/review/SKILL.md`. Any feature added to the standalone review skill that should also apply in brrr-driven cycles must be added to both files independently.
- **Rationale**: Cycle 006 gap analysis identified that the quality_summary emission (WI-093) was added only to `skills/review/SKILL.md`. Because brrr does not delegate, brrr-driven projects never emit quality_summary events and the Quality Trends section of report.sh is permanently empty for them. The planning phase did not identify brrr/phases/review.md as a required target.
- **Assumes**: This architectural separation is intentional and will not be unified into a shared review orchestration layer.
- **Source**: archive/cycles/006/decision-log.md D3, D4; archive/cycles/006/gap-analysis.md SG1
- **Policy**: P-18
- **Status**: settled
