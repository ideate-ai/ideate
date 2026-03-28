# Autopilot Phase 6d: Refinement Phase

## Entry Conditions

Called only when Phase 6c (convergence check, inline in the controller) determines the cycle did not converge.

Available from controller context:
- `{project_root}` — absolute path to the project root
- `{cycle_number}` — current 1-based cycle counter
- `{last_cycle_findings}` — dict with `critical_count`, `significant_count`, `minor_count`
- `{pending_count_start_of_cycle}` — the number of pending work items at the start of this cycle (for divergence detection)
- `{completed_items}` — current set of completed work item numbers

## Instructions

Produce new work items that address all critical and significant findings from the comprehensive review.

Retrieve the cycle's review artifacts via `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})`. For each critical or significant finding:

1. Determine whether an existing work item covers the fix, or whether a new work item is needed.
2. If a new work item is needed, create it.

   Call `ideate_write_work_items({items_array})` — atomically creates individual work items (WI-{NNN}) for each new work item.

   If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

3. If an existing work item needs rework, append a rework note to its spec and remove it from `{completed_items}`.

**Work item cap**: Create one work item per distinct finding group (e.g., one for all role-system findings, one for all README schema findings), not one per individual finding instance.

**Divergence check**: If the total pending work item count after this phase is greater than or equal to `{pending_count_start_of_cycle}`, stop the loop. Report: "Autopilot cycle is not converging — pending work items are not decreasing. Current: {N}. Previous: {M}. Stopping autonomous loop." Proceed to reporting.md.

Call `ideate_append_journal("autopilot", {date}, "refinement", {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Write a refinement summary:

```markdown
## [autopilot] {date} — Cycle {N} refinement
Findings addressed: {N} critical, {N} significant
New work items created: {list of new item numbers and titles}
Work items reset for rework: {list of item numbers, if any}
```

After producing new work items, update `{completed_items}`: remove any items reset for rework. Add all new items to the pending set for the next cycle.

## Exit Conditions

- New or modified work items exist for each critical/significant finding group
- `{completed_items}` updated (rework items removed)
- Journal updated with refinement summary

Return to the controller. The controller will run Phase 6e (cycle limit check) and, if within limit, start the next cycle.

## Artifacts Written (all via MCP)

- Work items (WI-{NNN}) — new items created via `ideate_write_work_items`
- Journal entries — refinement summary appended via `ideate_append_journal`
