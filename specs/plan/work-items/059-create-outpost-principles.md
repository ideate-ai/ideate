# Work Item 059: Create Outpost Guiding Principles

## Objective

Run a planning session for outpost to generate its own `steering/guiding-principles.md` and `steering/constraints.md`. Outpost has different concerns than ideate — it's an MCP server for Claude Code orchestration, not an SDLC tool.

## Acceptance Criteria

1. `~/code/outpost/specs/steering/guiding-principles.md` exists with outpost-specific principles
2. `~/code/outpost/specs/steering/constraints.md` exists with outpost-specific constraints
3. Principles include:
   - MCP tool interface stability
   - Session isolation and cleanup
   - Remote worker reliability
   - Role system flexibility
4. Constraints include:
   - Technology constraints (Python, FastAPI, MCP protocol)
   - Security constraints (API keys, session limits)
   - Deployment constraints (local vs remote)

## File Scope

- create: `~/code/outpost/specs/steering/guiding-principles.md`
- create: `~/code/outpost/specs/steering/constraints.md`

## Dependencies

- 052 (outpost project structure)

## Implementation Notes

Outpost's principles differ from ideate:
- **Ideate**: SDLC workflow, spec sufficiency, parallel execution, Andon cord model
- **Outpost**: MCP server stability, session management, remote worker coordination, role injection

Sample outpost principles:
1. **Tool Interface Stability** — MCP tool signatures are public APIs. Changes must be backward-compatible.
2. **Session Isolation** — Each spawned session has its own context, working directory, and limits.
3. **Graceful Degradation** — Remote worker failures are handled cleanly with status reporting.
4. **Observable Execution** — All sessions are logged with sufficient detail for debugging.

## Complexity

Medium

This work item may be expanded into a full planning session. Consider invoking `/ideate:plan` in the outpost directory after initial principles are drafted.