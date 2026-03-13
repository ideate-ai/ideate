# 022: JSONL Logging, Session Registry, and team_name Parameter

## Objective
Add structured JSONL logging and an in-memory session registry to the session-spawner, and add an optional `team_name` parameter to `spawn_session`. Every call writes a log entry (if `IDEATE_LOG_FILE` is set) and records to the registry for status table use.

## Acceptance Criteria
- [ ] `spawn_session` tool schema includes `team_name` (string, optional) with description "Advisory team name for the spawned session. Logged and propagated via IDEATE_TEAM_NAME env var."
- [ ] Module-level `_session_registry: list[dict]` is declared and initialized to `[]`
- [ ] `_log_entry(entry: dict) -> None` function exists; appends a JSON line + newline to the path in `IDEATE_LOG_FILE`; is a no-op if `IDEATE_LOG_FILE` is unset or empty
- [ ] `_log_entry` opens the file in append mode (`"a"`) per call; does not keep a file handle open between calls
- [ ] After every spawn call (success, failure, timeout, depth-exceeded errors excepted — see notes), an entry dict is built and: (a) appended to `_session_registry`, (b) passed to `_log_entry`
- [ ] Entry dict contains exactly these keys: `timestamp` (ISO 8601 UTC string), `session_id` (str), `depth` (int — `current_depth + 1`), `working_dir` (str — resolved path), `prompt_bytes` (int — byte length of original prompt before any injection), `team_name` (str or null), `used_team` (bool — true iff team_name is non-empty), `duration_ms` (int), `exit_code` (int), `success` (bool — exit_code == 0), `timed_out` (bool), `token_usage` (dict or null)
- [ ] `team_name` is propagated to child subprocess via `IDEATE_TEAM_NAME` env var when provided and non-empty
- [ ] When `IDEATE_LOG_FILE` is set and a spawn call completes, the log file gains exactly one new line containing valid JSON matching the entry schema
- [ ] Pre-spawn rejections (prompt too large, invalid working_dir, safe_root violation, depth exceeded) do NOT write log entries

## File Scope
- `mcp/session-spawner/server.py` (modify)

## Dependencies
- Depends on: none
- Blocks: 023, 025

## Implementation Notes

**Session registry placement**: Declare `_session_registry: list[dict] = []` at module level alongside `_semaphore` and `_server_max_depth`.

**_log_entry function**: Place after the registry declaration. Signature:
```python
def _log_entry(entry: dict) -> None:
    log_file = os.environ.get("IDEATE_LOG_FILE", "")
    if not log_file:
        return
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
```

**Timestamp**: Use `datetime.datetime.now(datetime.timezone.utc).isoformat()`. Add `import datetime` at the top.

**Entry construction**: Build a single dict after the subprocess completes (or times out). For timeout case, `exit_code=-1`, `timed_out=True`, `success=False`, `duration_ms` as computed, `session_id=""`, `token_usage=null`.

**team_name parameter**: Add to `inputSchema.properties` in `list_tools()`:
```python
"team_name": {
    "type": "string",
    "description": "Advisory team name for the spawned session. Logged and propagated via IDEATE_TEAM_NAME env var.",
}
```
Not in `required`. Read with `arguments.get("team_name")`.

**Env propagation**: In the env dict construction:
```python
env = {**os.environ, "IDEATE_SPAWN_DEPTH": str(current_depth + 1)}
if team_name:
    env["IDEATE_TEAM_NAME"] = team_name
```

**prompt_bytes**: Capture `len(prompt.encode("utf-8"))` before any instruction injection. Store as local variable `original_prompt_bytes`.

**Logging call placement**: After the existing response dict is built and before the return statement, build and log the entry. This ensures `session_id` and `token_usage` are already parsed.

## Complexity
Medium
