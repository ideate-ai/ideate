# Work Item 046: Token Budget Logging in spawn_session

## Objective

Parse token usage from the claude subprocess's JSON output and include it in the JSONL log entry for each spawn call. The `claude --output-format json` response includes token usage data. Extract it, log it, and document the schema. This was deferred since cycle 1 and explicitly re-committed in the 2026-03-11 refinement.

## Acceptance Criteria

1. The JSONL log entry written by `_log_entry()` includes a `token_usage` field
2. `token_usage` is an object with at minimum `input_tokens` and `output_tokens` integer fields (matching the claude JSON output schema)
3. If token usage cannot be parsed from the subprocess output (non-JSON output, missing fields, timeout path with partial output), `token_usage` is `null` in the log entry — never crashes
4. The token usage is extracted from the same JSON parsing path used to extract `session_id` (the `isinstance(parsed, dict)` block in the `call_tool` handler)
5. `mcp/session-spawner/README.md` JSONL schema example includes `token_usage` with the object structure documented
6. The `token_usage` field is present in both the success path and the timeout path (null on timeout)
7. All existing 42+ tests continue to pass

## File Scope

- modify: `mcp/session-spawner/server.py`
- modify: `mcp/session-spawner/README.md`

## Dependencies

- 044 (README already modified by WI-044; WI-046 must sequence after to avoid conflicting README edits)

## Implementation Notes

The claude `--output-format json` response is parsed in the `call_tool` handler. Locate the block:
```python
if isinstance(parsed, dict):
    session_id = parsed.get("session_id", "")
```

In this same block, extract:
```python
token_usage = parsed.get("usage", None)
# claude JSON output may use "usage" with keys "input_tokens", "output_tokens"
# or similar — check actual output format
```

Pass `token_usage` to `_log_entry()` as a new parameter. In `_log_entry()`, include it in the entry dict:
```python
entry = {
    ...existing fields...,
    "token_usage": token_usage  # dict with input_tokens/output_tokens, or null
}
```

For the timeout path, `token_usage` should be `null` (None in Python).

**Important**: Check the actual format of `claude --output-format json` token usage output. The field may be named `usage`, `token_count`, or similar. The acceptance criteria specifies `input_tokens` and `output_tokens` as the expected subfields — but if the actual output uses different field names, use the actual names and document accordingly.

**README update**: In the JSONL Logging section, add `token_usage` to the example entry:
```json
{
  ...existing fields...,
  "token_usage": {
    "input_tokens": 1250,
    "output_tokens": 340
  }
}
```
Add a note: "null when token data is unavailable (timeout path or non-JSON output)."

## Complexity

Medium
