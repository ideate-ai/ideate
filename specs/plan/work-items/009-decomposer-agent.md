# 009: Decomposer Agent

## Objective
Define the decomposer agent — a specialized agent for breaking modules into work items. Used during multi-pass progressive decomposition when the plan skill delegates module-level decomposition to parallel subagents.

## Acceptance Criteria
- [ ] `agents/decomposer.md` exists with valid frontmatter
- [ ] Agent has access to: Read, Grep, Glob
- [ ] Agent receives: module spec, architecture doc, guiding principles, constraints, and any relevant research
- [ ] Agent produces work items in the standard format: objective, acceptance criteria, file scope, dependencies, implementation notes, complexity
- [ ] Work items have machine-verifiable acceptance criteria where possible
- [ ] Work items have non-overlapping file scope
- [ ] Work items collectively cover 100% of the module's scope (explicit coverage statement)
- [ ] Agent respects the module's interface contracts — work items implement the defined Provides and use the defined Requires
- [ ] Agent identifies dependencies between work items within the module and to work items in other modules
- [ ] Output is structured markdown that the plan skill can parse and write to work-items/

## File Scope
- `agents/decomposer.md` (create)

## Dependencies
- Depends on: 001
- Blocks: 005

## Implementation Notes
The decomposer exists to enable parallel module decomposition. When a project has 5+ modules, the plan skill can spawn one decomposer per module to work in parallel, rather than decomposing each module sequentially in the main session.

Model should be `opus` — decomposition requires understanding the full module scope and making design decisions about file structure, function boundaries, and task ordering. MaxTurns: 25.

The decomposer must understand the spec sufficiency heuristic: each work item should be detailed enough that two independent LLMs would produce functionally equivalent output. Ambiguous terms should be operationalized. Subjective criteria should be converted to concrete checks.

The decomposer should flag when a module is too small to decompose (single work item is sufficient) or too large (should be further subdivided into sub-modules).

Cross-module dependencies are the critical challenge. The decomposer must explicitly declare which work items in its module depend on work items in other modules (by referencing the interface contracts). The plan skill reconciles these cross-module dependencies when assembling the final work item set.

## Complexity
Medium
