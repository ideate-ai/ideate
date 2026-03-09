# Execution Strategy — Refinement Cycle

## Mode
Batched parallel

## Parallelism
Max concurrent agents: 4

## Worktrees
Enabled: no
Reason: Same as initial cycle — plugin files are independent with non-overlapping scope.

## Review Cadence
After every batch

## Work Item Groups

Group 1 (parallel): 012, 015, 016, 017, 018, 019, 020, 021
  All independent — no shared file scope, no dependency between them. Max 4 concurrent, so execute in sub-batches:
  - Sub-batch 1a: 012, 015, 016, 017
  - Sub-batch 1b: 018, 019, 020, 021

Group 2 (parallel, depends on 012): 013, 014
  MCP server tests and README update both depend on the security fixes being in place.

## Dependency Graph

```
012 (MCP server security) ─┬─▶ 013 (MCP server tests)
                           └─▶ 014 (MCP server README)
015 (top-level README)
016 (artifact conventions)
017 (execute skill improvements)
018 (plan skill fixes)
019 (review skill fix)
020 (researcher Write tool)
021 (plugin validation)
```

## Agent Configuration
Model for workers: opus
Model for reviewers: sonnet
Permission mode: acceptEdits
