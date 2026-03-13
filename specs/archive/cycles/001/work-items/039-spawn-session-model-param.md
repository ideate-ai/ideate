# Work Item 039: Add model Parameter to spawn_session

## Objective

Add an optional `model` string parameter to the `spawn_session` MCP tool so that calling skills can specify which Claude model to use for a spawned session. This enables model-agnostic agent definitions — the calling skill specifies the model at spawn time rather than it being locked into agent frontmatter.

## Acceptance Criteria

1. `spawn_session` accepts an optional `model` parameter (string, nullable, default null)
2. When `model` is provided, `--model {model}` is appended to the claude subprocess command
3. When `model` is null or absent, no `--model` flag is passed (subprocess uses its default)
4. The `model` parameter appears in the tool's JSON schema definition
5. The parameter is documented in `mcp/session-spawner/README.md` parameters table
6. `exec_instructions` and other existing parameters are unaffected
7. All existing 42 tests continue to pass

## File Scope

- modify: `mcp/session-spawner/server.py`
- modify: `mcp/session-spawner/README.md`

## Dependencies

None.

## Implementation Notes

In `server.py`, the `spawn_session` tool definition (around line 63–133) lists parameters in the JSON schema. Add:
```json
"model": {
  "type": "string",
  "description": "Claude model to use for the spawned session (e.g. 'claude-opus-4-6', 'claude-sonnet-4-6'). If omitted, the subprocess uses its configured default."
}
```

In the handler function, after extracting other parameters, add:
```python
model = arguments.get("model")
```

In the command construction (where `cmd` is built), add:
```python
if model:
    cmd.extend(["--model", model])
```

Place the `--model` flag before the prompt argument. Follow the existing pattern for optional parameters (check `exec_instructions` handling for reference).

In `README.md`, add `model` as a row in the Parameters table. Example:
```
| `model` | string | No | (default) | Claude model identifier for the spawned session. Example: `claude-opus-4-6`. |
```

## Complexity

Low
