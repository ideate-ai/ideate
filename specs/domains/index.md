# Domain Registry

current_cycle: 6

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

**brrr review phase architectural gap (cycle 006)**: Q-14 (workflow) and Q-15 (agent-system) are the two highest-priority open questions from cycle 006. Q-14 is the missing quality_summary emission in brrr/phases/review.md; Q-15 is the stale `reviews/incremental/` path in three agent definitions. Both should be addressed in the next refinement cycle as their first two work items (non-overlapping file scopes; can run in parallel).

**metrics.jsonl documentation cluster**: Q-16, Q-17, Q-18 (artifact-structure) are lower-priority carry-forward items from cycle 006 that can be bundled into a single documentation work item alongside the two structural fixes above.
