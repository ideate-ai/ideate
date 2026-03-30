# Autopilot Phase 6a: Execute Phase

## Entry Conditions

Called by the autopilot loop controller at the start of each cycle. The following variables are available from the controller context:

- `{project_root}` — absolute path to the project root
- `{project_source_root}` — absolute path to the project source code
- `{cycle_number}` — current 1-based cycle counter
- `{completed_items}` — set of work item numbers already completed

## Instructions

Execute all pending work items following the execution strategy (loaded by the controller via `ideate_artifact_query({type: "execution_strategy"})`).

### Read Project Configuration

Call `ideate_get_config()` to read project configuration. Hold the response as `{config}`. Use `{config}.agent_budgets.{agent_name}` as the maxTurns value when spawning agents. If `ideate_get_config` is unavailable or returns no agent_budgets, use the agent's frontmatter maxTurns as fallback. Also hold `{config}.model_overrides` — a map of agent name to model string. When spawning any agent, use `{config}.model_overrides['{agent_name}']` as the model parameter if present and non-empty; otherwise use the hardcoded default listed in the spawn instruction.

### Prepare Context Digest

Before spawning workers, assemble a **context digest** for each pending work item using PPR-based context assembly. This provides graph-aware, relevance-ranked context within a token budget.

**PPR-based context assembly**: For each pending work item, call `ideate_assemble_context({seed_ids: [{current_work_item_id}], token_budget: {config}.ppr.default_token_budget, include_types: ["architecture", "guiding_principle", "constraint"]})`. The tool runs Personalized PageRank over the artifact graph, ranks all artifacts by relevance to the seed work item, and assembles context within the token budget. Always-include types (architecture, principles, constraints) are included regardless of PPR score.

Hold the returned context as `{ppr_context[item_id]}`. Pass it to the worker as their context digest.

**Fallback**: If `ideate_assemble_context` is unavailable or returns an error, fall back to the existing manual context digest construction:

Call `ideate_get_context_package()` — returns the architecture document, guiding principles, and constraints as a single pre-assembled package. Hold the result as `{context_package}`.

For each pending work item:
1. Use the architecture section from `{context_package}`. Check its total line count.
   - If the architecture content is ≤200 lines total, skip digest preparation for that item and pass the full content.
   - If >200 lines, extract:
     - The full `## Interface Contracts` section — always included in full, uncapped (contracts span modules and must not be truncated regardless of length)
     - Sections mentioning any file path in the work item's `file_scope`
     - The component map entry for the relevant component
     - Cap all non-interface-contracts content at 150 lines total; if over this limit, include the component map entry first, then file-scope sections. If the interface contracts section alone exceeds 150 lines, include only the interface contracts section.
2. Include guiding principles from `{context_package}` in full (typically short enough to include entirely).
3. Include constraints from `{context_package}` in full.

Store as `{work_item_context_digest[item_id]}`. Pass to the worker instead of the raw architecture content. Include a note that the full documents are available via MCP tools if more detail is needed.

### Context for Every Worker

Call `ideate_get_work_item_context({work_item_id})` — returns pre-assembled context including work item spec, module spec, domain policies, and research. Also provide the project source root path and relevant domain policies (if not already included). Skip the manual file reads in steps 1–8 below.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Every worker subagent receives:

1. The work item context — from `ideate_get_work_item_context({work_item_id})`, which returns the work item spec (including inline implementation notes), module spec, domain policies, and relevant research as a single pre-assembled package.
2. _(Implementation notes are inline in the work item YAML `notes` field, included in the response above.)_
3. The context digest — `{ppr_context[item_id]}` from the PPR-based context assembly in the "Prepare Context Digest" step above, or `{work_item_context_digest[item_id]}` if fallback was used. Includes a note that full documents are available via MCP tools if more detail is needed.
4. The relevant module spec — included in the `ideate_get_work_item_context` response if applicable; otherwise the full architecture doc from `{context_package}`.
5. _(Included in context digest)_
6. _(Included in context digest)_
7. Relevant research — included in the `ideate_get_work_item_context` response.
8. Project source root — the absolute path `{project_source_root}`.

All paths provided to workers must be absolute.

The worker prompt must instruct the agent to:
- Build exactly what the work item specifies
- Write source files under `{project_source_root}`
- Follow the context digest for system context (and read full architecture at the provided path if more detail is needed)
- Use the guiding principles from the digest to resolve ambiguous situations (read full principles if needed)
- Respect all constraints from the digest (read full constraints if needed)
- Not make design decisions beyond what the spec prescribes
- Report completion with a list of files created or modified

The worker prompt must also include this self-check instruction:

> **Before reporting completion**, walk every acceptance criterion from the work item spec. For each, determine:
> - `satisfied` — met and verifiable from the code or output you produced
> - `unsatisfied` — not met; fix before reporting completion, then re-verify
> - `unverifiable` — cannot check without test execution, running services, or external validation
>
> Do not report completion while any criterion is `unsatisfied`. Fix it first.
>
> Include a `## Self-Check` section in your completion report listing each criterion and its status:
>
>     ## Self-Check
>     - [x] {criterion text} — satisfied
>     - [ ] {criterion text} — unverifiable: {brief reason}

**Skipping completed items**: Before starting a work item, check whether its number is in `{completed_items}`. If so, skip it and report: "Skipping work item NNN: {title} — already completed."

**Hook: work_item.started**: Before spawning the worker for each work item (after the skip check passes), call `ideate_emit_event` with:
- event: "work_item.started"
- variables: { "WORK_ITEM_ID": "{work_item_id}", "WORK_ITEM_TITLE": "{work_item_title}" }

This call is best-effort — if it fails, continue without interruption.

**Hook: work_item.completed**: After each work item passes incremental review (findings handled, rework complete if any), call `ideate_emit_event` with:
- event: "work_item.completed"
- variables: { "WORK_ITEM_ID": "{work_item_id}", "VERDICT": "{review_verdict}" }

Where `{review_verdict}` is `"pass"` if the review passed without rework, `"rework"` if it passed after rework, or `"fail"` if unresolvable. This call is best-effort — if it fails, continue without interruption.

**Update work item status**: After each work item passes incremental review (findings handled, rework complete if any) and after emitting the `work_item.completed` event, call `ideate_update_work_items({updates: [{id: "{work_item_id}", status: "done"}]})` to transition the work item from 'pending' to 'done'. This ensures `ideate_get_execution_status` reflects completed items. If the call fails, log the error but continue — the status update is informational, not blocking.

**Refreshing execution status mid-cycle**: If the `{completed_items}` set needs to be refreshed mid-cycle (e.g., after a partial failure and retry), call `ideate_get_execution_status()` — returns current completed, pending, and blocked sets. Use the returned `completed` set to update `{completed_items}` before skipping decisions. If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

### Execution Modes

Execute according to the mode in the execution strategy (loaded by the controller via `ideate_artifact_query({type: "execution_strategy"})`):

**Sequential**: Execute one work item at a time in dependency order. Select the next item whose dependencies are all complete. Build it. Trigger incremental review. Handle findings. Update journal. Repeat.

**Batched parallel**: Execute work items in groups from the execution strategy. Spawn one subagent per work item up to the parallelism limit. Wait for the group. Trigger incremental reviews for all completed items. Handle findings. Update journal. Proceed to the next group.

**Full parallel (teams)**: Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Construct the shared task list respecting dependency ordering. Each teammate picks up the next available item whose dependencies are satisfied. On each item's completion, trigger incremental review, handle findings, and update journal.

**Worktree isolation**: If the execution strategy specifies worktrees, create a git worktree for each concurrent subagent before spawning it (`git worktree add` with branch `ideate/NNN-{name}`). After a work item's incremental review passes, merge back using `git merge --no-ff ideate/NNN-{name}`. Resolve trivial conflicts (whitespace, import ordering) automatically. For substantive merge conflicts, route to the Andon cord → proxy-human (see below). After a successful merge: `git worktree remove {path}` and `git branch -d ideate/NNN-{name}`.

**Workspace rename on phase transition**: When a phase transition has occurred (i.e., the controller entered this cycle via Phase 6c-ii → Phase Transition in refine.md), update the workspace label by calling `ideate_manage_autopilot_state({action: "update", state: {workspace_label: "phase-{phases_completed}"}})`. This is informational — it tags the session state so activity reports can group work by phase. Best-effort: if the call fails, continue without interruption.

**Metrics**: After each worker agent returns, emit a metric via `ideate_emit_metric({payload: {phase: "6a", agent_type: "worker", ...}})` (full field schema in controller SKILL.md). Best-effort only: if the call fails, continue without interruption. Extract `turns_used` from the `tool_uses` field in the Agent response `<usage>` block (integer; `null` if not available — do NOT leave as `null` if the usage block is present). Include `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` from agent response metadata (null if unavailable), and `mcp_tools_called` (array of MCP tool names used to assemble context for the spawn, or `[]` if none). Before each Agent tool call, record which MCP tool calls (if any) were made to assemble context for that spawn. Set `outcome`, `finding_count`, `finding_severities`, `first_pass_accepted` to `null` for worker entries. Set `rework_count` to the number of fix-and-re-review cycles completed for this work item (0 if first review passed without rework). If `turns_used` is non-null and the worker's maxTurns is known, and `turns_used / maxTurns > 0.80`, append to the journal entry for this work item: `Agent worker used {turns_used}/{maxTurns} turns ({pct}%) — near budget limit`.

### Incremental Review (Per Work Item)

When a work item completes, spawn the `ideate:code-reviewer` agent with:
- The work item spec
- The list of files created or modified
- The architecture document
- The guiding principles
- The worker's self-check results (the `## Self-Check` section from the worker's completion report)

Instruct the code-reviewer: "Spot-check at least 2 `satisfied` claims. Prioritize investigation of `unverifiable` criteria."

Include the following in the code-reviewer's prompt:

  > **Unverifiable claims**: The worker's self-check may contain criteria marked `unverifiable`. For each:
  > 1. List all `unverifiable` criteria explicitly in your findings.
  > 2. Attempt to verify at least 2 of them by reading the relevant source files. If verifiable by file inspection, reclassify as `satisfied` or `unsatisfied`.
  > 3. Only accept `unverifiable` for criteria requiring runtime testing, external system dependencies, or human judgment that cannot be derived from file contents.
  >
  > **Dynamic testing (incremental scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Step 2 — Incremental review scope (single work item)". Discover the project's test model, run the smoke test, and run tests scoped to the changed files. If the smoke test fails, report a Critical finding titled "Startup failure after [work item name]".

Write the result via `ideate_write_artifact({type: "finding", id: "F-{WI}-{SEQ}", content: {cycle: {cycle_number}, work_item: "{WI}", content: <findings from response>}})`. After the code-reviewer returns, emit a metric via `ideate_emit_metric({payload: {phase: "6a", agent_type: "code-reviewer", ...}})`. Best-effort only: if the call fails, continue without interruption. Extract `turns_used` from the `tool_uses` field in the Agent response `<usage>` block (integer; `null` if not available — do NOT leave as `null` if the usage block is present). The maxTurns budget for `code-reviewer` is `{config}.agent_budgets.code-reviewer` (fallback to agent frontmatter default). If `turns_used` is non-null and `turns_used / maxTurns > 0.80`, append to the journal entry for this work item: `Agent code-reviewer used {turns_used}/{maxTurns} turns ({pct}%) — near budget limit`. Include `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` from agent response metadata (null if unavailable), and `mcp_tools_called` (array of MCP tool names used to assemble context, or `[]` if none). Also set: `outcome` to `"pass"`, `"rework"`, or `"fail"` based on the review verdict and whether rework was required; `finding_count` to the total number of findings across all severities from the review (null if output cannot be parsed); `finding_severities` to `{"critical": N, "significant": N, "minor": N}` (null if output cannot be parsed); `first_pass_accepted` to `true` if the review passes with no rework required, `false` otherwise; `rework_count` to `null`. (Full field schema in controller SKILL.md.)

**Review format**:

```markdown
## Verdict: {Pass | Fail}

{One-sentence summary.}

## Critical Findings

### C1: {title}
- **File**: `path/to/file.ext:line`
- **Issue**: {description}
- **Impact**: {what goes wrong}
- **Suggested fix**: {concrete fix}

## Significant Findings

### S1: {title}
- **File**: `path/to/file.ext:line`
- **Issue**: {description}
- **Impact**: {what goes wrong}
- **Suggested fix**: {concrete fix}

## Minor Findings

### M1: {title}
- **File**: `path/to/file.ext:line`
- **Issue**: {description}
- **Suggested fix**: {concrete fix}

## Unmet Acceptance Criteria

- [ ] {criterion} — {why not met}
```

If a severity section has no findings, include the header with "None." underneath.

**Review finding handling**:

- **Minor findings**: Fix immediately, silently. Note rework in the journal entry.
- **Significant findings within scope**: Fix. Note rework in the journal entry.
- **Critical findings — "Startup failure after ..."**: Diagnose root cause immediately. If fixable within scope: apply surgical fix, note in the journal: `Rework: Startup failure root cause diagnosed and fixed. {brief description of fix}.` Re-run smoke test. If smoke test still fails after fix, treat as indeterminate and route to Andon cord → proxy-human. If not fixable (scope change required, cause indeterminate): note in journal — `Diagnosis: {root cause finding}. Routing to Andon — cause not fixable within work item scope.` Route to Andon cord → proxy-human.
- **Smoke test infrastructure failure (runner cannot execute)**: Determine if the failure is a regression caused by this work item (config files, dependency manifests, port bindings changed). If regression: diagnose, apply surgical fix (no scope expansion, no architectural decisions), re-run. If still fails: journal — `Diagnosis: {root cause finding}. Routing to Andon — smoke test infrastructure failure persists after fix.` Route to Andon cord → proxy-human. If not a regression: journal — `Smoke test infrastructure failure detected. Not a regression — routing to Andon.` Route to Andon cord → proxy-human.
- **Critical findings fixable within scope (non-startup-failure, non-infrastructure-failure)**: Fix. Note as significant rework in the journal entry.
- **Critical findings that are scope-changing or worktree merge conflicts**: Do NOT fix. Route to Andon cord → proxy-human (see below).
- **Unmet acceptance criteria**: Attempt to fix. If unfixable due to spec issues, route to Andon cord → proxy-human.

### Andon Cord → Proxy-Human Routing

When an Andon event occurs (scope-changing finding, merge conflict, spec ambiguity, environment failure), do NOT pause and present it to the user. Instead:

1. Formulate an `andon_event` description containing: what the issue is, which work item triggered it, what options are on the table, what context from artifacts is relevant.

2. Invoke the `ideate:proxy-human` agent via the Agent tool:

   ```
   subagent_type: "ideate:proxy-human"
   model: "opus"
   prompt: "[Andon Event for proxy-human agent]

   Project root: {project_root}
   Cycle: {cycle_number}

   Event:
   {andon_event_description}

   Write your decision via ideate_write_artifact with type 'proxy_human_decision' following the format defined in your agent definition."
   ```

3. Wait for the proxy-human agent to respond.

4. The proxy-human agent writes its decision via `ideate_write_artifact({type: "proxy_human_decision", id: "PH-{cycle}-{seq}", content: {...}})`. No separate recording step needed.

5. Apply the decision. If the decision is `"deferred"`, add it to the cycle's deferred items list and continue with other work items where possible. Immediately print to running output:
   ```
   [autopilot] ⚠ Deferred: {event description} — proxy-human deferred this decision. See activity report for details.
   ```
   Do NOT interrupt the loop or ask the user. This is logging only.

**If the Agent tool is not available**: Handle the event yourself — use the guiding principles and constraints from `{context_package}` (loaded via `ideate_get_context_package()` in the Prepare Context Digest step), apply them to the event, make the best decision, and record it via `ideate_write_artifact({type: "proxy_human_decision", id: "PH-{cycle}-{seq}", content: {cycle: {cycle_number}, trigger: "fallback", triggered_by: [], decision: "{decision}", rationale: "{rationale}", timestamp: "{ISO timestamp}", status: "resolved"}})`.

### Worker Agent Failure

If a subagent fails (crashes, times out, produces no output):
1. Record the failure in the journal
2. Retry once with the same work item and context
3. If the retry fails, route to proxy-human as an Andon event
4. Continue with items that do not depend on the failed item

### Journal Updates (Per Work Item)

After each work item completes (and after any rework), append a journal entry via `ideate_append_journal`.

Call `ideate_append_journal("autopilot", {date}, {entry_type}, {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

```markdown
## [autopilot] {date} — Cycle {cycle_N} — Work item NNN: {title}
Status: {complete | complete with rework}
{Deviations from plan. Decisions made. Notable observations.}
```

If rework occurred:

```markdown
## [autopilot] {date} — Cycle {cycle_N} — Work item NNN: {title}
Status: complete with rework
Rework: {N} minor, {N} significant findings fixed from incremental review.
{Description of significant fixes if any.}
```

After each item completes, call `ideate_manage_autopilot_state({action: "get"})` to read the current `total_items_executed`, increment it, then call `ideate_manage_autopilot_state({action: "update", state: {total_items_executed: {N+1}}})` to persist the update.

## Exit Conditions

- All pending work items have been attempted (skipped, completed, or failed+deferred)
- Each completed item has an incremental review finding written via `ideate_write_artifact`
- Each completed item has its status updated to 'done' via `ideate_update_work_items`
- `total_items_executed` is updated via `ideate_manage_autopilot_state`
- Journal has an entry for each completed item (via `ideate_append_journal`)

Return to the controller. The controller will proceed to Phase 6b (review.md).

## Artifacts Written (all via MCP)

- Findings (F-{WI}-{SEQ}) — one per work item reviewed, via `ideate_write_artifact`
- Journal entries — appended per work item and per Andon event, via `ideate_append_journal`
- Work item status — updated to 'done' for each completed item, via `ideate_update_work_items`
- Autopilot session state — `total_items_executed` and `workspace_label` updated via `ideate_manage_autopilot_state`
- Proxy-human decisions (PH-{cycle}-{seq}) — if Andon events occurred, via `ideate_write_artifact` with type `proxy_human_decision`
- Metrics — one entry per agent spawned, via `ideate_emit_metric`

## Self-Check

Before returning to the controller, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Workspace rename on phase transition uses `ideate_manage_autopilot_state`, not direct file writes
- [x] Every completed work item has a finding written via `ideate_write_artifact`
- [x] Every completed work item has status updated via `ideate_update_work_items`
- [x] `total_items_executed` updated via `ideate_manage_autopilot_state` after each item
- [x] Journal entries written via `ideate_append_journal`, not direct file writes
