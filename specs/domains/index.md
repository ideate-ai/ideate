# Domain Registry

current_cycle: 15

## Domains

### workflow
The five-skill SDLC lifecycle (plan, execute, review, refine, brrr), phase sequencing, Andon cord interaction model, continuous review architecture, and brrr convergence loop.
Files: domains/workflow/policies.md, decisions.md, questions.md

### artifact-structure
The artifact directory contract: what files exist, their paths, formats, read/write phase permissions, naming conventions, append-only semantics, and the module spec layer.
Files: domains/artifact-structure/policies.md, decisions.md, questions.md

### agent-system
All eight ideate agents (researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, proxy-human), their responsibility boundaries, tool grants, model defaults, invocation patterns, and output contracts.
Files: domains/agent-system/policies.md, decisions.md, questions.md

### project-boundaries
The ideate/outpost architectural separation, what belongs in each project, env var naming conventions, plugin manifest identity, and spec co-location rules.
Files: domains/project-boundaries/policies.md, decisions.md, questions.md

## Cross-Cutting Concerns

**brrr correctness**: Three open questions (Q-1, Q-2, Q-7) and one artifact question (Q-6) collectively describe a cluster of defects that prevent brrr from functioning correctly on a standard ideate installation (no outpost). All four should be addressed together in the next refinement cycle.

**Duplicate work item numbers**: Q-4 (artifact-structure) is a latent defect that affects workflow execution (Q-4 cross-references the execute and brrr skills). Any future `/ideate:execute` or `/ideate:brrr` run encounters ambiguous ordering for five number prefixes.

**brrr review phase architectural gap (cycle 006)**: Q-14 (workflow) and Q-15 (agent-system) were the two highest-priority open questions from cycle 006. Q-15 was resolved in cycle 003 (paths already correct). Q-14 is now resolved in cycle 004: WI-112 added the quality_summary emission block; WI-113 fixed the `skill` field value from `"review"` to `"brrr"` (D-27). Both the structural gap and the field value contradiction are closed.

**metrics.jsonl documentation cluster**: Q-16, Q-17, Q-18 (artifact-structure) are lower-priority carry-forward items from cycle 006 that can be bundled into a single documentation work item alongside structural fixes. D-30 (cycle 004) adds a significant gap: metrics.jsonl itself is absent from artifact-conventions.md. WI-115 addresses D-30; Q-16/Q-17/Q-18 remain open. Cycle 005 adds Q-22 (heading level) and Q-23 (placeholder convention) — both are single-line documentation fixes that belong in the same bundle.

**Suggestion field vestigial cluster (cycle 003)**: Q-19 (agent-system, no producer) and Q-16 (artifact-structure, no consumer) together indicate the `suggestion` sub-field in `by_reviewer` may be vestigial — added for schema symmetry but neither reliably produced nor consumed. These should be evaluated together.

**brrr vs standalone review divergence**: Q-20 (artifact-structure, review-manifest location) and D-19/P-18 (workflow, independent reimplementation) reflect ongoing divergence between the two review paths. Cycle 013 adds Q-36 (agent-system, domain-curator model selection) — brrr unconditionally uses opus while standalone review conditionally selects sonnet/opus. Any future work that touches review orchestration should audit both paths.

**Cross-item spec consistency (cycle 004)**: D-28 and D-29 (artifact-structure) document two bugs caused by independently-planned work items (WI-093 and WI-094) that shared a data contract but described it inconsistently. P-21 (workflow) codifies the mitigation: consumer planning notes must cite the producer's schema definition by file and section.

**Stale agent path references (cycle 005 reopened)**: Q-15 (agent-system) was marked resolved in cycle 003 but cycle 005 code-quality and gap-analysis independently confirmed the stale `reviews/incremental/` paths persist in `agents/spec-reviewer.md` and `agents/gap-analyst.md`. Q-15 is reopened. This should be bundled with Q-22 and Q-23 in the next documentation-fix work item.

**Startup failure protocol consistency (cycles 007-012)**: The startup-failure protocol is fully described in P-22 (amended through cycle 011). The context-appropriate smoke test generalization (D-44/WI-126) extended P-22 to cover library, CLI, e2e, and documentation-only projects. The infrastructure-failure regression-determination protocol is captured in P-23 (D-45/WI-128). Cycle 012 closed the two remaining follow-ups: Q-33 (inline prompt fragments updated by WI-129) and Q-34 (brrr label qualifier added by WI-129). The smoke test generalization is now complete across all locations.

**Smoke test inline prompt inconsistency (cycle 011)**: Resolved in cycle 012. Q-33 and Q-34 both closed by WI-129 (D-48). All inline prompts and labels now use language consistent with the generalized agent definition.

**Model configuration and tier aliases (cycle 013)**: D-49 (project-boundaries) established that custom model configuration belongs in Claude Code env vars, not ideate. D-50 (agent-system) replaced hardcoded model IDs with tier aliases to make env var overrides work. Three open questions remain: Q-35 (README table conflation), Q-36 (brrr unconditional opus), Q-37 (missing CLAUDE_CODE_SUBAGENT_MODEL documentation).
