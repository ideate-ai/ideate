# Work Item 058: Update Ideate Architecture for Split

## Objective

Update `specs/plan/architecture.md` to reflect the removal of MCP orchestration components. Ideate is now focused on planning, refinement, execution, and review — not on session spawning or remote work dispatch.

## Acceptance Criteria

1. Architecture Section 1 (Component Map) no longer lists session-spawner, remote-worker, or manager
2. Architecture Section 2 (Data Flow) removes the remote worker dispatch flow diagram
3. Architecture Section 5 (MCP Server Design) is removed or replaced with a note that MCP servers are separate projects
4. Architecture Section 6 (Module Decomposition) remains unchanged (no modules affected by split)
5. Architecture Section 7 (Continuous Review Architecture) remains unchanged
6. Agent definitions table shows only: researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, proxy-human
7. Skills table remains unchanged (plan, execute, review, refine, brrr)
8. External Tooling table removes session-spawner and remote-worker entries

## File Scope

- modify: `specs/plan/architecture.md`

## Dependencies

None (can run in parallel with outpost work items)

## Implementation Notes

This is a documentation-only change. The architecture document should now reflect ideate's reduced scope:
- Skills for SDLC workflow
- Agents for delegated work
- No MCP server implementation details

Add a note in the architecture indicating that session orchestration is handled by separate projects (outpost) configured as MCP servers.

## Complexity

Low