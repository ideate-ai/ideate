# Work Item 056: Move Manager Agent to Outpost

## Objective

Move `agents/manager.md` from ideate to outpost. The manager agent acts as a watchdog for remote job orchestration and is specific to outpost's MCP concerns.

## Acceptance Criteria

1. `~/code/outpost/agents/manager.md` exists with the same content as `ideate/agents/manager.md`
2. Manager agent definition references outpost tools (list_remote_workers, etc.)
3. Original `ideate/agents/manager.md` still exists (deletion is a separate work item)
4. Outpost CLAUDE.md references the manager agent if applicable

## File Scope

- create: `~/code/outpost/agents/manager.md`
- modify: `~/code/outpost/CLAUDE.md` (if needed to reference manager)

## Dependencies

- 052 (outpost project structure must exist)

## Implementation Notes

This is a lift-and-shift. The manager agent's role as a watchdog for remote jobs fits naturally in outpost rather than ideate.

Create the `~/code/outpost/agents/` directory if it doesn't exist.

## Complexity

Low