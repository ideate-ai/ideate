# Code Quality Review

## Critical Findings

### C1: max_depth is caller-controlled, enabling depth-limit bypass
[mcp/session-spawner/server.py:138] The `max_depth` limit is a caller-supplied parameter. A spawned session can pass `max_depth=999` to escape the fork-bomb protection entirely. The depth check should use a server-side configured maximum.
Fix: Read max_depth from a server-side environment variable (e.g., `IDEATE_MAX_DEPTH`). Ignore or cap the caller-supplied value.

### C2: Semaphore created at module import time before event loop exists
[mcp/session-spawner/server.py:41] `asyncio.Semaphore` is created at module level. Requires Python 3.10+ but requirements.txt has no version bound. Will fail at runtime under Python 3.9.
Fix: Create the semaphore inside `main()` or enforce Python version bound.

### C3: TimeoutExpired handler produces "None" string in output
[mcp/session-spawner/server.py:197] `str(partial_stdout)` on a `None` value returns the literal string `"None"`. When `subprocess.run` raises `TimeoutExpired`, `e.stdout` is `None`.
Fix: Use `e.stdout or b""` and decode bytes, or check for `None` explicitly.

## Significant Findings

### S1: Temp file written to caller-supplied working_dir without validation
[mcp/session-spawner/server.py:226-233] Overflow temp files are written into `working_dir` which is not validated against any safe root.
Fix: Write overflow files to a fixed temp directory, or validate `working_dir` is within a configured project root.

### S2: No prompt length validation
[mcp/session-spawner/server.py:159-171] No size limit on the `prompt` parameter. Multi-megabyte prompts will be passed directly to the subprocess.
Fix: Add a maximum prompt length validation (e.g., 100KB).

### S3: Resume detection logic is fragile
[skills/execute/SKILL.md:459] Presence of an incremental review file is used as the completion signal, but review files exist even for failed/deferred items.
Fix: Require both a passing verdict in the review file AND a completed journal entry.

### S4: journal-keeper runs in parallel with reviewers it needs to cross-reference
[skills/review/SKILL.md:186-192] The journal-keeper is spawned simultaneously with the other three reviewers but is documented to read their output files, which won't exist yet.
Fix: Run journal-keeper after the other three complete, or scope cross-references as best-effort.

### S5: Architect output path may be written to wrong location
[skills/plan/SKILL.md:277-291] The architect uses relative paths (`plan/architecture.md`) but if its cwd differs from the artifact directory, files go to the wrong location.
Fix: The plan skill prompt should provide explicit absolute target paths.

### S6: Three different incremental review formats across artifact-conventions, execute skill, and code-reviewer agent
[artifact-conventions.md, skills/execute/SKILL.md:214-247, agents/code-reviewer.md] All three define structurally different formats for the same file type.
Fix: Canonicalize in artifact-conventions.md and reference from execute skill and code-reviewer.

### S7: Final review format mismatch between artifact-conventions and agent definitions
[artifact-conventions.md:371-421] The compact format in conventions does not match the detailed format agents actually produce.
Fix: Update artifact-conventions.md to match agent output formats.

## Minor Findings

### M1: Unknown tool name returns success
[mcp/session-spawner/server.py:108-109] Returns TextContent (success) instead of MCP error for unknown tools.

### M2: Researcher Write tool conditional is dead code
[agents/researcher.md:58] Instructions reference Write tool conditionally, but Write is not in the tools list.

### M3: Decomposer cross-module dependency format underspecified
[agents/decomposer.md:119] Free-text dependency references (`{module-name} providing {interface}`) not reflected in work item schema.

### M4: Refine skill overwrites overview.md assuming git history exists
[skills/refine/SKILL.md:220-231] Prior overview is unrecoverable if artifact directory is not in a git repo.

### M5: Plan skill module threshold is rigid
[skills/plan/SKILL.md:303-304] Hardcoded 5-module threshold for generating module specs. Complex small projects may benefit from module specs.
