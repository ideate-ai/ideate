# Spec Adherence Review — Cycle 3 (2026-03-09)

## Scope

Capstone review of WI-022 through WI-025 after post-cycle-2 minor fixes. Files reviewed: `mcp/session-spawner/server.py`, `mcp/session-spawner/test_server.py`, `mcp/session-spawner/README.md`.

## Verdict: Pass

All acceptance criteria for WI-022, WI-023, WI-024, and WI-025 are met. Both targeted minor fixes (M1: `#` column width, M2: status table test assertion) are confirmed resolved. One carry-forward minor finding (M3: `_reset_globals` scope) remains with no behavioral impact. Two documentation deviations are identified in README.md against the architecture schema. No principle violations.

## Architecture Deviations

### D1: README status table example uses wrong column names and format
- **Expected**: Architecture specifies columns `#`, `Session ID`, `Depth`, `Status`, `Duration`, `Team`; duration as `{N.N}s`
- **Actual**: `README.md` Observability section shows columns `#`, `team`, `depth`, `duration`, `tokens`, `status` with duration as `12500ms` and a `tokens` column that does not exist in the implementation
- **Evidence**: `/Users/dan/code/ideate/mcp/session-spawner/README.md` status table example block

### D2: README JSONL schema omits `used_team` and misrepresents `team_name` null behavior
- **Expected**: Architecture entry schema includes `"used_team": true/false` (always present); `team_name` is always written as `null` when not provided
- **Actual**: README sample JSONL entry omits `used_team`; note states "`team_name` is omitted when not provided" (incorrect — implementation always writes the key as `null`)
- **Evidence**: `/Users/dan/code/ideate/mcp/session-spawner/README.md` JSONL Logging section

## Unmet Acceptance Criteria

None. All acceptance criteria for WI-022, WI-023, WI-024, and WI-025 are met.

Notes on previously-flagged items:
- WI-023 criterion 13 (em dash): criterion text corrected to ASCII hyphen; implementation at `server.py:476` uses `-`. Met.
- WI-022/025 `prompt_bytes` value assertions: `test_server.py:364` and `test_server.py:448` now assert exact byte-length values. Met.

## Principle Violations

None.

## Undocumented Additions

### U1: Three negative-case env propagation tests not enumerated in WI-025
- **Location**: `mcp/session-spawner/test_server.py:712-769`
- WI-025 acceptance criteria enumerate 18 specific test functions; these three are additional. Total test count is 32, not 29. The WI-025 "All 29 tests pass" criterion is superseded by the higher count. Additive and correct.

## Cycle 2 Findings Resolution

| Finding | Cycle 2 Status | Cycle 3 Status |
|---------|---------------|----------------|
| M1: `#` column minimum width 2 vs spec 4 | Open | Resolved — `server.py` initializes `"#": 4` |
| M2: status table test assertion too weak | Open | Resolved — `test_server.py:693-697` asserts all 5 column headers |
| M3: `_reset_globals` resets more than specified | Open | Unchanged — no behavioral regression |
| Incremental S1: `prompt_bytes` value not asserted | Resolved in cycle 2 | Confirmed — `test_server.py:364,448` assert exact values |
| WI-023 criterion 13 em dash contradiction | Documented | Resolved — criterion corrected to ASCII hyphen |

---

*Cycle 3 review above. Cycle 2 review below.*

---

# Spec Adherence Review — Session Spawner Enhancements (022–025)

## Verdict: Pass

All components implement their specified behavior. Two spec-internal contradictions are noted (both resolved correctly in favor of implementation notes). No principle violations. The overall implementation adheres to the architecture, guiding principles, and constraints.

## Critical Findings

None.

## Significant Findings

None.

## Minor Findings

### M1: `#` column minimum width initialized to 2, spec notes specify 4
- **File**: `mcp/session-spawner/server.py:496`
- **Issue**: WI-023 implementation notes specify `#: 4` minimum. Implementation initializes to `2`. Single-digit row counts render the column narrower than the illustrated spec format.
- **Suggested fix**: Initialize `"#": 4` in `col_widths`.

### M2: `test_status_table_printed_to_stderr` assertion too weak
- **File**: `mcp/session-spawner/test_server.py:693`
- **Issue**: Only asserts `len(captured.err) > 0`. Cannot distinguish a correct table from any non-empty stderr output. Criterion as written is satisfied; behavioral coverage is insufficient to catch a broken table renderer.
- **Suggested fix**: Also assert that `captured.err` contains `"Session ID"` (column header).

### M3: `_reset_globals` fixture resets more globals than WI-025 specified
- **File**: `mcp/session-spawner/test_server.py:42-48`
- **Issue**: WI-025 specifies adding `_session_registry` reset. Fixture also resets `_semaphore` and `_server_max_depth` with `autouse=True`, altering the implicit test isolation contract for all 29 tests.
- **Suggested fix**: Document fixture's full scope in a comment. No immediate behavioral issue.

## Unmet Acceptance Criteria

### Work Item 023: Status Table
- [ ] Criterion 13: `Team` shows `—` (em dash) when `team_name` is null or empty — Implementation shows ASCII `-`. This is a spec-internal contradiction: the implementation notes in the same work item explicitly instruct "Use ASCII `-` rather than em dash to avoid encoding issues." The implementation follows the notes. The criterion text is technically unmet; the notes are the authoritative source.

## Principle Adherence Evidence

- **Principle 2 — Minimal Inference**: `exec_instructions` priority (param > env var > None) implemented exactly as specified. `server.py:133-134`.
- **Principle 8 — Durable Knowledge Capture**: JSONL append-mode writes persist all session outcomes. `server.py:454-460`.
- **Constraint 6 — Non-overlapping scope**: WI-022 and WI-024 have disjoint code sections; sequencing respected.
- **Constraint 7 — Machine-verifiable criteria**: All new criteria tested with deterministic assertions. `test_server.py:342-701`.

## Incremental Review Cross-Reference

| Finding | Status |
|---------|--------|
| S1: `prompt_bytes` not asserted in logging tests | Resolved — `test_server.py:364,448` |
| S2: `_reset_globals` exceeds spec scope | Remains — carried forward as M3 |
| M1: `test_status_table_printed_to_stderr` too weak | Remains — carried forward as M2 |
| M2: `prompt_byte_len` redundant alias | Resolved — `server.py:141` |
| M3: Team column width 15 undocumented | False finding — WI-023 notes specify `Team: 15` |

---
*This review supersedes the prior-cycle spec-adherence entries above the separator line.*

### [Work Item 001] `claude plugin validate` never run
Criterion: "Plugin validates cleanly with `claude plugin validate`"
Status: Not verified. The incremental review deferred this to "end-of-execution validation" which was never performed.

### [Work Item 010] Token budget tracking not implemented
Criterion: "Total token budget tracking (logged, not enforced — for user awareness)"
Status: Entirely absent from implementation. The server has no token count field and no logging of token consumption.

## Architecture Deviations

### spawn_session — output_format parameter not in architecture spec
Architecture section 5 defines the tool interface without `output_format`. Work item 010 added it. Implementation follows the work item, creating inconsistency with architecture spec.
Architecture says: 7 parameters (prompt, working_dir, max_turns, max_depth, timeout, permission_mode, allowed_tools)
Implementation has: 8 parameters (adds output_format)

### spawn_session — undocumented return fields
Architecture return schema specifies 5 fields: output, exit_code, session_id, duration_ms, error.
Implementation adds: output_truncated, full_output_path, timed_out in relevant cases.

### Agent background field missing from all agent frontmatter
Architecture table lists `Background: no` for architect, code-reviewer, spec-reviewer, gap-analyst, journal-keeper; `Background: yes` for researcher. Only the researcher agent has a `background` field in its frontmatter. All others omit it entirely.

### Architect has no Write tool but is instructed to write files
Architecture lists architect tools as: Read, Grep, Glob, Bash. The architect's instructions tell it to write to `plan/architecture.md` and `plan/modules/*.md`. Writing is only possible via Bash, which is not explicitly stated.

## Guiding Principle Violations

None found. All 12 principles have evidence of adherence in the implementation.

## Undocumented Additions

- Resume detection in execute skill (not in architecture or work item 007)
- Worker agent retry-once policy in execute skill error handling
- Project source root derivation with four-step precedence in refine skill
- `IDEATE_MAX_CONCURRENCY` environment variable for concurrency configuration
- `cwd` argument passed to both `claude --cwd` and `subprocess.run(cwd=)` (belt-and-suspenders)
- Working directory existence validation before spawning

All undocumented additions are sensible safety measures or usability improvements. None contradict the specification.
