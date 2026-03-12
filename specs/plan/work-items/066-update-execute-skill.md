# 066: Update execute skill for archive paths

## Objective
Update `skills/execute/SKILL.md` to write incremental reviews to `archive/incremental/` and to optionally supply relevant domain policies to workers.

## Acceptance Criteria
- [ ] All references to `reviews/incremental/` updated to `archive/incremental/`
- [ ] Completed Items Scan reads from `archive/incremental/*.md`
- [ ] Phase 7 writes review result to `archive/incremental/NNN-{name}.md`
- [ ] Partial execution resume detection references `archive/incremental/`
- [ ] "What You Do Not Do" section references `archive/incremental/`
- [ ] Context for Every Worker includes item 8: relevant domain policies from `domains/{name}/policies.md` (optional, based on file scope → domain mapping)

## File Scope
- `skills/execute/SKILL.md` (modify)

## Dependencies
- Depends on: none
- Blocks: 071

## Complexity
Low
