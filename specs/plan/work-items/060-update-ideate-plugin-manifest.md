# Work Item 060: Update ideate Plugin Manifest

## Objective

Update `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` to reflect the reduced scope of ideate after the outpost split. Remove references to session-spawner MCP server since ideate no longer provides it.

## Acceptance Criteria

1. `plugin.json` removes session-spawner from the MCP servers list (if present)
2. `plugin.json` correctly lists only ideate's skills and agents
3. `marketplace.json` description reflects ideate's focus on planning/refine/execute/review
4. Plugin version incremented appropriately

## File Scope

- modify: `.claude-plugin/plugin.json`
- modify: `.claude-plugin/marketplace.json`

## Dependencies

- 053-056 (outpost components moved from ideate)
- 058 (architecture updated)

## Implementation Notes

The plugin manifest defines what ideate provides:
- Skills: plan, execute, review, refine, brrr
- Agents: researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, proxy-human

It no longer provides:
- MCP servers (session-spawner moved to outpost)
- Manager agent (moved to outpost)

If ideate previously declared session-spawner as an MCP server in its plugin configuration, remove that declaration. Ideate may *use* outpost as an MCP server, but it does not *provide* one.

## Complexity

Low