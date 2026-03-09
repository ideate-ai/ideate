# 008: Review Skill

## Objective
Define the `/ideate:review` skill — comprehensive multi-perspective review of completed work against the plan, guiding principles, and original intent.

## Acceptance Criteria
- [ ] `skills/review/SKILL.md` exists with valid frontmatter (description, user-invocable: true, argument-hint)
- [ ] Skill locates artifact directory (from argument or by searching)
- [ ] Reads all context: steering docs, plan docs, all work items, all incremental reviews, journal, and surveys actual project source code
- [ ] Spawns four review agents in parallel:
  - `code-reviewer`: full codebase quality review
  - `spec-reviewer`: adherence to architecture, principles, acceptance criteria
  - `gap-analyst`: missing requirements, edge cases, implicit requirements
  - `journal-keeper`: decision synthesis and open questions
- [ ] Each reviewer receives relevant context and access to source code
- [ ] Reviewer outputs written to `reviews/final/`:
  - `code-quality.md`
  - `spec-adherence.md`
  - `gap-analysis.md`
  - `decision-log.md`
- [ ] Synthesis produced as `reviews/final/summary.md`:
  - All findings by severity (critical/significant/minor/suggestion)
  - Each finding mapped to guiding principle or work item
  - Findings requiring user input identified separately
  - Proposed refinement plan if findings warrant another cycle
- [ ] Journal appended with review summary (finding counts by severity)
- [ ] Findings requiring user decisions presented directly — answers recorded in journal
- [ ] If review warrants another cycle, suggests `/ideate:refine` with specific scope

## File Scope
- `skills/review/SKILL.md` (create)

## Dependencies
- Depends on: 001, 004
- Blocks: none

## Implementation Notes
The review skill is a coordinator — it spawns specialized reviewers and synthesizes their findings. It does not do the reviewing itself.

**Incremental review integration**: The comprehensive review should account for what was already caught and fixed during incremental reviews. The spec-reviewer and gap-analyst should read `reviews/incremental/` to understand what was already addressed. The comprehensive review focuses on cross-cutting concerns that per-item reviews can't see: consistency across modules, integration completeness, architectural coherence.

**Evaluation against both pillars**: The review maps to the two evaluation pillars:
1. Requirements fulfillment (spec-reviewer + gap-analyst): does the output match what was asked?
2. Technical correctness (code-reviewer): does it work as written?

**User decision handling**: Some findings require decisions that existing steering documents don't cover. These are presented to the user, and their answers are recorded in `journal.md` for future reference. This is how the steering context grows over iterations.

**Refinement recommendation**: If there are enough findings to warrant another development cycle, the summary should outline what `/ideate:refine` should address — specific areas, not just "fix the bugs." This feeds directly into the refine skill's interview.

## Complexity
Medium
