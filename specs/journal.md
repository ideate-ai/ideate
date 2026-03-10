# Project Journal

## [plan] 2026-03-08 — Planning session completed
Conducted a structured interview covering intent, design, and process tracks. Key decisions:

- Clean-slate reimplementation of ideate v1, no design assumptions carried forward
- Core goal: specs detailed enough that an LLM executes without subjective decisions
- Sufficiency test: any reasonable question answerable from specs; two LLMs produce equivalent output
- Progressive decomposition: architecture → modules (with interface contracts) → work items
- Parallel-first execution with continuous review (review overlaps execution)
- Andon cord interaction model: minimal post-planning user interaction, flag only unresolvable issues
- External tooling in scope: MCP session-spawner for recursive self-invocation
- Domain agnostic design with software as primary focus
- Guiding principles serve as the decision framework for delegating vs. asking the user

Background research completed on:
- Spec sufficiency for LLM execution (ambiguity markers, progressive decomposition levels, machine-verifiable criteria)
- Agent teams, plugin architecture, continuous review patterns
- Recursive project decomposition (human PM frameworks, AI agent patterns, Claude Code constraints)
- Session multiplexing (CLI headless mode, Agent SDK, MCP server approach, hooks)

Produced 11 work items across 5 dependency groups. Architecture doc delegated to architect agent.

Deferred questions:
- Exact spec sufficiency heuristic for runtime validation (theoretically clean, pragmatic proxy needed)
- Token budget management for recursive session spawning
- Whether the MCP session-spawner should be Python or TypeScript

## [execute] 2026-03-08 — Work item 001: Plugin Manifest
Status: complete with rework
Rework: 6 missing .gitkeep files created after incremental review flagged them.

## [execute] 2026-03-08 — Work item 002: Researcher Agent
Status: complete with rework
Rework: tools field converted from comma-separated string to YAML list format for consistency with other agents.

## [execute] 2026-03-08 — Work item 003: Architect Agent
Status: complete
No deviations.

## [execute] 2026-03-08 — Work item 004: Review Agents
Status: complete
No deviations. Created code-reviewer, spec-reviewer, gap-analyst, and journal-keeper agents.

## [execute] 2026-03-08 — Work item 009: Decomposer Agent
Status: complete with rework
Rework: added `delete` to File Scope template options to match artifact-conventions.md canonical format.

## [execute] 2026-03-08 — Work item 011: Artifact Conventions
Status: complete
No deviations.

## [execute] 2026-03-08 — Work item 005: Plan Skill
Status: complete
No deviations. 619-line skill covering all 7 phases from setup through finalization.

## [execute] 2026-03-08 — Work item 006: Refine Skill
Status: complete with rework
Rework: added project source root derivation logic to Phase 1 after review identified missing project root specification for architect analyze-mode spawn.

## [execute] 2026-03-08 — Work item 007: Execute Skill
Status: complete
No deviations. Covers all three execution modes (sequential, batched parallel, full parallel teams), continuous incremental review, Andon cord mechanism, error recovery.

## [execute] 2026-03-08 — Work item 008: Review Skill
Status: complete
No deviations. Coordinates four parallel reviewers (code-reviewer, spec-reviewer, gap-analyst, journal-keeper) with cross-reviewer synthesis.

## [execute] 2026-03-08 — Work item 010: Session Spawner MCP Server
Status: complete with rework
Rework: 3 fixes from review — output truncation now slices by byte boundary instead of character count, simplified TimeoutExpired handler, added IDEATE_MAX_CONCURRENCY validation with fallback.

## [execute] 2026-03-08 — Execution complete
Items completed: 11/11
Items requiring rework: 5
Outstanding issues: none

## [review] 2026-03-08 — Comprehensive review completed
Critical findings: 6
Significant findings: 11
Minor findings: 11
Suggestions: 5
Items requiring user input: 3

## [refine] 2026-03-08 — Refinement planning completed
Trigger: review findings (6 critical, 11 significant)
Principles changed: none
New work items: 012-021
Addresses: MCP server security bugs (max_depth bypass, "None" string, semaphore, prompt validation, working_dir validation), missing infrastructure (README, tests, plugin validation), artifact-conventions format drift, execute skill gaps (resume detection, source root, worktree merge), plan skill path handling, review skill journal-keeper timing, researcher Write tool.
Deferred: Python vs TypeScript (v3), plan skill overwrite guard, subset execution, temp cleanup, domain agnosticism, refine git assumption, agent background field.

## [execute] 2026-03-08 — Work item 012: MCP Server Security Fixes
Status: complete
Applied 7 security fixes: server-side max_depth enforcement, TimeoutExpired None handling, semaphore moved into main(), prompt length validation, safe root validation, unknown tool McpError, token budget logging.

## [execute] 2026-03-08 — Work item 015: Top-Level README
Status: complete
Created README.md with installation, MCP setup, workflow documentation, and quick start guide.

## [execute] 2026-03-08 — Work item 016: Artifact Conventions Canonicalization
Status: complete
Aligned all review format sections with actual agent output formats.

## [execute] 2026-03-08 — Work item 017: Execute Skill Improvements
Status: complete
Added resume detection, project source root derivation, worktree merge protocol, absolute paths in worker context.

## [execute] 2026-03-08 — Work item 018: Plan Skill Fixes
Status: complete
Fixed architect spawning to use absolute paths, added researcher inline output handling with fallback Write logic.

## [execute] 2026-03-08 — Work item 019: Review Skill Fix
Status: complete
Restructured to run journal-keeper sequentially after other three reviewers complete.

## [execute] 2026-03-08 — Work item 020: Researcher Write Tool
Status: complete
Added Write to researcher agent tools list, replaced conditional logic with direct instruction.

## [execute] 2026-03-08 — Work item 021: Plugin Validation
Status: complete
Ran `claude plugin validate .` — passed.

## [execute] 2026-03-08 — Work item 013: MCP Server Tests
Status: complete
Created test_server.py with 11 tests covering all safety-critical behaviors. All tests pass.

## [execute] 2026-03-08 — Work item 014: MCP Server README Update
Status: complete
Updated README with setup instructions, parameter table, safety mechanisms, environment variables, and testing section.

## [execute] 2026-03-08 — Refinement execution complete
Items completed: 10/10
Items requiring rework: 0
Outstanding issues: none

## [review] 2026-03-09 — User decisions recorded
- README update: address now in a targeted fix.
- team_name intent: observability and tracking only. No automatic team directive injection. README should document this.

## [review] 2026-03-09 — Comprehensive review completed
Critical findings: 1
Significant findings: 5
Minor findings: 8
Suggestions: 0
Items requiring user input: 2

## [execute] 2026-03-09 — Work item 022: JSONL Logging, Session Registry, and team_name Parameter
Status: complete
Added `import datetime`, `_session_registry`, `_log_entry()`, `team_name` tool parameter, `original_prompt_bytes` capture, `IDEATE_TEAM_NAME` env propagation. Refactored timeout path to fall through to shared post-processing block instead of returning early, enabling both success and timeout paths to write log entries.

## [execute] 2026-03-09 — Work item 023: Status Table
Status: complete
Added `import sys`, `_print_status_table()` with plain ASCII box table format. Called in both timeout and success paths after `_log_entry()`. Empty registry produces no output. Wrapped in try/except for error isolation.

## [execute] 2026-03-09 — Work item 024: Execution Instructions Injection
Status: complete
Added `exec_instructions` tool parameter. Resolves from param (priority) or `IDEATE_EXEC_INSTRUCTIONS` env var. Augments prompt with `[EXECUTION INSTRUCTIONS]...[END EXECUTION INSTRUCTIONS]` block. Propagates via `IDEATE_EXEC_INSTRUCTIONS` in child env. Original prompt used for size validation and `prompt_bytes` logging.

## [execute] 2026-03-09 — Work item 025: Tests for New Features
Status: complete with rework
Added 18 new tests across 5 groups (JSONL logging, session registry, team_name, exec_instructions, status table). Updated `_reset_globals` fixture to reset `_session_registry`. All 29 tests pass.
Rework: 1 significant finding fixed from incremental review — added `prompt_bytes` value assertion to `test_jsonl_logging_writes_entry` and `test_jsonl_timeout_entry`. 1 minor finding fixed — removed `prompt_byte_len` alias in server.py.

## [execute] 2026-03-09 — Targeted fixes from cycle 3 review
Status: complete
Applied 4 fixes: (1) C1 — moved `parsed.get("session_id", "")` inside `isinstance(parsed, dict)` block to prevent `AttributeError` on non-dict JSON output; (2) S1 — replaced README status table example with correct columns/format (`#/Session ID/Depth/Status/Duration/Team`, duration as `12.5s`, status as `completed/failed/timed_out`); (3) S2 — added `used_team` to README JSONL schema example, corrected `team_name` null description, added peak concurrency approximation note; (4) M2 carry-forward resolved — `prompt_bytes` assertion already present in `test_jsonl_timeout_entry` (comment added for clarity). All 32 tests pass.

## [review] 2026-03-09 — Comprehensive review completed (cycle 3)
Critical findings: 1
Significant findings: 3
Minor findings: 3
Suggestions: 0
Items requiring user input: 1

## [execute] 2026-03-09 — Minor fixes before cycle 3 review
Status: complete
Addressed all 5 remaining minor findings from cycle 2: (1) OQ3 — consolidated duplicate entry dict into a single shared block using outcome variables, both timeout and success paths now use one dict; (2) OQ6 — corrected `#` column minimum width from 2 to 4 to match spec; (3) OQ7 — strengthened status table test to assert column headers present (Session ID, Depth, Status, Duration, Team); (4) OQ8 — fixed IDEATE_TEAM_NAME grandchild leak by stripping it from env before conditional re-set; (5) OQ9 — added 3 negative-case tests for absent env vars; (6) OQ10 — fixed WI-023 acceptance criterion from em dash to ASCII hyphen. 32 tests pass.

## [execute] 2026-03-09 — Targeted fixes from cycle 2 review
Status: complete
Applied 3 fixes based on critical/significant findings: (1) wrapped `_log_entry()` file I/O in try/except with `logger.warning` — prevents IDEATE_LOG_FILE misconfiguration from crashing the server; (2) fixed timestamp format to millisecond precision with Z suffix at both call sites; (3) updated README with team_name and exec_instructions parameters, returns schema, observability section (JSONL schema, status table example), env var table with IDEATE_LOG_FILE/IDEATE_EXEC_INSTRUCTIONS/IDEATE_TEAM_NAME, and recursive propagation documentation. All 29 tests pass.

## [refine] 2026-03-09 — Refinement planning completed
Trigger: user request to add observability and execution control to session spawner.
Principles changed: none.
New work items: 022-025.
Addresses: JSONL logging of spawn calls (configurable IDEATE_LOG_FILE), in-memory session registry, team_name parameter with IDEATE_TEAM_NAME propagation, terminal status table printed to stderr after each spawn, execution instructions injection via exec_instructions parameter and IDEATE_EXEC_INSTRUCTIONS env var with recursive propagation.
Scope: mcp/session-spawner/server.py and test_server.py only.
Deferred: researcher findings on claude CLI flags (background agent running; may influence instruction injection mechanism if CLI flags exist).

## [refine] 2026-03-09 — Refinement planning completed
Trigger: user request to address all deferred open items across all prior review cycles.
Principles changed: none.
New work items: 026-028.
Addresses: _reset_globals fixture comment (WI 026), status table structural test assertions (WI 026), --allowedTools comma syntax test (WI 026), concurrent status table README non-determinism note (WI 027), overflow temp file lifecycle documentation (WI 027), agent background: false frontmatter field for 6 foreground agents (WI 028).
Scope: test_server.py, README.md, agents/*.md only. No behavioral changes.
Deferred: none — all open items addressed.

## [execute] 2026-03-09 — Work item 026: Test Suite Polish
Status: complete with rework
Rework: 1 significant finding fixed (AC5 test count corrected from 35 to 33 in work item spec), 1 minor finding fixed (test_allowed_tools_comma_syntax moved from inside status table section to its own section 17 at end of file). All 33 tests pass.

## [execute] 2026-03-09 — Work item 027: README Observability Notes
Status: complete with rework
Rework: 1 significant finding fixed — overflow file lifecycle note was placed after the Returns JSON block (line 82) instead of in the Output Truncation section (line 108). Moved note to correct location under ### Output Truncation.

## [execute] 2026-03-09 — Work item 028: Agent Background Field
Status: complete with rework
Rework: 1 significant finding fixed — background: false was placed after maxTurns in all six files, but researcher.md places background before maxTurns. Reordered all six files to match the reference ordering (model → background → maxTurns).

## [execute] 2026-03-09 — Work item 029: Marketplace Version Bump
Status: complete
Both version fields in .claude-plugin/marketplace.json updated from 0.2.0 to 0.3.0.

## [execute] 2026-03-09 — Execution complete
Items completed: 4/4
Items requiring rework: 3 (026, 027, 028)
Outstanding issues: none
