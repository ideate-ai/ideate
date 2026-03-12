# Work Item 053: Move Session-Spawner to Outpost

## Objective

Lift and shift `mcp/session-spawner/` from ideate to outpost. This includes the FastAPI MCP server, test suite, and README.

## Acceptance Criteria

1. `~/code/outpost/mcp/session-spawner/` directory exists with all files from `ideate/mcp/session-spawner/`
2. All Python imports updated to reflect the new package path
3. All tests pass in the new location
4. README updated to reflect outpost project context
5. Original `ideate/mcp/session-spawner/` directory still exists (deletion is a separate work item)

## File Scope

- create: `~/code/outpost/mcp/session-spawner/` (copy of ideate/mcp/session-spawner/)
- modify: `~/code/outpost/mcp/session-spawner/server.py` (import paths if needed)
- modify: `~/code/outpost/mcp/session-spawner/test_server.py` (import paths if needed)
- modify: `~/code/outpost/mcp/session-spawner/README.md` (outpost context)

## Dependencies

- 052 (outpost project structure must exist)

## Implementation Notes

This is a lift-and-shift. The session-spawner code does not need to change — it just moves to a new home.

Key files to copy:
- `server.py` — MCP server implementation
- `test_server.py` — Test suite
- `README.md` — Documentation
- `requirements.txt` — Dependencies

After copy:
- Verify tests run: `cd ~/code/outpost && python -m pytest mcp/session-spawner/test_server.py`
- No need to update imports unless there are project-relative paths

## Complexity

Low