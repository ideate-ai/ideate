# Questions: Workflow

## Q-1: brrr Phase 6c convergence check still uses spawn_session
- **Question**: `skills/brrr/SKILL.md:494` invokes `spawn_session` for the principles-checker (Condition B of convergence) with no fallback. Should this be replaced with an Agent tool invocation using `subagent_type: "spec-reviewer"` to match the proxy-human fix in WI-057?
- **Source**: archive/cycles/001/gap-analysis.md G1+E1, archive/cycles/001/decision-log.md OQ1
- **Impact**: Without outpost configured, Condition B cannot be evaluated; brrr exhausts max_cycles without declaring convergence and produces no error message explaining why.
- **Status**: being addressed in cycle 002 (WI-072)
- **Reexamination trigger**: Any attempt to run `/ideate:brrr` on an installation without outpost configured.
- **Resolution**: Resolved in cycle 002 via WI-072 (replaced spawn_session with Agent tool invocation).

## Q-2: Decision label mismatch — brrr checks DEFERRED, proxy-human writes DEFER
- **Question**: `skills/brrr/SKILL.md:317` checks for the string `DEFERRED` but `agents/proxy-human.md:90` specifies `Decision: {PROCEED | DEFER | ESCALATE}`. Will any proxy-human output ever match?
- **Source**: archive/cycles/001/decision-log.md OQ2
- **Impact**: Proxy-human deferrals are silently dropped from brrr's deferred items list; Phase 9 activity report always shows zero deferrals regardless of actual proxy-human decisions.
- **Status**: being addressed in cycle 002 (WI-073)
- **Reexamination trigger**: Next refinement cycle (one-line fix; no design decision required).
- **Resolution**: Resolved in cycle 002 via WI-073 (changed `DEFERRED` to `DEFER` at line 317).

## Q-3: spawn_session listed as primary path in plan/execute/review skills after split
- **Question**: `skills/plan/SKILL.md`, `skills/execute/SKILL.md`, and `skills/review/SKILL.md` present spawn_session as the primary agent-spawning mechanism and Agent tool as fallback. Post-split, this ordering is inverted from reality. Should the preference be updated so Agent tool is primary and spawn_session is noted as optional outpost enhancement?
- **Source**: archive/cycles/001/gap-analysis.md I1, archive/cycles/001/decision-log.md OQ5
- **Impact**: Skills attempt spawn_session first on every invocation, receive a tool-not-found error, then fall back; this produces visible noise inconsistent with brrr (which was correctly updated in WI-057).
- **Status**: open
- **Reexamination trigger**: Documentation pass; fallbacks exist so runtime behavior is correct but the noise degrades user experience.

## Q-14: brrr review phase never emits quality_summary events
- **Question**: Should `skills/brrr/phases/review.md` include a quality_summary emission block equivalent to `skills/review/SKILL.md` Phase 7.6? The `last_cycle_findings` dict is already in scope at the insertion point.
- **Source**: archive/cycles/006/gap-analysis.md SG1; archive/cycles/006/decision-log.md D3, D4, OQ1
- **Impact**: The Quality Trends section of `scripts/report.sh` produces no rows for any brrr-driven project. Because brrr is the primary path for multi-cycle runs, quality trend analysis is non-functional for the majority of ideate users.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; no design decision required — additive insertion after the journal-keeper step.
