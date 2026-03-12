# Execution Strategy — Refinement Cycle 7 (Ideate/Outpost Split, 2026-03-11)

## Mode
Batched parallel

## Parallelism
Max concurrent agents: 5

## Worktrees
Enabled: no
Reason: All work items have non-overlapping file scope. Lift-and-shift items create files in new directories; modification items touch separate files.

## Review Cadence
After each group.

## Work Item Groups

Group 1 (parallel, no dependencies): 052, 057, 058
  - 052: Create `~/code/outpost/` directory structure (new project)
  - 057: Modify `skills/brrr/SKILL.md` (Agent tool invocation)
  - 058: Modify `specs/plan/architecture.md` (documentation)

Group 2 (parallel, after Group 1): 053, 054, 056
  - 053: Move `mcp/session-spawner/` from ideate to outpost
  - 054: Move `mcp/remote-worker/` from ideate to outpost
  - 056: Move `agents/manager.md` from ideate to outpost

Group 3 (after 053): 055
  - 055: Move `mcp/roles/default-roles.json` from ideate to outpost
  - Depends on 053 (roles directory lives inside session-spawner context)

Group 4 (parallel, after Group 2 + Group 3): 059, 060
  - 059: Delete moved directories from ideate, clean up plugin.json and README
  - 060: Run `/ideate:plan ~/code/outpost/specs` to generate outpost principles/constraints
  - Both depend on all move work items completing; 060 needs code in place for architecture analysis

Group 5 (after 059): 061
  - 061: Update ideate plugin version, remove MCP declarations
  - Depends on 059 (components must be removed before plugin cleanup)

## Dependency Graph

```
052 (outpost structure) ─┬─▶ 053 (move session-spawner) ─▶ 055 (move roles) ─┬─▶ 059 (remove from ideate) ─▶ 061 (plugin version)
                         ├─▶ 054 (move remote-worker) ──────────────────────┤
                         └─▶ 056 (move manager) ────────────────────────────┤
                                                                             └─▶ 060 (outpost principles)
057 (brrr Agent tool) ───┐
058 (architecture doc) ─┴─ all independent, run in Group 1
```

## Critical Path
052 → 053 → 055 → 059 → 061 (5 sequential steps minimum)

## Agent Configuration
Model for workers: sonnet
Model for reviewers: sonnet
Permission mode: acceptEdits