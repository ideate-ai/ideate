# Architecture — Session Spawner Observability & Execution Control (2026-03-09)

## Scope

Enhancements to `mcp/session-spawner/server.py` and its tests. No other files are modified.

## New Capabilities

### 1. JSONL Logging + Session Registry

A module-level list `_session_registry: list[dict]` accumulates an entry for every completed `spawn_session` call during the server process lifetime.

After each call (success, failure, or timeout), `_log_entry(entry)` appends the entry as a JSON line to `IDEATE_LOG_FILE` (if configured). If the env var is unset, logging is a no-op.

Entry schema:
```json
{
  "timestamp": "2026-03-09T14:23:01.123Z",
  "session_id": "sess-abc123",
  "depth": 1,
  "working_dir": "/path/to/project",
  "prompt_bytes": 4096,
  "team_name": "workers",
  "used_team": true,
  "duration_ms": 12500,
  "exit_code": 0,
  "success": true,
  "timed_out": false,
  "token_usage": {"input_tokens": 1500, "output_tokens": 800}
}
```

- `depth` = value of `IDEATE_SPAWN_DEPTH` at time of call (the child's depth, i.e., current_depth + 1)
- `used_team` = true if `team_name` argument was provided and non-empty
- `token_usage` = dict from JSON output, or null
- Log file is opened in append mode per entry (no file handle kept open)

### 2. team_name Parameter

New optional parameter added to the `spawn_session` tool schema:
- `team_name` (string, optional): Advisory team name for the spawned session
- Logged in the JSONL entry and session registry
- Propagated to child subprocess via `IDEATE_TEAM_NAME` env var

The parameter does not directly configure the subprocess beyond env var propagation. It signals the intended team to the spawned session so it can configure its own agent calls accordingly.

### 3. Status Table

After each spawn call completes, `_print_status_table()` prints a formatted ASCII table to stderr showing all entries in `_session_registry`.

Columns: `#`, `Session ID` (12-char truncated), `Depth`, `Status`, `Duration`, `Team`

Status values:
- `completed` — exit_code == 0
- `failed` — exit_code != 0 and not timed out
- `timed_out` — subprocess.TimeoutExpired was raised

Team column shows `—` if team_name is null/empty.

Printed to stderr (not stdout) because the MCP server's stdio transport uses stdout for the protocol.

### 4. Execution Instructions Injection

New optional parameter: `exec_instructions` (string, optional)

Source priority:
1. `exec_instructions` parameter (per-call override)
2. `IDEATE_EXEC_INSTRUCTIONS` environment variable (process-wide default)

When instructions are available, the prompt is augmented:
```
[EXECUTION INSTRUCTIONS]
{instructions}
[END EXECUTION INSTRUCTIONS]

{original_prompt}
```

Propagation: `IDEATE_EXEC_INSTRUCTIONS` is set in the child subprocess environment so the same instructions cascade to grandchild sessions. The per-call `exec_instructions` parameter overrides the env var for that call and is also what gets propagated to children.

`prompt_bytes` in the log entry captures the original prompt size before injection.

## Configuration Reference (new additions)

| Env Var | Default | Description |
|---------|---------|-------------|
| `IDEATE_LOG_FILE` | (none) | Path to JSONL log file. Logging disabled if unset. |
| `IDEATE_EXEC_INSTRUCTIONS` | (none) | Default execution instructions prepended to every spawned session's prompt. |
| `IDEATE_TEAM_NAME` | (none) | Propagated team name. Set by parent spawner for child session awareness. |

## Data Flow (updated)

```
call_tool("spawn_session", args)
    │
    ├─ [existing] Validate prompt size, working_dir, depth, safe_root
    │
    ├─ [new] Resolve exec_instructions (param > env var > None)
    ├─ [new] Augment prompt with instruction block if instructions present
    │
    ├─ [existing] Build cmd array
    │
    ├─ [new] Set IDEATE_EXEC_INSTRUCTIONS in child env (propagate instructions)
    ├─ [new] Set IDEATE_TEAM_NAME in child env if team_name provided
    │
    ├─ [existing] Execute subprocess with concurrency semaphore
    │
    ├─ [existing] Parse session_id, token_usage from output
    │
    ├─ [new] Build registry entry dict
    ├─ [new] Append to _session_registry
    ├─ [new] Write JSONL via _log_entry()
    ├─ [new] Print status table via _print_status_table() to stderr
    │
    └─ [existing] Return TextContent with result JSON
```

## Work Item Grouping

- **022** and **024** are independent (no shared file sections at risk of conflict)
- **023** depends on **022** (needs `_session_registry`)
- **025** depends on **022**, **023**, **024** (tests all new features)

Execution order: [022, 024] → [023] → [025]
