# Work Item 038: Documentation and Version Bump

## Objective

Update documentation to cover remote workers, role system, and brrr mode. Bump plugin version to 0.4.0.

## Acceptance Criteria

1. `mcp/remote-worker/README.md` created with: overview, prerequisites (Python 3.10+, claude CLI, fastapi), installation (`pip install -r requirements.txt`), startup instructions (`IDEATE_WORKER_API_KEY=... python server.py`), full API reference (all 5 endpoints with request/response examples), environment variables table.
2. `mcp/session-spawner/README.md` updated: add `spawn_remote_session`, `poll_remote_job`, `list_remote_workers` to the Tools section; add `IDEATE_REMOTE_WORKERS` to env vars table; add `role` parameter to `spawn_session` parameters table.
3. `README.md` (top-level) updated: add "Remote Workers" section explaining setup and use; add "/ideate:brrr" to the Skills table; update MCP server description to mention three new tools.
4. `.claude-plugin/marketplace.json` version bumped from `0.3.0` to `0.4.0` in both `version` fields.
5. `mcp/session-spawner/server.py` server version string updated from `"0.3.0"` to `"0.4.0"`.
6. `mcp/remote-worker/server.py` version string is `"0.1.0"` (independent versioning for the new component).

## File Scope

- create: `mcp/remote-worker/README.md`
- modify: `mcp/session-spawner/README.md`
- modify: `README.md`
- modify: `.claude-plugin/marketplace.json`
- modify: `mcp/session-spawner/server.py` (version string only)

## Dependencies

030 (remote worker exists to document), 033 (new tools exist to document), 037 (brrr skill exists to reference).

## Implementation Notes

- Remote worker README API reference should include curl examples for each endpoint.
- Top-level README brrr section: brief description, convergence definition, mention of proxy-human agent, `--max-cycles` option.
- Do not document implementation internals — README is for users deploying and using the tools.

## Complexity

Low
