# 028: Agent Background Field

## Objective
Add `background: false` to the YAML frontmatter of all agent definition files that are not background agents, making the intent explicit and consistent with `researcher.md` which already declares `background: true`.

## Acceptance Criteria
- [ ] `agents/architect.md` frontmatter contains `background: false`
- [ ] `agents/code-reviewer.md` frontmatter contains `background: false`
- [ ] `agents/spec-reviewer.md` frontmatter contains `background: false`
- [ ] `agents/gap-analyst.md` frontmatter contains `background: false`
- [ ] `agents/journal-keeper.md` frontmatter contains `background: false`
- [ ] `agents/decomposer.md` frontmatter contains `background: false`
- [ ] `agents/researcher.md` is not modified (it already has `background: true`)
- [ ] No agent body content (description, model, tools, maxTurns, instructions) is modified

## File Scope
- `agents/architect.md` (modify)
- `agents/code-reviewer.md` (modify)
- `agents/spec-reviewer.md` (modify)
- `agents/gap-analyst.md` (modify)
- `agents/journal-keeper.md` (modify)
- `agents/decomposer.md` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes

For each agent file, add `background: false` to the YAML frontmatter block (between the `---` delimiters), after the `maxTurns` field (or after whichever field appears last in the frontmatter). The frontmatter structure for all six files follows this pattern:

```yaml
---
name: {agent-name}
description: {description}
model: {model}
tools:
  - {tool}
maxTurns: {N}
background: false
---
```

`researcher.md` uses `background: true` as the last frontmatter field. Match this position (after `maxTurns` or equivalent last field) for consistency.

Do not add `background: false` to `researcher.md`.

## Complexity
Low
