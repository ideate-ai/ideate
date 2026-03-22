# Refinement Interview — 2026-03-22 (Compiled Transcript)

**Trigger**: Cycle 007 gap-analysis II1 (Significant). Startup failure Critical findings are not unconditionally routed to Andon in execute/brrr finding-handling.

See `_general.md` for Q&A transcript.

## Summary

**Change**: Add explicit exception rule to execute finding-handling in two files.

**WI-120**: `skills/execute/SKILL.md` Phase 8 + `skills/brrr/phases/execute.md` finding-handling — any Critical finding titled "Startup failure after ..." is always treated as scope-changing and routed to Andon, regardless of apparent fixability.

**Deferred**: EC1 (blocking smoke test), EC2 (library projects), M1 (cross-reference format).
