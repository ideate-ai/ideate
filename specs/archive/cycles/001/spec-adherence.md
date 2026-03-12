# Spec Adherence Review — Capstone (WI 052–062)

## Verdict: PASS

All outpost-split components moved, deleted, and updated per plan. The architecture accurately reflects ideate's reduced scope. plugin.json and marketplace.json are clean. brrr invokes proxy-human via Agent tool. Two issues survive this cycle: (1) a `spawn_session` call in brrr Phase 6c (Convergence Check) creates an undocumented MCP dependency that contradicts the architecture's claim of no built-in MCP; (2) five duplicate work item numbers remain uncorrected in the work-items directory. Neither prevents acceptance — the split is functionally complete — but both require follow-up work items.

## Architecture Deviations

[A1] spawn_session in brrr Phase 6c — undocumented MCP dependency survives split — Expected: architecture section 1 ("External Tooling") and section 5 ("MCP Servers") both state session orchestration is handled by separate projects; ideate does not include built-in MCP. Actual: `skills/brrr/SKILL.md:494` contains a `spawn_session()` call in Phase 6c (Condition B: Guiding Principles Adherence) using `role="spec-reviewer"`, `model="claude-sonnet-4-6"`, `timeout=300` — operative instruction, not a removed example. No fallback for Phase 6c when MCP is unavailable. Convergence can never be declared without outpost's session-spawner configured. The incremental review for WI-057 flagged this as minor finding M1 but accepted it as out-of-scope; no subsequent work item addressed it.

[A2] Three skills retain conditioned spawn_session references — `skills/execute/SKILL.md:249`, `skills/review/SKILL.md:85`, `skills/plan/SKILL.md:136` all reference the session-spawner MCP tool conditioned on availability with documented fallbacks. Consistent with the architecture's position that ideate uses outpost optionally. Not a violation — documented for completeness.

## Unmet Acceptance Criteria

[U1] WI-062 criterion 3 — "outpost-specific journal entries moved to outpost" — The criterion states entries are "moved." The implementation wrote new entries into `/Users/dan/code/outpost/specs/journal.md` during outpost setup; no ideate journal content was transferred. Incremental review accepted this as pass. Documented here for completeness; not a blocking issue.

## Principle Violations

None.

## Undocumented Additions

[D1] Duplicate work item spec files — five number conflicts — `/Users/dan/code/ideate/specs/plan/work-items/` contains pairs: `055-move-roles-to-outpost.md`/`055-move-roles-system.md`; `056-move-manager-to-outpost.md`/`056-move-manager-agent.md`; `059-create-outpost-principles.md`/`059-remove-outpost-components-from-ideate.md`; `060-update-ideate-plugin-manifest.md`/`060-init-outpost-principles.md`; `061-cleanup-ideate-outpost-references.md`/`061-update-ideate-plugin-version.md`. Earlier draft work items were superseded but never deleted. Artifact directory contract in architecture.md section 8 specifies unique 3-digit-numbered work items. Already flagged in incremental review 059 as finding M1. Not corrected in this cycle.
