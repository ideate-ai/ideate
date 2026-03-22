# Gap Analysis — Cycle 007

**Reviewer**: gap-analyst (capstone)
**Date**: 2026-03-22
**Scope**: WI-117, WI-118, WI-119 (dynamic testing guidance additions)

## Verdict: Fail

One significant gap: the startup failure → Andon routing is not unconditionally enforced in the execute finding-handling logic. All other gaps are minor or informational.

## Missing Requirements from Interview

None. All stated requirements from Change Plan Cycle 010 (`specs/plan/overview.md`) are present in the delivered artifacts.

## Unhandled Edge Cases

### EC1: Smoke test with no defined stop condition (hanging process)
- **Component**: `agents/code-reviewer.md` — Dynamic Testing, Step 2
- **Scenario**: A project requiring docker-compose, a database connection, or a network service to start. The smoke test instruction says "attempt to import the main module or start the app in dry-run mode." An app with external service dependencies will hang, blocking the reviewer indefinitely.
- **Current behavior**: No timeout instruction and no guidance to avoid commands that spawn persistent processes or wait on external services.
- **Expected behavior**: Agent should use only non-blocking probes (dry-run flags, syntax checks, `--help`/`--version`). If the startup command requires external services, classify as non-runnable (same as the Minor finding path in Step 3).
- **Severity**: Minor
- **Recommendation**: Defer — add a note to Step 2 that smoke tests must use non-blocking probes only.

### EC2: Library or batch-processor project has no startup proxy
- **Component**: `agents/code-reviewer.md` — Dynamic Testing, Step 2
- **Scenario**: A library (no entry point), batch processor, or data pipeline. The smoke test step covers compiled/interpreted/CLI but not libraries — which have no `--help` flag and can produce usage errors misclassified as startup failures.
- **Severity**: Minor
- **Recommendation**: Defer — the compiled-language build path is sufficient for libraries. A clarifying note would prevent false Critical findings.

## Incomplete Integrations

### II1: Startup failure → Andon routing not explicitly unconditional in execute finding-handling
- **Producer**: `agents/code-reviewer.md:91` — instructs reviewer to mark startup failure as "scope-changing"
- **Consumer**: `skills/execute/SKILL.md` Phase 8; `skills/brrr/phases/execute.md` finding-handling block
- **Gap**: Phase 8 defines scope-changing as "requires changes to other work items, architectural changes, or contradicts guiding principles." A startup failure caused by a simple typo appears fixable within scope. A worker executing Phase 8 may silently fix the startup issue rather than escalating. The code-reviewer marks the finding as scope-changing in its description, but Phase 8 instructs the execute skill to make its own judgment on scope. Neither `skills/execute/SKILL.md` Phase 8 nor `skills/brrr/phases/execute.md` finding-handling contains an explicit rule that "Startup failure after ..." findings are always Andon-level regardless of apparent fixability.
- **Impact**: A work item that breaks app startup could be silently fixed by a worker who sees the fix as trivial, bypassing the quality floor this cycle was designed to establish.
- **Severity**: Significant
- **Recommendation**: Address in next cycle — add an explicit rule to Phase 8 of `skills/execute/SKILL.md` and to the finding-handling block of `skills/brrr/phases/execute.md`: any Critical finding titled "Startup failure after ..." is always treated as scope-changing and routed to the Andon cord, regardless of whether a fix appears available within the work item's scope.

## Missing Infrastructure

### MI1: refine skill does not spawn code-reviewer — Dynamic Testing guidance has no effect on refine
- **Gap**: `skills/refine/SKILL.md` spawns architect and researcher agents, not the code-reviewer. Dynamic Testing guidance (WI-117) and spawn prompt additions (WI-118, WI-119) do not affect the refine skill.
- **Impact**: None by design — refine's role is planning the delta. Build verification belongs to the next execute cycle. Architecture table already correctly states code-reviewer is spawned by execute and review only.
- **Severity**: Minor (informational)
- **Recommendation**: No action needed.

## Implicit Requirements

### IR1: brrr main controller (SKILL.md) needs no changes
- The brrr controller delegates entirely to phase documents. Dynamic Testing additions in execute.md and review.md are self-contained within the code-reviewer spawn prompt and introduce no new state or control flow that the controller must handle. Confirmed clean.
- **Severity**: Minor (informational)
- **Recommendation**: No action needed.
