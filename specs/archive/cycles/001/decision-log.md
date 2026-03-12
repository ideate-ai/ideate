# Decision Log — Capstone (WI 052–062)

## Decision Log

### D1 — Architectural Separation of SDLC from MCP Orchestration
- **Date**: 2026-03-11
- **Decision**: Split session-spawner, remote-worker, roles system, and manager agent out of ideate into outpost. ideate becomes SDLC-only (plan/execute/review/refine/brrr). Outpost becomes a distinct MCP orchestration project.
- **Rationale**: MCP orchestration had expanded beyond its original scope for ideate. Separating concerns allows independent evolution of each project's principles and constraints.
- **Alternatives considered**: Keeping orchestration within ideate with tighter modular boundaries was not formally evaluated; the user decision was categorical.
- **Implications**: brrr must invoke proxy-human via native Agent tool. outpost requires its own principles, constraints, architecture, and plugin manifest. WI-010 and WI-030–035 specs transferred to outpost repository.

### D2 — brrr Proxy-Human Invocation: Agent Tool Replaces spawn_session
- **Date**: 2026-03-11
- **Decision**: brrr Phase 6a invokes proxy-human via the native Agent tool (`subagent_type: "proxy-human"`) instead of spawn_session. Fallback retained for environments where the Agent tool is unavailable.
- **Rationale**: After the split, ideate does not ship session-spawner. The Agent tool is always available in Claude Code and eliminates the MCP dependency for a core SDLC operation.
- **Implications**: Phase 6c convergence check was not updated in this work item — explicitly flagged as out-of-scope in incremental review 057 as M1. Not corrected in any subsequent work item. (See OQ1.)

### D3 — Remote-Worker Environment Variables Preserved as IDEATE_*
- **Date**: 2026-03-11
- **Decision**: When moving mcp/remote-worker to outpost, IDEATE_* environment variable names were preserved rather than renamed to OUTPOST_*.
- **Rationale**: Renaming would require coordinated changes on both client and server and would break existing deployments.
- **Implications**: Remote-worker retains a naming inconsistency — logically owned by outpost but env vars use the ideate prefix.

### D4 — Session-Spawner Environment Variables Renamed to OUTPOST_*
- **Date**: 2026-03-11
- **Decision**: All IDEATE_* env vars in session-spawner renamed to OUTPOST_*; server name updated to outpost-session-spawner.
- **Rationale**: session-spawner is user-facing configuration. Renaming aligns outward identity with project ownership. No existing client code would break — session-spawner is configured fresh per installation.
- **Implications**: Any ideate user who had IDEATE_* env vars configured for session-spawner must rename them.

### D5 — proxy-human and brrr Kept in ideate, Not Moved to Outpost
- **Date**: 2026-03-11
- **Decision**: agents/proxy-human.md and skills/brrr/SKILL.md remain in ideate. Only manager.md moved to outpost.
- **Rationale**: proxy-human handles Andon events within brrr cycles — SDLC concern, not MCP orchestration. brrr is the autonomous SDLC loop skill.
- **Implications**: proxy-human invoked via Agent tool, not outpost spawn_session, to remain self-contained.

### D6 — Work Item Specs WI-010 and WI-030–035 Transferred to Outpost
- **Date**: 2026-03-11
- **Decision**: WI-062 moved seven work item spec files (010, 030-035) and six incremental reviews to outpost. WI-036 (proxy-human) and WI-037 (brrr) explicitly retained in ideate.
- **Rationale**: Specs and reviews co-located with the code they describe (principle 8 Durable Knowledge Capture).
- **Implications**: ideate's specs no longer contain authoritative specs for the moved components. Ideate journal retains historical entries.

### D7 — Duplicate Work Item Spec Numbers Not Corrected
- **Date**: 2026-03-11
- **Decision**: Five number prefixes (055, 056, 059, 060, 061) each have two files. Incremental review 059 flagged this as M1. No correction work item was created.
- **Rationale**: Not recorded — acknowledged but deferred.
- **Implications**: Latent defect for any future /ideate:execute or /ideate:brrr run. (See OQ4.)

### D8 — Outpost Principles Generated via /ideate:plan
- **Date**: 2026-03-11
- **Decision**: outpost's guiding principles and constraints created as first-class steering documents specific to MCP orchestration (12 principles), distinct from ideate's 12 SDLC-focused principles.
- **Rationale**: Independent evolution requires independent principles.
- **Implications**: outpost has a full steering document set and is ready for its own refinement cycles.

---

## Open Questions

### OQ1 — spawn_session in brrr Phase 6c Not Migrated
- **Question**: skills/brrr/SKILL.md:494 uses spawn_session for the principles-checker with no fallback. WI-057 excluded Phase 6c from its scope. Should Phase 6c be converted to use Agent tool with `subagent_type: "spec-reviewer"`?
- **Impact**: Condition B of convergence cannot be evaluated without outpost. brrr exhausts max_cycles without declaring convergence, with no error.
- **Who answers**: Next refinement — no design decision required, mechanical fix.
- **Consequence of inaction**: brrr cannot converge on any installation without outpost configured.

### OQ2 — Decision Label Mismatch: brrr Checks DEFERRED, proxy-human Writes DEFER
- **Question**: brrr/SKILL.md:317 checks for `DEFERRED` but agents/proxy-human.md:90 specifies `DEFER`. Will any proxy-human output ever match?
- **Impact**: Deferred Andon events silently disappear from brrr's deferred items list. Activity report in Phase 9 will always show zero deferrals.
- **Who answers**: Next refinement — one-line fix: change `DEFERRED` to `DEFER`.
- **Consequence of inaction**: Proxy-human deferrals are invisible to brrr's accounting.

### OQ3 — CLAUDE.md Absent from ideate Repository Root
- **Question**: outpost received a CLAUDE.md (WI-052 AC2). ideate has none. Should one be created covering plugin purpose, directory layout, artifact conventions, and development workflow?
- **Impact**: Developers opening ideate in Claude Code have no project-level context. Core "dogfood" workflow (using ideate to improve itself) is degraded.
- **Who answers**: Next refinement — content well-defined, no design decisions required.
- **Consequence of inaction**: Principle 8 (Durable Knowledge Capture) violated at the project entry point.

### OQ4 — Duplicate Work Item Number Prefixes
- **Question**: Five prefixes have two files each. Flagged as M1 in incremental review 059. Should superseded drafts be deleted?
- **Impact**: /ideate:execute and /ideate:brrr encounter ambiguous ordering for five numbers.
- **Who answers**: Next refinement — mechanical cleanup.
- **Consequence of inaction**: Latent defect for any future execution of these specs.

### OQ5 — Primary/Fallback Order Inverted in Three Skills After Split
- **Question**: skills/plan, execute, and review list spawn_session as primary and Agent tool as fallback. Post-split, this is inverted. Should the preference ordering be updated?
- **Impact**: Skills attempt spawn_session first, receive tool-not-found error, fall back. Unnecessary noise; inconsistent with brrr (correctly updated in WI-057).
- **Who answers**: Next refinement — documentation pass. Gap analyst recommends deferring since fallbacks exist.
- **Consequence of inaction**: Visible tool-not-found noise on every plan/execute/review invocation without outpost.

### OQ6 — Confidence Level Case Inconsistency in proxy-human
- **Question**: Output contract says lowercase (high/medium/low). Log format says uppercase (HIGH/MEDIUM/LOW). Which is canonical?
- **Impact**: brrr Phase 9 activity report confidence-level summaries may fail to parse if case-sensitive.
- **Who answers**: Next refinement — standardize on uppercase (durable artifact already uses uppercase).
- **Consequence of inaction**: Latent parsing defect in Phase 9 activity report.

### OQ7 — brrr Fallback Entry Heading Not Specified for proxy-human-log.md
- **Question**: The fallback path at brrr/SKILL.md:321 says to write with [brrr-fallback] notation but does not specify the heading. Phase 9 looks for `## [proxy-human] {date} — Cycle N`. Will fallback entries be found?
- **Impact**: Andon events handled by fallback path invisible in Phase 9 activity report.
- **Who answers**: Next refinement — specify fallback entries use `## [proxy-human] {date} — Cycle {N}` heading with `[brrr-fallback]` in Rationale field.
- **Consequence of inaction**: Phase 9 activity report undercounts Andon events in fallback environments.

### OQ8 — README Link to outpost Repository Not Verified
- **Question**: README.md:16 links to https://github.com/dan/outpost. Unconfirmed as public/accessible.
- **Impact**: Users clicking the link get a 404; no alternative guidance exists.
- **Who answers**: User decision — confirm URL before public release.
- **Consequence of inaction**: Users who want outpost-dependent features cannot locate the project.

### OQ9 — plugin.json and marketplace.json Do Not Mention brrr
- **Question**: Both describe ideate as "plan, execute, review, refine." Should brrr be added to description fields?
- **Impact**: brrr undiscoverable via plugin metadata; ideate's primary differentiator is hidden.
- **Who answers**: Next refinement — add "brrr (autonomous SDLC loop)" to descriptions.
- **Consequence of inaction**: brrr remains undiscoverable to evaluating users.

---

## Cross-References

### CR1 — spawn_session Remnant in brrr Phase 6c (OQ1)
All four perspectives independently identified `skills/brrr/SKILL.md:494`:
- Code review C1: runtime defect — loop exhausts max_cycles without explanation
- Spec review A1: architecture contradiction — architecture claims no built-in MCP, this call survives
- Gap analysis G1 + E1: missing requirement + missing fallback
- Incremental review 057-M1: flagged during execution, accepted as out-of-scope, no follow-up created
The call must be replaced with Agent tool invocation using `subagent_type: "spec-reviewer"` before brrr can function correctly on a standard ideate installation.

### CR2 — spawn_session as Primary Path in plan/execute/review Skills (OQ5)
- Code review S1, S2: significant — specific tool name ties ideate to outpost API; inconsistent primary path between review and brrr
- Spec review A2: not a violation — conditioned references with working fallbacks
- Gap analysis I1: documentation debt — deferred because fallbacks exist
Combined: documentation debt that creates unnecessary noise but does not break runtime. Should be resolved in the same work item as OQ1.

### CR3 — Duplicate Work Item Numbers (OQ4)
- Code review: observation only — "spec hygiene, not a runtime defect"
- Spec review D1: architecture section 8 requires unique numbers; undocumented addition; not blocking
- Gap analysis IN1: "address now" — execute and brrr glob by prefix; duplicates create ambiguous ordering
Gap analyst's assessment most actionable: next /ideate:execute run encounters ordering ambiguity. Mechanical fix, include in next refinement.
