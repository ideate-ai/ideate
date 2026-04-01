# Autopilot Phase 6b: Comprehensive Review Phase

## Entry Conditions

Called after Phase 6a (execute.md) completes. All pending work items have been attempted and have incremental reviews.

Available from controller context:
- `{project_root}` — absolute path to the project root
- `{project_source_root}` — absolute path to project source code
- `{cycle_number}` — current 1-based cycle counter
- `{formatted_cycle_number}` — cycle number zero-padded to 3 digits (e.g., cycle 1 → `001`)
- `{cycle_start_commit}` — git commit hash at start of execute phase (null if not a git repo)
- `{cycle_end_commit}` — git commit hash at end of execute phase

**Cycle output**: All review artifacts for this cycle are written via MCP tools using `cycle: {cycle_number}`. The MCP server manages the underlying storage.

## Instructions

### Read Project Configuration

Call `ideate_get_config()` to read project configuration. Hold the response as `{config}`. Use `{config}.agent_budgets.{agent_name}` as the maxTurns value when spawning agents. If `ideate_get_config` is unavailable or returns no agent_budgets, use the agent's frontmatter maxTurns as fallback. Also hold `{config}.model_overrides` — a map of agent name to model string. When spawning any agent, use `{config}.model_overrides['{agent_name}']` as the model parameter if present and non-empty; otherwise use the hardcoded default listed in the spawn instruction.

### Build Shared Context Package

Call `ideate_get_context_package()` — returns the pre-assembled context package. Hold the result as `{context_package}`.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

**GP-14 enforcement**: If an MCP tool call fails, report the error and stop. Do NOT fall back to reading, grepping, or globbing .ideate/ files directly. The MCP abstraction boundary (GP-14) is inviolable — a tool failure is a signal to fix the tool, not to bypass it.

**PPR-based context assembly (optional)**: For reviews scoped to specific artifacts, `ideate_assemble_context` can provide focused, graph-aware context. Call with seed artifact IDs and a token budget. This is useful when reviewing a specific module or feature area rather than the full project. For capstone reviews covering the full project, `ideate_get_context_package` remains the primary context source.

Pass `{context_package}` inline to all reviewer and journal-keeper prompts. Do not provide file paths to reviewers — pass the assembled content directly.

### Determine Review Scope

Determine whether to use **full review** or **differential review**.

Call `ideate_manage_autopilot_state({action: "get"})` and extract `last_full_review_cycle` and `full_review_interval`. Defaults: `last_full_review_cycle` = 0, `full_review_interval` = 3.

**Full review conditions** (any one → use full review):
- `{cycle_number}` is 1
- `({cycle_number} - last_full_review_cycle) >= full_review_interval`
- `{cycle_start_commit}` is null (git unavailable)

**If full review**: Set `{diff_mode}` = `"full"`. Set `{changed_files}` = all source files. Call `ideate_manage_autopilot_state({action: "update", state: {last_full_review_cycle: {cycle_number}}})`. Continue with Generate Review Manifest.

**If differential** (cycles 2+ within the interval):

1. Run `git diff --name-only {cycle_start_commit}..{cycle_end_commit}` in `{project_source_root}`.
   - If the command fails: fall back to full review. Append via `ideate_append_journal`: "Cycle {N}: differential diff failed — falling back to full review. Reason: {error}." Set `{diff_mode}` = `"full"`. Update `last_full_review_cycle`.
   - If no files changed: append via `ideate_append_journal`: "Cycle {N}: no source files changed — review skipped." Set `{last_cycle_findings}` = `{critical: 0, significant: 0, minor: 0}`. Return to controller immediately — do not spawn reviewers.
   - Otherwise: store file list as `{changed_files}`.

2. **Interface boundary detection**: For each file in `{changed_files}`, grep `{project_source_root}` source files for import/require/include statements referencing that file's name (without extension). Add matching files to `{changed_files}`. Best-effort — the full-review safety net covers any gaps.

3. Set `{diff_mode}` = `"differential"`. Store `{prior_cycle_formatted}` = previous cycle number zero-padded to 3 digits.

### Generate Review Manifest

Call `ideate_get_review_manifest()` — returns a pre-built manifest table matching work items to their incremental review verdicts and finding counts.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Call `ideate_write_artifact({type: "cycle_summary", id: "review-manifest", content: {cycle: {cycle_number}, content: {manifest_content}}, cycle: {cycle_number}})` to write the manifest.

If `{diff_mode}` = `"differential"`: filter the manifest to work items whose scope includes at least one file in `{changed_files}`. Include a note: "Differential review — scope: {N} changed files + {M} boundary files."

### Proportional Review Depth

Before spawning reviewers, assess severity and priority for each work item in the review manifest.

For each work item:

1. Read `severity`, `priority`, and `work_item_type` from work item metadata (from `ideate_artifact_query({type: "work_item"})`). If either severity or priority is absent, default to `medium`.

2. **Default**: Spawn all three reviewers (code-reviewer, spec-reviewer, gap-analyst).

3. **If BOTH `severity` AND `priority` are `low`**:
   a. Route to the proxy-human agent:
      > Andon: Work item {WI-NNN} is low severity / low priority ({work_item_type}). Proposing code-reviewer only for this item. Approve reduced review?
   b. If the proxy-human approves: spawn code-reviewer only for this item. Log via `ideate_append_journal`: "Reduced review for {WI-NNN}: low severity + low priority. Spawned code-reviewer only. Proxy-human approved."
   c. If the proxy-human rejects or defers: spawn all three reviewers for this item.
   d. If no proxy-human is available: default to full review (spawn all three reviewers). Do not silently reduce review without confirmation.

4. **Capstone review always uses all reviewers regardless of per-item decisions.** The three-reviewer parallel spawn below covers cross-cutting concerns.

The default behavior (full reviewer set) is unchanged for all work items where severity or priority is not `low`, or where only one of the two is `low`.

### Spawn Three Reviewers in Parallel

Spawn all three simultaneously. Do not wait for one before starting another.

**Differential reviewer additions** (include in all three prompts when `{diff_mode}` = `"differential"`):

> **Differential review scope** — this is cycle {cycle_number}; only a subset of files changed since cycle {prior_cycle_formatted}.
>
> **Changed files** (review these and their direct dependencies):
> {changed_files — one path per line}
>
> **Prior cycle baseline**: Retrieve prior cycle review artifacts via `ideate_artifact_query({type: "cycle_summary", cycle: {prior_cycle_number}})`. Use them as a baseline — findings already present in the prior cycle are known; focus on new or changed issues.
>
> Do not re-examine files outside the changed and boundary file lists unless a change in a listed file directly affects an unlisted file's behavior. If you encounter such a case, note it and include the affected file.

**ideate:code-reviewer**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.code-reviewer` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob, Bash
- Prompt:
  > You are conducting a comprehensive code review of the entire project.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — your index of all work items and incremental review status. Read individual work items and incremental reviews only when investigating specific findings.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on cross-cutting concerns: consistency across modules, patterns spanning multiple work items, integration between components, systemic issues no single-item review could see.
  >
  > **Dynamic testing (comprehensive scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Step 3 — Comprehensive review scope (full project)". Discover the project's test model and run the full test suite. Report test failures per the severity guidance in your agent instructions.
  >
  > Verdict is Fail if there are any Critical or Significant findings or unmet acceptance criteria. Otherwise Pass.
  >
  > Return your complete findings as the final section of your response. Use the standard review output format. Do NOT use the Write tool — return the content in your response.

**ideate:spec-reviewer**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.spec-reviewer` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob
- Prompt:
  > Verify that the implementation matches the plan, architecture, and guiding principles.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Module specs**: Call `ideate_artifact_query({type: "module_spec"})` to retrieve all module specs (if they exist).
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — use as an index. Read individual work items and incremental reviews only when investigating specific findings in their file scope.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on cross-cutting adherence: do all components collectively follow the architecture? Are interfaces consistent across module boundaries? Are guiding principles upheld across the entire codebase?
  >
  > For each guiding principle, state whether it is satisfied or violated. The `## Principle Violations` and `## Principle Adherence Evidence` sections of your output are used for automated convergence checking — ensure both sections are present even if empty.
  >
  > Return your complete findings as the final section of your response. Use the standard review output format. Do NOT use the Write tool — return the content in your response.

**ideate:gap-analyst**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.gap-analyst` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob
- Prompt:
  > Find what is missing from the implementation — things that should exist but do not.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Interview transcript**: Call `ideate_artifact_query({type: "interview"})` to retrieve the most recent interview transcript. If no interviews exist, proceed without interview context.
  >
  > **Module specs**: Call `ideate_artifact_query({type: "module_spec"})` to retrieve all module specs (if they exist).
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — use as an index. Read individual work items and incremental reviews only when investigating specific gaps in their file scope.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on gaps spanning the full project: missing requirements from the interview, integration gaps between components, implicit requirements the project as a whole should meet.
  >
  > Return your complete findings as the final section of your response. Use the standard review output format. Do NOT use the Write tool — return the content in your response.

Wait for all three to complete. After each reviewer returns, extract the findings from the agent's response and write them via MCP:

- After **code-reviewer** returns: call `ideate_write_artifact({type: "cycle_summary", id: "code-quality", content: {cycle: {cycle_number}, reviewer: "code-reviewer", content: <findings from response>}})`.
- After **spec-reviewer** returns: call `ideate_write_artifact({type: "cycle_summary", id: "spec-adherence", content: {cycle: {cycle_number}, reviewer: "spec-reviewer", content: <findings from response>}})`.
- After **gap-analyst** returns: call `ideate_write_artifact({type: "cycle_summary", id: "gap-analysis", content: {cycle: {cycle_number}, reviewer: "gap-analyst", content: <findings from response>}})`.

After writing all three artifacts, verify the writes succeeded before proceeding. For each reviewer (`code-reviewer`, `spec-reviewer`, `gap-analyst`), emit a metric via `ideate_emit_metric({payload: {phase: "6b", agent_type: "{reviewer}", ...}})`. Best-effort only: if the call fails, continue without interruption. **Token and turn count fields**: Set `turns_used`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` to `null` (not extractable from Agent tool responses). **Budget warning**: Currently inactive — activates when hook-based extraction is implemented. Also set `finding_count` to the total findings from the reviewer's output (null if unparseable) and `finding_severities` to `{"critical": N, "significant": N, "minor": N}` (null if unparseable). Set `outcome`, `first_pass_accepted`, and `rework_count` to `null` for all phase `"6b"` entries.

### Spawn Journal-Keeper (After Reviewers Complete)

**ideate:journal-keeper**
- Model: sonnet
- MaxTurns: `{config}.agent_budgets.journal-keeper` (fallback to agent frontmatter default)
- Tools: Read, Grep, Glob
- Prompt:
  > Synthesize the project history into a decision log and open questions list.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Journal**: Call `ideate_artifact_query({type: "journal_entry"})` to retrieve the most recent journal entries (last 20 entries).
  >
  > **Interview transcript**: Call `ideate_artifact_query({type: "interview"})` to retrieve the most recent interview transcript. If no interviews exist, proceed without interview context.
  >
  > **Plan overview**: Call `ideate_artifact_query({type: "overview"})` to retrieve the plan overview.
  >
  > **Review manifest**: Retrieve via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})` — use as an index. Read individual incremental reviews only when cross-referencing specific findings.
  >
  > **Review findings** (read via MCP — call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})` to retrieve the code-quality, spec-adherence, and gap-analysis review artifacts for this cycle).
  >
  > Return your complete output as the final section of your response. Do NOT use the Write tool — return the content in your response.

After the journal-keeper returns, extract the output from the agent's response and write it via MCP: call `ideate_write_artifact({type: "cycle_summary", id: "decision-log", content: {cycle: {cycle_number}, reviewer: "journal-keeper", content: <output from response>}})`.

Then emit a metric via `ideate_emit_metric({payload: {phase: "6b", agent_type: "journal-keeper", ...}})`. Best-effort only: if the call fails, continue without interruption. Set `turns_used`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` to `null` (not extractable from Agent tool responses). Set `finding_count`, `finding_severities`, `outcome`, `first_pass_accepted`, and `rework_count` to `null` for journal-keeper entries.

### Collect Review Findings

Retrieve all four review artifacts via MCP: call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})` to retrieve code-quality, spec-adherence, gap-analysis, and decision-log artifacts for this cycle.

Walk all findings and classify into: Critical, Significant, Minor, Suggestion.

Build `last_cycle_findings` for return to the controller:
- `critical_count`: number of critical findings
- `significant_count`: number of significant findings
- `minor_count`: number of minor findings

### Emit review.complete Hook

After computing `last_cycle_findings`, call `ideate_emit_event` with:
- event: "review.complete"
- variables: { "CYCLE_NUMBER": "{cycle_number}", "FINDING_COUNT": "{total_finding_count}" }

Where `{total_finding_count}` = `critical_count + significant_count + minor_count`. This call is best-effort — if it fails, continue without interruption.

### Emit Quality Summary

Best-effort: if any step below fails, skip it and continue without blocking.

> **Note**: The autopilot review phase does not produce a separate summary artifact (unlike standalone `/ideate:review`). Per-reviewer counts are derived directly from the in-memory reviewer output content. The emitted metric schema is structurally identical to `skills/review/SKILL.md` — the `by_reviewer` derivation method differs only because the summary artifact is not available at this point in the autopilot execution flow.

**Derive counts**:

1. **Severity counts** — use `last_cycle_findings` already computed in "Collect Review Findings":
   - `findings.by_severity.critical`: `last_cycle_findings.critical_count`
   - `findings.by_severity.significant`: `last_cycle_findings.significant_count`
   - `findings.by_severity.minor`: `last_cycle_findings.minor_count`
   - `findings.by_severity.suggestion`: count `### Suggestion` headings across all three reviewer artifact contents
   - `findings.total`: sum of the four severity counts

2. **Per-reviewer counts** — each reviewer uses different heading conventions; parse accordingly from the in-memory artifact content already retrieved in "Collect Review Findings":
   - `findings.by_reviewer.code-reviewer`: count `### C` (critical), `### S` (significant), `### M` (minor) headings in the code-quality artifact content.
   - `findings.by_reviewer.spec-reviewer`: in the spec-adherence artifact content, count `### D` headings as significant; count `### P` headings as significant if the `**Principle Violation Verdict**` line says `Fail`; count `### U` and `### N` headings as minor.
   - `findings.by_reviewer.gap-analyst`: in the gap-analysis artifact content, count occurrences of `**Severity**: Critical` (critical), `**Severity**: Significant` (significant), `**Severity**: Minor` (minor).
   - If an artifact cannot be retrieved, use `{"critical":0,"significant":0,"minor":0}` for that reviewer.

3. **Category counts** — classify each finding into exactly one category using these rules (apply in order):
   - `requirements_missed`: gap-analyst critical/significant findings with words "missing", "absent", "not implemented", "requirement", "not present", "never built", "no implementation", "omitted"
   - `bugs_introduced`: code-reviewer critical and significant findings
   - `principles_violated`: spec-reviewer findings (any severity) mentioning "principle", "violates", "violation", "constraint"
   - `implementation_gaps`: gap-analyst minor findings, or gap-analyst findings with "incomplete", "partial", "not connected", "missing integration"
   - `other`: anything else

4. **work_items_reviewed**: Count distinct work item rows in the review manifest (retrieved via `ideate_artifact_query({type: "cycle_summary", id: "review-manifest", cycle: {cycle_number}})`). Use `null` if the manifest is absent or cannot be parsed.

5. **andon_events**: Call `ideate_artifact_query({type: "journal_entry"})` to retrieve the most recent journal entries (last 20 entries). Count entries for cycle `{cycle_number}` that mention "Andon" (case-insensitive). Default to 0 if journal entries cannot be retrieved.

**Emit the event**: Call `ideate_emit_metric({payload: {timestamp: "<ISO8601>", event_type: "quality_summary", skill: "autopilot", cycle: N, findings: {total: N, by_severity: {critical: N, significant: N, minor: N, suggestion: N}, by_reviewer: {"code-reviewer": {critical: N, significant: N, minor: N}, "spec-reviewer": {critical: N, significant: N, minor: N}, "gap-analyst": {critical: N, significant: N, minor: N}}, by_category: {requirements_missed: N, bugs_introduced: N, principles_violated: N, implementation_gaps: N, other: N}}, work_items_reviewed: N, andon_events: N}})`.

If the call fails, log `quality_summary event skipped: {reason}` and continue. Do not retry.

### Spawn Domain Curator (After Quality Summary Emitted)

**ideate:domain-curator**
- Model: opus
- MaxTurns: `{config}.agent_budgets.domain-curator` (fallback to agent frontmatter default)
- Prompt:
  > Maintain the domain knowledge layer for this project.
  >
  > **Project root**: {project_root}
  > **Cycle number**: {cycle_number}
  > **Review type**: cycle
  >
  > **Review source**: Call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})` to retrieve the code-quality, spec-adherence, gap-analysis, and decision-log review artifacts for this cycle.
  >
  > Follow the domain-curator agent instructions. Extract policy-grade, decision-grade, question-grade, and conflict-grade items from this cycle's review artifacts. **Do not write any artifacts directly.** Return all proposed domain updates as structured content in the final section of your response. For each update, include the artifact type, designation, and the full content.

Wait for the curator to complete. After the curator returns:
1. Parse its response to extract each domain artifact it proposes to write (type, designation, content).
2. For each proposed domain update, call `ideate_write_artifact` with the correct artifact type:
   - For policies: `ideate_write_artifact({type: "domain_policy", id: "P-{N}", content: {...}})`
   - For decisions: `ideate_write_artifact({type: "domain_decision", id: "D-{N}", content: {...}})`
   - For questions: `ideate_write_artifact({type: "domain_question", id: "Q-{N}", content: {...}})`
3. Update the domain index: call `ideate_write_artifact({type: "domain_index", content: {current_cycle: {cycle_number}}})`.
4. Verify that at least one domain artifact was written. If not, note the failure in the journal.

Emit a metric via `ideate_emit_metric({payload: {phase: "6b", agent_type: "domain-curator", ...}})`. Best-effort only: if the call fails, continue without interruption. Set `turns_used`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` to `null` (not extractable from Agent tool responses). Set `finding_count`, `finding_severities`, `outcome`, `first_pass_accepted`, and `rework_count` to `null` for domain-curator entries.

### Archive Cycle (After Domain Curator)

Call `ideate_archive_cycle({cycle_number})` — archives completed work items and findings into the cycle directory. This is equivalent to the standalone review skill's Phase 7.5 archival.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

### Update Journal

Append a review summary via `ideate_append_journal`.

Call `ideate_append_journal("autopilot", {date}, "review_complete", {body})` — appends a structured journal entry atomically.

If the ideate MCP artifact server is not available, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

```markdown
## [autopilot] {date} — Cycle {N} review complete
Critical findings: {N}
Significant findings: {N}
Minor findings: {N}
```

Also append a per-cycle metrics summary:

```markdown
## [autopilot] {date} — Cycle {N} metrics summary
Agents spawned: {N total} ({N} workers, {N} code-reviewers, {N} reviewers)
Total wall-clock: {total_ms}ms
Models used: {list of distinct models}
Slowest agent: {agent_type} — {work_item or "N/A"} — {ms}ms
```

If `ideate_emit_metric` calls failed, note "metrics unavailable" and omit the breakdowns.

### Phase Convergence Check and Project Progress Assessment

This section is invoked by the controller from Phase 6c-ii, after `ideate_get_convergence_status` has confirmed the phase converged. It is NOT run on every cycle — only when the controller invokes it.

**Step 1: Assess project success criteria**

If `{current_project}` is null, set `{project_complete}` = false and skip to Step 2.

Otherwise, retrieve the active project: call `ideate_artifact_query({type: "project", id: "{current_project.id}"})` to get the current project record with its success criteria.

For each criterion in `{project_success_criteria}`:
1. Determine whether it is satisfied by querying the current cycle's review artifacts (call `ideate_artifact_query({type: "cycle_summary", cycle: {cycle_number}})`) and the current work item completion status (call `ideate_get_execution_status()`).
2. A criterion is satisfied if: (a) the relevant work items are all done, AND (b) none of the three cycle review artifacts report any Critical or Significant findings that directly contradict the criterion, AND (c) the spec-adherence artifact confirms the relevant principle or requirement is met.

Set `{project_complete}` = true if ALL criteria are satisfied. Set `{project_complete}` = false if any criterion is unsatisfied.

**Step 2: Identify next horizon items**

Call `ideate_artifact_query({type: "project", id: "{current_project.id}"})` to retrieve the project record. Extract `horizon.next` from the project (the canonical location for phase horizon data). If the project has no `horizon.next` field or it is empty, set `{next_horizon_items}` = [].

Otherwise, set `{next_horizon_items}` = the list of phase entries from `horizon.next`.

**Step 3: Append project progress to journal**

Call `ideate_append_journal("autopilot", {date}, "project_progress", {body})` with:

```markdown
## [autopilot] {date} — Cycle {N} project progress
Phase converged: yes
Project success criteria met: {yes | no | N/A (no active project)}
{If no: list each unsatisfied criterion with a one-line reason}
Next horizon items: {count} — {list of item IDs, or "none"}
Phases completed: {phases_completed + 1}
Appetite: {project_appetite or "N/A"}
```

**Step 4: Return to controller**

Return `{project_complete}` and `{next_horizon_items}` to the controller (Phase 6c-ii).

## Exit Conditions

- Cycle summary artifacts written via MCP: code-quality, spec-adherence, gap-analysis, decision-log
- Review manifest written via `ideate_write_artifact`
- `last_cycle_findings` dict populated with critical, significant, minor counts
- Journal updated with review summary and metrics summary (via `ideate_append_journal`)
- If invoked from 6c-ii: `{project_complete}` and `{next_horizon_items}` returned to controller; journal updated with project progress entry

Return to the controller with `last_cycle_findings`. The controller will run Phase 6c (convergence check).

## Artifacts Written (all via MCP)

- Cycle summaries (code-quality, spec-adherence, gap-analysis, decision-log) — via `ideate_write_artifact`
- Review manifest — via `ideate_write_artifact`
- Journal entries (review summary + metrics summary + project progress) — via `ideate_append_journal`
- Metrics — one entry per agent spawned + quality_summary event, via `ideate_emit_metric`
- Domain layer (policies, decisions, questions) — updated by domain-curator via `ideate_write_artifact`

## Self-Check

Before returning to the controller, verify:

- [x] No `.ideate/` path references in any instruction
- [x] No occurrences of `ideate_get_project_status` in this file
- [x] Phase Convergence Check section is clearly marked as invoked from 6c-ii only (not every cycle)
- [x] Project success criteria assessment uses `ideate_artifact_query` and `ideate_get_execution_status`, not direct file reads
- [x] `{project_complete}` and `{next_horizon_items}` returned to controller after project progress assessment
- [x] Project progress journal entry written via `ideate_append_journal`, not direct file write
- [x] All review artifacts written via `ideate_write_artifact`, not direct file writes
- [x] Domain artifacts written via `ideate_write_artifact` after parsing curator response
