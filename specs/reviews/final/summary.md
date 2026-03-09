# Review Summary

## Overview
The ideate v2 plugin is structurally complete — all four skills, seven agents, the MCP server, and artifact conventions are implemented and internally coherent. The architecture is well-decomposed and the guiding principles are consistently reflected across all components. The primary issues are: (1) the MCP server has several security and correctness bugs, (2) the artifact-conventions document has drifted from the actual formats used by agents and skills, (3) the plugin manifest likely needs additional fields for Claude Code to discover the skills, and (4) the project lacks a top-level README and MCP server tests.

## Reviewers
- Code quality: 3 critical, 7 significant, 5 minor findings
- Spec adherence: 2 unmet acceptance criteria, 5 architecture deviations, 0 principle violations, 6 undocumented additions (all sensible)
- Gap analysis: 3 critical, 5 significant, 6 minor gaps
- Decision log: 13 decisions recorded, 7 open questions identified

## Critical Findings
- [critical] **max_depth is caller-controlled** — code-reviewer — MCP server depth-limit bypass allows fork bomb. Any spawned session can pass `max_depth=999`.
- [critical] **No top-level README** — gap-analyst — zero discoverability for new users. No setup instructions exist.
- [critical] **plugin.json declares no skills or agents** — gap-analyst + code-reviewer — if plugin loader requires declaration, nothing works.
- [critical] **No MCP server tests** — gap-analyst — only runtime code in the project has zero test coverage, including safety-critical mechanisms.
- [critical] **Semaphore at module level** — code-reviewer — Python 3.9 incompatibility with no version enforcement.
- [critical] **TimeoutExpired produces "None" string** — code-reviewer — `str(None)` returns literal "None" in output field.

## Significant Findings
- [significant] **Incremental review format inconsistency** — code-reviewer + gap-analyst — three different formats across artifact-conventions, execute skill, and code-reviewer agent.
- [significant] **Execute skill has no resume detection implementation** — gap-analyst — re-running execute will re-execute completed items.
- [significant] **Worktree merge strategy unspecified** — gap-analyst — no branch strategy, conflict criteria, or cleanup specified.
- [significant] **Execute skill doesn't locate project source root** — gap-analyst — workers may write to wrong directory.
- [significant] **Token budget tracking not implemented** — spec-reviewer + gap-analyst — work item 010 criterion entirely absent.
- [significant] **`claude plugin validate` never run** — spec-reviewer — deferred validation never performed.
- [significant] **Temp files written to caller-supplied working_dir** — code-reviewer — no safe-root validation.
- [significant] **No prompt length validation in MCP server** — code-reviewer — unbounded input.
- [significant] **Architect output path mismatch** — code-reviewer — relative paths without explicit base directory.
- [significant] **journal-keeper timing in parallel execution** — code-reviewer — cross-references unavailable.
- [significant] **Final review format mismatch** — code-reviewer — agent output formats differ from conventions.

## Minor Findings
- [minor] Unknown tool name returns success instead of MCP error
- [minor] Researcher agent has no Write tool but instructions reference it conditionally
- [minor] Decomposer cross-module dependency format underspecified
- [minor] Refine skill overwrites overview.md assuming git history exists
- [minor] Module spec threshold hardcoded at 5 (no flexibility for complex small projects)
- [minor] Plan skill doesn't guard against existing artifacts in directory
- [minor] No mechanism to execute a subset of work items
- [minor] Overflow temp files never cleaned up
- [minor] Domain agnosticism has no concrete implementation path
- [minor] Agent background field missing from most agent frontmatter
- [minor] output_format parameter in MCP server not in architecture spec

## Suggestions
- Run journal-keeper sequentially after the other three reviewers instead of in parallel, so cross-references work
- Add `Write` to researcher agent tools list so it can save findings directly
- Consider `pyproject.toml` for the MCP server to enforce Python version and manage dependencies properly
- Add a guard in plan skill Phase 1 to warn if artifacts already exist
- Archive overview.md content before overwriting in refine skill

## Findings Requiring User Input
1. **Plugin manifest schema** — The plugin.json may need skills/agents arrays. The exact Claude Code plugin manifest schema should be confirmed. Does the current minimal manifest work, or does it need explicit skill/agent registration?
2. **Python vs TypeScript for session-spawner** — This was deferred during planning and silently resolved as Python. Should it stay Python, or would TypeScript better align with the Claude Code ecosystem?
3. **Token budget tracking** — Work item 010 specified "logged, not enforced." Should this be implemented now, documented as a known limitation, or removed from the acceptance criteria?

## Already Addressed During Execution
- Missing .gitkeep files (work item 001 rework)
- Researcher tools field format — string to YAML list (work item 002 rework)
- Decomposer missing `delete` in file scope template (work item 009 rework)
- Refine skill missing project source root derivation (work item 006 rework)
- MCP server output truncation byte vs character (work item 010 rework)
- MCP server TimeoutExpired hasattr simplification (work item 010 rework)
- MCP server IDEATE_MAX_CONCURRENCY validation (work item 010 rework)

## Proposed Refinement Plan
A refinement cycle is warranted. The following work streams are recommended:

**Stream 1: MCP Server Hardening (critical)**
- Fix max_depth to be server-side configured, not caller-supplied
- Fix TimeoutExpired "None" string bug
- Move semaphore creation into server startup or add Python version enforcement
- Add input validation (prompt length, working_dir safe root)
- Write tests for depth tracking, concurrency limiting, timeout handling, output truncation
- Add token budget logging (or document as known limitation)

**Stream 2: Plugin Infrastructure (critical)**
- Verify and fix plugin.json manifest schema
- Run `claude plugin validate`
- Create top-level README.md

**Stream 3: Format Canonicalization (significant)**
- Align artifact-conventions.md with actual agent output formats
- Single canonical incremental review format
- Single canonical final review format per reviewer type

**Stream 4: Execute Skill Completeness (significant)**
- Add project source root derivation (match refine skill)
- Implement resume detection in Phases 1-2
- Specify worktree merge strategy
- Add researcher Write tool or inline output handling in plan skill
