# Work Item 061: Update Ideate Plugin Version and Metadata

## Objective

Update ideate's plugin manifest to reflect the removal of MCP server components. The plugin should declare only the skills and agents that remain in ideate.

## Acceptance Criteria

1. `.claude-plugin/plugin.json` removes any MCP server declarations
2. `.claude-plugin/plugin.json` version is bumped to 0.5.0 (major removal)
3. `.claude-plugin/marketplace.json` description reflects ideate's focused scope
4. README.md reflects the new architecture (ideate for SDLC, outpost for orchestration)
5. All skill references in plugin.json are valid and point to existing skill files

## File Scope

- modify: `.claude-plugin/plugin.json`
- modify: `.claude-plugin/marketplace.json`
- modify: `README.md`

## Dependencies

- 059 (outpost components removed)

## Implementation Notes

The plugin.json should declare:
- Skills: plan, execute, review, refine, brrr
- Agents: researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, proxy-human

No MCP servers should be declared. Outpost is a separate plugin.

Version bump to 0.5.0 reflects the removal of MCP components (minor version for removal, but significant enough to warrant minor bump).

## Complexity

Low