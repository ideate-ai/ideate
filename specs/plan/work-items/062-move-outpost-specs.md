# Work Item 062: Move Outpost-Specific Specs to Outpost

## Objective

Move outpost-specific specification files from ideate's specs directory to outpost. This includes work items, reviews, and journal entries that relate to the moved components.

## Acceptance Criteria

1. Outpost-specific work items moved to `~/code/outpost/specs/plan/work-items/`
2. Outpost-specific incremental reviews moved to `~/code/outpost/specs/reviews/incremental/`
3. Outpost-specific journal entries moved to `~/code/outpost/specs/journal.md`
4. Ideate's specs remain focused on SDLC concerns (planning, execution, review, refinement)

## File Scope

- move: `specs/plan/work-items/010-session-spawner-mcp.md` to outpost
- move: `specs/plan/work-items/030-remote-worker-daemon.md` to outpost
- move: `specs/plan/work-items/031-remote-worker-tests.md` to outpost
- move: `specs/plan/work-items/032-role-system.md` to outpost
- move: `specs/plan/work-items/033-remote-dispatch-tools.md` to outpost
- move: `specs/plan/work-items/034-remote-dispatch-tests.md` to outpost
- move: `specs/plan/work-items/035-manager-agent.md` to outpost
- move: `specs/plan/work-items/036-proxy-human-agent.md` to outpost (shared, may stay in ideate)
- move: `specs/plan/work-items/037-brrr-skill.md` to outpost (shared, may stay in ideate)
- move: relevant incremental reviews to outpost
- move: relevant journal entries to outpost

## Dependencies

- 059 (outpost principles created)
- 052 (outpost project structure)

## Implementation Notes

This requires judgment about which specs are outpost-specific vs. shared:
- **Outpost-specific**: session-spawner MCP, remote-worker daemon, role system, remote dispatch tools, manager agent
- **Shared**: proxy-human (used by brrr in ideate), brrr skill (lives in ideate but may have outpost references)
- **Ideate-only**: planning skills, execution, review, refine

Create a `specs/journal.md` in outpost that appends the moved journal entries. Prefix with a note explaining the origin.

## Complexity

Medium