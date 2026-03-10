# ideate-session-spawner

MCP server that enables recursive Claude Code session invocation. Exposes a `spawn_session` tool that runs `claude --print` as a subprocess, allowing Claude to spawn new sessions for recursive decomposition and execution.

## Setup

### Prerequisites

- Python 3.10+
- `claude` CLI installed and available on PATH
- `mcp` Python package

### Install

```bash
cd mcp/session-spawner
pip install -r requirements.txt
```

### Configure in Claude Code

Add the MCP server to your project or user configuration:

```bash
claude mcp add ideate-session-spawner -- python /path/to/mcp/session-spawner/server.py
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "ideate-session-spawner": {
      "command": "python",
      "args": ["/path/to/mcp/session-spawner/server.py"]
    }
  }
}
```

## Tool: `spawn_session`

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | yes | — | The prompt for the spawned Claude Code session |
| `working_dir` | string | yes | — | Working directory for the spawned session |
| `max_turns` | integer | no | 30 | Maximum agentic turns before termination |
| `max_depth` | integer | no | 3 | Maximum recursive spawn depth |
| `timeout` | integer | no | 600 | Per-session timeout in seconds |
| `permission_mode` | string | no | "acceptEdits" | Permission mode: `acceptEdits` or `dontAsk` |
| `allowed_tools` | string[] | no | — | Tool allowlist for the spawned session |
| `output_format` | string | no | "json" | Output format: `json`, `text`, or `stream-json` |
| `team_name` | string | no | — | Advisory team name for observability. Logged in JSONL entries and propagated to child sessions via `IDEATE_TEAM_NAME`. Does not configure the subprocess directly — no CLI mechanism exists to pass team identity to `claude --print`. Use `exec_instructions` to instruct spawned sessions to use agent teams. |
| `exec_instructions` | string | no | — | Execution instructions prepended to the spawned session's prompt. Overrides `IDEATE_EXEC_INSTRUCTIONS` env var for this call and all its descendants. Instructions are wrapped in a `[EXECUTION INSTRUCTIONS]...[END EXECUTION INSTRUCTIONS]` block. |

### Returns

```json
{
  "output": "string — session stdout (truncated if exceeds 50KB)",
  "exit_code": 0,
  "session_id": "string — parsed from JSON output if available",
  "duration_ms": 1234,
  "error": "string or null",
  "token_usage": {"input_tokens": 1500, "output_tokens": 800}
}
```

`token_usage` is included when the spawned session returns JSON output containing token information. Omitted otherwise.

If output exceeds 50KB, full output is saved to a temporary file and the response includes:

```json
{
  "output_truncated": true,
  "full_output_path": "/path/to/temp/file.txt"
}
```

## Safety Mechanisms

### Depth Tracking

Each spawned session receives `IDEATE_SPAWN_DEPTH=N+1` in its environment. The server reads this variable from its own environment to know the current depth. If depth >= `max_depth`, the tool returns an error without spawning a subprocess.

The effective `max_depth` is the minimum of the caller-supplied `max_depth` parameter and the server-side `IDEATE_MAX_DEPTH` environment variable. This means callers can lower the depth limit but never raise it above the server-configured ceiling. Set `IDEATE_MAX_DEPTH` at server startup to enforce an organization-wide limit.

### Prompt Length Validation

Prompts are limited to 100KB (100,000 bytes UTF-8). If a prompt exceeds this limit, the tool returns an error immediately without spawning a subprocess. This prevents accidental resource exhaustion from oversized prompts.

### Safe Root Directory

When `IDEATE_SAFE_ROOT` is set, the server validates that every `working_dir` resolves to a path within (or equal to) the safe root. Requests targeting directories outside the safe root are rejected with an error. Symlinks are resolved before comparison, so they cannot be used to escape the boundary.

### Concurrency Limiting

An asyncio semaphore limits simultaneous spawned sessions. Default: 5. Excess requests queue (they do not fail). Configure via `IDEATE_MAX_CONCURRENCY` environment variable.

### Timeout Enforcement

Each subprocess has a hard timeout. If exceeded, the process is killed and the tool returns a structured error with any partial output and a `timed_out: true` flag.

### Output Truncation

If stdout exceeds the size threshold (default 50KB), the full output is written to a temporary file in the working directory. The tool response contains a truncated version plus the path to the full output file.

Overflow files are not automatically deleted. They accumulate in the `working_dir` of the call that produced them. Clean them up manually when no longer needed, or implement periodic cleanup in your workflow (e.g., `find . -name 'ideate-session-*.txt' -delete`).

### No Auto-Enable

This MCP server is not bundled as auto-start. The user must explicitly configure it via `claude mcp add` or `.mcp.json`. This is intentional — spawning subprocesses that run Claude Code sessions should be an opt-in capability.

### Token Budget Logging

When the spawned session returns JSON output containing token usage information, the server extracts it and includes a `token_usage` field in the response. The server looks for a `usage` or `token_usage` object in the parsed JSON, as well as top-level `input_tokens`, `output_tokens`, and `total_tokens` fields. If no token information is present, the field is omitted from the response.

## Observability

### JSONL Logging

When `IDEATE_LOG_FILE` is set, the server appends one JSON entry per spawn call:

```json
{
  "timestamp": "2026-03-09T14:23:01.123Z",
  "session_id": "string or null",
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

`token_usage` is `null` when the session does not return token information. When `team_name` is not provided, it is `null` and `used_team` is `false`.

Peak concurrency is not recorded directly. To approximate it, compare `timestamp` and `duration_ms` values across entries: sessions whose time windows overlap were executing in parallel.

### Status Table

After each spawn call, a summary table is printed to stderr:

```
+------+--------------+-------+-----------+----------+-----------------+
| #    | Session ID   | Depth | Status    | Duration | Team            |
+------+--------------+-------+-----------+----------+-----------------+
|    1 | sess-abc123  |     1 | completed |   12.5s  | workers         |
|    2 |              |     2 | failed    |    3.1s  | -               |
+------+--------------+-------+-----------+----------+-----------------+
```

Columns: `#` (1-indexed), `Session ID` (truncated to 12 chars), `Depth`, `Status` (`completed`/`failed`/`timed_out`), `Duration` (seconds, one decimal), `Team` (`-` when not provided). Column widths expand to fit content.

When multiple sessions execute concurrently, rows appear in completion order, not start order. The table is reprinted after each session completes, so earlier rows may shift position between prints.

The table is written to stderr because stdio transport uses stdout for the MCP protocol. Table errors are isolated — they cannot affect spawn results.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IDEATE_SPAWN_DEPTH` | 0 | Current recursive depth (set automatically by the server) |
| `IDEATE_MAX_DEPTH` | 3 | Server-side maximum recursive depth ceiling. Callers can lower but not exceed this value. |
| `IDEATE_MAX_CONCURRENCY` | 5 | Maximum simultaneous spawned sessions |
| `IDEATE_SAFE_ROOT` | *(unset)* | When set, restricts `working_dir` to paths within this directory |
| `IDEATE_LOG_FILE` | *(unset)* | When set, path to a JSONL file where spawn call entries are appended |
| `IDEATE_EXEC_INSTRUCTIONS` | *(unset)* | Default execution instructions prepended to all spawned session prompts. Propagated recursively to all descendant sessions. Overridden per-call by the `exec_instructions` parameter. |
| `IDEATE_TEAM_NAME` | *(unset)* | Advisory team name propagated from parent sessions. Set automatically when `team_name` is provided to `spawn_session`. Used for observability only — does not configure subprocess behavior. |

### Recursive Propagation

`exec_instructions` and `team_name` propagate to all descendant sessions automatically:

- When `exec_instructions` is provided (via parameter or `IDEATE_EXEC_INSTRUCTIONS`), the instructions are prepended to the spawned session's prompt **and** set as `IDEATE_EXEC_INSTRUCTIONS` in the child's environment. This means every session in the spawn tree receives the same instructions without explicit passing at each level.
- When `team_name` is provided, it is set as `IDEATE_TEAM_NAME` in the child's environment. Child sessions that call `spawn_session` will include this value in their log entries, enabling tracing of a spawn tree by team name.

## Testing

Run the test suite with pytest from the repository root:

```bash
pytest mcp/session-spawner/test_server.py
```
