# brrr Phase 6a: Execute Phase

## Entry Conditions

Called by the brrr loop controller at the start of each cycle. The following variables are available from the controller context:

- `{artifact_dir}` — absolute path to the artifact directory
- `{project_source_root}` — absolute path to the project source code
- `{cycle_number}` — current 1-based cycle counter
- `{completed_items}` — set of work item numbers already completed

## Instructions

Execute all pending work items following the execution strategy from `{artifact_dir}/plan/execution-strategy.md`.

### Context for Every Worker

**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_work_item_context` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_get_work_item_context` or `mcp__plugin_ideate_ideate_artifact_server__ideate_get_work_item_context`). If found:
1. Call it with `({artifact_dir}, {work_item_id})` — returns pre-assembled context including work item spec, module spec, domain policies, and research.
2. Also provide the project source root path and relevant domain policies (if not already included).
3. Skip the manual file reads in steps 1–8 below.

If not found, read files manually:

Every worker subagent receives:

1. The work item spec — if `{artifact_dir}/plan/work-items.yaml` exists, extract the item's content. Otherwise read `{artifact_dir}/plan/work-items/NNN-{name}.md`.
2. If `{artifact_dir}/plan/notes/{id}.md` exists, include it as additional implementation notes.
3. The architecture document — `{artifact_dir}/plan/architecture.md`
4. The relevant module spec — from `{artifact_dir}/plan/modules/` if it exists and matches the work item's scope; otherwise the full architecture doc
5. Guiding principles — `{artifact_dir}/steering/guiding-principles.md`
6. Constraints — `{artifact_dir}/steering/constraints.md`
7. Relevant research — any files from `{artifact_dir}/steering/research/` referenced in the work item
8. Project source root — the absolute path `{project_source_root}`

All paths provided to workers must be absolute.

The worker prompt must instruct the agent to:
- Build exactly what the work item specifies
- Write source files under `{project_source_root}`
- Follow the architecture document for system context
- Use the guiding principles to resolve ambiguous situations
- Respect all constraints
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

### Execution Modes

Execute according to the mode in `{artifact_dir}/plan/execution-strategy.md`:

**Sequential**: Execute one work item at a time in dependency order. Select the next item whose dependencies are all complete. Build it. Trigger incremental review. Handle findings. Update journal. Repeat.

**Batched parallel**: Execute work items in groups from the execution strategy. Spawn one subagent per work item up to the parallelism limit. Wait for the group. Trigger incremental reviews for all completed items. Handle findings. Update journal. Proceed to the next group.

**Full parallel (teams)**: Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. Construct the shared task list respecting dependency ordering. Each teammate picks up the next available item whose dependencies are satisfied. On each item's completion, trigger incremental review, handle findings, and update journal.

**Worktree isolation**: If the execution strategy specifies worktrees, create a git worktree for each concurrent subagent before spawning it (`git worktree add` with branch `ideate/NNN-{name}`). After a work item's incremental review passes, merge back using `git merge --no-ff ideate/NNN-{name}`. Resolve trivial conflicts (whitespace, import ordering) automatically. For substantive merge conflicts, route to the Andon cord → proxy-human (see below). After a successful merge: `git worktree remove {path}` and `git branch -d ideate/NNN-{name}`.

**Metrics**: After each worker agent returns, record a metrics entry with `phase: "6a"`, `agent_type: "worker"` (schema in controller SKILL.md). Include `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` from agent response metadata (null if unavailable), and `mcp_tools_called` (array of MCP tool names used to assemble context for the spawn, or `[]` if none). Before each Agent tool call, record which MCP tool calls (if any) were made to assemble context for that spawn.

### Incremental Review (Per Work Item)

When a work item completes, spawn the `code-reviewer` agent with:
- The work item spec
- The list of files created or modified
- The architecture document
- The guiding principles
- The worker's self-check results (the `## Self-Check` section from the worker's completion report)

Instruct the code-reviewer: "Spot-check at least 2 `satisfied` claims. Prioritize investigation of `unverifiable` criteria."

Write the result to `{artifact_dir}/archive/incremental/NNN-{name}.md`. After the code-reviewer returns, record a metrics entry with `phase: "6a"`, `agent_type: "code-reviewer"`. Include `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` from agent response metadata (null if unavailable), and `mcp_tools_called` (array of MCP tool names used to assemble context, or `[]` if none). (Full schema including `skill` and `cycle` fields defined in controller SKILL.md.)

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
- **Critical findings fixable within scope**: Fix. Note as significant rework in the journal entry.
- **Critical findings that are scope-changing or worktree merge conflicts**: Do NOT fix. Route to Andon cord → proxy-human (see below).
- **Unmet acceptance criteria**: Attempt to fix. If unfixable due to spec issues, route to Andon cord → proxy-human.

### Andon Cord → Proxy-Human Routing

When an Andon event occurs (scope-changing finding, merge conflict, spec ambiguity, environment failure), do NOT pause and present it to the user. Instead:

1. Formulate an `andon_event` description containing: what the issue is, which work item triggered it, what options are on the table, what context from artifacts is relevant.

2. Invoke the `proxy-human` agent via the Agent tool:

   ```
   subagent_type: "proxy-human"
   model: "claude-opus-4-6"
   prompt: "[Andon Event for proxy-human agent]

   Artifact directory: {artifact_dir}
   Cycle: {cycle_number}

   Event:
   {andon_event_description}

   Write your decision to {artifact_dir}/proxy-human-log.md following the entry format defined in your agent definition."
   ```

3. Wait for the proxy-human agent to respond.

4. Record the proxy-human's decision in `{artifact_dir}/journal.md`:

   ```markdown
   ## [brrr] {date} — Proxy-human decision (Cycle {N})
   Event: {one-sentence summary of the Andon event}
   Decision: {proxy-human's decision}
   Confidence: {HIGH | MEDIUM | LOW}
   ```

5. Apply the decision. If the decision is `DEFER`, add it to the cycle's deferred items list and continue with other work items where possible.

**If the Agent tool is not available**: Handle the event yourself — read `guiding-principles.md` and `constraints.md`, apply them to the event, make the best decision, and record it in `{artifact_dir}/proxy-human-log.md` with heading: `## [brrr-fallback] {ISO date} — Cycle {cycle_number}` followed by the same Event/Decision/Confidence/Rationale fields.

### Worker Agent Failure

If a subagent fails (crashes, times out, produces no output):
1. Record the failure in the journal
2. Retry once with the same work item and context
3. If the retry fails, route to proxy-human as an Andon event
4. Continue with items that do not depend on the failed item

### Journal Updates (Per Work Item)

After each work item completes (and after any rework), append to `{artifact_dir}/journal.md`:

```markdown
## [brrr] {date} — Cycle {cycle_N} — Work item NNN: {title}
Status: {complete | complete with rework}
{Deviations from plan. Decisions made. Notable observations.}
```

If rework occurred:

```markdown
## [brrr] {date} — Cycle {cycle_N} — Work item NNN: {title}
Status: complete with rework
Rework: {N} minor, {N} significant findings fixed from incremental review.
{Description of significant fixes if any.}
```

Update `total_items_executed` in `{artifact_dir}/brrr-state.md` after each item completes.

## Exit Conditions

- All pending work items have been attempted (skipped, completed, or failed+deferred)
- Each completed item has an incremental review written to `{artifact_dir}/archive/incremental/`
- `brrr-state.md` `total_items_executed` is updated
- Journal has an entry for each completed item

Return to the controller. The controller will proceed to Phase 6b (review.md).

## Artifacts Written

- `{artifact_dir}/archive/incremental/NNN-{name}.md` — one per work item reviewed
- `{artifact_dir}/journal.md` — appended per work item and per Andon event
- `{artifact_dir}/brrr-state.md` — `total_items_executed` updated
- `{artifact_dir}/proxy-human-log.md` — if Andon events occurred
- `{artifact_dir}/metrics.jsonl` — one entry per agent spawned
