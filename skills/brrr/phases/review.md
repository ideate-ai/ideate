# brrr Phase 6b: Comprehensive Review Phase

## Entry Conditions

Called after Phase 6a (execute.md) completes. All pending work items have been attempted and have incremental reviews.

Available from controller context:
- `{artifact_dir}` — absolute path to the artifact directory
- `{project_source_root}` — absolute path to project source code
- `{cycle_number}` — current 1-based cycle counter
- `{formatted_cycle_number}` — cycle number zero-padded to 3 digits (e.g., cycle 1 → `001`)
- `{cycle_start_commit}` — git commit hash at start of execute phase (null if not a git repo)
- `{cycle_end_commit}` — git commit hash at end of execute phase

**Set the cycle output directory**: `{artifact_dir}/archive/cycles/{formatted_cycle_number}/`. Create it if it does not exist.

## Instructions

### Build Shared Context Package

**Call `ideate_get_context_package`**: Look in your tool list for a tool whose name ends in `ideate_get_context_package` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_get_context_package` or `mcp__plugin_ideate_ideate_artifact_server__ideate_get_context_package`). If not found, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Call it with `({artifact_dir})` — returns the pre-assembled context package. Hold the result as `{context_package}`.

If `ideate_get_context_package` is unavailable, assemble inline:

1. Read `{artifact_dir}/plan/architecture.md`. If ≤300 lines, include in full. If >300 lines, include only the component map section and interface contracts section.
2. Read `{artifact_dir}/steering/guiding-principles.md` in full.
3. Read `{artifact_dir}/steering/constraints.md` in full.
4. Build source code index: Glob source files (exclude test files, generated files, node_modules, .git, dist, build, __pycache__). For each file, detect language from extension and grep for key exports (first 5 per file). Format as a markdown table: `| File | Language | Key Exports |`.
5. Compose as a single markdown document with sections in this order:
   - `## Architecture`
   - `## Guiding Principles`
   - `## Constraints`
   - `## Source Code Index`
   - `## Full Document Paths` (absolute paths to architecture.md, guiding-principles.md, constraints.md)

Hold as `{context_package}` in memory. Pass inline to all reviewer and journal-keeper prompts. Do not provide file paths to reviewers — pass the assembled content directly.

### Determine Review Scope

Determine whether to use **full review** or **differential review**.

Read `last_full_review_cycle` and `full_review_interval` from `{artifact_dir}/brrr-state.md`. Defaults: `last_full_review_cycle` = 0, `full_review_interval` = 3.

**Full review conditions** (any one → use full review):
- `{cycle_number}` is 1
- `({cycle_number} - last_full_review_cycle) >= full_review_interval`
- `{cycle_start_commit}` is null (git unavailable)

**If full review**: Set `{diff_mode}` = `"full"`. Set `{changed_files}` = all source files. Update `{artifact_dir}/brrr-state.md`: `last_full_review_cycle: {cycle_number}`. Continue with Generate Review Manifest.

**If differential** (cycles 2+ within the interval):

1. Run `git diff --name-only {cycle_start_commit}..{cycle_end_commit}` in `{project_source_root}`.
   - If the command fails: fall back to full review. Append to `{artifact_dir}/journal.md`: "Cycle {N}: differential diff failed — falling back to full review. Reason: {error}." Set `{diff_mode}` = `"full"`. Update `last_full_review_cycle`.
   - If no files changed: append to journal: "Cycle {N}: no source files changed — review skipped." Set `{last_cycle_findings}` = `{critical: 0, significant: 0, minor: 0}`. Return to controller immediately — do not spawn reviewers.
   - Otherwise: store file list as `{changed_files}`.

2. **Interface boundary detection**: For each file in `{changed_files}`, grep `{project_source_root}` source files for import/require/include statements referencing that file's name (without extension). Add matching files to `{changed_files}`. Best-effort — the full-review safety net covers any gaps.

3. Set `{diff_mode}` = `"differential"`. Store `{prior_cycle_formatted}` = previous cycle number zero-padded to 3 digits.

### Generate Review Manifest

**Call `ideate_get_review_manifest`**: Look in your tool list for a tool whose name ends in `ideate_get_review_manifest` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_get_review_manifest` or `mcp__plugin_ideate_ideate_artifact_server__ideate_get_review_manifest`). If not found, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Call it with `({artifact_dir})` — returns a pre-built manifest table matching work items to their incremental review verdicts and finding counts.

Write the response as the review manifest to the cycle output directory.

If `{diff_mode}` = `"differential"`: filter the manifest to work items whose scope includes at least one file in `{changed_files}`. Include a note: "Differential review — scope: {N} changed files + {M} boundary files."

### Spawn Three Reviewers in Parallel

Spawn all three simultaneously. Do not wait for one before starting another.

**Differential reviewer additions** (include in all three prompts when `{diff_mode}` = `"differential"`):

> **Differential review scope** — this is cycle {cycle_number}; only a subset of files changed since cycle {prior_cycle_formatted}.
>
> **Changed files** (review these and their direct dependencies):
> {changed_files — one path per line}
>
> **Prior cycle baseline**: The cycle {prior_cycle_formatted} review files are at `{artifact_dir}/archive/cycles/{prior_cycle_formatted}/`. Use them as a baseline — findings already present in the prior cycle are known; focus on new or changed issues.
>
> Do not re-examine files outside the changed and boundary file lists unless a change in a listed file directly affects an unlisted file's behavior. If you encounter such a case, note it and include the affected file.

**code-reviewer**
- Model: sonnet
- MaxTurns: 20
- Tools: Read, Grep, Glob, Bash
- Prompt:
  > You are conducting a comprehensive code review of the entire project.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Review manifest**: {artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md — your index of all work items and incremental review status. Read individual work items and incremental reviews only when investigating specific findings.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on cross-cutting concerns: consistency across modules, patterns spanning multiple work items, integration between components, systemic issues no single-item review could see.
  >
  > Write your findings to: {artifact_dir}/archive/cycles/{formatted_cycle_number}/code-quality.md
  >
  > **Dynamic testing (comprehensive scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Dynamic Testing > Comprehensive review scope". Discover the project's test model and run the full test suite. Report test failures per the severity guidance in your agent instructions.
  >
  > Verdict is Fail if there are any Critical or Significant findings or unmet acceptance criteria. Otherwise Pass.

**spec-reviewer**
- Model: sonnet
- MaxTurns: 25
- Tools: Read, Grep, Glob
- Prompt:
  > Verify that the implementation matches the plan, architecture, and guiding principles.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Module specs**: {artifact_dir}/plan/modules/*.md (if they exist).
  >
  > **Review manifest**: {artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md — use as an index. Read individual work items and incremental reviews only when investigating specific findings in their file scope.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on cross-cutting adherence: do all components collectively follow the architecture? Are interfaces consistent across module boundaries? Are guiding principles upheld across the entire codebase?
  >
  > For each guiding principle, state whether it is satisfied or violated. The `## Principle Violations` and `## Principle Adherence Evidence` sections of your output are used for automated convergence checking — ensure both sections are present even if empty.
  >
  > Write your findings to: {artifact_dir}/archive/cycles/{formatted_cycle_number}/spec-adherence.md

**gap-analyst**
- Model: sonnet
- MaxTurns: 25
- Tools: Read, Grep, Glob
- Prompt:
  > Find what is missing from the implementation — things that should exist but do not.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Interview transcript**: Read `{artifact_dir}/steering/interview.md` if it exists. If not, check `{artifact_dir}/steering/interviews/` — read the most recent `_full.md` file found there (highest refine-NNN directory). If neither exists, proceed without interview context.
  >
  > **Module specs**: {artifact_dir}/plan/modules/*.md (if they exist).
  >
  > **Review manifest**: {artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md — use as an index. Read individual work items and incremental reviews only when investigating specific gaps in their file scope.
  >
  > Project source code is at: {project_source_root} — read source files as needed.
  >
  > Focus on gaps spanning the full project: missing requirements from the interview, integration gaps between components, implicit requirements the project as a whole should meet.
  >
  > Write your findings to: {artifact_dir}/archive/cycles/{formatted_cycle_number}/gap-analysis.md

Wait for all three to complete. Verify their output files exist before proceeding. After each reviewer returns, record a metrics entry with `phase: "6b"` (schema in controller SKILL.md). For reviewer entries (`code-reviewer`, `spec-reviewer`, `gap-analyst`), also set `finding_count` to the total findings from the reviewer's output file (null if unparseable) and `finding_severities` to `{"critical": N, "significant": N, "minor": N}` (null if unparseable). Set `outcome`, `first_pass_accepted`, and `rework_count` to `null` for all phase `"6b"` entries.

### Spawn Journal-Keeper (After Reviewers Complete)

**journal-keeper**
- Model: sonnet
- MaxTurns: 15
- Tools: Read, Grep, Glob
- Prompt:
  > Synthesize the project history into a decision log and open questions list.
  >
  > **Shared context package** (inline — do not re-read architecture, principles, or constraints files individually):
  > {context_package}
  >
  > **Journal**: read only the last 20 entries from {artifact_dir}/journal.md.
  >
  > **Interview transcript**: Read `{artifact_dir}/steering/interview.md` if it exists. If not, check `{artifact_dir}/steering/interviews/` — read the most recent `_full.md` file found there. If neither exists, proceed without interview context.
  >
  > **Plan overview**: {artifact_dir}/plan/overview.md
  >
  > **Review manifest**: {artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md — use as an index. Read individual incremental reviews only when cross-referencing specific findings.
  >
  > - Code quality review: {artifact_dir}/archive/cycles/{formatted_cycle_number}/code-quality.md
  > - Spec adherence review: {artifact_dir}/archive/cycles/{formatted_cycle_number}/spec-adherence.md
  > - Gap analysis: {artifact_dir}/archive/cycles/{formatted_cycle_number}/gap-analysis.md
  >
  > Write your output to: {artifact_dir}/archive/cycles/{formatted_cycle_number}/decision-log.md

After the journal-keeper returns, record a metrics entry with `phase: "6b"`, `agent_type: "journal-keeper"` (schema in controller SKILL.md). Set `finding_count`, `finding_severities`, `outcome`, `first_pass_accepted`, and `rework_count` to `null` for journal-keeper entries.

### Collect Review Findings

Read all four output files:
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/code-quality.md`
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/spec-adherence.md`
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/gap-analysis.md`
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/decision-log.md`

Walk all findings and classify into: Critical, Significant, Minor, Suggestion.

Build `last_cycle_findings` for return to the controller:
- `critical_count`: number of critical findings
- `significant_count`: number of significant findings
- `minor_count`: number of minor findings

### Emit review.complete Hook

After computing `last_cycle_findings`, call `ideate_emit_event` with:
- artifact_dir: {artifact_dir}
- event: "review.complete"
- variables: { "ARTIFACT_DIR": "{artifact_dir}", "CYCLE_NUMBER": "{cycle_number}", "FINDING_COUNT": "{total_finding_count}" }

Where `{total_finding_count}` = `critical_count + significant_count + minor_count`. This call is best-effort — if it fails, continue without interruption.

### Emit Quality Summary

Best-effort: if any step below fails, skip it and continue without blocking.

> **Note**: The brrr review phase does not produce a `summary.md` file (unlike standalone `/ideate:review`). Per-reviewer counts are derived directly from raw reviewer output files. The emitted JSON schema is structurally identical to `skills/review/SKILL.md` — the `by_reviewer` derivation method differs only because `summary.md` is not available at this point in the brrr execution flow.

**Derive counts**:

1. **Severity counts** — use `last_cycle_findings` already computed in "Collect Review Findings":
   - `findings.by_severity.critical`: `last_cycle_findings.critical_count`
   - `findings.by_severity.significant`: `last_cycle_findings.significant_count`
   - `findings.by_severity.minor`: `last_cycle_findings.minor_count`
   - `findings.by_severity.suggestion`: count `### Suggestion` headings across all three reviewer output files
   - `findings.total`: sum of the four severity counts

2. **Per-reviewer counts** — each reviewer uses different heading conventions; parse accordingly:
   - `findings.by_reviewer.code-reviewer`: count `### C` (critical), `### S` (significant), `### M` (minor), `### Suggestion` (suggestion) headings in `{artifact_dir}/archive/cycles/{formatted_cycle_number}/code-quality.md`
   - `findings.by_reviewer.spec-reviewer`: in `{artifact_dir}/archive/cycles/{formatted_cycle_number}/spec-adherence.md`, count `### D` headings as significant; count `### P` headings as significant if the `**Principle Violation Verdict**` line says `Fail`; count `### U` and `### N` headings as minor. Use 0 for suggestion.
   - `findings.by_reviewer.gap-analyst`: in `{artifact_dir}/archive/cycles/{formatted_cycle_number}/gap-analysis.md`, count occurrences of `**Severity**: Critical` (critical), `**Severity**: Significant` (significant), `**Severity**: Minor` (minor). Use 0 for suggestion.
   - If a file cannot be read, use `{"critical":0,"significant":0,"minor":0,"suggestion":0}` for that reviewer.

3. **Category counts** — classify each finding into exactly one category using these rules (apply in order):
   - `requirements_missed`: gap-analyst critical/significant findings with words "missing", "absent", "not implemented", "requirement", "not present", "never built", "no implementation", "omitted"
   - `bugs_introduced`: code-reviewer critical and significant findings
   - `principles_violated`: spec-reviewer findings (any severity) mentioning "principle", "violates", "violation", "constraint"
   - `implementation_gaps`: gap-analyst minor findings, or gap-analyst findings with "incomplete", "partial", "not connected", "missing integration"
   - `other`: anything else

4. **work_items_reviewed**: Count distinct work item rows in `{artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md`. Use `null` if the file is absent or cannot be parsed.

5. **andon_events**: Read the last 20 entries of `{artifact_dir}/journal.md` (or the full file if shorter). Count entries for cycle `{cycle_number}` that mention "Andon" (case-insensitive). Default to 0 if the journal cannot be read.

**Emit the event**: Append one JSON line to `{artifact_dir}/metrics.jsonl`:

```json
{"timestamp":"<ISO8601>","event_type":"quality_summary","skill":"brrr","cycle":<N>,"findings":{"total":<N>,"by_severity":{"critical":<N>,"significant":<N>,"minor":<N>,"suggestion":<N>},"by_reviewer":{"code-reviewer":{"critical":<N>,"significant":<N>,"minor":<N>,"suggestion":<N>},"spec-reviewer":{"critical":<N>,"significant":<N>,"minor":<N>,"suggestion":<N>},"gap-analyst":{"critical":<N>,"significant":<N>,"minor":<N>,"suggestion":<N>}},"by_category":{"requirements_missed":<N>,"bugs_introduced":<N>,"principles_violated":<N>,"implementation_gaps":<N>,"other":<N>}},"work_items_reviewed":<N>,"andon_events":<N>}
```

If the event cannot be written, log `quality_summary event skipped: {reason}` and continue. Do not retry.

### Spawn Domain Curator (After Quality Summary Emitted)

**domain-curator**
- Model: opus
- MaxTurns: 25
- Tools: Read, Write, Glob
- Prompt:
  > Maintain the domain knowledge layer for this project.
  >
  > **Artifact directory**: {artifact_dir}
  > **Review source**: {artifact_dir}/archive/cycles/{formatted_cycle_number}/ — code-quality.md, spec-adherence.md, gap-analysis.md, decision-log.md
  > **Cycle number**: {cycle_number}
  > **Review type**: cycle
  >
  > Follow the domain-curator agent instructions. Extract policy-grade, decision-grade, question-grade, and conflict-grade items from this cycle's review files and update the domains/ layer accordingly.

After the domain-curator returns, record a metrics entry with `phase: "6b"`, `agent_type: "domain-curator"` (schema in controller SKILL.md). Set `finding_count`, `finding_severities`, `outcome`, `first_pass_accepted`, and `rework_count` to `null` for domain-curator entries.

### Archive Cycle (After Domain Curator)

**Call `ideate_archive_cycle`**: Look in your tool list for a tool whose name ends in `ideate_archive_cycle` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_archive_cycle` or `mcp__plugin_ideate_ideate_artifact_server__ideate_archive_cycle`). If not found, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Call it with `({artifact_dir}, {cycle_number})` — archives completed work items and findings into the cycle directory. This is equivalent to the standalone review skill's Phase 7.5 archival.

### Update Journal

Append a review summary to `{artifact_dir}/journal.md`.

**Call `ideate_append_journal`**: Look in your tool list for a tool whose name ends in `ideate_append_journal` (it will be prefixed, e.g. `mcp__ideate_artifact_server__ideate_append_journal` or `mcp__plugin_ideate_ideate_artifact_server__ideate_append_journal`). If not found, stop and report: "The ideate MCP artifact server is required but not available. Verify .mcp.json configuration."

Call it with `({artifact_dir}, "brrr", {date}, "review_complete", {body})` — appends a structured journal entry atomically.

```markdown
## [brrr] {date} — Cycle {N} review complete
Critical findings: {N}
Significant findings: {N}
Minor findings: {N}
```

Also append a per-cycle metrics summary:

```markdown
## [brrr] {date} — Cycle {N} metrics summary
Agents spawned: {N total} ({N} workers, {N} code-reviewers, {N} reviewers)
Total wall-clock: {total_ms}ms
Models used: {list of distinct models}
Slowest agent: {agent_type} — {work_item or "N/A"} — {ms}ms
```

If `metrics.jsonl` could not be written, note "metrics unavailable" and omit the breakdowns.

## Exit Conditions

- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/` contains: code-quality.md, spec-adherence.md, gap-analysis.md, decision-log.md
- `{artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md` written
- `last_cycle_findings` dict populated with critical, significant, minor counts
- Journal updated with review summary and metrics summary

Return to the controller with `last_cycle_findings`. The controller will run Phase 6c (convergence check).

## Artifacts Written

- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/code-quality.md`
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/spec-adherence.md`
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/gap-analysis.md`
- `{artifact_dir}/archive/cycles/{formatted_cycle_number}/decision-log.md`
- `{artifact_dir}/.ideate/cycles/{NNN}/review-manifest.md`
- `{artifact_dir}/journal.md` — appended (review summary + metrics summary)
- `{artifact_dir}/metrics.jsonl` — one entry per agent spawned; quality_summary event appended
- `{artifact_dir}/domains/` — policies, decisions, and questions updated by domain-curator
