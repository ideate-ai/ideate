# Review Summary — Cycle 3 (2026-03-09)

*Post-minor-fixes review of session spawner MCP server (`mcp/session-spawner/`).*

## Overview

All cycle 2 critical and significant findings were correctly resolved. All 32 tests pass. One new critical issue was found that escaped two prior review cycles: a latent `AttributeError` crash in the JSON parsing path. The README Observability section introduced during the cycle 2 README update contains two significant inaccuracies — the status table example is entirely wrong and the JSONL schema omits a required field. These are documentation defects that affect usability but not runtime correctness.

## Critical Findings

- [code-reviewer] `parsed.get("session_id", "")` called before `isinstance(parsed, dict)` guard at `server.py:327` — `AttributeError` on non-dict JSON output escapes `except (json.JSONDecodeError, TypeError)` and propagates unhandled, discarding the spawn result and preventing log entry and registry update — relates to: work item 022

## Significant Findings

- [code-reviewer + spec-reviewer + gap-analyst] README status table example (`README.md:147-152`) shows wrong column names (`team/depth/duration/tokens/status`), wrong duration format (`12500ms`), wrong status vocabulary (`ok`), and a non-existent `tokens` column — actual columns are `#/Session ID/Depth/Status/Duration/Team` with duration as `12.5s` — relates to: cross-cutting (3 reviewers independently)
- [code-reviewer + spec-reviewer + gap-analyst] README JSONL schema example (`README.md:124-140`) omits the `used_team` field (always written by implementation) and states "`team_name` is omitted when not provided" (incorrect — implementation always writes `null`) — relates to: cross-cutting (3 reviewers independently)
- [gap-analyst] No observability of peak concurrency — JSONL log records per-call data but cannot answer "how many sessions were running simultaneously"; the user's stated goal requires external timestamp-overlap analysis not documented anywhere — relates to: cross-cutting (recommended defer with README documentation)

## Minor Findings

- [code-reviewer] Status table non-determinism under concurrent spawns undocumented — multiple coroutines may print overlapping tables without synchronization — relates to: cross-cutting
- [code-reviewer] `test_jsonl_timeout_entry` does not assert `prompt_bytes` value in timeout path — a regression recording wrong bytes would go undetected (3rd review cycle without resolution) — relates to: work item 025
- [gap-analyst] Status table test does not verify separator characters or any data row value — table-formatting logic entirely untested beyond header word presence — relates to: work item 025

## Findings Requiring User Input

- **Peak concurrency measurement**: The JSONL log cannot directly answer "how many sessions were running in parallel." Options: (a) add an instantaneous concurrency counter field (requires shared async state, adds hot-path complexity), or (b) document that users can approximate concurrency by comparing `timestamp` + `duration_ms` across entries. The gap-analyst recommends option (b) as the lower-complexity approach, but this requires confirmation.

## Proposed Refinement Plan

The review identified 1 critical and 2 significant findings (plus 1 significant deferred). A targeted fix cycle is warranted. Scope is small — all fixes are in `mcp/session-spawner/server.py`, `test_server.py`, and `README.md`.

1. **Fix `AttributeError` crash** (`server.py:327`) — move `parsed.get("session_id", "")` inside the `isinstance(parsed, dict)` block. ~2 lines.
2. **Fix README status table example** (`README.md`) — replace with a table using actual column names and format. ~10 lines.
3. **Fix README JSONL schema** (`README.md`) — add `used_team`, correct `team_name` null description. ~3 lines.
4. **Fix `test_jsonl_timeout_entry`** (`test_server.py:424`) — add `prompt_bytes` value assertion. ~1 line.
5. **Document peak concurrency limitation in README** (pending user decision on option a vs b above).

Estimated: 1 targeted work item, all in `mcp/session-spawner/`. Or apply directly without a formal refine cycle.

---

*Prior-cycle summary follows.*

---

# Review Summary — Cycle 2 (2026-03-09)

*Work items 022–025: session spawner observability and execution control.*

## Overview
The four work items are functionally complete and all 29 tests pass. One critical issue exists that will cause production failures under normal usage: `_log_entry()` has no exception handler, so any disk or permission error on `IDEATE_LOG_FILE` propagates as an MCP error and breaks all subsequent spawn calls for the server's lifetime. Three significant issues require attention before the feature set is fully usable: the timestamp format does not match the architecture schema, the README was not updated and makes all new parameters and env vars invisible to users, and `team_name` does not achieve its stated user intent of causing spawned sessions to use agent teams.

## Critical Findings
- [code-reviewer] `_log_entry()` has no exception handler — any `IDEATE_LOG_FILE` path error crashes every subsequent `spawn_session` call for the server's lifetime — relates to: work item 022, cross-cutting with gap-analysis

## Significant Findings
- [code-reviewer] Timestamp format emits `+00:00` with microsecond precision; architecture schema specifies `Z` suffix with millisecond precision — relates to: work item 022
- [code-reviewer] Entry dict duplicated across timeout and success branches — schema drift risk on future field additions — relates to: work item 022
- [gap-analyst] README not updated — `team_name`, `exec_instructions`, `IDEATE_LOG_FILE`, `IDEATE_EXEC_INSTRUCTIONS`, `IDEATE_TEAM_NAME` all absent — relates to: cross-cutting (no work item owned README updates)
- [gap-analyst] `team_name` does not cause spawned sessions to use agent teams — `IDEATE_TEAM_NAME` env var is written but nothing reads it — relates to: work item 022, user intent from interview
- [code-reviewer / spec-reviewer] `team_name` and `exec_instructions` missing from README parameters table — relates to: cross-cutting

## Minor Findings
- [spec-reviewer] `#` column minimum width initialized to 2, spec notes specify 4 — relates to: work item 023
- [spec-reviewer] `test_status_table_printed_to_stderr` only checks `len(captured.err) > 0`, cannot detect broken renderer — relates to: work item 025
- [spec-reviewer] `_reset_globals` fixture resets more globals than WI-025 specified — relates to: work item 025
- [code-reviewer] Status table non-deterministic under concurrent spawns — relates to: work item 023
- [code-reviewer] No negative-case test for `IDEATE_TEAM_NAME` absent from child env — relates to: work item 025
- [gap-analyst] `IDEATE_TEAM_NAME` leaks to grandchild sessions via `os.environ` spread — relates to: work item 022
- [gap-analyst] Recursive `exec_instructions` propagation semantics not documented — relates to: cross-cutting
- [gap-analyst] Log write failures should emit `logger.warning`, not pass silently — relates to: work item 022

## Findings Requiring User Input
- **README update scope**: No work item was assigned README update responsibility. The README currently describes the pre-cycle-2 version of the server. Does the user want this addressed in a targeted fix now, or deferred to the next refinement cycle?
- **`team_name` product intent**: The implementation logs and propagates team name but does not activate agent team behavior. Should `team_name` automatically inject a team directive into the instruction block when provided? Or is observability-only acceptable with a README note?

## Proposed Refinement Plan
The review identified 1 critical and 5 significant findings. A targeted fix cycle is recommended before the new features are used in production. Scope:

1. **Fix `_log_entry()` error isolation** (server.py) — wrap in try/except, add `logger.warning`. ~5 lines.
2. **Fix timestamp format** (server.py, 2 locations) — `.isoformat(timespec="milliseconds").replace("+00:00", "Z")`. ~1 line each.
3. **Update README** (README.md) — add `team_name`, `exec_instructions` to parameters table; add `IDEATE_LOG_FILE`, `IDEATE_EXEC_INSTRUCTIONS`, `IDEATE_TEAM_NAME` to env var table; document recursive propagation; document `team_name` as advisory-only; show example JSONL entry.
4. **Resolve entry dict duplication** (server.py) — consolidate timeout and success entry construction into one block. Optional for this cycle; significant for long-term maintainability.

Estimated: 3–4 targeted work items, all in `mcp/session-spawner/`. Run `/ideate:refine` with this scope.

---
*Prior-cycle summary follows below.*

---
# Review Summary — Cycle 1

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
