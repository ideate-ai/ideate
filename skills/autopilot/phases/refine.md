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

---

## Phase Transition

This section is invoked by the controller from Phase 6c-ii **only** — when the current phase has converged but the project is not yet complete and `{next_horizon_items}` is non-empty. It is NOT run as part of the normal refinement loop.

### Step 1: Promote Next Horizon

Call `ideate_artifact_query({type: "project", id: "{current_project}"})` to retrieve the current project artifact. Extract:
- `horizon.next` — the list of phase IDs to promote into active scope
- `horizon.later` — any phases beyond the next horizon (may be absent)

For each work item in `horizon.next`, call `ideate_update_work_items({updates: [{id: "{work_item_id}", status: "pending", phase: "active"}]})` to promote it from horizon to active scope.

Update the project artifact to reflect the promotion: call `ideate_write_artifact({type: "project", id: "{current_project}", content: {horizon: {next: {horizon.later items or []}, later: []}}})`. Preserve all other project artifact fields.

Print:
```
[autopilot] Phase transition — promoting {N} work items from horizon.next to active scope
Items: {list of work item IDs and titles}
```

### Step 2: Clear Completed Set

Remove all previously completed items from `{completed_items}` that are not part of the newly promoted set. The new cycle begins fresh against the promoted work items.

Call `ideate_get_execution_status()` to refresh the pending/completed sets. Update `{completed_items}` from the returned `completed` set.

### Step 3: Spawn Transition Architect (optional)

If the promoted work items have unclear dependencies, ordering conflicts, or if the execution strategy does not specify an ordering for the new items, spawn the `ideate:architect` agent to produce a revised execution order:

```
subagent_type: "ideate:architect"
model: "{config.model_overrides.architect or 'sonnet'}"
prompt: "The autopilot is transitioning to the next project phase.
Newly promoted work items: {list of IDs and titles}
Execution strategy: {current strategy content}
Review the promoted items, resolve any dependency conflicts, and return a revised dependency ordering for the new items only. Do not modify the overall strategy fields. Return the revised ordering as structured content."
```

If the architect returns a revised ordering, update the execution strategy: call `ideate_write_artifact({type: "execution_strategy", content: {revised strategy with updated ordering for promoted items}})`.

If no ordering conflict exists, skip this step.

### Step 4: Write Transition Journal Entry

Call `ideate_append_journal("autopilot", {date}, "phase_transition", {body})`:

```markdown
## [autopilot] {date} — Phase transition
Previous phase converged at cycle {cycle_number}
Items promoted to active scope: {N} — {list of IDs and titles}
Items remaining in horizon.future: {N or "none"}
Phases completed so far: {phases_completed + 1}
Project appetite remaining: {project_appetite - (phases_completed + 1)} phases
```

### Exit Conditions (Phase Transition)

- `horizon.next` items promoted to active/pending via `ideate_update_work_items`
- Execution strategy updated to reflect new horizon state via `ideate_write_artifact`
- `{completed_items}` refreshed via `ideate_get_execution_status`
- Journal updated with phase transition entry
- If architect was spawned: execution strategy updated with revised ordering

Return to the controller (Phase 6c-ii). The controller will start the next cycle with the promoted work items.

## Artifacts Written (all via MCP)

- Work items (WI-{NNN}) — new items created via `ideate_write_work_items` (normal refinement)
- Work item status — promoted items updated via `ideate_update_work_items` (phase transition)
- Execution strategy — horizon updated via `ideate_write_artifact` (phase transition)
- Journal entries — refinement summary and/or phase transition entry appended via `ideate_append_journal`

## Self-Check

Before returning to the controller, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Phase Transition section is invoked only from controller Phase 6c-ii, not from normal refine loop
- [x] Phase transition promotes items via `ideate_update_work_items`, not direct file writes
- [x] Project artifact horizon updated via `ideate_write_artifact`, not direct file writes
- [x] `{completed_items}` refreshed via `ideate_get_execution_status` after phase transition
- [x] Divergence check present in normal refinement path (pending count not decreasing)
- [x] Journal updated via `ideate_append_journal`, not direct file writes
