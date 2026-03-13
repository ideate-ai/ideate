# 006: Refine Skill

## Objective
Define the `/ideate:refine` skill — plans changes to an existing codebase, whether from review findings, new requirements, or evolving user understanding.

## Acceptance Criteria
- [ ] `skills/refine/SKILL.md` exists with valid frontmatter (description, user-invocable: true, argument-hint)
- [ ] Skill locates existing artifact directory or asks for one
- [ ] Spawns `architect` agent to survey the existing codebase before interviewing
- [ ] Loads all prior context: guiding principles, constraints, overview, architecture, journal, review findings
- [ ] Interview adapted for refinement: focuses on what's changing and why
- [ ] If prior guiding principles exist, confirms whether they still hold
- [ ] If review findings exist, walks through critical/significant ones — asks which to address now vs defer
- [ ] Does not re-ask questions answered by existing artifacts
- [ ] Spawns `researcher` agents for new topics
- [ ] Updates (not replaces) guiding principles — notes what changed, when, and why
- [ ] Deprecated principles marked with rationale, not silently deleted
- [ ] New work items numbered continuing from highest existing number
- [ ] Work items reference existing files to modify (not create-from-scratch)
- [ ] overview.md becomes a change plan, not a full project plan
- [ ] architecture.md updated only if architecture changes
- [ ] Journal appended with refinement entry
- [ ] Handles both correction scenarios (review found bugs) and evolution scenarios (user changed their mind)

## File Scope
- `skills/refine/SKILL.md` (create)

## Dependencies
- Depends on: 001, 002, 003
- Blocks: 007

## Implementation Notes
Refine is the iterative counterpart to plan. It serves double duty:

1. **Post-review corrections**: Review found issues → refine plans fixes → execute fixes → review again
2. **Requirement evolution**: User sees the output and realizes they want something different → refine captures the new intent → new work items

The skill should be smart about what to re-plan. If the user says "the auth module needs to support OAuth in addition to password auth," the skill should only create new work items for the OAuth addition — not re-plan the entire auth module.

Interview rules specific to refine:
- Use the architect's codebase analysis to inform questions. Don't ask about technology choices the code already makes.
- For review-driven refinements, present the findings and ask the user to prioritize rather than going through the full three-track interview.
- For requirement-evolution refinements, focus the intent track on what changed and why, then assess design/process impacts.

## Complexity
High
