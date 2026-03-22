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
- **Status**: resolved
- **Resolution**: WI-112 added the emission block; WI-113 fixed the `skill` field value from `"review"` to `"brrr"`. Both the structural gap and the field value contradiction are now closed.
- **Resolved in**: cycle 004

## Q-24: Startup failure Andon rule not yet implemented in skills/execute/SKILL.md and skills/brrr/phases/execute.md
- **Question**: Policy P-22 requires an explicit named exception in Phase 8 of `skills/execute/SKILL.md` and in the finding-handling block of `skills/brrr/phases/execute.md` for "Startup failure after ..." Critical findings. Neither file currently contains this rule (cycle 007 II1). Should WI-120 be created to add the exception to both files?
- **Source**: archive/cycles/007/gap-analysis.md II1; archive/cycles/007/summary.md Proposed Refinement Plan
- **Impact**: Until implemented, a worker executing Phase 8 may silently fix a startup failure that appears trivially fixable, bypassing the Andon escalation that the dynamic testing quality floor (WI-117) was designed to enforce. The defect is latent — it only manifests when a code-reviewer emits a startup failure finding during an execute run.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; proposed as WI-120 in the cycle 007 summary. Low complexity — 2 files, 2 insertions.
