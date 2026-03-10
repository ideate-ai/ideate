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

---

# Execution Strategy — Refinement Cycle 2 (2026-03-09)

## Mode
Batched sequential

## Parallelism
Max concurrent agents: 2

## Worktrees
Enabled: no
Reason: All changes are in two files with sequenced dependency ordering.

## Review Cadence
After final group

## Work Item Groups

Group 1 (parallel): 022, 024
  Independent — 022 touches data structures and logging; 024 touches prompt augmentation and env. No shared code sections at risk.

Group 2 (sequential, depends on 022): 023
  Status table requires _session_registry from 022.

Group 3 (sequential, depends on 022, 023, 024): 025
  Tests cover all new features; must run last.

## Dependency Graph

```
022 (logging + registry + team_name) ─┬─▶ 023 (status table) ─▶ 025 (tests)
024 (exec instructions)               ─┘                    ─▶ 025 (tests)
```

## Critical Path
022 → 023 → 025 (3 sequential steps minimum)

## Agent Configuration
Model for workers: sonnet
Model for reviewers: sonnet
Permission mode: acceptEdits

---

# Execution Strategy — Refinement Cycle 4 (Deferred Items, 2026-03-09)

## Mode
Batched parallel

## Parallelism
Max concurrent agents: 3

## Worktrees
Enabled: no
Reason: All three work items touch different files with no overlap. Worktrees add overhead not warranted for low-complexity, non-conflicting changes.

## Review Cadence
After every item (incremental review per work item).

## Work Item Groups

Group 1 (parallel): 026, 027, 028, 029
  All independent — no shared file scope, no dependency between them.
  - 026: `mcp/session-spawner/test_server.py`
  - 027: `mcp/session-spawner/README.md`
  - 028: `agents/*.md` (six agent files)
  - 029: `.claude-plugin/marketplace.json`

## Dependency Graph

```
026 (test-polish)            ─┐
027 (readme-notes)           ─┼─ all independent, run in parallel
028 (agent-background)       ─┤
029 (marketplace-version)    ─┘
```

No sequential dependencies. All items complete in a single parallel batch.

## Agent Configuration
Model for workers: sonnet
Model for reviewers: sonnet
Permission mode: acceptEdits
