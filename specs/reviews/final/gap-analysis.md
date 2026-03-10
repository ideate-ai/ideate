# Gap Analysis — Cycle 3 (2026-03-09)

## Missing Requirements from Interview

### MR1: No observability of peak parallelism
- **Interview reference**: "Want to capture data about how often sessions are spawned and how many agents work in parallel" (2026-03-09 refinement interview)
- **Current state**: JSONL log records one entry per completed call with `depth`, `duration_ms`, and `timestamp`. No field records how many sessions were executing concurrently at the time of any given call.
- **Gap**: The user's stated goal was to understand "how many agents work in parallel." The current schema answers "how many sessions were spawned total" and "at what depth" but cannot answer "how many were running simultaneously." Peak concurrency cannot be derived from the log without external timestamp overlap analysis that the README does not describe.
- **Severity**: Significant
- **Recommendation**: Defer — recording instantaneous concurrency requires a shared async counter under a lock, adding meaningful complexity to the hot path. Document the limitation in README: "The log does not directly capture peak concurrency. Approximate it by comparing `timestamp` and `duration_ms` across entries to identify overlapping windows."

## Incomplete Integrations

### II1: README status table example does not match the implementation
- **Interface**: `_print_status_table()` output described in README Observability section
- **Producer**: `mcp/session-spawner/server.py` `_print_status_table()`
- **Consumer**: `mcp/session-spawner/README.md` status table example block
- **Gap**: README shows columns `#, team, depth, duration, tokens, status` with duration as `12500ms` and a `tokens` column. Actual implementation produces columns `#, Session ID, Depth, Status, Duration, Team` with duration as `12.5s` and no `tokens` column. Every column name, duration unit, and status vocabulary differs from reality.
- **Severity**: Significant
- **Recommendation**: Address now — replace README example with output matching the actual implementation.

### II2: README JSONL schema omits `used_team` and misrepresents `team_name` null behavior
- **Interface**: JSONL log entry schema in README
- **Producer**: `mcp/session-spawner/server.py` entry construction (lines 348–361)
- **Consumer**: `mcp/session-spawner/README.md` JSONL Logging section
- **Gap**: (1) `used_team` absent from README example — implementation always writes this field. (2) README states "`team_name` is omitted when not provided" — implementation always writes `"team_name": null`.
- **Severity**: Significant
- **Recommendation**: Address now — add `used_team` to the schema example; replace the note with "When not provided, `team_name` is `null` and `used_team` is `false`."

## Implicit Requirements

### IR1: Status table test does not verify table structure or data row content
- **Current state**: `test_status_table_printed_to_stderr` asserts five column header words appear in stderr. Does not verify `+` separator characters, any data value such as `completed`, or the `#` column header.
- **Gap**: Table-formatting logic — separator generation, right-alignment, status string derivation, duration formatting — is entirely untested by current assertions.
- **Severity**: Minor
- **Recommendation**: Defer — header assertions catch most critical regression. Tightening with `assert "+" in captured.err` and `assert "completed" in captured.err` is low-cost but not blocking.

---

*Cycle 3 above. Cycle 2 below.*

---

# Gap Analysis — Session Spawner Enhancements (Work Items 022–025)

## Critical Gaps

None.

## Significant Gaps

### MR1: No guidance for consuming the JSONL log
- **Interview reference**: "Want to capture data about how often sessions are spawned and how many agents work in parallel" and "Metrics for manual analysis."
- **Current state**: `IDEATE_LOG_FILE` is documented in the architecture but absent from the README. No query patterns or log schema explanation exists in any user-facing artifact.
- **Gap**: The user's primary motivation was to understand parallelism patterns from collected data. The feature writes data but provides no path to consuming it.
- **Recommendation**: Update README to document `IDEATE_LOG_FILE` and include an example JSONL entry.

### MR2: `team_name` does not cause spawned sessions to actually use agent teams
- **Interview reference**: "Whenever possible, spawned sessions should use agent teams."
- **Current state**: `team_name` is logged and propagated via `IDEATE_TEAM_NAME` env var. Research confirms no CLI mechanism exists to pass team name to `claude --print`. The child session has no mechanism to read `IDEATE_TEAM_NAME` and act on it — no CLAUDE.md hook, no exec_instructions default that references it.
- **Gap**: The env var is written by the parent and read by nothing. User intent — that spawned sessions actually use agent teams — is not fulfilled by env var propagation alone.
- **Recommendation**: Document in README that `team_name` is observability-only; users must embed team directives in `exec_instructions` for actual agent team behavior.

### MR3: README parameters table missing `team_name` and `exec_instructions`
- **Current state**: README parameters table lists 8 parameters; tool now has 10. Response schema omits `token_usage`. No work item was assigned README update responsibility.
- **Gap**: Two primary user-facing features of this work cycle are invisible to any user reading the README.
- **Recommendation**: Add both parameters to the README table with descriptions; update response schema.

### EC1 / MI2: `_log_entry` has no error isolation
- **File**: `mcp/session-spawner/server.py:456`
- **Scenario**: `IDEATE_LOG_FILE` is set to an unwritable path. `open(log_file, "a", ...)` raises `FileNotFoundError` or `PermissionError`. No try/except exists. Exception propagates through `call_tool()` uncaught, producing an MCP error — the successfully-completed spawn result is discarded.
- **Gap**: `_print_status_table` already uses a blanket try/except; `_log_entry` does not. A misconfigured env var silently breaks all spawn calls.
- **Recommendation**: Wrap `_log_entry` file I/O in try/except; add `logger.warning` inside the except so misconfiguration is diagnosable.

### MI1: README environment variable table missing three new env vars
- **File**: `mcp/session-spawner/README.md:115-121`
- **Gap**: Lists 4 env vars. `IDEATE_LOG_FILE`, `IDEATE_EXEC_INSTRUCTIONS`, `IDEATE_TEAM_NAME` are entirely absent. No work item owned README updates.
- **Recommendation**: Add all three to the env var table. The architecture doc contains the complete reference.

### IR1: README describes the pre-enhancement version of the server
- **Gap**: README parameters table has 8 entries; tool now has 10. Env var table has 4 entries; tool now uses 7. Response schema omits `token_usage`. Systematic gap — documentation was not assigned to any work item.
- **Recommendation**: Address now — README is the tool's primary user-facing interface.

## Minor Gaps

### EC2: `IDEATE_TEAM_NAME` leaks to grandchild sessions when middle session omits `team_name`
- Parent sets `IDEATE_TEAM_NAME=workers` in child env. Child's server spreads `os.environ` to grandchild unconditionally. Grandchild records incorrect `team_name` in log entry.
- **Recommendation**: Defer — requires 3 levels of nesting to manifest; document the behavior.

### EC3: Concurrent `_log_entry` writes not locked
- Up to 5 parallel spawns may call `_log_entry` simultaneously. On POSIX, single write calls under 4096 bytes are effectively atomic. JSONL entries are ~200–400 bytes.
- **Recommendation**: Defer — safe in practice on POSIX; document as known limitation.

### II1–II2: Missing negative-case env propagation tests
- No test verifies `IDEATE_EXEC_INSTRUCTIONS` is absent from child env when no instructions are resolved. No test verifies `IDEATE_TEAM_NAME` is absent when `team_name` is not passed.
- **Recommendation**: Defer — positive tests provide adequate behavioral coverage.

### MI3: Recursive `exec_instructions` propagation not documented
- The cascade behavior (all descendant sessions receive the instructions) appears nowhere in any user-facing artifact.
- **Recommendation**: Address in the same README update pass as MI1 — two sentences suffices.

### IR2: Log write failures silently drop entries rather than warning
- After adding try/except to `_log_entry`, write failures should emit `logger.warning(...)` rather than passing silently. The `logger` object already exists at module level.
- **Recommendation**: Address in the same change as the try/except fix — zero marginal cost.

### IR3: Status table has no self-identifying title
- The table has column headers but no label identifying it as an ideate session status table.
- **Recommendation**: Defer — column headers provide sufficient identification in most scenarios.

---
*This review supersedes the prior-cycle gap-analysis entries above the separator line.*

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
