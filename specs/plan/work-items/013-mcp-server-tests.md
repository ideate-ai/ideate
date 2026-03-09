# 013: MCP Server Tests

## Objective
Write tests for all safety-critical and correctness-critical behaviors of the session-spawner MCP server.

## Acceptance Criteria
- [ ] Test file exists at `mcp/session-spawner/test_server.py`
- [ ] Tests cover depth tracking: verify that `IDEATE_SPAWN_DEPTH` is incremented in child environment, and that requests at max depth are rejected with descriptive error
- [ ] Tests cover concurrency limiting: verify that the semaphore limits concurrent subprocess launches
- [ ] Tests cover timeout handling: verify that a timed-out subprocess returns structured error with `timed_out: true` and no "None" string in output
- [ ] Tests cover output truncation: verify that output exceeding 50KB is truncated by byte boundary, overflow file is created, and response includes `output_truncated: true` and `full_output_path`
- [ ] Tests cover prompt length validation: verify that prompts exceeding 100KB are rejected
- [ ] Tests cover working_dir validation: verify that non-existent directories are rejected; if `IDEATE_SAFE_ROOT` is set, verify directories outside the root are rejected
- [ ] Tests cover max_depth server-side enforcement: verify caller cannot exceed server-configured max_depth
- [ ] Tests cover token budget field: verify token data is included in response when available in claude output
- [ ] All tests pass with `pytest mcp/session-spawner/test_server.py`

## File Scope
- `mcp/session-spawner/test_server.py` (create)

## Dependencies
- Depends on: 012
- Blocks: none

## Implementation Notes
Use `pytest` with `unittest.mock` to mock `subprocess.run` and `asyncio.to_thread`. Do not spawn actual `claude` processes in tests — mock the subprocess layer.

Test structure:
- `test_depth_exceeded`: Set `IDEATE_SPAWN_DEPTH=3` in env, call with `max_depth=3`, verify rejection.
- `test_depth_incremented`: Mock subprocess.run, verify the child env has `IDEATE_SPAWN_DEPTH` incremented by 1.
- `test_server_side_max_depth`: Set `IDEATE_MAX_DEPTH=2`, call with caller `max_depth=10`, verify effective limit is 2.
- `test_timeout_handling`: Mock subprocess.run to raise `TimeoutExpired`, verify structured error response.
- `test_output_truncation`: Mock subprocess.run with stdout exceeding 50KB, verify truncation and overflow file.
- `test_prompt_length_validation`: Call with 200KB prompt, verify rejection.
- `test_working_dir_validation`: Call with non-existent directory, verify rejection.
- `test_safe_root_validation`: Set `IDEATE_SAFE_ROOT`, call with directory outside root, verify rejection.
- `test_concurrency`: Launch multiple concurrent calls, verify semaphore limits simultaneous executions.

Add `pytest` to `requirements.txt` as a dev dependency (or use a separate `requirements-dev.txt`).

## Complexity
Medium
