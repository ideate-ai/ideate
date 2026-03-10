"""
ideate-session-spawner: MCP server that enables recursive Claude Code session invocation.

Exposes a `spawn_session` tool that runs `claude --print` as a subprocess,
allowing Claude to invoke new Claude Code sessions for recursive decomposition
and execution of large projects.

Safety mechanisms:
- Depth tracking via IDEATE_SPAWN_DEPTH environment variable
- Server-side max_depth enforcement via IDEATE_MAX_DEPTH environment variable
- Concurrency limiting via asyncio semaphore
- Per-session timeout enforcement
- Output truncation for large responses
- Prompt length validation (100KB limit)
- Optional safe root directory enforcement via IDEATE_SAFE_ROOT
"""

import asyncio
import datetime
import json
import logging
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from mcp.server import Server
from mcp.shared.exceptions import McpError
from mcp.types import ErrorData, TextContent, Tool

logger = logging.getLogger(__name__)

# Configuration defaults
DEFAULT_MAX_DEPTH = 3
DEFAULT_CONCURRENCY = 5
DEFAULT_TIMEOUT = 600
DEFAULT_MAX_OUTPUT_BYTES = 50_000
DEFAULT_PERMISSION_MODE = "acceptEdits"
DEFAULT_MAX_TURNS = 30
DEFAULT_OUTPUT_FORMAT = "json"
MAX_PROMPT_BYTES = 100_000

server = Server("ideate-session-spawner", version="0.3.0")


@server.list_tools()
async def list_tools() -> list[Tool]:
    return [
        Tool(
            name="spawn_session",
            description=(
                "Spawn a new Claude Code session as a subprocess. "
                "Enables recursive self-invocation for decomposition and execution of large projects. "
                "The spawned session runs `claude --print` with the provided prompt and returns its output."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The prompt for the spawned Claude Code session.",
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Working directory for the spawned session.",
                    },
                    "max_turns": {
                        "type": "integer",
                        "description": f"Maximum agentic turns before the session terminates. Default: {DEFAULT_MAX_TURNS}.",
                        "default": DEFAULT_MAX_TURNS,
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": f"Maximum recursive spawn depth. Prevents fork bombs. Default: {DEFAULT_MAX_DEPTH}.",
                        "default": DEFAULT_MAX_DEPTH,
                    },
                    "timeout": {
                        "type": "integer",
                        "description": f"Per-session timeout in seconds. Default: {DEFAULT_TIMEOUT}.",
                        "default": DEFAULT_TIMEOUT,
                    },
                    "permission_mode": {
                        "type": "string",
                        "description": f"Permission mode for the spawned session. Default: '{DEFAULT_PERMISSION_MODE}'.",
                        "enum": ["acceptEdits", "dontAsk"],
                        "default": DEFAULT_PERMISSION_MODE,
                    },
                    "allowed_tools": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional tool allowlist for the spawned session.",
                    },
                    "output_format": {
                        "type": "string",
                        "description": f"Output format for the spawned session. Default: '{DEFAULT_OUTPUT_FORMAT}'.",
                        "enum": ["json", "text", "stream-json"],
                        "default": DEFAULT_OUTPUT_FORMAT,
                    },
                    "team_name": {
                        "type": "string",
                        "description": "Advisory team name for the spawned session. Logged and propagated via IDEATE_TEAM_NAME env var.",
                    },
                    "exec_instructions": {
                        "type": "string",
                        "description": (
                            "Execution instructions prepended to the spawned session's prompt. "
                            "Overrides IDEATE_EXEC_INSTRUCTIONS env var for this call and its children."
                        ),
                    },
                },
                "required": ["prompt", "working_dir"],
            },
        )
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    # Fix 6: Unknown tool error — raise MCP protocol error instead of returning TextContent
    if name != "spawn_session":
        raise McpError(ErrorData(code=-32601, message=f"Unknown tool: {name}"))

    prompt = arguments["prompt"]
    working_dir = arguments["working_dir"]
    max_turns = arguments.get("max_turns", DEFAULT_MAX_TURNS)
    caller_max_depth = arguments.get("max_depth", DEFAULT_MAX_DEPTH)
    timeout = arguments.get("timeout", DEFAULT_TIMEOUT)
    permission_mode = arguments.get("permission_mode", DEFAULT_PERMISSION_MODE)
    allowed_tools = arguments.get("allowed_tools")
    output_format = arguments.get("output_format", DEFAULT_OUTPUT_FORMAT)
    team_name = arguments.get("team_name")
    exec_instructions = arguments.get("exec_instructions") or os.environ.get("IDEATE_EXEC_INSTRUCTIONS", "")

    # Capture original prompt byte length before any injection
    original_prompt_bytes = len(prompt.encode("utf-8"))

    # Fix 4: Prompt length validation — reject prompts exceeding 100KB
    # Validation applies to original prompt only; injected instructions do not count toward limit.
    if original_prompt_bytes > MAX_PROMPT_BYTES:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "output": "",
                        "exit_code": 1,
                        "session_id": "",
                        "duration_ms": 0,
                        "error": (
                            f"Prompt too large: {original_prompt_bytes} bytes exceeds "
                            f"the {MAX_PROMPT_BYTES} byte limit. "
                            "Reduce the prompt size before retrying."
                        ),
                    }
                ),
            )
        ]

    # Validate working directory exists
    resolved_working_dir = Path(working_dir).resolve()
    if not resolved_working_dir.is_dir():
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "output": "",
                        "exit_code": 1,
                        "session_id": "",
                        "duration_ms": 0,
                        "error": f"Working directory does not exist: {working_dir}",
                    }
                ),
            )
        ]

    # Fix 5: working_dir safe root — validate against IDEATE_SAFE_ROOT if set
    safe_root = os.environ.get("IDEATE_SAFE_ROOT")
    if safe_root:
        safe_root_resolved = Path(safe_root).resolve()
        if not resolved_working_dir.is_relative_to(safe_root_resolved):
            return [
                TextContent(
                    type="text",
                    text=json.dumps(
                        {
                            "output": "",
                            "exit_code": 1,
                            "session_id": "",
                            "duration_ms": 0,
                            "error": (
                                f"Working directory {working_dir} is outside the safe root "
                                f"{safe_root}. Set IDEATE_SAFE_ROOT to allow this directory, "
                                "or use a directory within the safe root."
                            ),
                        }
                    ),
                )
            ]

    # Fix 1: max_depth server-side enforcement — callers can lower but not raise the limit
    max_depth = min(caller_max_depth, _server_max_depth)

    # Check recursive depth
    current_depth = int(os.environ.get("IDEATE_SPAWN_DEPTH", "0"))
    if current_depth >= max_depth:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "output": "",
                        "exit_code": 1,
                        "session_id": "",
                        "duration_ms": 0,
                        "error": (
                            f"Maximum recursive depth reached: current={current_depth}, "
                            f"max={max_depth}. Refusing to spawn to prevent fork bomb."
                        ),
                    }
                ),
            )
        ]

    # Build effective prompt — prepend execution instructions if present
    effective_prompt = prompt
    if exec_instructions:
        effective_prompt = (
            f"[EXECUTION INSTRUCTIONS]\n{exec_instructions}\n[END EXECUTION INSTRUCTIONS]\n\n{prompt}"
        )

    # Build the command
    cmd = [
        "claude",
        "--print",
        "--output-format",
        output_format,
        "--permission-mode",
        permission_mode,
        "--max-turns",
        str(max_turns),
        "--cwd",
        working_dir,
        effective_prompt,
    ]

    if allowed_tools:
        cmd.extend(["--allowedTools", ",".join(allowed_tools)])

    # Build environment with incremented depth.
    # IDEATE_TEAM_NAME is explicitly removed then conditionally re-set so it does not
    # leak from grandparent sessions when the direct caller omits team_name.
    env = {**os.environ, "IDEATE_SPAWN_DEPTH": str(current_depth + 1)}
    env.pop("IDEATE_TEAM_NAME", None)
    if team_name:
        env["IDEATE_TEAM_NAME"] = team_name
    if exec_instructions:
        env["IDEATE_EXEC_INSTRUCTIONS"] = exec_instructions

    # Execute with concurrency limiting
    start_time = time.monotonic()
    timed_out = False
    result = None
    partial_stdout = ""
    partial_stderr = ""
    try:
        async with _semaphore:
            result = await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=env,
                cwd=working_dir,
            )
    except subprocess.TimeoutExpired as e:
        # Fix 2: TimeoutExpired "None" fix — e.stdout/e.stderr may be None or bytes
        # With text=True, they could be str or None. With capture_output, they are
        # typically None on TimeoutExpired. Handle both bytes and str cases safely.
        timed_out = True
        if isinstance(e.stdout, bytes):
            partial_stdout = e.stdout.decode("utf-8", errors="ignore")
        else:
            partial_stdout = e.stdout or ""
        if isinstance(e.stderr, bytes):
            partial_stderr = e.stderr.decode("utf-8", errors="ignore")
        else:
            partial_stderr = e.stderr or ""

    duration_ms = int((time.monotonic() - start_time) * 1000)

    # Determine outcome fields shared by both paths
    if timed_out:
        outcome_session_id = ""
        outcome_exit_code = -1
        outcome_success = False
        outcome_token_usage = None
    else:
        # Handle output truncation (truncate by bytes, not characters)
        stdout = result.stdout
        output_truncated = False
        overflow_path = None

        stdout_bytes = stdout.encode("utf-8")
        if len(stdout_bytes) > DEFAULT_MAX_OUTPUT_BYTES:
            output_truncated = True
            with tempfile.NamedTemporaryFile(
                mode="w",
                prefix="ideate-session-",
                suffix=".txt",
                dir=working_dir,
                delete=False,
            ) as f:
                f.write(stdout)
                overflow_path = f.name
            stdout = stdout_bytes[:DEFAULT_MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore")

        # Parse session ID and token usage from JSON output if available
        outcome_session_id = ""
        outcome_token_usage = None
        if output_format == "json":
            try:
                parsed = json.loads(result.stdout)
                if isinstance(parsed, dict):
                    outcome_session_id = parsed.get("session_id", "")
                    usage = parsed.get("usage") or parsed.get("token_usage")
                    if isinstance(usage, dict):
                        outcome_token_usage = usage
                    elif any(
                        k in parsed
                        for k in ("input_tokens", "output_tokens", "total_tokens")
                    ):
                        outcome_token_usage = {
                            k: parsed[k]
                            for k in ("input_tokens", "output_tokens", "total_tokens")
                            if k in parsed
                        }
            except (json.JSONDecodeError, TypeError):
                pass

        outcome_exit_code = result.returncode
        outcome_success = result.returncode == 0

    # Shared post-processing: registry, logging, status table
    entry = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "session_id": outcome_session_id,
        "depth": current_depth + 1,
        "working_dir": str(resolved_working_dir),
        "prompt_bytes": original_prompt_bytes,
        "team_name": team_name or None,
        "used_team": bool(team_name),
        "duration_ms": duration_ms,
        "exit_code": outcome_exit_code,
        "success": outcome_success,
        "timed_out": timed_out,
        "token_usage": outcome_token_usage,
    }
    _session_registry.append(entry)
    _log_entry(entry)
    _print_status_table()

    if timed_out:
        return [
            TextContent(
                type="text",
                text=json.dumps(
                    {
                        "output": partial_stdout[:DEFAULT_MAX_OUTPUT_BYTES],
                        "exit_code": -1,
                        "session_id": "",
                        "duration_ms": duration_ms,
                        "error": (
                            f"Session timed out after {timeout}s. "
                            f"Partial stderr: {partial_stderr[:1000]}"
                        ),
                        "timed_out": True,
                    }
                ),
            )
        ]

    response = {
        "output": stdout,
        "exit_code": result.returncode,
        "session_id": outcome_session_id,
        "duration_ms": duration_ms,
        "error": result.stderr if result.returncode != 0 else None,
    }

    if outcome_token_usage is not None:
        response["token_usage"] = outcome_token_usage

    if output_truncated:
        response["output_truncated"] = True
        response["full_output_path"] = overflow_path
        response["output"] = (
            f"[Output truncated to {DEFAULT_MAX_OUTPUT_BYTES} bytes. "
            f"Full output saved to: {overflow_path}]\n\n" + stdout
        )

    return [TextContent(type="text", text=json.dumps(response))]


async def main():
    # Fix 3: Semaphore creation moved into main() to ensure it runs within
    # an active event loop, avoiding Python <3.10 compatibility issues.
    global _semaphore, _server_max_depth

    try:
        concurrency_limit = int(
            os.environ.get("IDEATE_MAX_CONCURRENCY", str(DEFAULT_CONCURRENCY))
        )
    except ValueError:
        concurrency_limit = DEFAULT_CONCURRENCY
    _semaphore = asyncio.Semaphore(concurrency_limit)

    # Fix 1: Read server-side max_depth from environment at startup
    try:
        _server_max_depth = int(
            os.environ.get("IDEATE_MAX_DEPTH", str(DEFAULT_MAX_DEPTH))
        )
    except ValueError:
        _server_max_depth = DEFAULT_MAX_DEPTH

    logger.info(
        "Starting ideate-session-spawner: max_depth=%d, concurrency=%d",
        _server_max_depth,
        concurrency_limit,
    )

    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


# Module-level defaults for globals set in main() — ensures the names exist
# even if someone imports the module without running main().
_semaphore: asyncio.Semaphore = asyncio.Semaphore(DEFAULT_CONCURRENCY)
_server_max_depth: int = DEFAULT_MAX_DEPTH
_session_registry: list[dict] = []


def _log_entry(entry: dict) -> None:
    log_file = os.environ.get("IDEATE_LOG_FILE", "")
    if not log_file:
        return
    try:
        with open(log_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception as exc:
        logger.warning("Failed to write JSONL log entry to %s: %s", log_file, exc)


def _print_status_table() -> None:
    try:
        if not _session_registry:
            return

        # Determine status string for each entry
        def _status(entry: dict) -> str:
            if entry.get("success"):
                return "completed"
            if entry.get("timed_out"):
                return "timed_out"
            return "failed"

        # Determine team string for each entry
        def _team(entry: dict) -> str:
            t = entry.get("team_name")
            if not t:
                return "-"
            return t

        # Determine session_id display (truncate to 12 chars)
        def _session_id(entry: dict) -> str:
            sid = entry.get("session_id") or ""
            return sid[:12]

        # Determine duration string
        def _duration(entry: dict) -> str:
            ms = entry.get("duration_ms", 0)
            return f"{ms / 1000:.1f}s"

        # Minimum column widths
        col_widths = {
            "#": 4,
            "Session ID": 12,
            "Depth": 5,
            "Status": 9,
            "Duration": 8,
            "Team": 15,
        }

        # Expand widths based on actual content
        rows = []
        for i, entry in enumerate(_session_registry, start=1):
            row = {
                "#": str(i),
                "Session ID": _session_id(entry),
                "Depth": str(entry.get("depth", "")),
                "Status": _status(entry),
                "Duration": _duration(entry),
                "Team": _team(entry),
            }
            rows.append(row)
            for col in col_widths:
                col_widths[col] = max(col_widths[col], len(row[col]))

        # Also ensure header fits
        for col in col_widths:
            col_widths[col] = max(col_widths[col], len(col))

        columns = ["#", "Session ID", "Depth", "Status", "Duration", "Team"]

        def _separator() -> str:
            parts = ["-" * (col_widths[col] + 2) for col in columns]
            return "+" + "+".join(parts) + "+"

        def _row_line(values: dict) -> str:
            cells = []
            for col in columns:
                val = values[col]
                w = col_widths[col]
                # Right-align numeric columns, left-align others
                if col in ("#", "Depth"):
                    cells.append(f" {val:>{w}} ")
                elif col == "Duration":
                    cells.append(f" {val:>{w}} ")
                else:
                    cells.append(f" {val:<{w}} ")
            return "|" + "|".join(cells) + "|"

        sep = _separator()
        header_values = {col: col for col in columns}

        print(sep, file=sys.stderr)
        print(_row_line(header_values), file=sys.stderr)
        print(sep, file=sys.stderr)
        for row in rows:
            print(_row_line(row), file=sys.stderr)
        print(sep, file=sys.stderr)
    except Exception:
        pass


if __name__ == "__main__":
    asyncio.run(main())
