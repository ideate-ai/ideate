# Decisions: Workflow

## D-1: Five-skill SDLC structure (plan / execute / review / refine / brrr)
- **Decision**: Ideate exposes five user-invocable skills covering the full lifecycle from idea to convergence; brrr is the autonomous loop mode added in cycle 1.
- **Rationale**: The interview established that the tool should take a project from spec creation to user-testable output; brrr was added to provide a fully autonomous mode where the user can step away (interview 2026-03-10).
- **Assumes**: Claude Code plugin format supports five skill definitions; skills invoke agents but do not call each other as sub-commands.
- **Source**: plan/architecture.md §3, specs/plan/work-items/037-brrr-skill.md
- **Status**: settled

## D-2: brrr convergence requires zero critical/significant findings AND zero guiding-principle violations simultaneously
- **Decision**: A brrr cycle is declared converged only when the review produces zero critical and zero significant findings and a focused spec-reviewer pass returns "No violations found" for all guiding principles.
- **Rationale**: The user specified "zero violations — it needs to be perfect" during the 2026-03-10 interview; minor findings are explicitly acceptable.
- **Assumes**: The principles-checker spec-reviewer is invoked with a narrow, well-defined prompt (not the full review scope).
- **Source**: specs/plan/work-items/037-brrr-skill.md AC7, specs/steering/interview.md (2026-03-10)
- **Status**: settled

## D-3: Refine appends/updates steering docs — it never silently deletes
- **Decision**: The refine skill appends new content or marks deprecated content; guiding principles are never silently removed; existing entries are never deleted without an explicit deprecation record.
- **Rationale**: Durable knowledge capture (GP-8) requires the artifact directory to be the authoritative record; silent deletion breaks traceability across refinement cycles.
- **Source**: plan/architecture.md §8 (steering/guiding-principles.md semantics), specs/plan/work-items/011-artifact-conventions.md
- **Status**: settled

## D-4: brrr proxy-human Andon path uses native Agent tool, not spawn_session
- **Decision**: brrr Phase 6a invokes proxy-human via the Agent tool with `subagent_type: "proxy-human"` rather than the outpost spawn_session MCP tool; a fallback is documented for environments where the Agent tool is unavailable.
- **Rationale**: After the ideate/outpost split, ideate does not ship session-spawner; the Agent tool is always available in Claude Code and eliminates the MCP dependency for a core SDLC operation (archive/cycles/001/decision-log.md D2).
- **Source**: archive/cycles/001/decision-log.md D2, specs/plan/work-items/057-update-brrr-proxy-human-invocation.md
- **Status**: settled

## D-19: brrr/phases/review.md is an independent reimplementation of review orchestration, not a delegate
- **Decision**: `skills/brrr/phases/review.md` reimplements review orchestration in full; it does not delegate to `skills/review/SKILL.md`. Any feature added to the standalone review skill that should also apply in brrr-driven cycles must be added to both files independently.
- **Rationale**: Cycle 006 gap analysis identified that the quality_summary emission (WI-093) was added only to `skills/review/SKILL.md`. Because brrr does not delegate, brrr-driven projects never emit quality_summary events and the Quality Trends section of report.sh is permanently empty for them. The planning phase did not identify brrr/phases/review.md as a required target.
- **Assumes**: This architectural separation is intentional and will not be unified into a shared review orchestration layer.
- **Source**: archive/cycles/006/decision-log.md D3, D4; archive/cycles/006/gap-analysis.md SG1
- **Policy**: P-18
- **Status**: settled

## D-23: Andon behavior is mode-relative — brrr logs deferrals, standalone execute interrupts
- **Decision**: In brrr mode, proxy-human deferrals are logged visibly in the activity report without interrupting the autonomous loop. In standalone `/ideate:execute`, the existing interrupt-and-ask behavior is unchanged.
- **Rationale**: brrr is designed for full autonomy; interrupting the loop for a deferral contradicts the autonomous design. Standalone execute has a human present, so the interrupt model remains appropriate.
- **Source**: archive/cycles/003/decision-log.md D2
- **Policy**: P-20
- **Status**: settled

## D-24: Domain-curator uses RAG semantic search before writing new policies
- **Decision**: The domain-curator agent performs an MCP semantic search against existing domain files before writing a new policy entry, to detect near-duplicate policies that should be amended rather than duplicated.
- **Rationale**: Decided during refine-008 interview to address policy accumulation risk as the domain layer grows.
- **Source**: archive/cycles/003/decision-log.md D3
- **Status**: settled

## D-31: Full review at cycle 4 revealed pre-existing bugs that incremental reviews missed
- **Decision**: The full capstone review (triggered because cycle 4 met the full_review_interval threshold) discovered two critical and one significant bug in report.sh that had been present since the previous brrr run. Incremental per-item reviewers did not catch these because the bugs span the boundary between two independently-planned work items (WI-093 defined nested schema, WI-094 consumed flat keys).
- **Rationale**: Incremental reviewers lack cross-item schema context. The full review is the designed catch for integration-level defects that span work item boundaries. This validates the full_review_interval mechanism.
- **Source**: archive/cycles/004/decision-log.md D2, CR2; archive/cycles/004/summary.md
- **Policy**: P-21
- **Status**: settled

## D-33: Startup failure Critical findings must bypass execute-skill scope judgment and route unconditionally to Andon
- **Decision**: Any Critical finding produced by the code-reviewer that is titled "Startup failure after ..." must be treated as scope-changing and routed to the Andon cord, regardless of whether the underlying cause appears trivially fixable within the current work item's scope. The execute skill (Phase 8) and brrr's execute phase finding-handling block must enforce this as an explicit named exception, not as an instance of the general scope-changing judgment.
- **Rationale**: Cycle 007 gap-analysis (II1) identified that Phase 8 of `skills/execute/SKILL.md` requires the worker to judge whether a Critical finding is "scope-changing." A startup failure whose root cause appears to be a typo may not trigger that judgment, bypassing the Andon escalation path that the dynamic testing quality floor (WI-117) was designed to establish. The rule must be unconditional to be reliable.
- **Assumes**: The code-reviewer uses the exact title prefix "Startup failure after ..." when reporting this finding class (per agents/code-reviewer.md:91).
- **Source**: archive/cycles/007/gap-analysis.md II1; archive/cycles/007/summary.md Significant Findings
- **Policy**: P-22
- **Status**: settled

## D-34: WI-120 confirmed P-22 enforcement — startup-failure exception implemented in both skill files
- **Decision**: WI-120 added the unconditional startup-failure exception rule to both `skills/execute/SKILL.md` Phase 8 and `skills/brrr/phases/execute.md` finding-handling block. The exception evaluates before the general fixable-within-scope routing logic. All three capstone reviewers returned Pass with zero Critical or Significant findings.
- **Rationale**: D-33 established the rule; WI-120 is its procedural enforcement. The exception is expressed as a named block that keys on the "Startup failure after ..." title prefix. The code-reviewer agent generates that exact title, completing the generation-to-handling round-trip.
- **Source**: archive/cycles/008/decision-log.md D-34; archive/cycles/008/summary.md
- **Policy**: P-22 (enforcement, not amendment)
- **Status**: settled

## D-35: Replace unconditional-Andon startup-failure rule with diagnose-and-fix protocol
- **Decision**: The unconditional-Andon startup-failure rule from D-33/WI-120 was replaced. Startup failures with a diagnosable, in-scope root cause are now fixed autonomously; Andon escalation is reserved for unfixable, out-of-scope, or indeterminate causes.
- **Rationale**: GP-6 ("User intervention is reserved for critical issues that cannot be resolved from existing steering documents") and P-5 both require escalation as last resort. The cycle 008 rule escalated fixable failures to the user unnecessarily.
- **Source**: archive/cycles/009/decision-log.md DL-1; archive/cycles/009/spec-adherence.md
- **Policy**: P-22 (amended in cycle 009)
- **Status**: settled

## D-36: WI-121 scoped to three files; code-reviewer agent excluded
- **Decision**: WI-121 targeted `skills/execute/SKILL.md`, `skills/brrr/phases/execute.md`, and `specs/domains/workflow/policies.md`. `agents/code-reviewer.md` was explicitly excluded despite containing language inconsistent with the new protocol.
- **Rationale**: The scoping decision (D-36) treated the code-reviewer update as secondary, deferred to a future cycle. This produced SG1 in gap analysis.
- **Source**: archive/cycles/009/decision-log.md DL-2, DL-4; archive/cycles/009/gap-analysis.md SG1
- **Status**: settled

## D-37: Smoke-test re-failure fallback added as execution-time extension
- **Decision**: Both skill files were extended beyond WI-121's specified replacement text to add: "If the smoke test still fails after the fix, treat the root cause as indeterminate and route to the Andon cord." Surfaced as M1 in incremental review and fixed before delivery.
- **Rationale**: Without this clause the executor had no instruction if the post-fix smoke test still failed. Behaviorally consistent with P-22's existing "cause is indeterminate" Andon trigger. P-22 was not amended to include this detail.
- **Source**: archive/cycles/009/decision-log.md DL-3; archive/cycles/009/code-quality.md M1; archive/cycles/009/spec-adherence.md D1
- **Status**: settled

## D-39: Added paragraph boundary label between startup-failure block and general Critical findings in execute/SKILL.md
- **Decision**: The label `**General critical findings (non-startup-failure)**:` was added immediately before the general Critical findings paragraph in `skills/execute/SKILL.md` Phase 8. The corresponding brrr file did not need the label because its bullet structure already provides a clear visual boundary.
- **Rationale**: WI-124 incremental review flagged S1: the two adjacent blocks (numbered startup-failure steps and the general Critical paragraph) had no typographic separator. An executor reading sequentially could apply startup-failure routing to all Critical findings. Adding an explicit label closes the ambiguity without restructuring Phase 8.
- **Source**: archive/cycles/010/decision-log.md D-39; archive/cycles/010/spec-adherence.md
- **Status**: settled

## D-41: P-22 back-propagated to include smoke-test re-run and indeterminate classification
- **Decision**: WI-123 appended two sentences to P-22's body: "After applying the fix, the smoke test must be re-run to confirm the app starts. If it still fails, the root cause is classified as indeterminate and the Andon cord must be pulled." P-22 now describes the full five-step startup-failure protocol.
- **Rationale**: D-37 (cycle 009) recorded that the re-run step was added to both skill files at execution time but was never back-propagated to P-22. Future work items consulting P-22 would be missing this requirement, risking regression of the re-run step.
- **Source**: archive/cycles/010/decision-log.md D-41; archive/cycles/010/spec-adherence.md
- **Policy**: P-22 (amendment)
- **Status**: settled

## D-42: Journal instruction added to the unfixable Andon path in both skill files
- **Decision**: WI-124 added an exact quoted journal template to the unfixable startup-failure path in `skills/execute/SKILL.md` Phase 8 and `skills/brrr/phases/execute.md`: `` `Diagnosis: {root cause finding}. Routing to Andon — cause not fixable within work item scope.` ``
- **Rationale**: The fixable path already instructed "note in the journal as significant rework." The unfixable path had no equivalent, meaning diagnostic context was lost when the executor escalated to Andon. The fixable-path instruction provided the precedent; the quoted-template style was used to match it and the unfixable-path entry added by this work item.
- **Source**: archive/cycles/010/decision-log.md D-42; archive/cycles/010/spec-adherence.md
- **Status**: settled

## D-43: Close Q-3 by correcting spawn_session ordering in skills/review/SKILL.md
- **Decision**: WI-125 updated `skills/review/SKILL.md` Phase 4a to state "Use the Agent tool to spawn subagents. If the outpost MCP server is configured, `spawn_session` may be used as an alternative." The error-handling section was also updated to key on Agent tool availability rather than spawn_session unavailability.
- **Rationale**: After the outpost/ideate split, spawning via spawn_session as primary creates visible tool-not-found errors on non-outpost installations. Agent tool is the standard mechanism on all installations; spawn_session is an optional enhancement. Q-3 was the last remaining skill file with the inverted ordering.
- **Source**: archive/cycles/011/decision-log.md D-43; archive/cycles/011/review-manifest.md WI-125
- **Status**: settled

## D-44: Close Q-27 by generalizing smoke test to a context-appropriate demo heuristic
- **Decision**: WI-126 replaced the startup-specific smoke test in `agents/code-reviewer.md` with a heuristic: "what would a reasonable person be expected to do to demo the work they just did?" Five example types are enumerated (startup command, CLI --help/--version, library build/test suite, e2e test, config/doc validation). P-22 updated to reference "context-appropriate smoke test" rather than startup command only.
- **Rationale**: P-22 and the startup-failure exception were inert for library projects, CLI tools, and documentation-only work items that have no meaningful startup step. The demo heuristic generalizes across project types without requiring exhaustive type enumeration.
- **Source**: archive/cycles/011/decision-log.md D-44; archive/cycles/011/review-manifest.md WI-126
- **Policy**: P-22 (amended in cycle 011)
- **Status**: settled

## D-45: Close Q-26 by adding smoke test infrastructure failure handling with regression determination
- **Decision**: WI-128 added a distinct "Smoke test infrastructure failure" exception to both `skills/execute/SKILL.md` and `skills/brrr/phases/execute.md`, and added P-23 to workflow policies. The protocol requires regression determination before Andon: if the failure is determined to be a regression caused by this work item's changes, diagnose and attempt a surgical fix; if not a regression, route to Andon immediately.
- **Rationale**: The startup-failure exception covers application failures but not infrastructure failures (runner not found, environment setup error, pre-execution crash). Treating these as identical failure modes was undefined behavior. Regression determination prevents excessive Andon escalations for pre-existing or environmental failures.
- **Source**: archive/cycles/011/decision-log.md D-45; archive/cycles/011/review-manifest.md WI-128
- **Policy**: P-23
- **Status**: settled

## D-46: Close Q-31 by replacing fixable-path prose note with exact quoted journal template
- **Decision**: WI-127 replaced "Note in the journal as significant rework" in both `skills/execute/SKILL.md:402` and `skills/brrr/phases/execute.md:158` with an exact quoted template: `` `Rework: Startup failure root cause diagnosed and fixed. {brief description of fix}.` ``
- **Rationale**: The unfixable startup-failure path (WI-124, cycle 010) used an exact quoted template. The fixable path used prose with no template string, creating an asymmetry and a latent journal-parsing risk. The template format mirrors the unfixable-path convention established in cycle 010.
- **Source**: archive/cycles/011/decision-log.md D-46; archive/cycles/011/review-manifest.md WI-127
- **Status**: settled

## D-48: Close Q-33 and Q-34 by updating inline prompts and brrr label qualifier
- **Decision**: WI-129 completed the smoke test generalization by making three string replacements: (1) `skills/execute/SKILL.md:325` inline prompt changed from "cannot build or start" to "smoke test fails"; (2) `skills/brrr/phases/execute.md:113` same replacement; (3) `skills/brrr/phases/execute.md:160` label amended to include "(non-startup-failure, non-infrastructure-failure)" qualifier. All three locations now use language consistent with the generalized agent definition (D-44/WI-126) and the execute skill's label (D-39).
- **Rationale**: WI-126 (cycle 011) generalized the agent definition but excluded inline prompt fragments by AC-7. The inline prompts retained pre-generalization language, creating contradictory guidance for code-reviewers spawned via execute or brrr. The brrr label lacked the exclusion qualifier present in the execute skill, risking misrouting of startup-failure or infra-failure findings.
- **Source**: archive/cycles/012/decision-log.md D-48; archive/cycles/012/summary.md
- **Status**: settled

## D-57: Watcher ignored-pattern bug survived all incremental reviews because no integration test exercised the async event path
- **Decision**: The chokidar `ignored: /(^|[/\\])\../` bug in `watcher.ts:24` caused the watcher to never fire for any `.ideate/` files, making incremental rebuild entirely non-functional. All seven incremental reviews for WI-143 through WI-149 returned Pass. The bug was caught only in the capstone review. No integration test existed that wrote a YAML file to a temp `.ideate/` directory and asserted the watcher triggered a rebuild.
- **Rationale**: Three independent reviewers (code-reviewer, spec-reviewer, gap-analyst) independently flagged both the bug and the missing integration test. The gap is structural: unit tests on the watcher and rebuild functions in isolation cannot detect a broken wiring between them. Only an end-to-end test of the assembled chain (file write -> watcher event -> rebuild call) would have caught this.
- **Source**: archive/cycles/016/code-quality.md C1, M5; archive/cycles/016/gap-analysis.md G2; archive/cycles/016/decision-log.md Q1
- **Policy**: P-24
- **Status**: settled

## D-75: Cycle 017 incremental-vs-capstone divergence confirms cross-item gap pattern from D-31
- **Decision**: Cycle 017 reproduced the D-31 pattern at larger scale: 10 incremental Pass verdicts against 3 capstone Fail verdicts on the same work items. The `deleteStaleRows` omission (WI-154) was missed by the incremental reviewer and independently caught by all three capstone reviewers. The migration completeness gaps (WI-157 vs WI-146) were similarly invisible to the per-item reviewer who lacked the parent spec context.
- **Rationale**: This is the same structural limitation identified in D-31/cycle 004: incremental reviewers operate on a single work item in isolation and cannot detect when a work item's notes spec is incomplete relative to its parent feature spec or when an acceptance criterion is unmet in code sections outside the work item's primary diff.
- **Source**: archive/cycles/017/decision-log.md D-014; archive/cycles/017/summary.md
- **Policy**: P-30
- **Status**: settled

## D-76: Cycle 018 all three capstone reviewers issued Pass — Phase 1 residual work fully addressed
- **Decision**: Cycle 018 (covering execution cycles 018 and 019) produced Pass verdicts from all three capstone reviewers (code-quality Pass with caveats, spec-adherence Pass, gap-analysis Pass). All 10 work items (WI-160 through WI-169) met acceptance criteria. 137 tests pass. Five significant findings are performance/maintenance concerns, not correctness bugs.
- **Rationale**: This reverses the cycle 017 triple-Fail outcome (D-74). The residual gaps from cycle 017 (deleteStaleRows Drizzle conversion, migration field extraction, plan/steering/interview migration, spec cleanup, domainQuestions column, document_artifacts table) are all resolved.
- **Source**: archive/cycles/018/summary.md; archive/cycles/018/review-manifest.md
- **Status**: settled

## D-78: WI-165 Andon cord correctly routed out-of-scope Critical finding to user — produced WI-168
- **Decision**: WI-165's incremental review emitted a Critical finding (three archive document types unknown to the indexer). The executor routed it to the Andon cord rather than attempting an in-scope fix, because the fix required changes to schema.ts, db.ts, and indexer.ts (all outside WI-165 scope). User decision created WI-168 to register all 10 unregistered document types via a new `document_artifacts` table.
- **Rationale**: Correct application of P-22 and P-23 — the finding was out-of-scope for WI-165 and required architectural changes. The Andon-to-WI-168 path demonstrates the designed flow: escalate, bound the follow-up, execute in a new work item.
- **Source**: archive/cycles/018/decision-log.md E3, E4; archive/cycles/018/spec-adherence.md (Principle 6 evidence)
- **Status**: settled

## D-102: Q-68 and Q-71 combined into a single work item targeting package.json
- **Decision**: Q-68 (stale `.d.ts`/`.js.map` files not cleaned by `build:migration`) and Q-71 (`pretest` exits 0 on stale or absent `.js`) were combined into WI-178 rather than planned as two separate work items, because both changes targeted `mcp/artifact-server/package.json` exclusively with no logical dependency between them.
- **Rationale**: Both questions were build-tooling hygiene with a shared single-file scope. One work item avoids unnecessary parallelism overhead for two-line changes in the same file; combining also prevents a potential edit conflict if both work items ran in parallel.
- **Source**: archive/cycles/021/decision-log.md D-102; WI-178
- **Status**: settled
