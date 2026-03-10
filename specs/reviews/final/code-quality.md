# Code Quality Review — Cycle 3 (2026-03-09)

## Verdict: Fail

The fixes from cycle 2 are correctly applied. However, two new issues remain: a pre-existing `AttributeError` crash path in JSON parsing that was not introduced by the cycle 2 fixes but was also not caught by the prior reviews, and the README status table example is a fiction that does not match the actual implementation.

## Critical Findings

### C1: `parsed.get("session_id", "")` called before `isinstance(parsed, dict)` guard — `AttributeError` escapes try/except

- **File**: `/Users/dan/code/ideate/mcp/session-spawner/server.py:327`
- **Issue**: Line 327 calls `parsed.get("session_id", "")` unconditionally. The `isinstance(parsed, dict)` guard is on line 328, after the call. `json.loads()` can legally return any JSON value — a list, string, number, boolean, or null. If the subprocess emits valid JSON that is not an object (e.g., `[1, 2]` or `"done"`), `parsed.get(...)` raises `AttributeError`. The `except` clause on line 341 catches only `(json.JSONDecodeError, TypeError)`, not `AttributeError`. The exception propagates unhandled out of `call_tool()`, crashing the call and preventing the session registry, JSONL log entry, and status table from being written for that call.
- **Impact**: Any subprocess that outputs a valid non-object JSON response (array, string, etc.) causes an unhandled exception in the server. Claude `--output-format json` output is typically an object, but this is a latent crash path.
- **Suggested fix**: Move line 327 inside the `isinstance(parsed, dict)` block, or change the except clause to `except Exception`. The minimal safe fix:
  ```python
  if isinstance(parsed, dict):
      outcome_session_id = parsed.get("session_id", "")
      usage = parsed.get("usage") or parsed.get("token_usage")
      ...
  ```

## Significant Findings

### S1: README status table example is entirely wrong — columns, format, and values do not match the implementation

- **File**: `/Users/dan/code/ideate/mcp/session-spawner/README.md:147-152`
- **Issue**: The README shows a status table with columns `team`, `depth`, `duration`, `tokens`, `status` and values like `12500ms` and `ok`. The actual implementation produces columns `#`, `Session ID`, `Depth`, `Status`, `Duration`, `Team` with values like `12.5s` and `completed`. The example appears to be from a different design that was never built. It misrepresents all column names, the Duration format (`Ns` not `Nms`), the Status values (`completed`/`failed`/`timed_out` not `ok`), and the absence of a `#` index column and `Session ID` column.
- **Impact**: Users who read the README to understand the status table output will see incorrect information. The README actively misdescribes a core observability feature.
- **Suggested fix**: Replace the table example with one that matches the actual `_print_status_table()` output format:
  ```
  +----+--------------+-------+-----------+----------+-----------------+
  | #  | Session ID   | Depth | Status    | Duration | Team            |
  +----+--------------+-------+-----------+----------+-----------------+
  |  1 | sess-abc123  |     1 | completed |   12.5s  | workers         |
  |  2 | sess-def456  |     2 | failed    |    3.1s  | -               |
  +----+--------------+-------+-----------+----------+-----------------+
  ```

### S2: README JSONL schema example omits `used_team` field and misrepresents `team_name` nullability

- **File**: `/Users/dan/code/ideate/mcp/session-spawner/README.md:124-140`
- **Issue**: The JSONL example schema does not include the `used_team` field, which is always written to every log entry (line 355 of server.py). Additionally, line 140 states "`team_name` is omitted when not provided" — this is incorrect. The implementation sets `"team_name": team_name or None` (server.py:354), meaning `team_name` is always present in the entry as JSON `null` when not provided, not absent. Consumers diffing against the README schema will miss a required field and misunderstand the nullability contract.
- **Impact**: The JSONL schema documentation is inaccurate on two counts. Code that reads log entries and iterates over required fields based on the README will omit `used_team` handling.
- **Suggested fix**: Add `"used_team": true` to the example object. Change line 140 to: "`team_name` is `null` when not provided. `token_usage` is `null` when the session does not return token information."

## Minor Findings

### M1: Status table non-determinism under concurrent spawns is undocumented

- **File**: `/Users/dan/code/ideate/mcp/session-spawner/server.py:362-364`
- **Issue**: Multiple concurrent coroutines share `_session_registry`. When coroutines A and B both complete around the same time, each appends its entry then calls `_print_status_table()`. Coroutine A may call `_print_status_table()` and see both entries, and then coroutine B does the same — printing the table twice with both entries. Alternatively A may print its one entry, then B prints both. The status table is printed without any synchronization. This was noted as M1 in the prior cycle review and is not a new finding, but remains unaddressed and undocumented.
- **Suggested fix**: Add a note to the README's Observability section that the status table reflects all registry entries at the moment of printing, which may include entries from concurrent calls.

### M2: `test_jsonl_logging_writes_entry` does not assert `prompt_bytes` value, only key presence

- **File**: `/Users/dan/code/ideate/mcp/session-spawner/test_server.py:363-364`
- **Issue**: `REQUIRED_LOG_FIELDS.issubset(entry.keys())` (line 363) confirms `prompt_bytes` exists but not its value. The test at line 364 correctly asserts `entry["prompt_bytes"] == len("hello".encode("utf-8"))`, so the value is checked in `test_jsonl_logging_writes_entry`. However, `test_jsonl_timeout_entry` (line 424) only checks `timed_out`, `exit_code`, and `success` — it never asserts `prompt_bytes` value even though the spec (WI-022) requires the timeout path to also record original prompt bytes. A regression in the timeout path setting `prompt_bytes = 0` would go undetected. The prior cycle review flagged this as S1 and it is still unresolved.
- **Suggested fix**: Add `assert entry["prompt_bytes"] == len("hello".encode("utf-8"))` to `test_jsonl_timeout_entry` after line 447.

## Unmet Acceptance Criteria

- [ ] **WI-022: "When IDEATE_LOG_FILE is set and a spawn call completes, the log file gains exactly one new line containing valid JSON matching the entry schema"** — The entry schema includes `used_team`, which is present in the implementation but absent from the README documentation of the schema. The implementation itself is correct; the documentation of the schema is not. This is a README accuracy failure, not a code failure.
- [ ] **WI-025: `test_jsonl_timeout_entry` must verify `prompt_bytes`** — The test (line 424) does not assert the value of `prompt_bytes` in the timeout path. WI-022 states `prompt_bytes` is the byte length of the original prompt; the test cannot distinguish a correct value from 0. This criterion was flagged in the prior cycle as S1 and was not fixed.

---

# Code Quality Review — Session Spawner Enhancements (022–025)

## Verdict: Fail

Two issues cause incorrect production behavior: uncaught IO errors in `_log_entry()` crash the MCP server, and the timestamp format does not match the architecture schema.

## Critical Findings

### C1: `_log_entry()` has no exception handler — IO errors crash the MCP server
- **File**: `mcp/session-spawner/server.py:456-461`
- **Issue**: `_log_entry()` opens the log file with no try/except. If the path is unwritable, disk is full, or permissions change mid-run, the exception propagates uncaught through `call_tool()`. By contrast, `_print_status_table()` — a lower-priority operation — is wrapped in try/except. The higher-priority operation is unprotected.
- **Impact**: A single disk-full or permission error causes every subsequent `spawn_session` call to raise an unhandled exception for the server's lifetime.
- **Suggested fix**: Wrap the body of `_log_entry` in `try/except Exception` and emit a `logger.warning` inside the except block.

## Significant Findings

### S1: Timestamp emits `+00:00` suffix, not `Z` as specified in the architecture schema
- **File**: `mcp/session-spawner/server.py:294,396`
- **Issue**: `datetime.datetime.now(datetime.timezone.utc).isoformat()` produces `2026-03-09T14:23:01.123456+00:00`. The architecture schema shows `"2026-03-09T14:23:01.123Z"` — `Z`-terminated, millisecond precision. Actual output differs: suffix is `+00:00` not `Z`, precision is microseconds not milliseconds.
- **Impact**: Log consumers using suffix-based UTC detection (`endswith("Z")`) or validating against the documented schema will fail.
- **Suggested fix**: Replace both occurrences with `.isoformat(timespec="milliseconds").replace("+00:00", "Z")`.

### S2: Entry dict duplicated across timeout and success branches
- **File**: `mcp/session-spawner/server.py:293-306` (timeout) and `395-408` (success)
- **Issue**: The 11-key entry dict is written in full twice. A field added or renamed in one branch must be manually synced to the other. WI-023 implementation notes explicitly recommended a flag-based refactor to avoid this split.
- **Impact**: A future schema change applied to only one branch silently produces incomplete log entries for the other path.
- **Suggested fix**: Use a single post-execution block with a `timed_out` flag; construct one entry dict from shared and variant values.

### S3: `Team` column uses ASCII hyphen, contradicting acceptance criterion (spec-internal contradiction)
- **File**: `mcp/session-spawner/server.py:481`
- **Issue**: WI-023 acceptance criterion specifies em dash `—`; implementation notes in the same work item direct ASCII `-`. The implementation follows the notes. The criterion as written is unmet.
- **Suggested fix**: Resolve the contradiction by updating the criterion to match the implementation notes.

## Minor Findings

### M1: Status table output is non-deterministic under concurrent spawns
- **File**: `mcp/session-spawner/server.py:307-309,409-411`
- **Issue**: Concurrent coroutines share `_session_registry`. A coroutine appending its entry and printing the table may find another coroutine's entry already appended. Under concurrency limit 5 this occurs routinely.
- **Suggested fix**: Document as known limitation, or snapshot registry length before appending.

### M2: No test for `IDEATE_TEAM_NAME` absent from child env when `team_name` omitted
- **File**: `mcp/session-spawner/test_server.py:527-542`
- **Issue**: Positive case tested only. A regression that always sets `IDEATE_TEAM_NAME` would not be caught.
- **Suggested fix**: Add test asserting `"IDEATE_TEAM_NAME" not in captured_env` when no `team_name` is passed.

## Unmet Acceptance Criteria

- [ ] **WI-023, criterion 13**: `Team` shows `—` (em dash) — implementation uses `"-"` at `server.py:481`. Spec-internal contradiction between criterion and implementation notes. The criterion as written is unmet.

---
*This review supersedes the prior-cycle code-quality entries above the separator line.*

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
