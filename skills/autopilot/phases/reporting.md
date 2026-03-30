# Autopilot Phases 7–9: Convergence Declaration and Activity Report

## Entry Conditions

Called by the controller after the main loop exits. Three entry paths:

- **Project completed** (`{project_complete}` = true): All project success criteria satisfied after phase convergence. Proceeds through Phase 7 → Phase 7b → Phase 9.
- **Converged** (`{convergence_achieved}` = true, `{current_project}` null): Both Conditions A and B passed in Phase 6c (single-project mode). Proceeds through Phase 7 → Phase 9.
- **Max cycles or appetite exhausted** (`{convergence_achieved}` = false): `cycles_completed >= max_cycles` without convergence, or appetite exhaustion proxy-human deferred. Proceeds through Phase 8 → Phase 8b (if applicable) → Phase 9.

Available from controller context:
- `{project_root}` — absolute path to the project root
- `{cycles_completed}` — total cycles completed
- `{max_cycles}` — the configured maximum
- `{convergence_achieved}` — true or false
- `{last_cycle_findings}` — final cycle's finding counts (critical, significant, minor)
- `{started_at}` — ISO 8601 timestamp from `ideate_manage_autopilot_state({action: "get"})`

## Instructions

### Phase 7: Convergence Declaration (if converged)

Print:

```
[autopilot] CONVERGED — Cycle {N}

Zero critical findings. Zero significant findings. All guiding principles satisfied.
```

Call `ideate_manage_autopilot_state({action: "update", state: {convergence_achieved: true, cycles_completed: {N}}})` to persist the final state.

Append via `ideate_append_journal`:

```markdown
## [autopilot] {date} — Convergence achieved
Cycles: {N}
Total items executed: {N}
```

Proceed to Phase 7b if `{project_complete}` = true; otherwise proceed to Phase 9.

### Phase 7b: Project Completion Declaration (if project completed)

If `{current_project}` is not null and the loop exited because `{project_complete}` = true (from Phase 6c-ii):

Print:

```
[autopilot] PROJECT COMPLETE — {current_project.title}

All success criteria satisfied. Project marked completed.
```

Call `ideate_manage_autopilot_state({action: "update", state: {workspace_label: "project-complete", current_project: "{current_project.id}"}})`.

Append via `ideate_append_journal`:

```markdown
## [autopilot] {date} — Project completed
Project: {current_project.title} ({current_project.id})
Phases completed: {phases_completed}
Cycles completed: {cycles_completed}
All success criteria met.
```

Proceed to Phase 9 (Activity Report).

### Phase 8: Max Cycles Report (if not converged)

Print:

```
[autopilot] STOPPED — Maximum cycles ({N}) reached without convergence.

Cycle {N} state:
Critical findings: {N}
Significant findings: {N}
```

List the outstanding findings that prevented convergence.

Ask:

> The autonomous loop reached its cycle limit. Options:
> a) Continue with --max-cycles {N+10} (extend the limit)
> b) Stop and review the current state manually
> c) Run /ideate:review to inspect the findings directly

Wait for the user's response. Apply it.

Proceed to Phase 9 regardless of the user's choice.

### Phase 8b: Appetite Exhaustion Note (if appetite triggered Andon)

If the loop exited because appetite was exhausted and the proxy-human deferred, note in the activity report's Final State:

> Appetite exhausted: {phases_completed} phases completed (appetite: {project_appetite}). Proxy-human decision: deferred. Project "{current_project.title}" remains open.

### Phase 9: Activity Report

Before presenting the report, append via `ideate_append_journal`:

```markdown
## [autopilot] {date} — Overall metrics summary
Total agents spawned across all cycles: {N}
Total wall-clock across all cycles: {total_ms}ms
```

If `ideate_emit_metric` calls failed, note "metrics unavailable".

**Reconstructing per-cycle data**: The autopilot session state (via `ideate_manage_autopilot_state({action: "get"})`) stores only aggregates. Retrieve journal entries via `ideate_artifact_query({type: "journal_entry"})` — collect all `[autopilot]` entries. For each cycle N, collect: work item completions, review summaries. Also retrieve proxy-human decisions via `ideate_artifact_query({type: "proxy_human_decision", filters: {cycle: N}})`. For each proxy-human decision where the decision is `deferred`, record it as a deferred item for that cycle.

Present the full activity report:

```
## Autopilot Activity Report

### Run Summary
Started: {started_at}
Ended: {now}
Total cycles: {cycles_completed}
Total work items executed: {total_items_executed}
Convergence: {achieved | not achieved}
Project: {current_project.title ({current_project.id}) | N/A}
Phases completed: {phases_completed | N/A}
Project status: {completed | in progress | appetite exhausted | N/A}

### Cycle-by-Cycle Summary

#### Cycle 1
Work items completed: {N} ({list of item numbers and titles})
Items with rework: {N}
Critical findings: {N}
Significant findings: {N}
Minor findings: {N}
Proxy-human decisions: {N}
Deferred decisions: {N} — {list of deferred event topics, or "None."}

#### Cycle 2
...

### Proxy-Human Decision Log Summary
{If proxy-human decision artifacts exist: summarize each — cycle number, trigger, decision, rationale.}
{If no decisions were made: "No proxy-human decisions were required."}

### Open Items

**Deferred Andon Events**
{For each deferred proxy-human decision across all cycles (retrieved via `ideate_artifact_query({type: "proxy_human_decision"})`), list:}
- Cycle {N} — {event description} — Rationale: {proxy-human's deferral rationale}
{If no deferred Andon events: "None."}

**Other Unresolved Items**
{List any unresolved conflicts or items that could not be completed for reasons other than deferral.}
{If none: "None."}

### Final State
{If project completed: "Project '{current_project.title}' completed. All success criteria satisfied. Zero critical, zero significant findings. All guiding principles satisfied."}
{If converged (single-project mode): "Work converged. Zero critical, zero significant findings. All guiding principles satisfied."}
{If appetite exhausted: "Appetite exhausted after {phases_completed} phases. Project '{current_project.title}' remains open. See Proxy-Human Decision Log for details."}
{If not converged: "Loop stopped at cycle limit. See outstanding findings above."}
```

## Exit Conditions

Activity report presented to user. Session ends.

## Artifacts Written (all via MCP)

- Autopilot session state — `convergence_achieved`, `cycles_completed`, `workspace_label` updated via `ideate_manage_autopilot_state` (Phases 7 and 7b)
- Project artifact — status set to "completed" via `ideate_write_artifact` (Phase 7b only, if project completed)
- Journal entries — convergence/stop entry, project completion entry (if applicable), and overall metrics summary appended via `ideate_append_journal`

## Self-Check

Before presenting the activity report, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Project-level reporting included in Run Summary (project title, phases completed, project status)
- [x] Phase 7b fires if and only if `{current_project}` is not null and `{project_complete}` = true
- [x] Phase 8b fires if and only if appetite exhaustion triggered the Andon and proxy-human deferred
- [x] Final State covers all four outcomes: project completed, converged (single-project), appetite exhausted, cycle limit
- [x] `workspace_label` updated via `ideate_manage_autopilot_state`, not via direct file write
- [x] Project artifact completion written via `ideate_write_artifact`, not direct file write
