# 025: Tests for New Features

## Objective
Add pytest test cases covering JSONL logging, session registry, status table, team_name parameter, and execution instructions injection. All tests use mocked subprocess calls.

## Acceptance Criteria
- [ ] Test file `mcp/session-spawner/test_server.py` has new test functions (added to existing file, not replacing existing tests)
- [ ] All existing tests continue to pass without modification
- [ ] New tests pass with the implementation from work items 022, 023, 024

### JSONL Logging Tests
- [ ] `test_jsonl_logging_writes_entry`: When `IDEATE_LOG_FILE` is set to a temp file, a completed spawn call writes exactly one valid JSON line to the file containing all required fields (`timestamp`, `session_id`, `depth`, `working_dir`, `prompt_bytes`, `team_name`, `used_team`, `duration_ms`, `exit_code`, `success`, `timed_out`, `token_usage`)
- [ ] `test_jsonl_logging_disabled_when_unset`: When `IDEATE_LOG_FILE` is not set, no file is created and no exception is raised
- [ ] `test_jsonl_logging_appends`: Two sequential spawn calls with `IDEATE_LOG_FILE` set result in a file with exactly two JSON lines, each valid
- [ ] `test_jsonl_no_entry_on_depth_exceeded`: A depth-exceeded rejection does not write a log entry
- [ ] `test_jsonl_timeout_entry`: A timed-out call writes an entry with `timed_out=True`, `exit_code=-1`, `success=False`

### Session Registry Tests
- [ ] `test_session_registry_accumulates`: After two spawn calls, `spawner._session_registry` has exactly two entries
- [ ] `test_session_registry_reset_between_tests`: The `_reset_globals` fixture resets `_session_registry` to `[]` (verify fixture covers this)

### team_name Tests
- [ ] `test_team_name_in_log_entry`: When `team_name="workers"` is passed, log entry has `team_name="workers"` and `used_team=True`
- [ ] `test_no_team_name_in_log_entry`: When `team_name` is not passed, log entry has `team_name=None` and `used_team=False`
- [ ] `test_team_name_propagated_to_env`: When `team_name="workers"` is passed, the child subprocess receives `IDEATE_TEAM_NAME="workers"` in its env

### Execution Instructions Tests
- [ ] `test_exec_instructions_param_prepended`: When `exec_instructions="prefer parallel"` is passed, the subprocess receives a prompt starting with `[EXECUTION INSTRUCTIONS]\nprefer parallel\n[END EXECUTION INSTRUCTIONS]\n\n`
- [ ] `test_exec_instructions_env_var_used`: When `IDEATE_EXEC_INSTRUCTIONS="use teams"` is set and no param provided, the subprocess receives the injected prompt
- [ ] `test_exec_instructions_param_overrides_env`: When both param and env var are set, param value is used
- [ ] `test_exec_instructions_propagated_to_child_env`: When instructions are resolved, `IDEATE_EXEC_INSTRUCTIONS` is set in the child subprocess env
- [ ] `test_no_exec_instructions_prompt_unchanged`: When neither param nor env var is set, the subprocess receives the original prompt unchanged
- [ ] `test_prompt_size_validation_uses_original_prompt`: A prompt just under 100KB with exec_instructions set passes validation (instructions not counted toward limit)

### Status Table Tests
- [ ] `test_status_table_printed_to_stderr`: After a spawn call, something is printed to stderr (use `capsys` pytest fixture to capture stderr; assert it's non-empty after one successful call)
- [ ] `test_status_table_empty_registry_no_output`: If `_session_registry` is empty, `_print_status_table()` prints nothing to stderr

## File Scope
- `mcp/session-spawner/test_server.py` (modify)

## Dependencies
- Depends on: 022, 023, 024
- Blocks: none

## Implementation Notes

**Fixture update**: The `_reset_globals` fixture must be updated to also reset `spawner._session_registry = []`. Add this line to the existing fixture.

**JSONL log temp file pattern**:
```python
import tempfile, os
with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
    log_path = f.name
try:
    with patch.dict(os.environ, {"IDEATE_LOG_FILE": log_path}):
        await spawner.call_tool("spawn_session", {...})
    with open(log_path) as f:
        lines = [l for l in f.read().splitlines() if l.strip()]
    assert len(lines) == 1
    entry = json.loads(lines[0])
    # assert fields
finally:
    os.unlink(log_path)
```

**Capturing subprocess cmd for instruction tests**: Use the `captured_env` pattern already established in `test_depth_incremented`, but also capture `args[0]` (the cmd list) to inspect the prompt argument:
```python
captured_cmd = []
def fake_run(cmd, **kwargs):
    captured_cmd.extend(cmd)
    return _make_completed_process(stdout='{"result": "ok"}')
```
The prompt is the last positional argument to `claude --print ...` (see server.py line ~221).

**stderr capture**: Use pytest's `capsys` fixture:
```python
async def test_status_table_printed_to_stderr(capsys, tmp_working_dir):
    with patch("subprocess.run", return_value=_make_completed_process(...)):
        await spawner.call_tool("spawn_session", {"prompt": "hi", "working_dir": tmp_working_dir})
    captured = capsys.readouterr()
    assert len(captured.err) > 0
```

**prompt_bytes validation test**: Create a prompt of exactly 99,900 bytes, set `exec_instructions` to a 1000-byte string. The call should proceed (not be rejected for size). Verify subprocess.run is called.

## Complexity
Medium
