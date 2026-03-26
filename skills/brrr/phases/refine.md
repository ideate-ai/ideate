# brrr Phase 6d: Refinement Phase

## Entry Conditions

Called only when Phase 6c (convergence check, inline in the controller) determines the cycle did not converge.

Available from controller context:
- `{artifact_dir}` — absolute path to the artifact directory
- `{cycle_number}` — current 1-based cycle counter
- `{last_cycle_findings}` — dict with `critical_count`, `significant_count`, `minor_count`
- `{pending_count_start_of_cycle}` — the number of pending work items at the start of this cycle (for divergence detection)
- `{completed_items}` — current set of completed work item numbers

## Instructions

Produce new work items that address all critical and significant findings from the comprehensive review.

For each critical or significant finding from `{artifact_dir}/archive/cycles/{formatted_cycle_number}/`:

1. Determine whether an existing work item covers the fix, or whether a new work item is needed.
2. If a new work item is needed, create it.

   **Call `ideate_write_work_items`**: Look in your tool list for a tool whose name ends in `ideate_write_work_items` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_write_work_items` or `mcp__plugin_ideate_ideate_artifact_server__ideate_write_work_items`). If not found, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

   Call it with `({artifact_dir}, {items_array})` — atomically appends the new work items to `plan/work-items.yaml` (or creates per-item files in the legacy format). Skip the manual create steps below.

   If `ideate_write_work_items` is unavailable, create manually:
   - If `{artifact_dir}/plan/work-items.yaml` exists: add a new entry to the `items:` mapping using the next available NNN id, following the existing schema (`title`, `complexity`, `scope`, `depends`, `blocks`, `criteria`).
   - Otherwise: create `{artifact_dir}/plan/work-items/{NNN}-{name}.md` with: objective, acceptance criteria, file scope, dependencies.

3. If an existing work item needs rework, append a rework note to its spec and remove it from `{completed_items}`.

**Work item cap**: Create one work item per distinct finding group (e.g., one for all role-system findings, one for all README schema findings), not one per individual finding instance.

**Divergence check**: If the total pending work item count after this phase is greater than or equal to `{pending_count_start_of_cycle}`, stop the loop. Report: "brrr cycle is not converging — pending work items are not decreasing. Current: {N}. Previous: {M}. Stopping autonomous loop." Proceed to reporting.md.

**Call `ideate_append_journal`**: Look in your tool list for a tool whose name ends in `ideate_append_journal` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_append_journal` or `mcp__plugin_ideate_ideate_artifact_server__ideate_append_journal`). If not found, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Call it with `({artifact_dir}, "brrr", {date}, "refinement", {body})` — appends a structured journal entry atomically.

Write a refinement summary to `{artifact_dir}/journal.md`:

```markdown
## [brrr] {date} — Cycle {N} refinement
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

## Artifacts Written

- `{artifact_dir}/plan/work-items.yaml` (modified — new items added) **or** `{artifact_dir}/plan/work-items/{NNN}-{name}.md` (new files created)
- `{artifact_dir}/journal.md` — refinement summary appended
