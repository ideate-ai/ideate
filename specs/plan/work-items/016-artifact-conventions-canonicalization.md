# 016: Artifact Conventions Canonicalization

## Objective
Align artifact-conventions.md with the formats that agents and skills actually produce. Eliminate the three-way format divergence for incremental reviews and the agent-vs-conventions mismatch for final reviews.

## Acceptance Criteria
- [ ] Incremental review format in artifact-conventions.md matches the format used by the code-reviewer agent and the execute skill: `## Verdict: {Pass | Fail}` on one line, finding sections with `### C1:` / `### S1:` / `### M1:` numbered subsections, each with `File`, `Issue`, `Impact`, `Suggested fix` sub-fields, and a separate `## Unmet Acceptance Criteria` section
- [ ] Final review formats in artifact-conventions.md match the corresponding agent output formats:
  - `code-quality.md` matches code-reviewer agent comprehensive review format
  - `spec-adherence.md` matches spec-reviewer agent format (deviations, unmet criteria, principle violations, undocumented additions)
  - `gap-analysis.md` matches gap-analyst agent format (categorized gaps with severity and recommendation)
  - `decision-log.md` matches journal-keeper agent format (decision log + open questions with structured fields)
- [ ] `summary.md` format matches what the review skill actually produces
- [ ] No format in artifact-conventions.md contradicts any agent or skill definition

## File Scope
- `specs/artifact-conventions.md` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
Read each agent definition (`agents/code-reviewer.md`, `agents/spec-reviewer.md`, `agents/gap-analyst.md`, `agents/journal-keeper.md`) and each skill that produces review output (`skills/execute/SKILL.md`, `skills/review/SKILL.md`). Extract the canonical format from each. Update artifact-conventions.md to match.

The code-reviewer agent's format is the most detailed and should be treated as authoritative for incremental reviews. For final reviews, each agent's own output format is authoritative for its corresponding file.

## Complexity
Medium
