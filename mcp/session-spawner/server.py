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
import json
import logging
import os
import subprocess
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

server = Server("ideate-session-spawner")


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

    # Fix 4: Prompt length validation — reject prompts exceeding 100KB
    prompt_byte_len = len(prompt.encode("utf-8"))
    if prompt_byte_len > MAX_PROMPT_BYTES:
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
                            f"Prompt too large: {prompt_byte_len} bytes exceeds "
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
        prompt,
    ]

    if allowed_tools:
        cmd.extend(["--allowedTools", ",".join(allowed_tools)])

    # Build environment with incremented depth
    env = {**os.environ, "IDEATE_SPAWN_DEPTH": str(current_depth + 1)}

    # Execute with concurrency limiting
    start_time = time.monotonic()
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
        duration_ms = int((time.monotonic() - start_time) * 1000)
        if isinstance(e.stdout, bytes):
            partial_stdout = e.stdout.decode("utf-8", errors="ignore")
        else:
            partial_stdout = e.stdout or ""
        if isinstance(e.stderr, bytes):
            partial_stderr = e.stderr.decode("utf-8", errors="ignore")
        else:
            partial_stderr = e.stderr or ""
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

    duration_ms = int((time.monotonic() - start_time) * 1000)

    # Handle output truncation (truncate by bytes, not characters)
    stdout = result.stdout
    output_truncated = False
    overflow_path = None

    stdout_bytes = stdout.encode("utf-8")
    if len(stdout_bytes) > DEFAULT_MAX_OUTPUT_BYTES:
        output_truncated = True
        # Write full output to a temp file
        with tempfile.NamedTemporaryFile(
            mode="w",
            prefix="ideate-session-",
            suffix=".txt",
            dir=working_dir,
            delete=False,
        ) as f:
            f.write(stdout)
            overflow_path = f.name
        # Truncate by byte boundary, decode safely
        stdout = stdout_bytes[:DEFAULT_MAX_OUTPUT_BYTES].decode("utf-8", errors="ignore")

    # Parse session ID and token usage from JSON output if available
    session_id = ""
    token_usage = None
    if output_format == "json":
        try:
            parsed = json.loads(result.stdout)
            session_id = parsed.get("session_id", "")
            # Fix 7: Token budget logging — extract token usage fields if present
            if isinstance(parsed, dict):
                usage = parsed.get("usage") or parsed.get("token_usage")
                if isinstance(usage, dict):
                    token_usage = usage
                # Also check for top-level token fields
                elif any(
                    k in parsed
                    for k in ("input_tokens", "output_tokens", "total_tokens")
                ):
                    token_usage = {
                        k: parsed[k]
                        for k in ("input_tokens", "output_tokens", "total_tokens")
                        if k in parsed
                    }
        except (json.JSONDecodeError, TypeError):
            pass

    response = {
        "output": stdout,
        "exit_code": result.returncode,
        "session_id": session_id,
        "duration_ms": duration_ms,
        "error": result.stderr if result.returncode != 0 else None,
    }

    # Fix 7: Include token usage in response if available
    if token_usage is not None:
        response["token_usage"] = token_usage

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

if __name__ == "__main__":
    asyncio.run(main())
