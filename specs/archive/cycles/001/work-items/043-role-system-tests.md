# Work Item 043: Role System Test Coverage

## Objective

Add tests for the role resolution system in `mcp/session-spawner/server.py`. WI-032 added complete role resolution (prompt injection, allowed_tools override with caller-wins precedence, max_turns override, permission_mode override, unknown-role structured error) but WI-034 delivered no role tests. Fix `_reset_globals` to reset role state.

## Acceptance Criteria

1. `_reset_globals` fixture includes `spawner._roles = {}` to prevent role state leaking between tests
2. Test: `spawn_session` with a known role that has `system_prompt` prefixes the prompt with that system prompt
3. Test: caller-provided `allowed_tools` wins over role-defined `allowed_tools` when both are present
4. Test: caller omits `allowed_tools`; role-defined `allowed_tools` is used
5. Test: `spawn_session` with `role=None` (no role) behaves identically to a call without a role parameter — no system prompt injection, no tool restriction from role
6. Test: unknown role name returns a structured error with `exit_code: 1` and an error message containing the role name
7. Test: known role with `max_turns` override uses the role's max_turns when caller doesn't specify
8. All existing 42 tests continue to pass with the `_reset_globals` change
9. New tests use the same fixture and mock patterns as the existing test suite

## File Scope

- modify: `mcp/session-spawner/test_server.py`

## Dependencies

None. Role resolution code already exists in server.py — only tests are missing.

## Implementation Notes

Locate `_reset_globals` in `test_server.py` (around line 43). Add:
```python
spawner._roles = {}
```
alongside the existing resets for `_session_registry`, `_semaphore`, etc.

For test setup, role tests need to pre-populate `spawner._roles` with test data before calling `spawn_session`. Use the same `monkeypatch` or direct attribute assignment pattern as the existing tests. Example setup:
```python
spawner._roles = {
    "test-role": {
        "system_prompt": "You are a test agent.",
        "allowed_tools": ["Read"],
        "max_turns": 10,
        "permission_mode": "acceptEdits"
    }
}
```

For the prompt injection test, verify that the actual claude subprocess command receives the prefixed prompt (check `mock_run.call_args`).

For caller-wins precedence tests, pass `allowed_tools=["Write"]` when the role defines `["Read"]` — verify the subprocess command contains `--allowedTools Write` not `Read`.

For the unknown role test, the response should have `exit_code: 1` and `error` containing the role name (check the existing unknown-role structured error format in server.py).

Group new tests into a clearly labeled section (e.g., `# Section N: Role System`) following the existing section comment pattern.

## Complexity

Medium
