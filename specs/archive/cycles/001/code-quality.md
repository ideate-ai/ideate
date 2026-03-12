# Code Quality Review — Capstone (WI 052–062)

## Verdict: FAIL

The outpost split leaves ideate substantially coherent: the `mcp/` directory is gone, `agents/manager.md` is deleted, `plugin.json` has no MCP server declarations, all eight declared agents have definition files, and all five declared skills have SKILL.md files. However, there are two critical defects — one in the brrr convergence check (a `spawn_session` call with no fallback) and one in the brrr/proxy-human decision routing loop (a label mismatch that silently drops DEFER decisions) — plus two significant inconsistencies in how `spawn_session` is described after the split.

## Critical Findings

[C1] `spawn_session` in brrr Convergence Check has no fallback — `skills/brrr/SKILL.md:494` — Phase 6c (Condition B check) spawns a `principles-checker` via `spawn_session()`. Unlike the proxy-human invocation (correctly migrated to the Agent tool in WI-057) and unlike the `spawn_session` references in `execute` and `review` (both of which have "if not available, do X" fallbacks), this one has none. If session-spawner is not configured — which is the normal state after the outpost split — Condition B cannot complete. A missing Condition B result means brrr can never converge regardless of finding counts. The loop will run until `max_cycles` is exhausted without ever declaring convergence, with no error message explaining why. Fix: Replace the `spawn_session` block at lines 493–501 with Agent tool invocation using `subagent_type: "spec-reviewer"` — the same pattern used for proxy-human at line 289.

[C2] Decision label mismatch: brrr checks `DEFERRED` but proxy-human writes `DEFER` — `skills/brrr/SKILL.md:317` vs `agents/proxy-human.md:90` — brrr line 317 reads `If the decision is DEFERRED` but the proxy-human log entry format explicitly lists `Decision: {PROCEED | DEFER | ESCALATE}`. The value is `DEFER`, not `DEFERRED`. The string comparison will never match. When proxy-human defers an event, brrr will not add it to the deferred items list and the cycle's deferred items list will always be empty regardless of actual deferrals. Fix: Change line 317 from `DEFERRED` to `DEFER`.

## Significant Findings

[S1] execute's Recursive Execution section names `spawn_session` by outpost's specific tool name — `skills/execute/SKILL.md:249` — After the split, naming the specific tool `spawn_session` ties ideate to outpost's API surface. The fallback at line 251 exists and is correct so this does not break functionality, but the primary-path instruction implies `spawn_session` is the expected interface name for any orchestration MCP server. Fix: Change the reference to "use the session spawning tool provided by your configured MCP orchestration server (e.g., outpost's `spawn_session`)".

[S2] Reviewer-spawning mechanism is inconsistent between review and brrr — `skills/review/SKILL.md:85` — The review skill says "Use `spawn_session` (if the session-spawner MCP server is available) or subagents." The brrr skill's Phase 6b spawns the same reviewers using only the Agent tool with no `spawn_session` mention. Two skills performing the same operation describe different mechanisms as the primary path. The canonical pattern after WI-057 should be Agent tool for all native invocations. Fix: Update `skills/review/SKILL.md:85` to use the Agent tool as primary, `spawn_session` as secondary.

## Minor Findings

[M1] Confidence level case inconsistency in proxy-human output contract — `agents/proxy-human.md:95` vs `agents/proxy-human.md:108` — The Output Contract section says to report confidence as `"high"`, `"medium"`, or `"low"` (lowercase) but the log entry format at line 95 uses `{HIGH | MEDIUM | LOW}` (uppercase). Fix: Standardize on uppercase in both places since the log entry (the durable artifact) already uses uppercase and brrr reads the log.

[M2] brrr fallback path does not specify heading prefix for `proxy-human-log.md` entries — `skills/brrr/SKILL.md:321` — The fallback instruction says to record the decision with `[brrr-fallback]` notation but does not specify whether to use `## [brrr-fallback]` or the standard `## [proxy-human]` heading. The Phase 9 activity report reconstruction (line 626) reads the log looking for entries matching `## [proxy-human] {date} — Cycle N`, so brrr-fallback entries written with a different prefix will be silently excluded from the activity report. Fix: Specify that the heading prefix for fallback entries should be `## [proxy-human] {date} — Cycle {N}` with `[brrr-fallback]` in the Rationale field.

## Observations

The outpost split itself is well-executed. All deleted components are gone, the plugin manifest is clean, and the architecture document correctly delegates orchestration to external projects. The incremental reviews for this cycle were thorough and caught the expected changes. The duplicate work item numbers (items 055, 056, 059, 060, 061 each having two files) remain unaddressed — spec hygiene issue, not a runtime defect.
