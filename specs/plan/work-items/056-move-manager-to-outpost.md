# Work Item 056: Move Manager Agent to Outpost

## Objective

Move `agents/manager.md` from ideate to outpost. The manager agent is a watchdog for remote job orchestration and belongs with the orchestration infrastructure.

## Acceptance Criteria

1. `~/code/outpost/agents/manager.md` exists with manager agent definition
2. Manager agent definition updated to reflect outpost context (if needed)
3. Original file in ideate marked for deletion

## File Scope

- move: `agents/manager.md` from ideate to `~/code/outpost/agents/manager.md`

## Dependencies

- 052 (outpost project structure must exist)

## Implementation Notes

The manager agent:
- Monitors parallel workers
- Polls remote job status via `list_remote_workers`
- Applies git diffs from remote jobs
- Writes status reports to `status/manager-report-{timestamp}.md`
- Routes Andon events to proxy-human (but this will change — see WI-057)

After the split, outpost may invoke manager as a watchdog for its own orchestration, or expose it via MCP tool for external callers.

## Complexity

Low