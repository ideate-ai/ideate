"""
Tests for the ideate-session-spawner MCP server.

Uses pytest with unittest.mock to verify safety-critical behaviors
without spawning actual claude processes.
"""

import asyncio
import json
import os
import subprocess
from unittest.mock import MagicMock, patch

import pytest

# Import the module under test
import server as spawner


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_response(result: list) -> dict:
    """Extract the JSON payload from a call_tool response."""
    assert len(result) == 1
    assert result[0].type == "text"
    return json.loads(result[0].text)


def _make_completed_process(
    stdout: str = "",
    stderr: str = "",
    returncode: int = 0,
) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=["claude"], returncode=returncode, stdout=stdout, stderr=stderr
    )


@pytest.fixture(autouse=True)
def _reset_globals():
    """Reset module-level globals before each test."""
    spawner._semaphore = asyncio.Semaphore(spawner.DEFAULT_CONCURRENCY)
    spawner._server_max_depth = spawner.DEFAULT_MAX_DEPTH
    yield


@pytest.fixture
def tmp_working_dir(tmp_path):
    """Provide a real temporary directory to use as working_dir."""
    return str(tmp_path)


# ---------------------------------------------------------------------------
# 1. Depth exceeded
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_depth_exceeded(tmp_working_dir):
    """When current depth equals max_depth, the request is rejected."""
    with patch.dict(os.environ, {"IDEATE_SPAWN_DEPTH": "3"}):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir, "max_depth": 3},
        )
    data = _parse_response(result)
    assert data["exit_code"] == 1
    assert "Maximum recursive depth reached" in data["error"]
    assert data["output"] == ""


# ---------------------------------------------------------------------------
# 2. Depth incremented in child env
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_depth_incremented(tmp_working_dir):
    """The child subprocess must receive IDEATE_SPAWN_DEPTH incremented by 1."""
    captured_env = {}

    def fake_run(*args, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return _make_completed_process(stdout='{"result": "ok"}')

    with patch.dict(os.environ, {"IDEATE_SPAWN_DEPTH": "1"}):
        with patch("subprocess.run", side_effect=fake_run):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "hello", "working_dir": tmp_working_dir, "max_depth": 5},
            )

    assert captured_env["IDEATE_SPAWN_DEPTH"] == "2"


# ---------------------------------------------------------------------------
# 3. Server-side max_depth enforcement
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_server_side_max_depth(tmp_working_dir):
    """IDEATE_MAX_DEPTH caps the effective max_depth even if caller requests higher."""
    spawner._server_max_depth = 2

    with patch.dict(os.environ, {"IDEATE_SPAWN_DEPTH": "2"}):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir, "max_depth": 10},
        )
    data = _parse_response(result)
    assert data["exit_code"] == 1
    assert "Maximum recursive depth reached" in data["error"]
    # The effective max should be 2 (server limit), not 10 (caller request)
    assert "max=2" in data["error"]


# ---------------------------------------------------------------------------
# 4. Timeout handling
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_timeout_handling(tmp_working_dir):
    """TimeoutExpired produces a structured error with timed_out=true and no 'None' string."""
    exc = subprocess.TimeoutExpired(cmd=["claude"], timeout=10)
    exc.stdout = None
    exc.stderr = None

    with patch("subprocess.run", side_effect=exc):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir, "timeout": 10},
        )

    data = _parse_response(result)
    assert data["timed_out"] is True
    assert data["exit_code"] == -1
    assert "None" not in data["output"]
    assert "None" not in data.get("error", "")


# ---------------------------------------------------------------------------
# 5. Output truncation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_output_truncation(tmp_working_dir):
    """Output exceeding 50KB is truncated; overflow file is created."""
    big_output = "x" * 60_000  # >50KB

    with patch(
        "subprocess.run",
        return_value=_make_completed_process(stdout=big_output),
    ):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir},
        )

    data = _parse_response(result)
    assert data["output_truncated"] is True
    assert "full_output_path" in data
    # The overflow file should exist and contain the full output
    overflow_path = data["full_output_path"]
    with open(overflow_path) as f:
        assert len(f.read()) == 60_000
    # Clean up overflow file
    os.unlink(overflow_path)


# ---------------------------------------------------------------------------
# 6. Prompt length validation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_prompt_length_validation(tmp_working_dir):
    """Prompts exceeding 100KB are rejected before any subprocess is launched."""
    huge_prompt = "a" * 200_000  # 200KB

    with patch("subprocess.run") as mock_run:
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": huge_prompt, "working_dir": tmp_working_dir},
        )
        # subprocess.run must NOT have been called
        mock_run.assert_not_called()

    data = _parse_response(result)
    assert data["exit_code"] == 1
    assert "Prompt too large" in data["error"]
    assert "200000" in data["error"]


# ---------------------------------------------------------------------------
# 7. Working directory validation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_working_dir_validation():
    """A non-existent working directory is rejected."""
    result = await spawner.call_tool(
        "spawn_session",
        {"prompt": "hello", "working_dir": "/nonexistent/path/that/does/not/exist"},
    )
    data = _parse_response(result)
    assert data["exit_code"] == 1
    assert "does not exist" in data["error"]


# ---------------------------------------------------------------------------
# 8. Safe root validation
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_safe_root_validation(tmp_working_dir, tmp_path):
    """When IDEATE_SAFE_ROOT is set, directories outside it are rejected."""
    # Create a separate directory that is outside the safe root
    safe_root = str(tmp_path / "safe")
    os.makedirs(safe_root)
    outside_dir = str(tmp_path / "outside")
    os.makedirs(outside_dir)

    with patch.dict(os.environ, {"IDEATE_SAFE_ROOT": safe_root}):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": outside_dir},
        )

    data = _parse_response(result)
    assert data["exit_code"] == 1
    assert "outside the safe root" in data["error"]


# ---------------------------------------------------------------------------
# 9. Concurrency limiting
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_concurrency():
    """The semaphore limits simultaneous executions."""
    spawner._semaphore = asyncio.Semaphore(2)

    max_concurrent = 0
    current_concurrent = 0
    lock = asyncio.Lock()

    original_to_thread = asyncio.to_thread

    async def slow_to_thread(fn, *args, **kwargs):
        nonlocal max_concurrent, current_concurrent
        async with lock:
            current_concurrent += 1
            if current_concurrent > max_concurrent:
                max_concurrent = current_concurrent
        # Simulate work
        await asyncio.sleep(0.05)
        async with lock:
            current_concurrent -= 1
        return _make_completed_process(stdout='{"result": "ok"}')

    tmp_dir = os.path.realpath(os.path.dirname(__file__) or ".")

    with patch("asyncio.to_thread", side_effect=slow_to_thread):
        tasks = [
            spawner.call_tool(
                "spawn_session",
                {"prompt": f"task {i}", "working_dir": tmp_dir},
            )
            for i in range(5)
        ]
        await asyncio.gather(*tasks)

    # The semaphore is set to 2, so at most 2 should run concurrently
    assert max_concurrent <= 2


# ---------------------------------------------------------------------------
# 10. Token budget field
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_token_budget_field(tmp_working_dir):
    """Token usage data from claude JSON output appears in the response."""
    claude_output = json.dumps(
        {
            "result": "done",
            "session_id": "sess-abc123",
            "usage": {
                "input_tokens": 1500,
                "output_tokens": 800,
            },
        }
    )

    with patch(
        "subprocess.run",
        return_value=_make_completed_process(stdout=claude_output),
    ):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir},
        )

    data = _parse_response(result)
    assert "token_usage" in data
    assert data["token_usage"]["input_tokens"] == 1500
    assert data["token_usage"]["output_tokens"] == 800
    assert data["session_id"] == "sess-abc123"


@pytest.mark.asyncio
async def test_token_budget_top_level_fields(tmp_working_dir):
    """Token fields at the top level of JSON output are also captured."""
    claude_output = json.dumps(
        {
            "result": "done",
            "input_tokens": 500,
            "output_tokens": 200,
            "total_tokens": 700,
        }
    )

    with patch(
        "subprocess.run",
        return_value=_make_completed_process(stdout=claude_output),
    ):
        result = await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir},
        )

    data = _parse_response(result)
    assert "token_usage" in data
    assert data["token_usage"]["total_tokens"] == 700
