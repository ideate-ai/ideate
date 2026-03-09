# 015: Top-Level README

## Objective
Create a top-level README.md that provides installation instructions, MCP server setup, and usage documentation for the ideate plugin.

## Acceptance Criteria
- [ ] `README.md` exists at project root
- [ ] Describes what ideate is (1-2 paragraphs)
- [ ] Lists prerequisites (Claude Code CLI)
- [ ] Documents installation: how to add the plugin to Claude Code
- [ ] Documents MCP server setup: step-by-step instructions for configuring the session-spawner (optional but recommended for large projects)
- [ ] Documents the four-command workflow: `/ideate:plan`, `/ideate:execute`, `/ideate:review`, `/ideate:refine` with one-line descriptions
- [ ] Documents the artifact directory structure (what gets created where)
- [ ] Notes that the MCP server is optional — the plugin works without it but recursive decomposition is unavailable
- [ ] Includes a "Quick Start" section showing the minimum path: `/ideate:plan "my idea"` → `/ideate:execute` → `/ideate:review`

## File Scope
- `README.md` (create)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
Keep it concise. This is a reference document, not a tutorial. The skills themselves contain detailed instructions — the README covers setup and orientation only.

For plugin installation, use `claude plugin add` or document the manual installation path (clone repo, add to plugin search path).

For MCP setup, reference the session-spawner README for detailed configuration and document the one-line setup: `claude mcp add ideate-session-spawner -- python /path/to/mcp/session-spawner/server.py`.

## Complexity
Low
