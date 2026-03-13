# Work Item 059: Remove Outpost Components from Ideate

## Objective

Delete the moved components from ideate: session-spawner, remote-worker, roles, and manager agent. Clean up any references to these components in ideate's configuration and documentation.

## Acceptance Criteria

1. `ideate/mcp/session-spawner/` directory is deleted
2. `ideate/mcp/remote-worker/` directory is deleted
3. `ideate/mcp/roles/` directory is deleted
4. `ideate/agents/manager.md` is deleted
5. `ideate/mcp/` directory is deleted (if empty)
6. `ideate/.claude-plugin/plugin.json` removes any MCP server configuration for session-spawner
7. `ideate/README.md` removes references to session-spawner and remote-worker
8. `ideate/specs/plan/work-items/` retains historical work items (no deletion)

## File Scope

- delete: `ideate/mcp/session-spawner/`
- delete: `ideate/mcp/remote-worker/`
- delete: `ideate/mcp/roles/`
- delete: `ideate/agents/manager.md`
- delete: `ideate/mcp/` (if empty)
- modify: `ideate/.claude-plugin/plugin.json`
- modify: `ideate/README.md`

## Dependencies

- 053 (session-spawner must be in outpost)
- 054 (remote-worker must be in outpost)
- 055 (roles must be in outpost)
- 056 (manager must be in outpost)
- 058 (architecture must be updated)

## Implementation Notes

After confirming all components are working in outpost, delete the original directories from ideate.

Git will track the deletions. The historical work items (030-051) remain in specs/plan/work-items/ for historical record.

## Complexity

Low