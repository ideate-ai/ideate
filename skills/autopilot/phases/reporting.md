# Autopilot Phases 7–9: Convergence Declaration and Activity Report

## Entry Conditions

Called by the controller after the main loop exits. Two entry paths:

- **Converged** (`{convergence_achieved}` = true): Both Conditions A and B passed in Phase 6c during the same cycle.
- **Max cycles reached** (`{convergence_achieved}` = false): `cycles_completed >= max_cycles` without convergence.

Available from controller context:
- `{project_root}` — absolute path to the project root
- `{cycles_completed}` — total cycles completed
- `{max_cycles}` — the configured maximum
- `{convergence_achieved}` — true or false
- `{last_cycle_findings}` — final cycle's finding counts (critical, significant, minor)
- `{started_at}` — ISO 8601 timestamp from `ideate_get_autopilot_state()`

## Instructions

### Phase 7: Convergence Declaration (if converged)

Print:

```
[autopilot] CONVERGED — Cycle {N}

Zero critical findings. Zero significant findings. All guiding principles satisfied.
```

Call `ideate_update_autopilot_state({state: {convergence_achieved: true, cycles_completed: {N}}})` to persist the final state.

Append via `ideate_append_journal`:

```markdown
## [autopilot] {date} — Convergence achieved
Cycles: {N}
Total items executed: {N}
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

### Phase 9: Activity Report

Before presenting the report, append via `ideate_append_journal`:

```markdown
## [autopilot] {date} — Overall metrics summary
Total agents spawned across all cycles: {N}
Total wall-clock across all cycles: {total_ms}ms
```

If `ideate_emit_metric` calls failed, note "metrics unavailable".

**Reconstructing per-cycle data**: The autopilot session state (via `ideate_get_autopilot_state()`) stores only aggregates. Retrieve journal entries via `ideate_artifact_query({type: "journal_entry"})` — collect all `[autopilot]` entries. For each cycle N, collect: work item completions, review summaries, and proxy-human decisions. Also retrieve proxy-human decisions from the journal entries. For each proxy-human decision where the decision is `DEFER`, record it as a deferred item for that cycle.

Present the full activity report:

```
## Autopilot Activity Report

### Run Summary
Started: {started_at}
Ended: {now}
Total cycles: {cycles_completed}
Total work items executed: {total_items_executed}
Convergence: {achieved | not achieved}

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
{If proxy-human journal entries exist: summarize each decision entry — cycle number, event, decision, confidence.}
{If no decisions were made: "No proxy-human decisions were required."}

### Open Items

**Deferred Andon Events**
{For each deferred proxy-human decision across all cycles, list:}
- Cycle {N} — {event description} — Rationale: {proxy-human's deferral rationale from journal entries}
{If no deferred Andon events: "None."}

**Other Unresolved Items**
{List any unresolved conflicts or items that could not be completed for reasons other than deferral.}
{If none: "None."}

### Final State
{If converged: "Project meets all review criteria. Zero critical, zero significant findings. All guiding principles satisfied."}
{If not converged: "Loop stopped at cycle limit. See outstanding findings above."}
```

## Exit Conditions

Activity report presented to user. Session ends.

## Artifacts Written (all via MCP)

- Autopilot session state — `convergence_achieved`, `cycles_completed` updated via `ideate_update_autopilot_state` (Phase 7 only)
- Journal entries — convergence/stop entry and overall metrics summary appended via `ideate_append_journal`
