# Work Item 055: Move Roles System to Outpost

## Objective

Lift and shift `mcp/roles/` from ideate to outpost. The roles system provides role definitions (default-roles.json) that session-spawner uses to inject system prompts and tool restrictions.

## Acceptance Criteria

1. `~/code/outpost/mcp/roles/` directory exists with `default-roles.json`
2. session-spawner in outpost loads roles from the new location
3. All role-related tests pass
4. Original `ideate/mcp/roles/` directory still exists (deletion is a separate work item)

## File Scope

- create: `~/code/outpost/mcp/roles/default-roles.json` (copy of ideate/mcp/roles/default-roles.json)
- modify: `~/code/outpost/mcp/session-spawner/server.py` (role path if hardcoded)

## Dependencies

- 053 (session-spawner must be in outpost)

## Implementation Notes

The roles system is a single JSON file. The session-spawner code already reads from a relative path. Verify the path is correct after the move.

## Complexity

Low