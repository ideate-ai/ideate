# 019: Review Skill — Journal-Keeper Timing Fix

## Objective
Fix the journal-keeper timing issue so cross-references between reviewers work reliably.

## Acceptance Criteria
- [ ] The review skill spawns the journal-keeper AFTER the other three reviewers (code-reviewer, spec-reviewer, gap-analyst) complete — not in parallel with them
- [ ] Phase 3 is restructured: first spawn three reviewers in parallel, then after all three complete, spawn journal-keeper with access to all three final review files
- [ ] The journal-keeper prompt includes the paths to the completed review files and instructs it to read them for cross-referencing
- [ ] Phase 4 is updated to reflect the two-stage collection: first three reviewers, then journal-keeper

## File Scope
- `skills/review/SKILL.md` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
Restructure Phase 3 into two sub-phases:

**Phase 3a: Spawn Three Reviewers (parallel)**
- code-reviewer
- spec-reviewer
- gap-analyst

Wait for all three to complete. Write their outputs to `reviews/final/`.

**Phase 3b: Spawn Journal-Keeper (sequential)**
- journal-keeper receives all context it had before PLUS the three completed review files
- The prompt explicitly references `reviews/final/code-quality.md`, `reviews/final/spec-adherence.md`, `reviews/final/gap-analysis.md`

Update Phase 4 to reflect that three files are written first, then the fourth. The synthesis (Phase 5) still waits for all four.

## Complexity
Low
