# Gap Analysis

## Critical Gaps

### G1: No top-level README
No file explains what ideate is, how to install it, how to set up the MCP server, or the four-command workflow. A user who installs this plugin has no starting point.
Recommendation: Address now.

### G2: plugin.json declares no skills, agents, or MCP server
The manifest has name/version/description but no registration of skills or agents. If the Claude Code plugin loader requires declaration, no skill will be recognized.
Recommendation: Address now — verify the Claude Code plugin manifest schema and add required fields.

### G3: No tests for MCP server
The session-spawner is the only runtime code. No test file exists. Safety mechanisms (depth tracking, concurrency limiting, timeout handling, output truncation) are untested.
Recommendation: Address now.

## Significant Gaps

### G4: Execute skill has no resume detection implementation
Phase 12 says to detect already-completed items on resume, but Phases 1-2 contain no instructions for building a "completed items" list. Re-running `/ideate:execute` will re-execute completed work.
Recommendation: Address now.

### G5: Worktree merge strategy unspecified
Execute skill says "merge the worktree back" without specifying branch strategy (merge/rebase/squash), conflict resolution criteria, or cleanup.
Recommendation: Address now.

### G6: Incremental review format inconsistency
Three sources (artifact-conventions.md, execute/SKILL.md, code-reviewer.md) define different formats for the same file type.
Recommendation: Address now — canonicalize in artifact-conventions.md.

### G7: Token budget tracking entirely absent
Work item 010 acceptance criterion requires "logged, not enforced" token budget tracking. Not implemented, not logged, not documented as a limitation.
Recommendation: Defer, but document as known limitation in README.

### G8: Execute skill doesn't locate project source root
The refine and review skills have source-root derivation logic; the execute skill does not. Workers writing to relative paths may target the wrong directory if artifact dir differs from project root.
Recommendation: Address now.

## Minor Gaps

### G9: Plan skill doesn't guard against existing artifacts
Running `/ideate:plan` twice on the same directory silently overwrites all prior artifacts.
Recommendation: Defer.

### G10: Refine skill assumes git history for overview.md backup
Overwrites overview.md with "The previous content is in git history" but artifact directory may not be in git.
Recommendation: Defer.

### G11: No mechanism to execute a subset of work items
Users cannot specify "only execute items 005, 007, 008."
Recommendation: Defer.

### G12: Overflow temp files never cleaned up
`ideate-session-*.txt` files accumulate in working_dir with `delete=False`.
Recommendation: Defer.

### G13: Researcher agent has no Write tool
Instructions conditionally reference Write, but it's not in the tools list. Plan skill has no handling for inline researcher output.
Recommendation: Address now — add Write to researcher tools or add inline handling to plan skill.

### G14: Domain agnosticism has no implementation path
Code-reviewer and gap-analyst are hardcoded to software concerns. Non-software use cases would get irrelevant findings.
Recommendation: Defer — software is the explicit primary focus.
