# Refinement Plan — Ideate/Outpost Architectural Split

## What Is Changing

ideate's orchestration components (session-spawner, remote-worker, roles system, manager agent) are moving to a separate project called "outpost". ideate becomes focused solely on SDLC: planning, refinement, execution, and review. The brrr skill's proxy-human invocation changes from MCP spawn_session to native Agent tool.

## Triggering Context

User decision (2026-03-11): The session-spawner MCP component has expanded beyond its original design scope for ideate. MCP orchestration introduces design decisions that may not be relevant for all ideate use cases. Separating concerns allows:
- ideate to remain focused on SDLC workflow
- outpost to specialize in MCP orchestration (session management, remote dispatch)
- Independent evolution of each project's principles and constraints

## What Is NOT Changing

- ideate's skills: plan, refine, execute, review, brrr (only brrr's proxy-human invocation changes)
- ideate's agents: researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper (proxy-human stays; manager moves to outpost)
- ideate's guiding principles and constraints
- ideate's artifact conventions
- Existing work items 001-051 (historical record retained)

## Scope

Files and directories affected:

**Create (outpost project structure):**
- `~/code/outpost/CLAUDE.md`
- `~/code/outpost/.claude-plugin/plugin.json`
- `~/code/outpost/.claude-plugin/marketplace.json`
- `~/code/outpost/README.md`
- `~/code/outpost/.gitignore`
- `~/code/outpost/specs/` (directory structure)

**Move (lift-and-shift):**
- `ideate/mcp/session-spawner/` → `outpost/mcp/session-spawner/`
- `ideate/mcp/remote-worker/` → `outpost/mcp/remote-worker/`
- `ideate/mcp/roles/` → `outpost/mcp/roles/`
- `ideate/agents/manager.md` → `outpost/agents/manager.md`

**Modify:**
- `skills/brrr/SKILL.md` — Agent tool invocation for proxy-human
- `specs/plan/architecture.md` — Remove MCP components
- `.claude-plugin/plugin.json` — Remove MCP servers, bump version
- `.claude-plugin/marketplace.json` — Update description
- `README.md` — Reflect new architecture

**Delete (after move confirmed):**
- `ideate/mcp/session-spawner/`
- `ideate/mcp/remote-worker/`
- `ideate/mcp/roles/`
- `ideate/agents/manager.md`
- `ideate/mcp/` (if empty)

## Expected Impact

After this cycle:
- ideate contains only SDLC-focused skills and agents
- outpost is a separate MCP server project for session orchestration
- brrr invokes proxy-human via Agent tool (no MCP dependency for Andon)
- ideate's architecture.md reflects reduced scope
- outpost has its own principles, constraints, and architecture (via /ideate:plan)

## New Work Items

WI-052 through WI-061 (10 items across 4 dependency groups).