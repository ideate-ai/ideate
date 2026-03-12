# Work Item 054: Move Remote-Worker to Outpost

## Objective

Lift and shift `mcp/remote-worker/` from ideate to outpost. This includes the FastAPI HTTP daemon and its test suite.

## Acceptance Criteria

1. `~/code/outpost/mcp/remote-worker/` directory exists with all files from `ideate/mcp/remote-worker/`
2. All Python imports updated to reflect the new package path
3. All tests pass in the new location
4. README updated to reflect outpost project context
5. Original `ideate/mcp/remote-worker/` directory still exists (deletion is a separate work item)

## File Scope

- create: `~/code/outpost/mcp/remote-worker/` (copy of ideate/mcp/remote-worker/)
- modify: `~/code/outpost/mcp/remote-worker/server.py` (import paths if needed)
- modify: `~/code/outpost/mcp/remote-worker/test_server.py` (import paths if needed)
- modify: `~/code/outpost/mcp/remote-worker/README.md` (outpost context)

## Dependencies

- 052 (outpost project structure must exist)

## Implementation Notes

Key files to copy:
- `server.py` — HTTP daemon implementation
- `test_server.py` — Test suite
- `README.md` — Documentation
- `requirements.txt` — Dependencies

This is independent from session-spawner move (WI-053) and can run in parallel.

## Complexity

Low