# Work Item 055: Move Roles to Outpost

## Objective

Move `mcp/roles/default-roles.json` from ideate to outpost. The roles system is an implementation detail of session-spawner's role resolution and belongs with the orchestration infrastructure.

## Acceptance Criteria

1. `~/code/outpost/mcp/roles/default-roles.json` exists with all role definitions
2. Session-spawner's role resolution (`_roles` global, `_load_roles`, role parameter handling) works in outpost context
3. Tests pass: roles load correctly, role resolution applies system_prompt and allowed_tools
4. Original file in ideate marked for deletion

## File Scope

- move: `mcp/roles/default-roles.json` from ideate to `~/code/outpost/mcp/roles/`
- modify: `~/code/outpost/mcp/session-spawner/server.py` (role loading path if needed)

## Dependencies

- 053 (session-spawner must be in outpost)

## Implementation Notes

The roles file is loaded by session-spawner at startup. Ensure the path resolution works in the new project structure.

Roles currently defined:
- `worker` — general-purpose
- `reviewer` — read-only
- `manager` — coordination (may move to outpost as watchdog)
- `proxy-human` — decision-making for brrr (may stay in ideate for Agent tool invocation)

After this move, outpost will own all role definitions. Ideate may define its own prompting abstractions but will not use the role system directly.

## Complexity

Low