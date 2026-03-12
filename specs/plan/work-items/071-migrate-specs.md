# 071: Migrate specs/ to new archive + domain structure

## Objective
Run the migration on ideate's own `specs/` directory so that ideate uses its own new architecture. This is Track B — the moment ideate dogfoods its own domain knowledge layer.

## Acceptance Criteria
- [ ] `specs/archive/incremental/` exists and contains all files from `specs/reviews/incremental/`
- [ ] `specs/archive/cycles/001/` exists and contains all files from `specs/reviews/final/`
- [ ] `specs/domains/` exists with 2-4 domains, each having policies.md, decisions.md, questions.md
- [ ] `specs/domains/index.md` exists with `current_cycle: 1` and domain registry
- [ ] `specs/steering/interviews/legacy.md` exists (former interview.md)
- [ ] `specs/reviews/` original directory preserved (not deleted)

## File Scope
- `specs/archive/incremental/` (create — copy of reviews/incremental/)
- `specs/archive/cycles/001/` (create — copy of reviews/final/)
- `specs/domains/` (create — bootstrapped by domain-curator agent)
- `specs/steering/interviews/legacy.md` (create — moved from steering/interview.md)

## Dependencies
- Depends on: 063, 064, 066, 067, 068, 069
- Blocks: none

## Implementation Notes
The `claude -p` step in the migration script cannot run inside an active Claude Code session. The domain bootstrap must be done by spawning the domain-curator agent directly from within the session.

## Complexity
Low
