# Policies: Project Boundaries

## P-14: ideate includes the SDLC workflow and its MCP artifact server; session orchestration is external ~~[AMENDED]~~
The ideate repository contains the SDLC workflow (skills, agents, plugin manifest) and the MCP artifact server (`mcp/artifact-server/`) which provides the runtime index and tool interface for artifact access. Session orchestration infrastructure (remote worker daemons, multi-session coordination, role systems) belongs in external projects configured as additional MCP servers. The boundary is: artifact data access is internal to ideate; compute orchestration is external.
- **Derived from**: GP-7 (Recursive Decomposition), GP-8 (Durable Knowledge Capture)
- **Established**: cycle 001
- **Amended**: cycle 026 — rewritten. Original policy prohibited all MCP servers in ideate; the v3 artifact server is now an intrinsic component. Removed outpost-specific references. Boundary clarified as artifact access (internal) vs. compute orchestration (external).
- **Status**: active

## P-15: Specs and review files are co-located with the project they describe
Work item spec files and incremental review files for externally-owned components live in the external project's repository, not ideate; historical specs for moved components may be retained in ideate's journal but the authoritative record moves.
- **Derived from**: GP-8 (Durable Knowledge Capture)
- **Established**: cycle 001
- **Amended**: cycle 026 — removed outpost-specific references; generalized to "external projects"
- **Status**: active

## P-16: Plugin manifest version is bumped in every refinement cycle that changes user-visible behavior
The version field in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` must be updated before cycle completion whenever skills, agents, or externally visible interfaces change.
- **Derived from**: GP-10 (Full SDLC Ownership) — the plugin manifest is the user-facing contract
- **Established**: cycle 001 (WI-029, WI-048, WI-061)
- **Status**: active
