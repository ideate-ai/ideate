# Policies: Project Boundaries

## P-14: ideate is SDLC-only; MCP orchestration infrastructure belongs in outpost
No MCP server implementations, remote worker daemons, role systems, or session-spawning infrastructure may be added to the ideate repository; those concerns belong to the outpost project.
- **Derived from**: GP-7 (Recursive Decomposition) — external tooling is handled by separate projects configured as MCP servers
- **Established**: cycle 001 (architectural split, 2026-03-11)
- **Status**: active

## P-15: Specs and review files are co-located with the project they describe
Work item spec files and incremental review files for outpost-owned components live in the outpost repository, not ideate; historical specs for moved components may be retained in ideate's journal but the authoritative record moves.
- **Derived from**: GP-8 (Durable Knowledge Capture)
- **Established**: cycle 001 (WI-062)
- **Status**: active

## P-16: Plugin manifest version is bumped in every refinement cycle that changes user-visible behavior
The version field in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` must be updated before cycle completion whenever skills, agents, or externally visible interfaces change.
- **Derived from**: GP-10 (Full SDLC Ownership) — the plugin manifest is the user-facing contract
- **Established**: cycle 001 (WI-029, WI-048, WI-061)
- **Status**: active
