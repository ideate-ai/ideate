---
## Refinement Interview — 2026-03-22

**Context**: Post-review correction following Cycle 007. Significant finding II1: startup failure Critical findings are not unconditionally routed to Andon in execute/brrr finding-handling. User confirmed: address II1 only; defer EC1/EC2 edge cases; all 12 guiding principles hold.

**Q: Address just II1, or bundle EC1/EC2 into the agent definition as a second work item?**
A: II1 only. EC1/EC2 touch a different file and are genuine edge cases already tagged defer. Keeping WI-120 focused is the right call.

**Q: All 12 guiding principles still hold?**
A: Yes.

**Scope**: WI-120 — add explicit "Startup failure after ..." exception rule to Phase 8 of `skills/execute/SKILL.md` and finding-handling block of `skills/brrr/phases/execute.md`.
