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
- **Status**: resolved
- **Resolution**: WI-125 updated `skills/review/SKILL.md` Phase 4a to list Agent tool as primary with spawn_session as optional outpost alternative. (`skills/plan/SKILL.md:148` and `skills/execute/SKILL.md:299-301` were already correct before cycle 011.)
- **Resolved in**: cycle 011

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
- **Status**: resolved
- **Resolution**: WI-120 added the exception rule to both files. All three capstone reviewers confirmed Pass.
- **Resolved in**: cycle 008

## Q-26: Smoke test blocking scenario in brrr — what happens when the smoke test itself triggers the Andon cord
- **Question**: If the smoke test (dynamic testing step) itself is blocked by the Andon cord — for example, the test infrastructure fails to start rather than the application — what is the expected behavior? The startup-failure exception (P-22) covers application startup failures, but does not address the case where the testing harness itself cannot execute.
- **Source**: archive/cycles/008/gap-analysis.md Deferred EC1; archive/cycles/007/gap-analysis.md
- **Impact**: Undefined behavior when the test runner fails. The executor may classify this as a scope-changing finding (general rule) or may attempt to fix it within scope, depending on interpretation. The ambiguity is low-frequency but high-consequence when it occurs.
- **Status**: resolved
- **Resolution**: WI-128 added a distinct "Smoke test infrastructure failure" exception to both skill files with a regression determination protocol. P-23 captures the rule in the domain layer.
- **Resolved in**: cycle 011

## Q-27: Library projects with no startup command — startup-failure exception is inapplicable
- **Question**: P-22 and the startup-failure exception assume the project has a startup command that can fail. Library projects (npm packages, Python libraries, CLI tools invoked differently) may not have a meaningful "startup" step. Should the dynamic testing flow define an alternative quality floor for projects without a startup command, or is the exception simply not triggered and the general finding-routing rules apply?
- **Source**: archive/cycles/008/gap-analysis.md Deferred EC2; archive/cycles/007/gap-analysis.md
- **Impact**: Library projects receive no benefit from the startup-failure quality floor. If ideate is used for a library project, the entire P-22 enforcement path is inert. Whether this is acceptable depends on how broadly the dynamic testing quality floor is intended to apply.
- **Status**: resolved
- **Resolution**: WI-126 replaced the startup-specific smoke test in `agents/code-reviewer.md` with a context-appropriate demo heuristic covering library builds, CLI invocations, e2e tests, and config/doc validation. P-22 updated to reference "context-appropriate smoke test."
- **Resolved in**: cycle 011

## Q-29: P-22 does not document the smoke-test re-run step or its failure path
- **Question**: P-22 states Andon fires "only if the root cause cannot be fixed ... or the cause is indeterminate" but does not mention the mandatory smoke-test re-run after a surgical fix, nor the rule that a second failure reclassifies the cause as indeterminate. Both skill files encode this path but P-22 omits it. Should P-22 be amended to include: "When a surgical fix is applied, the smoke test must be re-run; if it still fails, the failure is classified as indeterminate and routes to Andon"?
- **Source**: archive/cycles/009/code-quality.md M1; archive/cycles/009/spec-adherence.md D1; archive/cycles/009/decision-log.md OQ-2
- **Impact**: P-22 is less precise than the skill files it governs. Future work items modifying the startup-failure path may not preserve the re-run step if they read only the policy.
- **Status**: resolved
- **Resolution**: WI-123 appended the smoke-test re-run requirement and indeterminate-classification rule to P-22's body. P-22 now fully describes the five-step protocol.
- **Resolved in**: cycle 010

## Q-30: No journal instruction on the unfixable Andon path
- **Question**: The fixable startup-failure path instructs "note in the journal as significant rework." The unfixable path says only "route to the Andon cord" with no equivalent journal instruction. Should both skill files add a journal step before Andon routing on the unfixable path?
- **Source**: archive/cycles/009/gap-analysis.md MG1; archive/cycles/009/decision-log.md OQ-5
- **Impact**: Diagnostic findings on the unfixable path are surfaced to the user at escalation time (Phase 9 context field) but not recorded in the permanent journal. The asymmetry between fixable and unfixable paths is a documentation gap, not a functional failure.
- **Status**: resolved
- **Resolution**: WI-124 added an exact quoted journal template to the unfixable path in both `skills/execute/SKILL.md` and `skills/brrr/phases/execute.md`.
- **Resolved in**: cycle 010

## Q-31: Fixable-path journal note is prose, not a quoted template
- **Question**: The unfixable startup-failure path (added by WI-124) has an exact quoted journal template. The fixable path still says "Note in the journal as significant rework" — prose with no template string. Should both skill files replace the prose note with a quoted template, e.g. `` `Rework: Startup failure root cause diagnosed and fixed. {brief description of fix}.` ``?
- **Source**: archive/cycles/010/code-quality.md M1; archive/cycles/010/gap-analysis.md MG2 (`skills/execute/SKILL.md:402`), MG3 (`skills/brrr/phases/execute.md:158`)
- **Impact**: Fixable-path journal entries are unpredictably formatted across executor runs. If journal parsing is ever automated, the fixable-path entries will not parse reliably. Asymmetry with the unfixable path is a consistency gap.
- **Status**: resolved
- **Resolution**: WI-127 replaced the prose note in both `skills/execute/SKILL.md:402` and `skills/brrr/phases/execute.md:158` with the exact quoted template: `` `Rework: Startup failure root cause diagnosed and fixed. {brief description of fix}.` ``
- **Resolved in**: cycle 011

## Q-32: P-22 Amended field does not record cycle 010
- **Question**: WI-123 modified P-22's body in cycle 010 but the `Amended` metadata read only `cycle 009`. Should the field be updated to `cycle 009, cycle 010`?
- **Source**: archive/cycles/010/gap-analysis.md MG1; archive/cycles/010/decision-log.md OQ-7
- **Impact**: P-22 amendment trail is incomplete; stated provenance disagrees with change history.
- **Status**: resolved
- **Resolution**: Domain curator updated the `Amended` field in `specs/domains/workflow/policies.md` to `cycle 009, cycle 010` during cycle 010 curator pass.
- **Resolved in**: cycle 010

## Q-33: Inline code-reviewer prompts use narrower smoke test trigger than agent definition
- **Question**: `skills/execute/SKILL.md:325` and `skills/brrr/phases/execute.md:113` pass inline prompts to the code-reviewer that read "If the project cannot build or start, report a Critical finding." WI-126 generalized the agent definition to "If the smoke test fails" — a broader condition covering library builds, e2e tests, and CLI invocations. The inline override was excluded from WI-126 scope by AC-7. Should both inline prompts be updated to match the agent definition?
- **Source**: archive/cycles/011/code-quality.md S1; archive/cycles/011/spec-adherence.md U1; archive/cycles/011/gap-analysis.md IG1; archive/cycles/011/decision-log.md OQ-8
- **Impact**: Code-reviewers spawned via execute or brrr receive contradictory guidance about when to emit a Critical finding. For library, CLI, e2e, and documentation-only projects, the inline override may suppress correct Critical findings that the generalized smoke test would otherwise produce.
- **Status**: resolved
- **Resolution**: WI-129 replaced "cannot build or start" with "smoke test fails" in both inline prompts at `skills/execute/SKILL.md:325` and `skills/brrr/phases/execute.md:113`.
- **Resolved in**: cycle 012

## Q-34: brrr "Critical findings fixable within scope" label lacks exclusion qualifier
- **Question**: `skills/execute/SKILL.md:410` has the explicit label "**General critical findings (non-startup-failure, non-infrastructure-failure)**" to bound which Critical findings the default fixable-within-scope path applies to. The equivalent bullet in `skills/brrr/phases/execute.md:160` reads "**Critical findings fixable within scope**" with no such qualifier. Should the qualifier be added to match?
- **Source**: archive/cycles/011/code-quality.md M2; archive/cycles/011/decision-log.md OQ-9
- **Impact**: An executor reading the brrr file could route a startup-failure or infra-failure Critical finding through the default path if the finding title does not exactly match the named exception patterns. The ambiguity is title-matching-sensitive and low-frequency but could produce incorrect behavior.
- **Status**: resolved
- **Resolution**: WI-129 added the "(non-startup-failure, non-infrastructure-failure)" qualifier to the brrr finding-handling label at `skills/brrr/phases/execute.md:160`.
- **Resolved in**: cycle 012

## Q-71: `pretest` does not fail-fast when `migrate-to-v3.js` is stale or absent
- **Question**: The `pretest` hook detects staleness and emits a warning to stderr but exits 0. A developer running `npm test` with a stale or absent compiled file sees the warning scroll past and proceeds with potentially incorrect results. Additionally, when `migrate-to-v3.js` does not exist (fresh clone before running `build:migration`), `statSync` throws and the `catch(e) {}` block swallows the error silently — no warning is emitted at all. Should `pretest` exit non-zero on staleness or absence?
- **Source**: archive/cycles/020/code-quality.md M2; archive/cycles/020/gap-analysis.md MI1; archive/cycles/020/decision-log.md Q-71
- **Impact**: CI and local runs against stale or absent compiled scripts produce incorrect test results with no machine-readable signal. On a fresh clone, the missing-file case produces no signal whatsoever.
- **Status**: resolved
- **Resolution**: WI-178 hardened `pretest` to exit 1 with a warning when `.js` is absent (ENOENT), exit 1 with a staleness warning when `.js` mtime is less than `.ts` mtime, and exit 0 when both files exist and `.js` is current. See D-102.
- **Resolved in**: cycle 021

## Q-72: `pretest` outer catch silently swallows all errors on `migrate-to-v3.ts` stat
- **Question**: The outer `try/catch(e) {}` in `pretest` wraps the `statSync` call on `migrate-to-v3.ts`. Any error — wrong working directory, permissions, `.ts` absent — is swallowed silently and `pretest` exits 0. The design is intentional (specs/plan/notes/178.md line 56: "don't want infra issues to break test runs"), but no inline comment documents this. The one-liner format prevents adding a comment directly.
- **Source**: archive/cycles/021/code-quality.md M1; archive/cycles/021/gap-analysis.md MG1; archive/cycles/021/decision-log.md Q-72
- **Impact**: Future readers may silently inherit a broken pretest guard and not realize the outer catch is intentionally permissive. Behavior is correct per spec; this is a documentation gap only.
- **Status**: open
- **Reexamination trigger**: Any future touch to the `pretest` script; add a comment or update surrounding documentation to note the intentional permissiveness.
