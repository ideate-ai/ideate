# Work Item 040: Agent Model Agnosticism

## Objective

Remove hardcoded `model: opus` from agent definition frontmatter files. Change affected agents to `model: sonnet` as a safe default. Update `skills/plan/SKILL.md` and `skills/refine/SKILL.md` to explicitly specify `model: opus` when spawning architect and decomposer agents, so model selection is controlled by the skill at spawn time rather than locked into the agent definition.

## Acceptance Criteria

1. `agents/architect.md` frontmatter has `model: sonnet` (changed from `model: opus`)
2. `agents/decomposer.md` frontmatter has `model: sonnet` (changed from `model: opus`)
3. `agents/proxy-human.md` frontmatter has `model: sonnet` (changed from `model: opus`)
4. `skills/plan/SKILL.md` wherever it instructs spawning the architect agent includes `model: claude-opus-4-6` in the spawn call specification
5. `skills/plan/SKILL.md` wherever it instructs spawning the decomposer agent includes `model: claude-opus-4-6` in the spawn call specification
6. `skills/refine/SKILL.md` wherever it instructs spawning the architect agent includes `model: claude-opus-4-6` in the spawn call specification
7. `skills/refine/SKILL.md` wherever it instructs spawning the decomposer agent includes `model: claude-opus-4-6` in the spawn call specification
8. All other agent files that already have `model: sonnet` are unchanged
9. The frontmatter ordering convention (model → background → maxTurns) is preserved in all modified files

## File Scope

- modify: `agents/architect.md`
- modify: `agents/decomposer.md`
- modify: `agents/proxy-human.md`
- modify: `skills/plan/SKILL.md`
- modify: `skills/refine/SKILL.md`

## Dependencies

- 039 (spawn_session model parameter must exist before skills reference it for MCP-spawned sessions)

## Implementation Notes

For the three agent files, find the frontmatter block (between `---` delimiters) and change:
```yaml
model: opus
```
to:
```yaml
model: sonnet
```

For `skills/plan/SKILL.md` and `skills/refine/SKILL.md`, locate the sections that describe spawning the architect agent (search for "architect" near "spawn" or "Agent tool"). Add model specification to those spawn instructions. Example instruction addition:

> Spawn the architect agent with `model: claude-opus-4-6`. This overrides the agent's default model for this task.

Do the same for decomposer spawn instructions.

The model to specify for architect and decomposer: `claude-opus-4-6` (complex multi-factor reasoning tasks warrant the larger model).

Do not change the frontmatter of agents that already specify `model: sonnet`: researcher.md, code-reviewer.md, spec-reviewer.md, gap-analyst.md, journal-keeper.md, manager.md.

## Complexity

Low
