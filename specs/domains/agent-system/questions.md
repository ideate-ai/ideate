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
- **Impact**: Very large projects (requiring multiple levels of decomposition deeper than architecture -> modules -> work items) cannot be fully automated within ideate alone.
- **Status**: open
- **Reexamination trigger**: First project encountered that requires more than one level of module decomposition to reach atomic work items.

## Q-15: Three agent definitions reference stale reviews/incremental/ path
- **Question**: Should `agents/spec-reviewer.md:26`, `agents/gap-analyst.md:24`, and `agents/journal-keeper.md:20` replace `reviews/incremental/` with `archive/incremental/`?
- **Source**: archive/cycles/006/gap-analysis.md SG2; archive/cycles/006/decision-log.md D16, OQ2
- **Impact**: Agents following these definitions read from a non-existent directory and silently proceed without incremental review context. spec-reviewer's deduplication instruction and journal-keeper's synthesis both depend on this context. The problem compounds on every review cycle until fixed.
- **Status**: reopened
- **Prior resolution**: Marked resolved in cycle 003 (WI-111 reported all three agent files already used the correct path). Cycle 005 code-quality M2 and gap-analysis MG1 independently confirmed that `agents/spec-reviewer.md:26` and `agents/gap-analyst.md:24` still reference `reviews/incremental/`. The cycle 003 resolution was incorrect.
- **Reexamination trigger**: Next cycle; all three files can be fixed in a single work item alongside Q-22 and Q-23.

## Q-19: Suggestion heading pattern has no producer in code-reviewer output format
- **Question**: `skills/brrr/phases/review.md:212,216` counts `### Suggestion` headings in code-quality.md to derive `findings.by_severity.suggestion` and `by_reviewer.code-reviewer.suggestion`. The code-reviewer agent output format (`agents/code-reviewer.md`) defines only `### C`, `### S`, and `### M` heading sections — there is no mechanism for the code-reviewer to produce suggestion-level findings. Should the suggestion count be hardcoded to 0 for code-reviewer, or should a `## Suggestions` section be added to the code-reviewer output format?
- **Source**: archive/cycles/003/code-quality.md M1; archive/cycles/003/decision-log.md OQ2
- **Impact**: `by_reviewer.code-reviewer.suggestion` is structurally impossible to be non-zero. Related to Q-16 (no consumer for `by_reviewer.suggestion`); together these suggest the suggestion sub-field in `by_reviewer` may be vestigial.
- **Status**: open
- **Reexamination trigger**: When the suggestion derivation rules for quality_summary are next revised, or when Q-16 is addressed.

## Q-25: Cross-reference labels in spawn prompts do not match actual agent definition section headings
- **Question**: Spawn prompts in `skills/execute/SKILL.md` and `skills/brrr/phases/execute.md` reference `"Dynamic Testing > Incremental review scope"` and `"Dynamic Testing > Comprehensive review scope"`, but the actual headings in `agents/code-reviewer.md` are `**Step 2 — Incremental review scope (single work item):**` and `**Step 3 — Comprehensive review scope (full project):**`. Should the spawn prompt cross-references be updated to exactly match the bold-step headings, or should standalone label anchors be added above each step?
- **Source**: archive/cycles/007/code-quality.md M1
- **Impact**: Functionally sufficient — key terms are unique substrings and the cross-references resolve unambiguously in practice. Cosmetic only. Exact matching would reduce ambiguity when the agent definition evolves.
- **Status**: open
- **Reexamination trigger**: Next documentation pass touching agents/code-reviewer.md or the dynamic testing spawn prompts.
