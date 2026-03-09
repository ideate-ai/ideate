# 010: Session Spawner MCP Server

## Objective
Build an MCP server that exposes a `spawn_session` tool, enabling Claude to recursively invoke new Claude Code sessions. This breaks the single-session limitation and enables recursive decomposition and execution for large projects.

## Acceptance Criteria
- [ ] `mcp/session-spawner/server.py` exists and implements a valid MCP server
- [ ] Server exposes a `spawn_session` tool with parameters:
  - `prompt` (string, required): The prompt for the spawned session
  - `working_dir` (string, required): Working directory for the session
  - `max_turns` (integer, default 30): Maximum agentic turns
  - `max_depth` (integer, default 3): Maximum recursive depth (prevents fork bombs)
  - `timeout` (integer, default 600): Timeout in seconds
  - `permission_mode` (string, default "acceptEdits"): Permission mode for the session
  - `allowed_tools` (string[], optional): Tool allowlist
  - `output_format` (string, default "json"): Output format
- [ ] Tool returns structured result: `{output: string, exit_code: number, session_id: string, duration_ms: number}`
- [ ] Safety mechanisms enforced:
  - Hard max_depth limit (configurable, default 3) — tracks depth via environment variable
  - Concurrency limiter (configurable, default 5 simultaneous sessions)
  - Per-session timeout (configurable, default 600s)
  - Total token budget tracking (logged, not enforced — for user awareness)
- [ ] Depth tracking: spawned session receives `IDEATE_SPAWN_DEPTH=N+1` in environment, server refuses requests where depth >= max_depth
- [ ] Error handling: subprocess failures return structured error with stderr, exit code, and partial output
- [ ] Server can be configured via `claude mcp add` or `.mcp.json`
- [ ] `mcp/session-spawner/README.md` documents setup, configuration, and safety mechanisms

## File Scope
- `mcp/session-spawner/server.py` (create)
- `mcp/session-spawner/requirements.txt` (create)
- `mcp/session-spawner/README.md` (create)

## Dependencies
- Depends on: 001
- Blocks: none (optional enhancement — core workflow works without it)

## Implementation Notes
This is the most novel component of ideate v2. It enables a capability that doesn't exist natively in Claude Code: recursive self-invocation.

**Implementation approach**: Use the `mcp` Python package to create a stdio MCP server. The `spawn_session` tool runs `claude --print` as a subprocess with the specified parameters.

**Depth tracking**: The server sets `IDEATE_SPAWN_DEPTH` in the environment of each spawned process. The server reads this variable from its own environment to know the current depth. If `IDEATE_SPAWN_DEPTH >= max_depth`, the tool returns an error rather than spawning.

**Concurrency control**: Use an asyncio semaphore to limit concurrent spawned sessions. Excess requests queue rather than fail.

**Output handling**: The spawned session's stdout (with `--output-format json`) is parsed and returned as the tool result. If the output is too large for the parent's context window, it should be truncated with a note. Consider writing full output to a file and returning a summary + file path.

**Security considerations**:
- The MCP server inherits the host's filesystem permissions
- Spawned sessions run with `--permission-mode acceptEdits` by default (no human confirmation in subprocess)
- The user must explicitly configure this MCP server — it is not auto-enabled
- Fork bomb prevention is critical: the depth limit and concurrency limit are hard safety mechanisms

**Testing**: The server should be testable standalone via `python -m mcp.server.test` or similar MCP testing patterns.

## Complexity
High
