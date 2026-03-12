# 069: Update refine skill for domain context loading

## Objective
Update `skills/refine/SKILL.md` to load domain policies and questions as the primary context for current project state, replacing the full load of all incremental reviews.

## Acceptance Criteria
- [ ] Phase 3 item 10 updated to note optional existence of journal.md
- [ ] Phase 3 section 3.1 added: domain layer loading (domains/index.md, domains/*/policies.md, domains/*/questions.md, archive/cycles/{N}/summary.md) when domains/ exists; explicitly skips incremental reviews
- [ ] Phase 3 section 3.2 added: legacy fallback (reviews/final/*.md and reviews/incremental/*.md) for pre-domain artifact directories
- [ ] Phase 7a updated: when steering/interviews/ exists, write to steering/interviews/refine-{cycle_number}/ with per-domain files and _general.md and _full.md; otherwise append to steering/interview.md

## File Scope
- `skills/refine/SKILL.md` (modify)

## Dependencies
- Depends on: none
- Blocks: 071

## Complexity
Low
