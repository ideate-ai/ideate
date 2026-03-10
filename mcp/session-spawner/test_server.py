"""
Tests for the ideate-session-spawner MCP server.

Uses pytest with unittest.mock to verify safety-critical behaviors
without spawning actual claude processes.
"""

import asyncio
import json
import os
import subprocess
import tempfile
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
    """Reset module-level globals before each test.

    All three globals are reset intentionally:
    - _semaphore: tests like test_concurrency replace it with a smaller semaphore;
      subsequent tests must start with the default.
    - _server_max_depth: tests like test_server_side_max_depth set a lower limit;
      subsequent tests must use DEFAULT_MAX_DEPTH.
    - _session_registry: each test starts with an empty registry to avoid
      cross-test contamination in status table and JSONL logging assertions.
    """
    spawner._semaphore = asyncio.Semaphore(spawner.DEFAULT_CONCURRENCY)
    spawner._server_max_depth = spawner.DEFAULT_MAX_DEPTH
    spawner._session_registry = []
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


# ---------------------------------------------------------------------------
# 11. JSONL Logging Tests
# ---------------------------------------------------------------------------

REQUIRED_LOG_FIELDS = {
    "timestamp", "session_id", "depth", "working_dir", "prompt_bytes",
    "team_name", "used_team", "duration_ms", "exit_code", "success",
    "timed_out", "token_usage",
}


@pytest.mark.asyncio
async def test_jsonl_logging_writes_entry(tmp_working_dir):
    """When IDEATE_LOG_FILE is set, a completed spawn writes exactly one valid JSON line."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        log_path = f.name
    try:
        with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
            with patch.dict(os.environ, {"IDEATE_LOG_FILE": log_path}):
                await spawner.call_tool("spawn_session", {"prompt": "hello", "working_dir": tmp_working_dir})

        with open(log_path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert REQUIRED_LOG_FIELDS.issubset(entry.keys())
        assert entry["prompt_bytes"] == len("hello".encode("utf-8"))
    finally:
        os.unlink(log_path)


@pytest.mark.asyncio
async def test_jsonl_logging_disabled_when_unset(tmp_working_dir):
    """When IDEATE_LOG_FILE is not set, no file is created and no exception is raised."""
    env_without_log = {k: v for k, v in os.environ.items() if k != "IDEATE_LOG_FILE"}
    with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
        with patch.dict(os.environ, env_without_log, clear=True):
            # Should not raise
            result = await spawner.call_tool("spawn_session", {"prompt": "hello", "working_dir": tmp_working_dir})
    data = _parse_response(result)
    assert data["exit_code"] == 0


@pytest.mark.asyncio
async def test_jsonl_logging_appends(tmp_working_dir):
    """Two sequential spawn calls result in a file with exactly two JSON lines."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        log_path = f.name
    try:
        with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
            with patch.dict(os.environ, {"IDEATE_LOG_FILE": log_path}):
                await spawner.call_tool("spawn_session", {"prompt": "first", "working_dir": tmp_working_dir})
                await spawner.call_tool("spawn_session", {"prompt": "second", "working_dir": tmp_working_dir})

        with open(log_path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        assert len(lines) == 2
        for line in lines:
            entry = json.loads(line)
            assert REQUIRED_LOG_FIELDS.issubset(entry.keys())
    finally:
        os.unlink(log_path)


@pytest.mark.asyncio
async def test_jsonl_no_entry_on_depth_exceeded(tmp_working_dir):
    """A depth-exceeded rejection does not write a log entry."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        log_path = f.name
    try:
        with patch.dict(os.environ, {"IDEATE_SPAWN_DEPTH": "3", "IDEATE_LOG_FILE": log_path}):
            result = await spawner.call_tool(
                "spawn_session",
                {"prompt": "hello", "working_dir": tmp_working_dir, "max_depth": 3},
            )

        data = _parse_response(result)
        assert data["exit_code"] == 1

        with open(log_path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        assert len(lines) == 0
    finally:
        os.unlink(log_path)


@pytest.mark.asyncio
async def test_jsonl_timeout_entry(tmp_working_dir):
    """A timed-out call writes an entry with timed_out=True, exit_code=-1, success=False."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        log_path = f.name
    try:
        exc = subprocess.TimeoutExpired(cmd=["claude"], timeout=10)
        exc.stdout = None
        exc.stderr = None

        with patch("subprocess.run", side_effect=exc):
            with patch.dict(os.environ, {"IDEATE_LOG_FILE": log_path}):
                await spawner.call_tool(
                    "spawn_session",
                    {"prompt": "hello", "working_dir": tmp_working_dir, "timeout": 10},
                )

        with open(log_path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        assert len(lines) == 1
        entry = json.loads(lines[0])
        assert entry["timed_out"] is True
        assert entry["exit_code"] == -1
        assert entry["success"] is False
        assert entry["prompt_bytes"] == len("hello".encode("utf-8"))  # original prompt, not injected
    finally:
        os.unlink(log_path)


# ---------------------------------------------------------------------------
# 12. Session Registry Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_session_registry_accumulates(tmp_working_dir):
    """After two spawn calls, _session_registry has exactly two entries."""
    with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
        await spawner.call_tool("spawn_session", {"prompt": "first", "working_dir": tmp_working_dir})
        await spawner.call_tool("spawn_session", {"prompt": "second", "working_dir": tmp_working_dir})

    assert len(spawner._session_registry) == 2


@pytest.mark.asyncio
async def test_session_registry_reset_between_tests(tmp_working_dir):
    """The _reset_globals fixture resets _session_registry to []."""
    # At the start of each test, _reset_globals has already run, so registry must be empty
    assert spawner._session_registry == []

    with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
        await spawner.call_tool("spawn_session", {"prompt": "hello", "working_dir": tmp_working_dir})

    assert len(spawner._session_registry) == 1


# ---------------------------------------------------------------------------
# 13. team_name Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_team_name_in_log_entry(tmp_working_dir):
    """When team_name='workers' is passed, log entry has team_name='workers' and used_team=True."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        log_path = f.name
    try:
        with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
            with patch.dict(os.environ, {"IDEATE_LOG_FILE": log_path}):
                await spawner.call_tool(
                    "spawn_session",
                    {"prompt": "hello", "working_dir": tmp_working_dir, "team_name": "workers"},
                )

        with open(log_path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        entry = json.loads(lines[0])
        assert entry["team_name"] == "workers"
        assert entry["used_team"] is True
    finally:
        os.unlink(log_path)


@pytest.mark.asyncio
async def test_no_team_name_in_log_entry(tmp_working_dir):
    """When team_name is not passed, log entry has team_name=None and used_team=False."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.jsonl', delete=False) as f:
        log_path = f.name
    try:
        with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
            with patch.dict(os.environ, {"IDEATE_LOG_FILE": log_path}):
                await spawner.call_tool(
                    "spawn_session",
                    {"prompt": "hello", "working_dir": tmp_working_dir},
                )

        with open(log_path) as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        entry = json.loads(lines[0])
        assert entry["team_name"] is None
        assert entry["used_team"] is False
    finally:
        os.unlink(log_path)


@pytest.mark.asyncio
async def test_team_name_propagated_to_env(tmp_working_dir):
    """When team_name='workers' is passed, child subprocess receives IDEATE_TEAM_NAME='workers'."""
    captured_env = {}

    def fake_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return _make_completed_process(stdout='{"result": "ok"}')

    with patch("subprocess.run", side_effect=fake_run):
        await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir, "team_name": "workers"},
        )

    assert captured_env.get("IDEATE_TEAM_NAME") == "workers"


# ---------------------------------------------------------------------------
# 14. Execution Instructions Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_exec_instructions_param_prepended(tmp_working_dir):
    """When exec_instructions='prefer parallel' is passed, subprocess receives injected prompt."""
    captured_cmd = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return _make_completed_process(stdout='{"result": "ok"}')

    env_without_exec = {k: v for k, v in os.environ.items() if k != "IDEATE_EXEC_INSTRUCTIONS"}
    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, env_without_exec, clear=True):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "do something", "working_dir": tmp_working_dir, "exec_instructions": "prefer parallel"},
            )

    actual_prompt = captured_cmd[-1]
    assert actual_prompt.startswith(
        "[EXECUTION INSTRUCTIONS]\nprefer parallel\n[END EXECUTION INSTRUCTIONS]\n\n"
    )
    assert "do something" in actual_prompt


@pytest.mark.asyncio
async def test_exec_instructions_env_var_used(tmp_working_dir):
    """When IDEATE_EXEC_INSTRUCTIONS='use teams' is set and no param provided, prompt is injected."""
    captured_cmd = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return _make_completed_process(stdout='{"result": "ok"}')

    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, {"IDEATE_EXEC_INSTRUCTIONS": "use teams"}):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "do something", "working_dir": tmp_working_dir},
            )

    actual_prompt = captured_cmd[-1]
    assert actual_prompt.startswith(
        "[EXECUTION INSTRUCTIONS]\nuse teams\n[END EXECUTION INSTRUCTIONS]\n\n"
    )


@pytest.mark.asyncio
async def test_exec_instructions_param_overrides_env(tmp_working_dir):
    """When both param and env var are set, param value is used."""
    captured_cmd = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return _make_completed_process(stdout='{"result": "ok"}')

    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, {"IDEATE_EXEC_INSTRUCTIONS": "env value"}):
            await spawner.call_tool(
                "spawn_session",
                {
                    "prompt": "do something",
                    "working_dir": tmp_working_dir,
                    "exec_instructions": "param value",
                },
            )

    actual_prompt = captured_cmd[-1]
    assert "param value" in actual_prompt
    assert "env value" not in actual_prompt


@pytest.mark.asyncio
async def test_exec_instructions_propagated_to_child_env(tmp_working_dir):
    """When instructions are resolved, IDEATE_EXEC_INSTRUCTIONS is set in child subprocess env."""
    captured_env = {}

    def fake_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return _make_completed_process(stdout='{"result": "ok"}')

    env_without_exec = {k: v for k, v in os.environ.items() if k != "IDEATE_EXEC_INSTRUCTIONS"}
    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, env_without_exec, clear=True):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "hello", "working_dir": tmp_working_dir, "exec_instructions": "prefer parallel"},
            )

    assert captured_env.get("IDEATE_EXEC_INSTRUCTIONS") == "prefer parallel"


@pytest.mark.asyncio
async def test_no_exec_instructions_prompt_unchanged(tmp_working_dir):
    """When neither param nor env var is set, subprocess receives the original prompt unchanged."""
    captured_cmd = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return _make_completed_process(stdout='{"result": "ok"}')

    env_without_exec = {k: v for k, v in os.environ.items() if k != "IDEATE_EXEC_INSTRUCTIONS"}
    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, env_without_exec, clear=True):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "original prompt", "working_dir": tmp_working_dir},
            )

    actual_prompt = captured_cmd[-1]
    assert actual_prompt == "original prompt"


@pytest.mark.asyncio
async def test_prompt_size_validation_uses_original_prompt(tmp_working_dir):
    """A prompt just under 100KB with exec_instructions passes validation (instructions not counted)."""
    # 99,900 bytes prompt — under the 100KB limit
    big_prompt = "a" * 99_900
    # 1000-byte exec_instructions — would push total over limit if counted, but shouldn't be
    exec_instr = "x" * 1000

    with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')) as mock_run:
        env_without_exec = {k: v for k, v in os.environ.items() if k != "IDEATE_EXEC_INSTRUCTIONS"}
        with patch.dict(os.environ, env_without_exec, clear=True):
            result = await spawner.call_tool(
                "spawn_session",
                {"prompt": big_prompt, "working_dir": tmp_working_dir, "exec_instructions": exec_instr},
            )
        mock_run.assert_called_once()

    data = _parse_response(result)
    assert data["exit_code"] == 0


# ---------------------------------------------------------------------------
# 15. Status Table Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_status_table_printed_to_stderr(capsys, tmp_working_dir):
    """After a spawn call, the status table is printed to stderr with expected column headers."""
    with patch("subprocess.run", return_value=_make_completed_process(stdout='{"result": "ok"}')):
        await spawner.call_tool("spawn_session", {"prompt": "hi", "working_dir": tmp_working_dir})

    captured = capsys.readouterr()
    assert "Session ID" in captured.err
    assert "Depth" in captured.err
    assert "Status" in captured.err
    assert "Duration" in captured.err
    assert "Team" in captured.err
    assert "+" in captured.err          # separator row(s) present
    assert "completed" in captured.err  # at least one completed data row


def test_status_table_empty_registry_no_output(capsys):
    """If _session_registry is empty, _print_status_table() prints nothing to stderr."""
    spawner._session_registry = []
    spawner._print_status_table()
    captured = capsys.readouterr()
    assert captured.err == ""


# ---------------------------------------------------------------------------
# 16. Negative-case env propagation tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_team_name_absent_from_child_env_when_not_provided(tmp_working_dir):
    """When team_name is not passed, IDEATE_TEAM_NAME is absent from the child subprocess env."""
    captured_env = {}

    def fake_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return _make_completed_process(stdout='{"result": "ok"}')

    env_without_team = {k: v for k, v in os.environ.items() if k != "IDEATE_TEAM_NAME"}
    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, env_without_team, clear=True):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "hello", "working_dir": tmp_working_dir},
            )

    assert "IDEATE_TEAM_NAME" not in captured_env


@pytest.mark.asyncio
async def test_team_name_not_inherited_from_grandparent_env(tmp_working_dir):
    """Even if IDEATE_TEAM_NAME is set in os.environ, it is stripped when team_name param is absent."""
    captured_env = {}

    def fake_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return _make_completed_process(stdout='{"result": "ok"}')

    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, {"IDEATE_TEAM_NAME": "grandparent-team"}):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "hello", "working_dir": tmp_working_dir},
                # No team_name param — should strip inherited env var
            )

    assert "IDEATE_TEAM_NAME" not in captured_env


@pytest.mark.asyncio
async def test_exec_instructions_absent_from_child_env_when_not_provided(tmp_working_dir):
    """When exec_instructions is not passed and env var is unset, IDEATE_EXEC_INSTRUCTIONS is absent from child env."""
    captured_env = {}

    def fake_run(cmd, **kwargs):
        captured_env.update(kwargs.get("env", {}))
        return _make_completed_process(stdout='{"result": "ok"}')

    env_without_exec = {k: v for k, v in os.environ.items() if k != "IDEATE_EXEC_INSTRUCTIONS"}
    with patch("subprocess.run", side_effect=fake_run):
        with patch.dict(os.environ, env_without_exec, clear=True):
            await spawner.call_tool(
                "spawn_session",
                {"prompt": "hello", "working_dir": tmp_working_dir},
            )

    assert "IDEATE_EXEC_INSTRUCTIONS" not in captured_env


# ---------------------------------------------------------------------------
# 17. --allowedTools CLI Syntax Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_allowed_tools_comma_syntax(tmp_working_dir):
    """allowed_tools list is passed to claude as '--allowedTools Read,Edit' (comma-separated)."""
    captured_cmd = []

    def fake_run(cmd, **kwargs):
        captured_cmd.extend(cmd)
        return _make_completed_process(stdout='{"result": "ok"}')

    with patch("subprocess.run", side_effect=fake_run):
        await spawner.call_tool(
            "spawn_session",
            {"prompt": "hello", "working_dir": tmp_working_dir, "allowed_tools": ["Read", "Edit"]},
        )

    assert "--allowedTools" in captured_cmd
    idx = captured_cmd.index("--allowedTools")
    assert captured_cmd[idx + 1] == "Read,Edit"
