# 014: MCP Server README Update

## Objective
Update the session-spawner README to document new features (token budget logging, safe root, prompt limits) and updated safety mechanisms.

## Acceptance Criteria
- [ ] README documents the `IDEATE_MAX_DEPTH` environment variable for server-side depth limiting
- [ ] README documents the `IDEATE_SAFE_ROOT` environment variable for working directory validation
- [ ] README documents the prompt length limit (100KB)
- [ ] README documents token budget logging behavior (included when available, omitted otherwise)
- [ ] README's environment variables table includes all new variables
- [ ] README's safety mechanisms section is updated to reflect server-side depth enforcement (not caller-controlled)
- [ ] README documents how to run tests (`pytest mcp/session-spawner/test_server.py`)

## File Scope
- `mcp/session-spawner/README.md` (modify)

## Dependencies
- Depends on: 012
- Blocks: none

## Implementation Notes
Update existing sections rather than rewriting. The README already has Safety Mechanisms and Environment Variables sections — extend them with new content.

## Complexity
Low
