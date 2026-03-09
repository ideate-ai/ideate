# 001: Plugin Manifest and Directory Structure

## Objective
Create the plugin skeleton — manifest file, directory structure, and marketplace configuration. This is the foundation that all other work items build on.

## Acceptance Criteria
- [ ] `.claude-plugin/plugin.json` exists with name "ideate", version "0.2.0", correct schema
- [ ] `.claude-plugin/marketplace.json` exists with valid marketplace configuration
- [ ] Directory structure matches: `skills/{plan,execute,review,refine}/`, `agents/`, `mcp/session-spawner/`
- [ ] Plugin validates cleanly with `claude plugin validate`

## File Scope
- `.claude-plugin/plugin.json` (create)
- `.claude-plugin/marketplace.json` (create)
- `skills/plan/.gitkeep` (create)
- `skills/execute/.gitkeep` (create)
- `skills/review/.gitkeep` (create)
- `skills/refine/.gitkeep` (create)
- `agents/.gitkeep` (create)
- `mcp/session-spawner/.gitkeep` (create)

## Dependencies
- Depends on: none
- Blocks: 002, 003, 004, 005, 006, 007, 008, 009, 010, 011

## Implementation Notes
Plugin manifest must follow the Claude Code plugin spec. Version should be 0.2.0 to distinguish from v1. Keywords should include: planning, development, review, workflow, agents, sdlc, spec-driven.

## Complexity
Low
