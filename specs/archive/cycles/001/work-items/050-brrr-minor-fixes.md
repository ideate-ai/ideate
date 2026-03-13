# Work Item 050: brrr Skill Minor Fixes

## Objective

Apply two minor fixes to `skills/brrr/SKILL.md` identified in the capstone review: (1) add `working_dir` to the principles-checker spawn call in Phase 6c, which currently omits it; (2) add a cap on new work items per refinement phase in Phase 6d to prevent unbounded work item growth that would cause divergence rather than convergence.

## Acceptance Criteria

1. Phase 6c principles-checker spawn call includes `working_dir: {project_source_root}` as an explicit parameter
2. Phase 6d refinement instructions include a stated limit on new work items per cycle: one work item per distinct finding group, not one per finding instance
3. Phase 6d instructions state that if the total pending work item count is growing cycle-over-cycle (not shrinking toward convergence), the brrr skill should route this as an Andon event rather than continuing to queue items
4. No other content in `skills/brrr/SKILL.md` is modified by this work item

## File Scope

- modify: `skills/brrr/SKILL.md`

## Dependencies

- 042 (WI-042 also modifies SKILL.md; WI-050 must run after to avoid conflicts)

## Implementation Notes

**Phase 6c fix**: Locate the principles-checker spawn section. Find where `spawn_session` parameters are listed. Add `working_dir: {project_source_root}` to the parameter list alongside the existing parameters (prompt, role/model, etc.).

**Phase 6d cap**: Locate the refinement phase instructions where new work items are created per finding. After the instruction to create a work item per finding, add:

> **Work item cap**: Create one work item per distinct finding group (e.g., one for all role-system findings, one for all README schema findings), not one per individual finding instance. If the total pending work item count after this phase is greater than or equal to the pending count at the start of this cycle, route a divergence Andon event: "brrr cycle is not converging — pending work items are not decreasing. Current: {N}. Previous: {M}. Stopping autonomous loop."

## Complexity

Low
