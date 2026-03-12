# Gap Analysis — Capstone (WI 052–062)

## Missing Requirements

[G1] brrr convergence check (Phase 6c) still invokes `spawn_session` for the principles-checker — flagged as M1 in incremental review 057 when WI-057 fixed the proxy-human path but left Phase 6c untouched, and no follow-up work item was created — source: plan/overview.md split goal ("removes the MCP dependency"), WI-057 AC3 (scoped to proxy-human path only) — Significant — Address now: `skills/brrr/SKILL.md:494` contains the remaining `spawn_session` call. Post-split ideate does not ship a session-spawner. This call will fail silently or not run if outpost is not configured, meaning Condition B of convergence will never be evaluated — brrr will either deadlock or skip the principles check entirely. Replace the `spawn_session` block with an Agent tool invocation using `subagent_type: "spec-reviewer"`, mirroring the pattern used for proxy-human at lines 289–304.

[G2] `CLAUDE.md` is absent from the ideate repository root — WI-061 file scope listed "modify: `CLAUDE.md` (if exists)" and did not create the file, but outpost received a `CLAUDE.md` as a first-class deliverable in WI-052 AC2, establishing the expectation that both projects have one — source: WI-052, WI-061, guiding principle 8 (Durable Knowledge Capture) — Significant — Address now: a developer opening ideate in Claude Code has no project-level context. The file should cover: plugin purpose, skill and agent directory layout, artifact directory convention, how to invoke and test skills during development, and the principle that this is a markdown-only plugin (no runtime code to build or test).

## Unhandled Edge Cases

[E1] brrr Phase 6c `spawn_session`-based principles-checker has no fallback when the MCP tool is unavailable — the proxy-human Andon path at line 321 has an explicit fallback ("If the Agent tool is not available...") but the convergence check at line 494 has none — if `spawn_session` is absent the result variable receives nothing and brrr either stalls or incorrectly treats the check as passed — component: `skills/brrr/SKILL.md:494` — Significant — Address now together with G1: replacing the call with the Agent tool eliminates the availability concern and the missing fallback simultaneously.

## Incomplete Integrations

[I1] Three skills reference `spawn_session` as the primary or preferred spawning mechanism after the split removed the session-spawner from ideate — `skills/plan/SKILL.md:136` frames spawn_session as the first option and subagents as fallback for researcher spawning; `skills/execute/SKILL.md:249` describes recursive execution as conditional on session-spawner MCP being "configured"; `skills/review/SKILL.md:85` presents spawn_session before subagents for parallel reviewer spawning — post-split, the Agent tool is always available and is the canonical mechanism; spawn_session is optional outpost infrastructure — components: `skills/plan/SKILL.md`, `skills/execute/SKILL.md`, `skills/review/SKILL.md` — Minor — Defer: all three skills include a working subagents fallback path so runtime behavior is correct. Fix in the next documentation pass: invert the preference so Agent tool is listed first and spawn_session is noted as an optional enhancement when outpost is configured.

## Missing Infrastructure

[IN1] Five work item number prefixes (055, 056, 059, 060, 061) each have two files in `specs/plan/work-items/` — e.g., `055-move-roles-system.md` and `055-move-roles-to-outpost.md` — flagged as M1 in incremental review 059 but no work item was created to resolve it — the execute and brrr skills glob `plan/work-items/*.md` and match journal entries and review files by number prefix; duplicate prefixes create ambiguous ordering — Minor — Address now: identify the superseded version of each duplicated number (the earlier draft), delete it, and confirm the retained file has the correct name. Leaving five doubled prefixes is a latent defect for any future `/ideate:execute` run against these specs.

[IN2] `README.md:16` links to `https://github.com/dan/outpost` — this URL has not been verified as a public, accessible repository — if outpost is private or not yet published at that path, users get a 404 with no alternative guidance — Minor — Defer: confirm URL resolves before public release of ideate. If outpost will remain private, replace the hyperlink with a description of where to obtain it.

## Implicit Requirements Not Addressed

[R1] The plan skill's fallback language at `skills/plan/SKILL.md:158` presents subagent capability as equivalent to "no session-spawner MCP" — the phrasing is "If no session-spawner MCP server or subagent capability is available" — but post-split the Agent tool (subagent capability) is always present in Claude Code and is not a degraded mode — source: architecture.md, constraints §3 — Minor — Defer: functionally the plan skill works. Fix alongside I1 in the next documentation pass.

[R2] Neither `plugin.json` nor `marketplace.json` mentions brrr in their description fields — both say "plan, execute, review, refine" — brrr is now a primary differentiator of ideate post-split — source: interview, constraints §14 — Minor — Defer: add "brrr (autonomous SDLC loop)" to descriptions before public release.
