# Work Item 052: Create Outpost Project Structure

## Objective

Initialize a new project at `~/code/outpost` to house the MCP orchestration infrastructure being split out from ideate. Outpost will be an optional MCP server for delegating work to separate Claude Code instances — either as local subprocesses or remote processes.

## Acceptance Criteria

1. `~/code/outpost/` directory exists with standard project structure:
   - `CLAUDE.md` — project instructions for Claude Code
   - `.claude-plugin/plugin.json` — plugin manifest for outpost
   - `.claude-plugin/marketplace.json` — marketplace entry (copy structure from ideate)
   - `README.md` — project overview
   - `.gitignore` — standard Python/MCP ignores
2. `CLAUDE.md` contains:
   - Project purpose statement
   - Development setup instructions
   - Testing instructions
   - Artifact directory location (`specs/`)
3. `specs/` directory created with subdirectories: `steering/`, `plan/`, `reviews/`
4. `specs/journal.md` initialized with creation entry
5. Git repository initialized with initial commit

## File Scope

- create: `~/code/outpost/CLAUDE.md`
- create: `~/code/outpost/.claude-plugin/plugin.json`
- create: `~/code/outpost/.claude-plugin/marketplace.json`
- create: `~/code/outpost/README.md`
- create: `~/code/outpost/.gitignore`
- create: `~/code/outpost/specs/steering/` (empty directory)
- create: `~/code/outpost/specs/plan/` (empty directory)
- create: `~/code/outpost/specs/reviews/` (empty directory)
- create: `~/code/outpost/specs/journal.md`

## Dependencies

None.

## Implementation Notes

This is a greenfield project creation. Use ideate's structure as a reference but simplify:
- No skills or agents directories yet (those will be moved)
- MCP server code directories will be created in subsequent work items
- The plugin.json should declare outpost as an MCP server providing session-spawner tools

## Complexity

Low