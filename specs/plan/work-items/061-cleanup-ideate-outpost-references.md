# Work Item 061: Cleanup ideate References to Outpost Components

## Objective

Remove all moved components from ideate after the outpost split is complete. This includes deleting files, updating imports, and cleaning up documentation.

## Acceptance Criteria

1. `mcp/session-spawner/` directory removed from ideate
2. `mcp/remote-worker/` directory removed from ideate
3. `mcp/roles/` directory removed from ideate
4. `agents/manager.md` removed from ideate
5. `specs/plan/architecture.md` has no references to session-spawner, remote-worker, or manager as owned components
6. `README.md` updated to reflect ideate's reduced scope
7. `CLAUDE.md` (if it exists) updated to reflect ideate's reduced scope

## File Scope

- delete: `mcp/session-spawner/`
- delete: `mcp/remote-worker/`
- delete: `mcp/roles/`
- delete: `agents/manager.md`
- modify: `README.md`
- modify: `CLAUDE.md` (if exists)

## Dependencies

- 053-056 (components moved to outpost)
- 058 (architecture updated)
- 060 (plugin manifest updated)

## Implementation Notes

This is a cleanup work item. It should run after all references have been updated. Use git rm to remove directories:

```bash
git rm -r mcp/session-spawner/
git rm -r mcp/remote-worker/
git rm -r mcp/roles/
git rm agents/manager.md
```

Update README.md to:
- Remove references to session-spawner MCP server
- Remove references to remote worker daemon
- Add a note pointing to outpost for orchestration needs
- Clarify ideate's scope: planning, refinement, execution, review

## Complexity

Low