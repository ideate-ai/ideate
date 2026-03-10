# Decision Log and Open Questions — Cycle 3 (2026-03-09)

*Cycle 3 covers the minor fixes applied after the cycle 2 review and the subsequent capstone review of those fixes. Scope: `mcp/session-spawner/server.py`, `mcp/session-spawner/test_server.py`, `mcp/session-spawner/README.md`.*

---

## Decision Log

### Execution Phase — Cycle 3

#### DL28: Consolidated entry dict into single shared block using outcome variables
- **When**: Minor fixes before cycle 3 review (2026-03-09), resolving OQ3
- **Decision**: Both timeout and success branches now set `outcome_*` variables; a single post-execution block constructs one entry dict from those variables. The duplicate 11-key dict written in both branches is eliminated.
- **Rationale**: Code-quality S2 (cycle 2) flagged that a field rename applied to only one branch would silently produce inconsistent JSONL entries.

#### DL29: Fixed `#` column minimum width from 2 to 4
- **When**: Minor fixes before cycle 3 review (2026-03-09), resolving OQ6
- **Decision**: `col_widths["#"]` initialized to `4`, matching WI-023 implementation notes.

#### DL30: Strengthened status table test to assert all five column headers
- **When**: Minor fixes before cycle 3 review (2026-03-09), resolving OQ7
- **Decision**: `test_status_table_printed_to_stderr` now asserts all five column header strings appear in captured stderr.

#### DL31: IDEATE_TEAM_NAME stripped from env before conditional re-set
- **When**: Minor fixes before cycle 3 review (2026-03-09), resolving OQ8
- **Decision**: `env.pop("IDEATE_TEAM_NAME", None)` called before the conditional block that re-sets it only when `team_name` is provided. Prevents grandparent team name from leaking to grandchildren.

#### DL32: Added three negative-case env propagation tests
- **When**: Minor fixes before cycle 3 review (2026-03-09), resolving OQ9
- **Decision**: Three tests added verifying `IDEATE_EXEC_INSTRUCTIONS` and `IDEATE_TEAM_NAME` are absent from child env when not provided. Total test count is 32.

#### DL33: WI-023 acceptance criterion corrected from em dash to ASCII hyphen
- **When**: Minor fixes before cycle 3 review (2026-03-09), resolving OQ10
- **Decision**: Criterion 13 text updated to specify ASCII hyphen `-`, matching both implementation notes and the implementation.

#### DL34: README status table example found incorrect during cycle 3 review
- **When**: Review — cycle 3 capstone (2026-03-09)
- **Decision**: The status table example written during the cycle 2 README update uses wrong column names, wrong duration format (`12500ms` vs `12.5s`), a non-existent `tokens` column, and wrong status vocabulary (`ok` vs `completed/failed/timed_out`). All three reviewers flagged independently. Fix deferred — review closed after execution.

---

## Open Questions — Cycle 3

### OQ11: README status table example is entirely wrong [Critical — address now]
- **Question**: README Observability section shows columns `#, team, depth, duration, tokens, status` with `ok` status and `12500ms` duration. Actual implementation: columns `#, Session ID, Depth, Status, Duration, Team`, duration as `12.5s`, status as `completed/failed/timed_out`, no `tokens` column.
- **Source**: Code-quality C1 (cycle 3 — actually S1); Spec-adherence D1; Gap-analysis II1 — all three reviewers independently
- **Fix**: Replace example block with output matching actual `_print_status_table()`.

### OQ12: README JSONL schema omits `used_team` and misrepresents `team_name` null behavior [Significant — address now]
- **Question**: (1) `used_team` absent from README schema example — implementation always writes it. (2) README states `team_name` is "omitted when not provided" — implementation writes `null`.
- **Source**: Code-quality S2; Spec-adherence D2; Gap-analysis II2 — all three reviewers independently
- **Fix**: Add `used_team` to example; change note to "When not provided, `team_name` is `null` and `used_team` is `false`."

### OQ13: `AttributeError` crash on non-dict subprocess JSON output [Critical — address now]
- **Question**: `parsed.get("session_id", "")` at `server.py:327` is called before the `isinstance(parsed, dict)` guard on line 328. `json.loads()` can return list, string, number, or null. `AttributeError` from `.get()` on a non-dict is not caught by `except (json.JSONDecodeError, TypeError)` — propagates unhandled, discarding the spawn result, session registry entry, and log entry.
- **Source**: Code-quality C1 (cycle 3) — not caught in prior reviews
- **Fix**: Move `parsed.get("session_id", "")` inside the `isinstance(parsed, dict)` block.

### OQ14: `test_jsonl_timeout_entry` still does not assert `prompt_bytes` value [Minor — 2nd-cycle carry-forward]
- **Question**: Timeout-path log entry test checks `timed_out`, `exit_code`, `success` but never asserts `prompt_bytes` equals the original prompt byte length. A regression recording `prompt_bytes = 0` in the timeout path would go undetected.
- **Source**: Code-quality M1 (cycle 3); incremental review S1 (cycle 2) — two consecutive cycles unresolved

### OQ15: No observability of peak concurrency [Deferred]
- **Question**: JSONL log cannot answer "how many sessions were running simultaneously." The user's stated goal requires external timestamp-overlap analysis not documented anywhere.
- **Source**: Gap-analysis MR1 (cycle 3)
- **Recommendation**: Document limitation in README; optionally add a concurrency counter field.

### OQ16: `_reset_globals` fixture scope exceeds specification [Minor — 3rd-cycle carry-forward]
- **Question**: Fixture resets `_semaphore`, `_server_max_depth`, and `_session_registry` with `autouse=True`; WI-025 specified only `_session_registry`. Flagged in three consecutive review cycles without resolution.
- **Source**: Spec-adherence M3 (cycle 3); code-quality M2 (cycle 2); incremental S2 (cycle 2)

### OQ17: Status table test does not verify separator characters or data row content [Deferred]
- **Question**: Table-formatting logic — separator generation, right-alignment, status strings, duration format — entirely untested. Test would pass if implementation emitted a flat string containing the five header words.
- **Source**: Gap-analysis IR1 (cycle 3)

### OQ18: team_name advisory-only — no mechanism for spawned sessions to act on IDEATE_TEAM_NAME [Significant — documented, unresolved]
- **Question**: `IDEATE_TEAM_NAME` written to child env but read by nothing. No CLAUDE.md hook, exec_instructions default, or skill reads it. README now documents advisory-only but capability gap remains.
- **Source**: Gap-analysis MR2 (cycle 2 carry-forward); OQ5 (cycle 2)

---

## Cross-References

| ID | Finding | Reviewers |
|----|---------|-----------|
| CR6 | README status table example wrong — columns, duration, status vocabulary | Code-quality S1 + Spec-adherence D1 + Gap-analysis II1 |
| CR7 | README JSONL schema omits `used_team`, misrepresents `team_name` null | Code-quality S2 + Spec-adherence D2 + Gap-analysis II2 |
| CR8 | `AttributeError` crash on non-dict JSON output | Code-quality C1 only — new finding, not caught in prior two cycles |

---

*Prior-cycle decision log follows.*

---

# Decision Log and Open Questions — Cycle 2 (2026-03-09)

*Cycle 2 covers work items 022–025: session spawner observability and execution control enhancements.*

---

## Decision Log

### Planning Phase — Cycle 2

#### DL18: Observability and execution control as the cycle 2 scope
- **When**: Refinement interview — 2026-03-09
- **Decision**: Cycle 2 adds four capabilities to `server.py` only: JSONL logging, in-memory session registry, team_name parameter with env propagation, status table to stderr, and execution instructions injection.
- **Rationale**: Session spawner not being called as much as expected. User wants data on spawn frequency, parallelism, and a mechanism to tune agent behavior across all recursive sessions.

#### DL19: JSONL as log format
- **When**: Refinement interview Q5 (2026-03-09)
- **Decision**: Log entries written as JSONL to `IDEATE_LOG_FILE`. No-op if env var unset.
- **Rationale**: User specified JSONL when asked for preferred format.

#### DL20: Status table printed to stderr after every spawn
- **When**: Refinement interview Q6, architecture doc (2026-03-09)
- **Decision**: ASCII box table printed to stderr after each `spawn_session` call. Wrapped in try/except to prevent table errors from affecting spawn results.
- **Rationale**: stderr chosen because stdio transport uses stdout for the MCP protocol.

#### DL21: exec_instructions propagate recursively via env var
- **When**: Refinement interview Q7, architecture doc (2026-03-09)
- **Decision**: Instructions prepended to prompt in a delimited block and also set as `IDEATE_EXEC_INSTRUCTIONS` in child env for recursive propagation.
- **Rationale**: User: "instructions propagate recursively — not just the foreground session but all sessions spawned as a result."

#### DL22: team_name is advisory and observability-only
- **When**: Architecture doc (2026-03-09)
- **Decision**: `team_name` is logged and propagated via `IDEATE_TEAM_NAME` env var but does not configure subprocess behavior. No CLI flag exists for passing team name to `claude --print`.
- **Rationale**: Research confirmed no CLI mechanism. Architecture explicitly states: "The parameter does not directly configure the subprocess beyond env var propagation."
- **Implications**: User intent — spawned sessions use agent teams — is not fulfilled by env var propagation alone (see OQ5).

#### DL23: "Reasonable assumptions" for open design questions
- **When**: Refinement interview Q8 (2026-03-09)
- **Decision**: Log rotation policy, instruction injection format, and table timing resolved by architect without returning to user.
- **Rationale**: User explicitly: "Use reasonable assumptions."

### Execution Phase — Cycle 2

#### DL24: Timeout and success paths share post-processing block
- **Decision**: Timeout path refactored to set a flag and fall through rather than return early, enabling both paths to call `_log_entry` and `_print_status_table`. Despite this, the entry dict is still written in full in both branches (code-quality S2).

#### DL25: prompt_bytes records original prompt before injection
- **Decision**: `original_prompt_bytes` captured before any `exec_instructions` block is prepended. Used for size validation and log entry.

#### DL26: `_reset_globals` fixture broadened to all globals
- **Decision**: Fixture was extended to reset `_semaphore` and `_server_max_depth` in addition to `_session_registry`, with `autouse=True` on all 29 tests. Exceeds WI-025 specification. Three reviewers flagged this (spec-adherence M3, code-quality M2, incremental S2).

### Review Phase — Cycle 2

#### DL27: em dash vs. ASCII hyphen in Team column — spec-internal contradiction
- **Decision**: Implementation uses ASCII `-` following implementation notes; acceptance criterion specifies em dash `—`. Three reviewers flagged the contradiction. Criterion must be updated to match actual behavior.

---

## Open Questions — Cycle 2

### OQ1: `_log_entry()` has no exception handler [CRITICAL — address now]
- A misconfigured `IDEATE_LOG_FILE` (unwritable path, full disk) causes every `spawn_session` call to raise an MCP error for the server's lifetime.
- **Fix**: Wrap body in try/except, emit `logger.warning` in except.
- **Source**: Code-quality C1; gap-analysis EC1/MI2 (three reviewers, two independently)

### OQ2: Timestamp format is `+00:00` not `Z` [Significant — address now]
- `datetime.isoformat()` produces microsecond precision with `+00:00` suffix; architecture schema shows millisecond precision with `Z` suffix.
- **Fix**: `.isoformat(timespec="milliseconds").replace("+00:00", "Z")` — both call sites.
- **Source**: Code-quality S1

### OQ3: Entry dict duplicated across timeout and success branches [Significant]
- 11-key dict written twice. A field rename applied to only one branch silently produces inconsistent logs.
- **Fix**: Construct one dict using a `timed_out` flag.
- **Source**: Code-quality S2

### OQ4: README does not document new parameters, env vars, or log format [Significant — address now]
- `team_name`, `exec_instructions`, `IDEATE_LOG_FILE`, `IDEATE_EXEC_INSTRUCTIONS`, `IDEATE_TEAM_NAME` all absent from README. No work item was assigned README update responsibility.
- **Source**: Gap-analysis MR1, MR3, MI1, IR1, MI3

### OQ5: team_name does not activate agent team behavior [Significant]
- `IDEATE_TEAM_NAME` env var written to child env but read by nothing. Users expecting parallel agent teams will see no change.
- **Resolution needed**: Document as advisory-only in README; optionally inject team directive into exec_instructions block when team_name is provided.
- **Source**: Gap-analysis MR2

### OQ6: `_reset_globals` fixture scope exceeds specification [Minor]
- Fixture resets three globals with `autouse=True`; spec specified resetting one.
- **Source**: Spec-adherence M3; code-quality M2; incremental S2

### OQ7: Status table test assertion too weak [Minor]
- `test_status_table_printed_to_stderr` only checks `len(captured.err) > 0`.
- **Fix**: Add assertion for column header presence.
- **Source**: Spec-adherence M2; incremental M1

### OQ8: IDEATE_TEAM_NAME leaks to grandchild sessions [Minor]
- In three-level nesting, grandchild inherits team name from grandparent via `os.environ` spread even when middle session omits `team_name`.
- **Source**: Gap-analysis EC2

### OQ9: Missing negative-case env propagation tests [Minor]
- No test verifies `IDEATE_EXEC_INSTRUCTIONS` or `IDEATE_TEAM_NAME` are absent from child env when not provided.
- **Source**: Gap-analysis II1–II2; code-quality M2

### OQ10: WI-023 criterion and implementation notes contradict on em dash vs. hyphen
- Criterion text is permanently "unmet" unless updated to match implementation.
- **Source**: Code-quality S3; spec-adherence unmet criterion 13

---

## Cross-References

| ID | Finding | Reviewers |
|----|---------|-----------|
| CR1 | `_log_entry()` crash risk | Code-quality C1 + Gap-analysis EC1/MI2 |
| CR2 | Test coverage weakness (table + env propagation) | Code-quality M2 + Spec-adherence M2 + Gap-analysis II1-II2 + Incremental M1 |
| CR3 | Timestamp schema non-conformance + undocumented schema | Code-quality S1 + Gap-analysis MR1 |
| CR4 | README documentation gap — no work item owned it | Gap-analysis MR1/MR3/MI1/IR1/MI3 |
| CR5 | team_name intent vs. advisory implementation | Gap-analysis MR2 (architecture explicitly chose advisory design) |

---

*Prior-cycle decision log follows the separator line below.*

---
# Decision Log and Open Questions — Cycle 1

## Decision Log

### Planning Phase

#### DL1: Clean-Slate Reimplementation
- **When**: Planning
- **Decision**: Build ideate v2 as a complete reimplementation with no assumptions from v1.
- **Rationale**: Use ideate to redesign itself (dogfooding). Clean-slate avoids inherited design bias.
- **Implications**: All design choices justified from first principles. No v1 user migration addressed.

#### DL2: Spec Sufficiency as Primary Quality Standard
- **When**: Planning
- **Decision**: A plan is complete only when two independent LLMs given the same spec would produce functionally equivalent output.
- **Rationale**: LLMs struggle with large tasks due to underspecified plans.
- **Implications**: High bar for planning interview depth and work item specification breadth.

#### DL3: Progressive Decomposition (Architecture → Modules → Work Items)
- **When**: Planning
- **Decision**: Three-level decomposition with interface contracts at the module level.
- **Rationale**: LLMs are good at small, well-bounded tasks.
- **Implications**: 5-module threshold for intermediate module specs. May be too rigid for complex smaller projects.

#### DL4: Parallel-First Execution
- **When**: Planning
- **Decision**: Agent teams as default; sequential and batched as secondary modes.
- **Rationale**: Speed and quality priorities. User preference for teams mode.
- **Implications**: Non-overlapping scope required. All three modes must be supported.

#### DL5: Andon Cord Interaction Model
- **When**: Planning
- **Decision**: Minimal post-planning user interaction. Issues batched at natural pause points.
- **Rationale**: User requested minimal post-planning interaction. Principles serve as decision framework.
- **Implications**: Principles must be thorough enough to resolve most runtime decisions.

#### DL6: External MCP Session-Spawner
- **When**: Planning
- **Decision**: Build a Python MCP server for recursive sub-session spawning.
- **Rationale**: Recursive decomposition requires sub-session invocation; Claude Code cannot natively do this.
- **Alternatives**: Multiple sequential runs (no tooling), Claude Agent SDK orchestration.
- **Implications**: Python runtime dependency. Language choice deferred during planning.

#### DL7: Guiding Principles as Delegation Framework
- **When**: Planning
- **Decision**: Principles are the single decision framework for autonomous vs. user-input decisions.
- **Rationale**: Users care about objectives, not every implementation detail.

#### DL8: Durable Artifact Directory as Inter-Phase Contract
- **When**: Planning
- **Decision**: All knowledge on disk. No in-memory state between skill invocations.
- **Rationale**: Context windows are limited. Artifact directory is single source of truth.

#### DL9: Continuous Review Overlapping Execution
- **When**: Planning
- **Decision**: Incremental reviews during execution; capstone synthesis at end.
- **Rationale**: Catching issues at creation is faster than batch review.

#### DL10: Domain Agnostic Core, Software Primary
- **When**: Planning
- **Decision**: Core workflow is domain agnostic. Evaluation criteria come from the plan.
- **Rationale**: User goal with software as near-term focus.

#### DL11: Scope: Idea to User-Testable Output
- **When**: Planning
- **Decision**: Stop at user-testable output. No ongoing maintenance or deployment.
- **Rationale**: User-defined scope boundary.

### Execution Phase

#### DL12: Python for MCP Session-Spawner
- **When**: Execution — work item 010
- **Decision**: Python implementation selected.
- **Rationale**: Not documented. Language choice was deferred during planning.
- **Implications**: Python 3.10+ dependency. TypeScript alternative never formally evaluated.

#### DL13: Incremental Review Format Richer Than Conventions
- **When**: Execution — work items 007, 008
- **Decision**: Execute skill and code-reviewer use richer format than artifact-conventions.md specifies.
- **Rationale**: More informative format. Assessment: conventions should be updated to match.
- **Implications**: artifact-conventions.md is inconsistent with practice. Not fixed this cycle.

---

## Open Questions

### OQ1: Spec Sufficiency Runtime Heuristic
- **Question**: How does the tool pragmatically validate spec sufficiency at runtime?
- **Source**: Journal — explicitly deferred.
- **Impact**: Plan skill cannot reliably signal "done."
- **Who answers**: Technical investigation.
- **Consequence of inaction**: Plans declared complete with unanswered questions. Core quality guarantee weakened.

### OQ2: Token Budget for Recursive Sessions
- **Question**: How are token budgets bounded across the session tree?
- **Source**: Journal — explicitly deferred.
- **Impact**: Large projects could exhaust budgets with no warning.
- **Who answers**: Technical investigation.
- **Consequence of inaction**: Runaway cost with no safeguard.

### OQ3: Python vs TypeScript Rationale
- **Question**: Was Python the right choice? Decision was never formally evaluated.
- **Source**: Journal — deferred during planning, silently resolved during execution.
- **Who answers**: User decision.
- **Consequence of inaction**: Python stands by default. Undocumented language choice.

### OQ4: artifact-conventions.md Format Inconsistency
- **Question**: Conventions doc doesn't match actual review format used by agents.
- **Source**: Multiple incremental reviews.
- **Who answers**: Technical investigation.
- **Consequence of inaction**: Conventions doc drifts from reality.

### OQ5: Plugin Manifest Validation Never Run
- **Question**: Does plugin.json pass `claude plugin validate`?
- **Source**: Incremental review 001.
- **Who answers**: Technical investigation — run the command.
- **Consequence of inaction**: Plugin may fail to load.

### OQ6: Module Spec Threshold Rigidity
- **Question**: Should 5-module threshold be softened or made configurable?
- **Source**: Incremental review 005-006.
- **Who answers**: Design review.
- **Consequence of inaction**: Complex small projects miss progressive decomposition benefits.

### OQ7: --allowedTools CLI Syntax
- **Question**: Does Claude CLI accept comma-separated tool names?
- **Source**: Incremental review 007-008-010.
- **Who answers**: Technical investigation — test it.
- **Consequence of inaction**: Tool allowlist feature may be silently broken.
