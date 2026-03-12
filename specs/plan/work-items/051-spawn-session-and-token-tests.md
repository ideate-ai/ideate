# Work Item 051: Tests for model Parameter and Token Budget Logging

## Objective

Add tests covering the new `model` parameter in `spawn_session` (WI-039) and token budget logging (WI-046). These tests must run after WI-039, WI-043, and WI-046 are all complete to avoid file conflicts and to build on the `_reset_globals` fix from WI-043.

## Acceptance Criteria

1. Test: `spawn_session` with `model="claude-opus-4-6"` passes `--model claude-opus-4-6` to the subprocess command
2. Test: `spawn_session` without `model` parameter does NOT include `--model` in the subprocess command
3. Test: `spawn_session` with `model=None` does NOT include `--model` in the subprocess command
4. Test: JSONL log entry includes `"token_usage"` field when claude JSON output contains usage data
5. Test: JSONL log entry has `"token_usage": null` when claude output is non-JSON (e.g., plain text)
6. Test: JSONL log entry has `"token_usage": null` on the timeout path
7. Test: `token_usage` field structure matches the documented schema (has `input_tokens` and `output_tokens` integer keys when not null)
8. All existing tests (43+ at time of this work item) continue to pass
9. New tests follow the existing mock patterns (mock subprocess.run, check call_args for command flags)

## File Scope

- modify: `mcp/session-spawner/test_server.py`

## Dependencies

- 039 (model parameter must exist in server.py)
- 043 (`_reset_globals` fix prevents state contamination; WI-051 must run after)
- 046 (token budget logging must exist in server.py)

## Implementation Notes

**Model parameter tests**: Mock `subprocess.run` as in existing tests. Call `spawn_session` via the tool handler with `model` in the arguments dict. Assert `mock_run.call_args[0][0]` (the command list) contains `"--model"` followed by the model string. For the no-model case, assert `"--model"` is NOT in the command list.

**Token budget tests**: The mock subprocess.run needs to return output that includes token usage data in the JSON. Set up the mock to return:
```python
CompletedProcess(
    args=[],
    returncode=0,
    stdout=json.dumps({
        "session_id": "test-session",
        "result": "done",
        "usage": {"input_tokens": 100, "output_tokens": 50}
    }),
    stderr=""
)
```
Then read the JSONL log file (or capture `_log_entry` call) and assert the entry contains `token_usage` with the expected values.

For the non-JSON output test, set `stdout="plain text response"` and assert `token_usage` is null in the log entry.

For the timeout test, use the existing timeout mock pattern and assert `token_usage` is null.

Group the new tests into a labeled section following the existing section comment convention.

## Complexity

Medium
