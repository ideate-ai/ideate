# Execution Strategy — Cycle 011

## Mode

Sequential — one work item.

## Parallelism

N/A — single item.

## Worktree Configuration

None required. All changes are to markdown files.

## Review Cadence

Standard incremental review after work item completes. Capstone review after completion.

## Work Item Groups

### Group A

| Work Item | Title | Complexity | Files |
|---|---|---|---|
| WI-120 | Add startup-failure exception to execute finding-handling | low | `skills/execute/SKILL.md`, `skills/brrr/phases/execute.md` |

## Dependency Graph

```
WI-120 ──▶ (capstone review)
```

## Agent Configuration

- Worker: default model (sonnet)
- Incremental reviewer: default model (sonnet)
