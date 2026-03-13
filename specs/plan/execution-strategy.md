# Execution Strategy — Cycle 002 (brrr Fixes)

## Mode
Sequential — both work items modify `skills/brrr/SKILL.md`, so they run in sequence to avoid conflicts.

## Parallelism Settings
- Max concurrent: 1 (sequential due to shared file)
- Agent model: sonnet (default for execute)

## Worktrees
Not required — single file modifications, no risk of conflict beyond sequencing.

## Review Cadence
Incremental review after each work item completion. Quick review expected (small changes).

## Work Item Groups

### Group 1: brrr Phase 6c Fix
- WI-072: Fix brrr Phase 6c — Replace spawn_session with Agent tool

### Group 2: brrr Label Fix (after Group 1)
- WI-073: Fix DEFERRED → DEFER label mismatch

## Dependency Graph

```
WI-072 ──▶ WI-073
```

Sequential execution required — both modify brrr/SKILL.md.

## Agent Configuration

| Phase | Agent Type | Model | Background |
|-------|------------|-------|------------|
| Execution | worker | sonnet | no |
| Review | code-reviewer | sonnet | no |

## Execution Notes

- WI-072 modifies Phase 6c (lines 494-508 area)
- WI-073 modifies line 317
- Running sequentially prevents edit conflicts on the same file

## Estimated Completion
2 work items × ~15 min each + reviews = ~45 minutes total.
