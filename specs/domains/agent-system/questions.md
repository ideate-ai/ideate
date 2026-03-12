# Questions: Agent System

## Q-6: proxy-human confidence level case is inconsistent between output contract and log format
- **Question**: `agents/proxy-human.md` output contract specifies lowercase confidence values (`high|medium|low`) but the log format uses uppercase (`HIGH/MEDIUM/LOW`). Which is canonical?
- **Source**: archive/cycles/001/decision-log.md OQ6, archive/cycles/001/summary.md Minor M3
- **Impact**: brrr Phase 9 activity report parses confidence-level summaries from proxy-human-log.md; case-sensitive parsing may fail to aggregate correctly.
- **Status**: open
- **Reexamination trigger**: Next refinement — gap analyst recommendation is to standardize on uppercase since the durable log artifact already uses uppercase.

## Q-7: brrr fallback entry heading format for proxy-human-log.md not specified
- **Question**: The fallback path at `skills/brrr/SKILL.md:321` instructs brrr to write a proxy-human-log entry with `[brrr-fallback]` notation but does not specify the heading format. Phase 9 looks for `## [proxy-human] {date} — Cycle N`. Will fallback entries be found by Phase 9?
- **Source**: archive/cycles/001/decision-log.md OQ7, archive/cycles/001/summary.md Minor M4
- **Impact**: Andon events handled via the fallback path are invisible in the Phase 9 activity report; the cycle's Andon count will be undercounted.
- **Status**: open
- **Reexamination trigger**: Next refinement — the fix is to specify that fallback entries use `## [proxy-human] {date} — Cycle {N}` heading with `[brrr-fallback]` in the Rationale field.

## Q-8: No sub-subagents or nested teams — recursive decomposition requires external tooling
- **Question**: Claude Code does not support subagents spawning their own subagents. For truly large projects requiring recursive decomposition (GP-7), what external tooling fills this gap, and when should it be built?
- **Source**: specs/steering/constraints.md C-5, specs/steering/guiding-principles.md GP-7, specs/steering/interview.md (2026-03-08)
- **Impact**: Very large projects (requiring multiple levels of decomposition deeper than architecture → modules → work items) cannot be fully automated within ideate alone.
- **Status**: open
- **Reexamination trigger**: First project encountered that requires more than one level of module decomposition to reach atomic work items.
