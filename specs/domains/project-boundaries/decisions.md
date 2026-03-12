# Decisions: Project Boundaries

## D-12: Architectural split: session-spawner, remote-worker, roles system, and manager move to outpost
- **Decision**: All MCP orchestration infrastructure (session-spawner, remote-worker, roles system, manager agent) was removed from ideate and placed in a separate project at `~/code/outpost`.
- **Rationale**: MCP orchestration had expanded beyond its original scope for ideate; separating concerns allows independent evolution of each project's principles and constraints (archive/cycles/001/decision-log.md D1, journal 2026-03-11 refine entry).
- **Source**: archive/cycles/001/decision-log.md D1, specs/plan/overview.md
- **Status**: settled

## D-13: Remote-worker environment variables preserved as IDEATE_* after move to outpost
- **Decision**: When moving `mcp/remote-worker` to outpost, the `IDEATE_*` environment variable names were kept rather than renamed to `OUTPOST_*`.
- **Rationale**: Renaming would require coordinated changes on both client and server and would break existing deployments; session-spawner env vars were safe to rename (fresh installations) but remote-worker env vars were not (archive/cycles/001/decision-log.md D3).
- **Assumes**: No existing deployment has both session-spawner and remote-worker configured with the old ideate prefix simultaneously.
- **Source**: archive/cycles/001/decision-log.md D3
- **Status**: settled

## D-14: Session-spawner environment variables renamed from IDEATE_* to OUTPOST_* during move
- **Decision**: All `IDEATE_*` env vars in session-spawner were renamed to `OUTPOST_*` and the server name was updated to `outpost-session-spawner`.
- **Rationale**: Session-spawner is user-facing configuration configured fresh per installation, so renaming aligns outward identity with project ownership without breaking existing deployments (archive/cycles/001/decision-log.md D4).
- **Source**: archive/cycles/001/decision-log.md D4, specs/plan/work-items/053-move-session-spawner.md
- **Status**: settled

## D-15: proxy-human and brrr kept in ideate; only manager moved to outpost
- **Decision**: `agents/proxy-human.md` and `skills/brrr/SKILL.md` remain in ideate; `agents/manager.md` moved to outpost.
- **Rationale**: proxy-human handles Andon events within brrr cycles — an SDLC concern, not MCP orchestration; brrr is the autonomous SDLC loop skill; manager coordinates agent teams via MCP tooling (archive/cycles/001/decision-log.md D5).
- **Source**: archive/cycles/001/decision-log.md D5, specs/plan/work-items/036-proxy-human-agent.md
- **Status**: settled

## D-16: Outpost principles generated via /ideate:plan as a first-class steering document set
- **Decision**: Outpost's guiding principles and constraints were created as independent steering documents specific to MCP orchestration (12 principles), distinct from ideate's 12 SDLC-focused principles.
- **Rationale**: Independent evolution requires independent principles; co-locating outpost principles in ideate's steering directory would re-entangle the concerns that were just separated (archive/cycles/001/decision-log.md D8).
- **Source**: archive/cycles/001/decision-log.md D8, specs/plan/work-items/060-init-outpost-principles.md
- **Status**: settled
