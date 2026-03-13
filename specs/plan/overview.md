# Refinement Plan — brrr Critical Fixes (Cycle 002)

## What Is Changing

Fixing two defects in the brrr skill that prevent correct operation on standard installations without outpost configured:

1. **Phase 6c convergence check** — Replace `spawn_session` invocation with Agent tool using `subagent_type: "spec-reviewer"` (with fallback for when Agent tool is unavailable)
2. **DEFERRED/DEFER label mismatch** — Change brrr's string comparison from `DEFERRED` to `DEFER` to match proxy-human output contract

## Triggering Context

Review findings from cycle 001 (outpost split):
- S1: spawn_session in brrr Phase 6c has no fallback — without outpost, convergence cannot be declared
- S2: Decision label mismatch — proxy-human deferrals are silently dropped

Both are blockers for brrr correctness on standard installations.

## What Is NOT Changing

- G1 (CLAUDE.md creation) — deferred to future cycle
- Stream 2 items (plugin manifest updates, preference ordering, duplicate work item cleanup) — all deferred
- No architectural changes
- No new features or scope expansions

## Scope

**Modify:**
- `skills/brrr/SKILL.md` — Phase 6c Condition B (Agent tool invocation)
- `skills/brrr/SKILL.md` — line 317 (DEFERRED → DEFER)

## Expected Impact

After this cycle:
- brrr can declare convergence on installations without outpost
- Proxy-human deferrals are correctly captured and reported
- Minor: May include optional fixes for confidence level case and fallback entry heading format

## New Work Items

WI-072 through WI-073 (2 items, parallelizable).
