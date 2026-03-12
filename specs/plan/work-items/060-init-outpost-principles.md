# Work Item 060: Initialize Outpost Principles and Constraints

## Objective

Run /ideate:plan for the outpost project to generate its own guiding principles, constraints, architecture, and initial work items. Outpost needs its own decision framework separate from ideate.

## Acceptance Criteria

1. `~/code/outpost/specs/steering/guiding-principles.md` exists with outpost-specific principles
2. `~/code/outpost/specs/steering/constraints.md` exists with outpost-specific constraints
3. `~/code/outpost/specs/steering/interview.md` exists with the planning interview
4. `~/code/outpost/specs/plan/overview.md` exists with outpost project description
5. `~/code/outpost/specs/plan/architecture.md` exists with outpost component map
6. `~/code/outpost/specs/plan/execution-strategy.md` exists
7. `~/code/outpost/specs/plan/work-items/` exists with initial work items (if any)
8. Principles and constraints are specific to outpost's scope (MCP orchestration, session management, remote dispatch) and do not duplicate ideate's SDLC principles

## File Scope

- create: `~/code/outpost/specs/steering/guiding-principles.md`
- create: `~/code/outpost/specs/steering/constraints.md`
- create: `~/code/outpost/specs/steering/interview.md`
- create: `~/code/outpost/specs/plan/overview.md`
- create: `~/code/outpost/specs/plan/architecture.md`
- create: `~/code/outpost/specs/plan/execution-strategy.md`
- create: `~/code/outpost/specs/plan/work-items/` (directory)

## Dependencies

- 052 (outpost project structure must exist)
- 053, 054, 055, 056 (code must be in outpost for architecture to reflect reality)

## Implementation Notes

Run `/ideate:plan ~/code/outpost/specs` as a separate session after the code is in place. The planning interview should focus on:
- Outpost's purpose: MCP orchestration layer for delegating work to Claude Code instances
- Key principles: reliability, transparency, configurability (local vs remote)
- Constraints: MCP protocol compatibility, session isolation, resource management

This work item is a placeholder — the actual planning is interactive and may spawn additional work items.

## Complexity

Medium (requires interactive planning session)