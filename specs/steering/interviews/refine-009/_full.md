# Refinement Interview — 2026-03-22 (Compiled Transcript)

**Trigger**: Post-convergence refinement. brrr session completed (5 cycles, WI-102 through WI-116, convergence achieved 2026-03-22). User identified that code reviewers perform only static analysis and never verify the project still starts after a work item completes.

See `_general.md` for the full Q&A transcript.

## Summary

**Change**: Add dynamic testing guidance to the code-reviewer agent and the incremental/capstone reviewer spawn prompts.

**Design**: Two-tier quality floor:
1. Incremental review: smoke test (does the project still start?) + targeted tests for changed files. Startup failure = Critical finding = Andon.
2. Capstone review: full test suite run.

**Principle**: Ideate automates human-style iteration — parallel workstreams, incremental quality gates, Andon for blocking failures. Breaking app startup is an egregious failure that must be caught immediately, not deferred to capstone.

## New Work Items

- WI-117: Add dynamic testing guidance to `agents/code-reviewer.md`
- WI-118: Update incremental reviewer spawn prompts (execute/SKILL.md, brrr/phases/execute.md)
- WI-119: Update capstone reviewer spawn prompts (review/SKILL.md, brrr/phases/review.md)
