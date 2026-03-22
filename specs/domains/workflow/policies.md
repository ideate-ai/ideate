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

## P-22: Startup failure Critical findings always route to Andon — execute skill must not apply scope judgment
When the code-reviewer emits a Critical finding titled "Startup failure after ...", `skills/execute/SKILL.md` Phase 8 and `skills/brrr/phases/execute.md` finding-handling must treat it as scope-changing unconditionally. The execute skill's general scope-judgment rule does not apply to this finding class; apparent fixability within the work item's scope is not a valid reason to suppress escalation.
- **Derived from**: D-33 (Startup failure must bypass scope judgment)
- **Established**: cycle 007
- **Status**: active
