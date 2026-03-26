# Policies: Workflow

## P-1: Spec sufficiency before execution
No work item may be handed to an executor until any reasonable question about the system can be answered from the specs alone; if two independent LLM runs given the same spec would diverge, the spec is incomplete.
- **Derived from**: GP-1 (Spec Sufficiency)
- **Established**: planning phase
- **Status**: active

## P-2: Executor makes no subjective decisions
All architectural choices, technology selections, interface contracts, error handling strategies, and behavioral details must be resolved during planning; the executor follows instructions and does not design.
- **Derived from**: GP-2 (Minimal Inference at Execution)
- **Established**: planning phase
- **Status**: active

## P-3: Parallel execution is the default
Work items must be scoped to have non-overlapping file ownership so they can run concurrently; sequential ordering is reserved for work items with genuine data dependencies.
- **Derived from**: GP-4 (Parallel-First Design)
- **Established**: planning phase
- **Status**: active

## P-4: Review overlaps execution — do not wait for the end
The code-reviewer is spawned immediately upon each work item's completion while other items continue; the capstone review is additive synthesis, not the first quality check.
- **Derived from**: GP-5 (Continuous Review)
- **Established**: planning phase
- **Status**: active

## P-5: User intervention is reserved for issues that guiding principles cannot resolve
During execute, review, and brrr phases the user is not consulted for routine decisions; unresolvable gaps are batched and surfaced at natural pause points or when blocking progress (Andon cord).
- **Derived from**: GP-6 (Andon Cord Interaction Model)
- **Established**: planning phase
- **Status**: active

## P-18: Work items for review-skill features must include skills/brrr/phases/review.md in scope
When a feature is added to `skills/review/SKILL.md` that governs review orchestration behavior (event emission, agent sequencing, output format), the corresponding work item must also list `skills/brrr/phases/review.md` in its file scope, because brrr reimplements review orchestration independently and does not inherit changes to the standalone review skill.
- **Derived from**: D-19 (brrr/phases/review.md is an independent reimplementation)
- **Established**: cycle 006
- **Status**: active

## P-20: Andon deferral handling differs by execution mode
In brrr mode, proxy-human deferrals are logged to `proxy-human-log.md` without interrupting the autonomous loop; the deferral appears in the Phase 9 activity report. In standalone `/ideate:execute`, deferrals interrupt execution and prompt the user directly.
- **Derived from**: D-23 (Andon behavior is mode-relative)
- **Established**: cycle 003
- **Status**: active

## P-21: Planning notes for consumer work items must cite the producer's schema definition
When two or more work items share a data contract (one defines a schema, another reads it), the planning note for the consumer must explicitly cite the producer work item's schema definition by file and section. Relying on parallel but independently-worded schema descriptions across planning notes risks contradictory assumptions that incremental reviewers cannot detect.
- **Derived from**: D-31 (Full review revealed cross-item spec inconsistency); D-28 (report.sh nested vs flat severity path)
- **Established**: cycle 004
- **Status**: active

## P-22: Startup failure Critical findings require immediate diagnosis and surgical fix; Andon only if unfixable
When the code-reviewer emits a Critical finding titled "Startup failure after ...", `skills/execute/SKILL.md` Phase 8 and `skills/brrr/phases/execute.md` finding-handling must immediately diagnose the root cause and apply a surgical fix if the cause is within the current work item's scope. After applying the fix, the smoke test must be re-run to confirm the smoke test passes. If it still fails, the root cause is classified as indeterminate and the Andon cord must be pulled. If the Andon cord is triggered, the executor must record a journal entry before escalating. The Andon cord is triggered only if the root cause cannot be fixed (requires changes outside the current work item, architectural changes, or the cause is indeterminate). Silent correction without diagnosis and user escalation without attempted repair are both incorrect. The appropriate smoke test is determined by the code-reviewer based on the work item's context — what a reasonable person would be expected to do to demo the work just completed (startup command, CLI invocation, library build, e2e test, or config/doc validation, as appropriate).
- **Derived from**: D-33 (amended), user correction after Cycle 008
- **Established**: cycle 007
- **Amended**: cycle 009, cycle 010, cycle 011
- **Status**: active

## P-23: Smoke test infrastructure failures require regression determination before Andon escalation
When the smoke test cannot execute at all (infrastructure failure — runner not found, environment setup error, pre-execution crash), the executor must determine whether the failure is a regression caused by this work item's changes before routing to Andon. If the failure is determined to be a regression (e.g., the work item changed config, dependencies, port bindings, or environment files and those changes are causally linked to the failure), diagnose and attempt a careful surgical fix within scope. If the fix fails or the failure is not a regression (pre-existing or environmental), route to Andon with a journal note citing the diagnostic finding. Silent treatment of infra failures as application failures is incorrect.
- **Derived from**: D-45 (smoke test infrastructure failure handling); Q-26 (smoke test blocking scenario); user decision in cycle 011 refinement interview
- **Established**: cycle 011
- **Status**: active

## P-24: Work items implementing async event paths in a background service must include an end-to-end integration test for that path
When a work item delivers a feature that depends on an asynchronous event chain (e.g., file watcher -> callback -> index rebuild), the work item's acceptance criteria must include at least one integration test that exercises the full chain end-to-end against a real or realistic environment. Unit tests on individual links in the chain are insufficient — the chain must be tested as assembled. A missing integration test for an async path is a specification gap, not merely a quality gap.
- **Derived from**: D-57 (watcher ignored-pattern bug survived all incremental reviews due to absent integration test)
- **Established**: cycle 016
- **Status**: active

## P-30: Child work item notes specs must be cross-checked against the parent feature spec for scope completeness
When a refinement cycle decomposes a feature-level spec (e.g., WI-146 "migration script") into per-cycle child work items (e.g., WI-157 "migration completion"), the child's notes spec must be validated against the parent for missing steps before execution begins. The decomposer or refiner must confirm that the union of all child work items covers every step in the parent spec. Omissions in a child spec are invisible to incremental reviewers who see only the child's notes — the capstone review is the first opportunity to detect gaps, at which point rework is required.
- **Derived from**: D-75 (cycle 017 incremental-vs-capstone divergence); D-66 (migration script implemented against WI-157 without checking WI-146 steps 7-12)
- **Established**: cycle 017
- **Status**: active
