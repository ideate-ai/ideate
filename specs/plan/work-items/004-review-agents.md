# 004: Review Agents (code-reviewer, spec-reviewer, gap-analyst, journal-keeper)

## Objective
Define four specialized review agents that provide different perspectives on completed work. Used during both incremental (per-item) and comprehensive (end-of-cycle) review.

## Acceptance Criteria

### code-reviewer
- [ ] `agents/code-reviewer.md` exists with valid frontmatter
- [ ] Tools: Read, Grep, Glob, Bash
- [ ] Checks: acceptance criteria satisfaction, correctness (logic errors, race conditions, null handling), security (OWASP top 10), quality (readability, dead code, complexity), test coverage
- [ ] Output format: Verdict (Pass/Fail), Findings by severity (Critical/Significant/Minor), with file:line references and suggested fixes
- [ ] Does not praise good code — only reports problems

### spec-reviewer
- [ ] `agents/spec-reviewer.md` exists with valid frontmatter
- [ ] Tools: Read, Grep, Glob
- [ ] Checks: architecture adherence, guiding principle adherence (with concrete evidence), acceptance criteria completeness, naming/pattern consistency
- [ ] Output format: Deviations from architecture, unmet acceptance criteria, principle violations, undocumented additions
- [ ] Focuses on adherence, not quality (that's code-reviewer's job)

### gap-analyst
- [ ] `agents/gap-analyst.md` exists with valid frontmatter
- [ ] Tools: Read, Grep, Glob
- [ ] Identifies: missing requirements from interview, unhandled edge cases, incomplete integrations, missing infrastructure (logging, config, deployment, docs), implicit requirements
- [ ] Each gap has severity and recommendation (address now vs defer with rationale)
- [ ] Re-reads interview transcript to catch requirements mentioned in passing

### journal-keeper
- [ ] `agents/journal-keeper.md` exists with valid frontmatter
- [ ] Tools: Read, Grep, Glob
- [ ] Produces: chronological decision log (decision, rationale, alternatives, implications) and open questions list (question, impact, who answers, consequence of inaction)
- [ ] Synthesizes across all reviews without duplicating their content
- [ ] Connects related findings across different reviewers

## File Scope
- `agents/code-reviewer.md` (create)
- `agents/spec-reviewer.md` (create)
- `agents/gap-analyst.md` (create)
- `agents/journal-keeper.md` (create)

## Dependencies
- Depends on: 001
- Blocks: 007, 008

## Implementation Notes
All review agents should use `sonnet` — review is focused analysis, not open-ended reasoning. MaxTurns: code-reviewer 20, spec-reviewer 25, gap-analyst 25, journal-keeper 15.

Code-reviewer should also be usable for incremental reviews during execution (scoped to a single work item's files). The same agent definition works for both incremental and comprehensive review — the difference is in the spawn prompt.

Gap-analyst should pay special attention to "implicit requirements" — things not stated but expected by any reasonable user. Examples: error messages should be meaningful, APIs should return appropriate status codes, CLI tools should have help text.

## Complexity
Medium
