# Refinement Plan — Post-Review Hardening

## What Is Changing

The comprehensive review identified security vulnerabilities in the MCP session-spawner, missing infrastructure (README, tests, plugin validation), format inconsistencies between artifact-conventions.md and actual agent/skill output, and incomplete features in the execute skill. This refinement addresses all critical and significant findings from the review.

## Work Streams

### Stream 1: MCP Server Hardening
Fix security bugs (caller-controlled max_depth bypass, unsanitized working_dir, unbounded prompt size), correctness issues (TimeoutExpired "None" string, module-level semaphore), add token budget logging, and write comprehensive tests.

### Stream 2: Plugin Infrastructure
Create a top-level README with installation, MCP setup, and usage instructions. Run `claude plugin validate` and fix any manifest issues.

### Stream 3: Format Canonicalization
Align artifact-conventions.md with the richer formats that agents and skills actually produce. Eliminate the three-way format divergence for incremental reviews and the agent-vs-conventions mismatch for final reviews.

### Stream 4: Skill Improvements
Add resume detection and project source root derivation to the execute skill. Specify the worktree merge strategy. Fix architect path handling in the plan skill. Fix journal-keeper timing in the review skill. Add Write tool to researcher agent so it can save findings directly.

## Deferred Items
- Python vs TypeScript for session-spawner (v3 determination)
- Plan skill artifact overwrite guard
- Subset work item execution
- Overflow temp file cleanup
- Domain agnosticism implementation path
- Refine skill git history assumption for overview.md backup
- Background field in agent frontmatter (omission acceptable)
