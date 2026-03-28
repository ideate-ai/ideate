---
description: "Comprehensive review of completed work. Supports cycle review (default), domain review (--domain name), full audit (--full), and ad-hoc review (natural language scope). Spawns specialized reviewers and the domain curator."
user-invocable: true
argument-hint: "[--domain name | --full | \"natural language scope\"]"
---

You are the **review** skill for the ideate plugin. You coordinate a comprehensive, multi-perspective evaluation of completed work. You are a coordinator — you spawn specialized reviewers and synthesize their findings. You do not do the reviewing yourself.

This is the capstone review — layer 2 of the continuous review architecture. Incremental reviews already caught per-item issues during execution. Your job is cross-cutting concerns that per-item reviews cannot see: cross-module consistency, architectural coherence, integration completeness, overall principle adherence. Account for what incremental reviews already found. Do not duplicate their work.

Two evaluation pillars drive this review:
1. **Requirements fulfillment** (spec-reviewer + gap-analyst): does the output match what was asked?
2. **Technical correctness** (code-reviewer): does it work as written?

Tone: neutral, factual. No encouragement, no validation, no hedging qualifiers. Let severity ratings speak for themselves. If something is wrong, state what is wrong and how severe it is. If everything is acceptable, say so without celebration.

---

# Phase 0: Read Project Configuration

Call `ideate_get_config()` to read project configuration. Hold the response as `{config}`. Use `{config}.agent_budgets.{agent_name}` as the maxTurns value when spawning agents. If `ideate_get_config` is unavailable or returns no agent_budgets, use the agent's frontmatter maxTurns as fallback.

---

# Phase 1: Parse Arguments and Determine Review Mode

## 1.1 Parse Invocation Arguments

Parse the invocation for:

1. **Project root** — Call `ideate_get_config()` to resolve the project root. If a positional argument is provided, pass it as a hint. If none found, ask: "Where is the project root?"

2. **Review mode flags and arguments**:
   - No arguments (beyond project root): **cycle review** (default)
   - `--domain {name}`: **domain review** — load that domain's artifacts, scope reviewers to it
   - `--full`: **full audit** — load all domain artifacts + latest cycle summary + full source tree
   - `--scope "{description}"`: combined with `--domain`, narrows the focus further
   - Any other argument (natural language): **ad-hoc review** — classify intent and select agent set

All MCP tool calls resolve paths internally from the project configuration — the skill never constructs artifact paths.

Validate by calling `ideate_get_project_status` with the resolved path. If the MCP server cannot find artifacts, stop and report the error.

## 1.2 Determine Review Mode

Based on parsed arguments:

| Arguments | Mode | Output location | Curator runs |
|---|---|---|---|
| None | Cycle review | Cycle-scoped output (MCP derives location from cycle number) | Always |
| `--domain {name}` | Domain review | Ad-hoc output (MCP derives location from date + domain name) | If policy/question/conflict-grade findings |
| `--full` | Full audit | Ad-hoc output (MCP derives location from date + "full-audit") | If policy/question/conflict-grade findings |
| Natural language string | Ad-hoc (feature-fit or retrospective) | Ad-hoc output (MCP derives location from date + slug) | If policy/question/conflict-grade findings |

**Slug generation for ad-hoc**: lowercase the natural language argument, replace spaces with hyphens, truncate to 40 characters. E.g., "how does auth fit the current model" becomes `how-does-auth-fit-the-current-model`.

**Date format**: `YYYYMMDD` using today's date.

**Cycle number for cycle reviews**: Call `ideate_get_domain_state()` — the response includes `current_cycle`. Add 1 to get the new cycle number. If the domain state is unavailable, use `001`.

Store the determined mode, cycle number (if applicable), and the slug or scope label for ad-hoc modes.

---

# Phase 2: Load Context (Mode-Aware)

## 2.1 Always load

1. Call `ideate_get_context_package()` — returns architecture, guiding principles, and constraints as a single assembled package. Hold the result as `{context_package}`.
2. Call `ideate_artifact_query({type: "overview"})` — returns the project overview.

## 2.2 Cycle review context

For cycle reviews, additionally load:

5. Call `ideate_get_domain_state()` — returns all domain policies, decisions, and questions across all domains.
6. Current-cycle findings: call `ideate_artifact_query({type: "finding"})` with `filters: { cycle: N }` to load findings from the current cycle. Do NOT load findings from prior cycles — the domain layer already distills them.
7. Call `ideate_artifact_query({type: "work_item"})` — returns all work items. The manifest (Phase 3.5) will index these for reviewers.

Do NOT load all prior cycle archives — the domain layer already distills history.

## 2.3 Domain review context

For `--domain {name}` reviews:

5. Call `ideate_get_domain_state({domains: ["{name}"]})` — returns policies, decisions, and questions for the specified domain.
6. Source files associated with that domain (derive from the domain's decisions — look at file paths mentioned in decision sources and implementation notes).
7. Relevant incremental reviews for those source files.

## 2.4 Full audit context

For `--full` reviews:

5. Call `ideate_get_domain_state()` — returns all domain policies, decisions, and questions across all domains.
6. Call `ideate_artifact_query({type: "cycle_summary"})` — returns the latest cycle summary.
7. Source code (survey via Glob).

Do NOT re-read all raw archive — the domain layer already distills the history.

## 2.5 Ad-hoc (natural language) context

For natural language scope:

5. Call `ideate_get_domain_state()` — returns all domain policies, decisions, and questions across all domains.
6. Architecture is already loaded in 2.1 (from `ideate_get_context_package()`).
7. Source files relevant to the described scope (derive from the description + domain decisions).

## 2.6 Survey Project Source Code

In all modes: use Glob to map the project source tree. Identify source files, directory structure, entry points, test files, and build configuration.

The source code location is determinable from work item file scopes or the architecture document. Read enough source code to form a working mental model of what was built.

## 2.7 Ad-Hoc Artifact Queries

At any point during context loading or review, if you need to search across artifact content by keyword or topic, use `ideate_artifact_query`. Use it to perform ad-hoc queries against the artifact index — for example, searching for all decisions related to a specific domain, finding work items touching a particular file, or locating research notes on a topic. This tool is always available and can reduce manual file reading for exploratory queries.

---

# Phase 3: Ensure Output Location

The MCP server derives output paths internally. The skill does not construct or create directories. Instead, use the appropriate `ideate_write_artifact` call with the review mode's type and scope identifiers:

- **Cycle review**: `ideate_write_artifact({type: "cycle_summary", ...})` with `cycle: N`
- **Domain review**: `ideate_write_artifact({type: "cycle_summary", ...})` with `scope: "domain-{name}"` and `date: "{YYYYMMDD}"`
- **Full audit**: `ideate_write_artifact({type: "cycle_summary", ...})` with `scope: "full-audit"` and `date: "{YYYYMMDD}"`
- **Ad-hoc**: `ideate_write_artifact({type: "cycle_summary", ...})` with `scope: "{slug}"` and `date: "{YYYYMMDD}"`

All reviewer output is written through these MCP calls. The skill never creates directories or constructs file paths.

---

# Phase 3.5: Generate Review Manifest

For **cycle reviews only**, generate a lightweight manifest that reviewers use as an index instead of reading all work items and incremental reviews upfront.

Call `ideate_get_review_manifest()`. It returns a pre-built manifest table matching work items to incremental reviews with verdicts and finding counts. Hold the response as `{manifest_content}`.

Call `ideate_write_artifact({type: "cycle_summary", id: "review-manifest", content: {cycle: N, content: {manifest_content}}})` to persist the manifest.

If this tool call fails, stop and report: "The ideate MCP artifact server is required but not available. Verify MCP configuration."

The manifest is ~2-3 lines per work item. For 50 items, this is ~150 lines vs reading 50 full work item artifacts + 50 review artifacts.

---

# Phase 3.6: Build Shared Context Package

Before spawning reviewers, assemble a single context package document and hold it in memory. This replaces the pattern where each reviewer independently reads the same architecture, principles, and constraints.

Call `ideate_get_context_package()`. It returns the pre-assembled context package. Hold the result as `{context_package}` — it is passed inline to all reviewer prompts.

If this tool call fails, stop and report: "The ideate MCP artifact server is required but not available. Verify MCP configuration."

**Target size**: ~500-800 lines.

**PPR-based context assembly (optional)**: For reviews scoped to specific artifacts, `ideate_assemble_context` can provide focused, graph-aware context. Call with seed artifact IDs and a token budget. This is useful when reviewing a specific module or feature area rather than the full project. For capstone reviews covering the full project, `ideate_get_context_package` remains the primary context source.

---

# Phase 4a: Spawn Three Reviewers in Parallel

Spawn three review agents simultaneously. Each receives the relevant subset of context and has access to the project source code. Use the Agent tool to spawn subagents. If external MCP servers are configured, `spawn_session` may be used as an alternative.

All three agents run in parallel. Do not wait for one to finish before starting another.

## 4.1 code-reviewer

**Agent**: ideate:code-reviewer
**Model**: sonnet
**MaxTurns**: `{config}.agent_budgets.code-reviewer` (fallback to agent frontmatter default)
**Tools**: Read, Grep, Glob, Bash

**Prompt** (adapt to the actual project source location):

> You are conducting a comprehensive code review of the entire project — not a single work item.
>
> **Shared context package** (inline — do not re-read architecture, principles, or constraints individually):
> {context_package}
>
> **Review manifest**: {manifest_content} — your index of all work items and their incremental review status. Read individual work items only when investigating specific findings. Read individual incremental reviews only when you find an issue in the same file scope and need to check whether it was already caught.
>
> Project source code is at: {project source path} — read source files as needed to investigate specific findings.
>
> This is a capstone review. Focus on cross-cutting concerns: consistency across modules, patterns that span multiple work items, integration between components, systemic issues that no single-item review could see.
>
> **Dynamic testing (comprehensive scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Step 3 — Comprehensive review scope (full project)". Discover the project's test model and run the full test suite. Report test failures per the severity guidance in your agent instructions.
>
> Follow the output format defined in your agent instructions. Verdict is Fail if there are any Critical or Significant findings or unmet acceptance criteria. Otherwise Pass.
>
> Return your complete findings as the final section of your response. Use the standard review output format (Verdict, Critical/Significant/Minor Findings sections). Do NOT use the Write tool — return the content in your response.

After this agent returns:
1. Extract the findings content from the agent's response.
2. Call `ideate_write_artifact({type: "cycle_summary", id: "code-quality", content: {cycle: N, reviewer: "code-reviewer", content: <extracted findings>}})` to persist the review.
3. Record a metrics entry (see Metrics Instrumentation).

## 4.2 spec-reviewer

**Agent**: ideate:spec-reviewer
**Model**: sonnet
**MaxTurns**: `{config}.agent_budgets.spec-reviewer` (fallback to agent frontmatter default)
**Tools**: Read, Grep, Glob

**Prompt**:

> Verify that the implementation matches the plan, architecture, and guiding principles.
>
> **Shared context package** (inline — do not re-read architecture, principles, or constraints individually):
> {context_package}
>
> **Module specs**: Call `ideate_artifact_query({type: "module_spec"})` to retrieve all module specs (if they exist — use these for interface contracts).
>
> **Review manifest**: {manifest_content} — use as an index. Read individual work items and incremental reviews only when investigating specific findings in their file scope.
>
> Project source code is at: {project source path} — read source files as needed to investigate specific findings.
>
> This is a capstone review. Focus on cross-cutting adherence: do all components collectively follow the architecture? Are interfaces consistent across module boundaries? Are guiding principles upheld across the entire codebase, not just within individual work items?
>
> Follow the output format defined in your agent instructions. Include all sections even if empty.
>
> Return your complete findings as the final section of your response. Use the standard review output format (Verdict, Critical/Significant/Minor Findings sections). Do NOT use the Write tool — return the content in your response.

After this agent returns:
1. Extract the findings content from the agent's response.
2. Call `ideate_write_artifact({type: "cycle_summary", id: "spec-adherence", content: {cycle: N, reviewer: "spec-reviewer", content: <extracted findings>}})` to persist the review.
3. Record a metrics entry (see Metrics Instrumentation).

## 4.3 gap-analyst

**Agent**: ideate:gap-analyst
**Model**: sonnet
**MaxTurns**: `{config}.agent_budgets.gap-analyst` (fallback to agent frontmatter default)
**Tools**: Read, Grep, Glob

**Prompt**:

> Find what is missing from the implementation — things that should exist but do not.
>
> **Shared context package** (inline — do not re-read architecture, principles, or constraints individually):
> {context_package}
>
> **Interview transcript**: Call `ideate_artifact_query({type: "interview"})` to retrieve the most recent interview (to identify requirements from the original interview).
>
> **Module specs**: Call `ideate_artifact_query({type: "module_spec"})` to retrieve all module specs (if they exist).
>
> **Review manifest**: {manifest_content} — use as an index. Read individual work items and incremental reviews only when investigating specific gaps in their file scope.
>
> Project source code is at: {project source path} — read source files as needed to investigate specific gaps.
>
> This is a capstone review. Focus on gaps that span the full project: missing requirements from the interview that fell through the cracks across all work items, integration gaps between components, infrastructure that no single work item was responsible for, implicit requirements that the project as a whole should meet.
>
> Follow the output format defined in your agent instructions. Include all sections even if empty.
>
> Return your complete findings as the final section of your response. Use the standard review output format (Verdict, Critical/Significant/Minor Findings sections). Do NOT use the Write tool — return the content in your response.

After this agent returns:
1. Extract the findings content from the agent's response.
2. Call `ideate_write_artifact({type: "cycle_summary", id: "gap-analysis", content: {cycle: N, reviewer: "gap-analyst", content: <extracted findings>}})` to persist the review.
3. Record a metrics entry (see Metrics Instrumentation).

Wait for all three reviewers to complete. Verify their outputs were persisted via `ideate_write_artifact` before proceeding.

---

# Phase 4b: Spawn Journal-Keeper (Sequential)

Spawn the journal-keeper only AFTER all three reviewers from Phase 4a have completed and their outputs have been persisted via `ideate_write_artifact`. The journal-keeper depends on these outputs for cross-referencing.

## 4b.1 journal-keeper

**Agent**: ideate:journal-keeper
**Model**: sonnet
**MaxTurns**: `{config}.agent_budgets.journal-keeper` (fallback to agent frontmatter default)
**Tools**: Read, Grep, Glob

**Prompt** (adapt to the actual project source location):

> Synthesize the project's history into a decision log and open questions list.
>
> **Shared context package** (inline — do not re-read architecture or principles individually):
> {context_package}
>
> **Review manifest**: {manifest_content} — use as an index of all work items and their review status. Read individual incremental reviews only when cross-referencing specific findings.
>
> **Journal**: call `ideate_artifact_query({type: "journal_entry"})` to retrieve the most recent journal entries (last 20 entries).
>
> **Plan overview**: call `ideate_artifact_query({type: "overview"})` to retrieve the plan overview.
>
> For cycle reviews, also call `ideate_artifact_query({type: "interview"})` to retrieve the latest interview.
>
> The following three review outputs have been completed by the other reviewers. Retrieve all three for cross-referencing:
> - Code quality review: call `ideate_artifact_query({type: "cycle_summary", id: "code-quality", cycle: N})`
> - Spec adherence review: call `ideate_artifact_query({type: "cycle_summary", id: "spec-adherence", cycle: N})`
> - Gap analysis: call `ideate_artifact_query({type: "cycle_summary", id: "gap-analysis", cycle: N})`
>
> Follow the output format defined in your agent instructions. Build the decision log chronologically. Include cross-references where findings from different reviewers relate to the same concern.
>
> Return your complete decision log as the final section of your response. Do NOT use the Write tool — return the content in your response.

After this agent returns:
1. Extract the decision log content from the agent's response.
2. Call `ideate_write_artifact({type: "cycle_summary", id: "decision-log", content: {cycle: N, reviewer: "journal-keeper", content: <extracted decision log>}})` to persist the decision log.
3. Record a metrics entry (see Metrics Instrumentation).

---

# Phase 5: Collect and Verify Results

After the journal-keeper completes (all four reviewers are now done) and all four outputs have been persisted via `ideate_write_artifact`:

1. Retrieve all four reviewer outputs via MCP:
   - `ideate_artifact_query({type: "cycle_summary", id: "code-quality", cycle: N})`
   - `ideate_artifact_query({type: "cycle_summary", id: "spec-adherence", cycle: N})`
   - `ideate_artifact_query({type: "cycle_summary", id: "gap-analysis", cycle: N})`
   - `ideate_artifact_query({type: "cycle_summary", id: "decision-log", cycle: N})`

2. Verify each artifact contains substantive content. If a reviewer failed to produce output (session timeout, error, empty response), note the failure and proceed with the outputs that do exist. Do not re-run failed reviewers automatically — note the gap in the summary.

---

# Phase 6: Synthesize into Summary

Read all four reviewer outputs and produce a summary artifact. This is the single document that captures the full picture.

## 6.1 Classify All Findings by Severity

Walk through every finding from all reviewers. Classify each into one of four severity levels:

- **Critical**: Will cause failure, data loss, security exposure, or incorrect behavior in normal use. Must be addressed before the project is usable.
- **Significant**: Will cause problems in common scenarios, leaves important functionality incomplete, or violates stated requirements. Should be addressed in the current cycle.
- **Minor**: Affects edge cases, polish, or completeness but does not prevent the project from functioning. Can be deferred with documented rationale.
- **Suggestion**: Improvements that would make the project better but are not problems in the current state.

## 6.2 Map Findings to Sources

Each finding must be mapped to:
- The **source reviewer** that identified it (code-reviewer, spec-reviewer, gap-analyst, or journal-keeper)
- The **guiding principle** it relates to (if applicable)
- The **work item** it relates to (if applicable)

If a finding does not map to any principle or work item, it is a cross-cutting concern. State that explicitly.

## 6.3 Identify Findings Requiring User Input

Separate out findings that require user decisions — questions that cannot be resolved from existing steering documents, architecture, or guiding principles. These are decisions the user must make for the project to move forward correctly.

For each:
- State the finding or question
- Explain why existing context does not resolve it
- State the impact of leaving it unresolved

## 6.4 Propose Refinement Plan (If Warranted)

If there are critical or significant findings, outline what `/ideate:refine` should address. Be specific:

- Which findings should be addressed (reference by finding ID)
- What areas of the codebase are affected
- Whether architecture changes are needed
- Estimated scope (number of work items, rough complexity)

If no critical or significant findings exist, state that no refinement cycle is needed. The project is ready for user evaluation.

## 6.5 Write Summary Artifact

Compose the summary content in memory using this format, then call `ideate_write_artifact({type: "cycle_summary", id: "summary", content: {cycle: N, content: <summary text>}})` to persist it. Do NOT use the Write tool for this artifact.

```markdown
# Review Summary

## Overview
{2-3 sentence assessment of the project's state. Neutral, factual.}

## Critical Findings
- [{source reviewer}] {finding} — relates to: {principle name or work item NNN, or "cross-cutting"}

## Significant Findings
- [{source reviewer}] {finding} — relates to: {principle name or work item NNN, or "cross-cutting"}

## Minor Findings
- [{source reviewer}] {finding} — relates to: {principle name or work item NNN, or "cross-cutting"}

## Suggestions
- [{source reviewer}] {suggestion} — relates to: {principle name or work item NNN, or "cross-cutting"}

## Findings Requiring User Input
- {question} — context: {why this came up, why existing docs do not resolve it}

## Proposed Refinement Plan
{If findings warrant another cycle, outline what /ideate:refine should address with specific scope. If no refinement is needed, state: "No critical or significant findings require a refinement cycle. The project is ready for user evaluation."}
```

Omit severity sections that have no findings. Include the "Findings Requiring User Input" section even if empty (state "None — all findings can be resolved from existing context.").

After writing the summary artifact, call `ideate_emit_event` with:
- event: "review.complete"
- variables: { "CYCLE_NUMBER": "{cycle_number}", "FINDING_COUNT": "{total_finding_count}" }

Where `{total_finding_count}` is the sum of all findings across all severity levels derived from the summary (Critical + Significant + Minor + Suggestions). For ad-hoc and domain reviews where cycle number is not applicable, use `"0"` for `CYCLE_NUMBER`. This call is best-effort — if it fails, continue without interruption.

---

# Phase 7: Spawn Domain Curator

## 7.1 Determine Whether Curator Runs

**Cycle reviews**: always run the curator.

**Ad-hoc reviews** (domain, full audit, or natural language): run the curator only if the review produced at least one finding that is:
- Policy-grade: implies a durable rule future workers must follow
- Question-grade: an unresolved issue with impact if unanswered
- Conflict-grade: contradicts an existing domain policy

Read the summary artifact to make this determination. If no such findings exist, skip to Phase 8 (Update Journal). Note in the journal that the curator was not run.

## 7.2 Spawn Curator

**Pre-screening for conflict signals** (determines model to use):

1. Call `ideate_get_domain_state()`. If no domain state exists (first cycle), skip pre-screening. Use `model: sonnet`.

2. Otherwise:
   a. From the domain state response, extract: policy IDs (P-N pattern), domain names, and file paths mentioned in the policy body.
   b. Retrieve the summary artifact via `ideate_artifact_query({type: "cycle_summary", id: "summary", cycle: N})`. For each Critical or Significant finding, extract: the domain name (if stated) and any file paths referenced.
   c. Check for conflict signals — any of:
      - A finding references the same file path as a path mentioned in an existing policy
      - A finding's domain name matches an existing policy's domain name
      - A finding explicitly recommends changing or removing behavior that a policy prescribes
   d. If any conflict signal is detected: use `model: opus` (full reasoning needed).
   e. If no conflict signals detected: use `model: sonnet` (default for non-conflict curation).

3. Log the model selection decision in the journal entry for this review: which model was chosen and why (conflict detected / no conflict / first cycle).

**Spawn the `ideate:domain-curator`** with the model determined above (this overrides the agent's default model):

Provide:

> Project root: {project_root}
>
> Review type: {cycle | adhoc}
>
> Review source: Retrieve all review outputs for this cycle/scope via `ideate_artifact_query({type: "cycle_summary", cycle: N})`.
>
> Cycle number: {N} (for cycle reviews) or slug: {date-slug} (for ad-hoc reviews)
>
> Process the review output and determine all domain layer updates. Follow your agent instructions to identify new/updated policies, decisions, and questions. **Do NOT use the Write tool to write domain files.** Instead, return all proposed domain updates as structured content in the final section of your response. For each update, include the artifact type, designation, and the full content.

**Wait for the curator to complete.** The curator runs in the foreground because it writes domain artifacts that downstream skills depend on.

After the curator returns:
1. Parse its response to extract each domain artifact it proposes to write (type, designation, content).
2. For each proposed domain update, call `ideate_write_artifact({type: "domain_file", id: "<designation>", content: {content: <artifact content>}})` to persist the artifact via MCP.
3. Record a metrics entry (see Metrics Instrumentation).

## 7.3 After Curator Completes (Cycle Reviews Only)

After writing the curator's domain artifacts via `ideate_write_artifact`:

1. Update the domain index: call `ideate_write_artifact({type: "domain_index", content: {current_cycle: N}})` to set `current_cycle` to the current cycle number N.
2. Verify that at least one domain artifact was written via `ideate_write_artifact`. If not, note the failure in the journal.

---

# Phase 7.5: Archive Completed Work Items (Cycle Reviews Only)

For **cycle reviews only**, after the domain curator completes, archive the current cycle's work items and incremental reviews into the cycle output. This keeps only active/pending work items in the working set.

Call `ideate_archive_cycle({cycle_number})`. It archives completed work items and findings into the cycle-scoped storage.

If this tool call fails, stop and report: "The ideate MCP artifact server is required but not available. Verify MCP configuration."

Verify by calling `ideate_artifact_query` to confirm:
   - Archived work items are accessible under the cycle scope
   - Archived findings are accessible under the cycle scope
   - Only items not completed this cycle remain in the active working set (if any)

After archival, the cycle's artifacts include: the review manifest, archived work items, archived findings, code-quality review, spec-adherence review, gap-analysis review, decision log, and summary.

---

# Phase 7.6: Quality Metrics Event

After the domain curator completes (and after Phase 7.5 archival for cycle reviews), emit a `quality_summary` metric. This is a best-effort operation — if it fails for any reason, skip it and continue to Phase 8 without blocking.

## 7.6.1 Derive Counts from Summary

Retrieve the summary artifact via `ideate_artifact_query({type: "cycle_summary", id: "summary", cycle: N})` (already produced in Phase 6). Derive the following counts from its content:

**Severity counts** — count bullet points under each severity heading:
- `findings.by_severity.critical`: count items under `## Critical Findings`
- `findings.by_severity.significant`: count items under `## Significant Findings`
- `findings.by_severity.minor`: count items under `## Minor Findings`
- `findings.by_severity.suggestion`: count items under `## Suggestions`
- `findings.total`: sum of all four severity counts

**Per-reviewer counts** — each finding line includes a `[reviewer-name]` prefix. Count findings per severity per reviewer:
- `findings.by_reviewer.code-reviewer`: count lines prefixed `[code-reviewer]` in each severity section, separated into `critical`, `significant`, `minor`
- `findings.by_reviewer.spec-reviewer`: same for `[spec-reviewer]`
- `findings.by_reviewer.gap-analyst`: same for `[gap-analyst]`

**Category counts** — classify each finding into exactly one category using these rules, applied in order:
- `requirements_missed`: gap-analyst findings (`[gap-analyst]` prefix) that are critical or significant and describe a missing requirement (look for words like "missing", "absent", "not implemented", "requirement", "not present", "never built", "no implementation", "omitted")
- `bugs_introduced`: code-reviewer (`[code-reviewer]` prefix) critical and significant findings
- `principles_violated`: spec-reviewer (`[spec-reviewer]` prefix) findings (any severity) that describe a principle violation (look for words like "principle", "violates", "violation", "constraint")
- `implementation_gaps`: gap-analyst findings that are minor, or gap-analyst findings describing incomplete coverage or integration (look for words like "incomplete", "partial", "not connected", "missing integration")
- `other`: all findings not matching any of the above categories

**work_items_reviewed**: Count distinct work item numbers referenced in the review manifest content (`{manifest_content}` from Phase 3.5). If the manifest is unavailable, query findings via `ideate_artifact_query`.

**andon_events**: Call `ideate_artifact_query({type: "journal_entry"})` to retrieve the most recent journal entries (last 20 entries). Count entries for the current cycle number N that mention "Andon" (case-insensitive). Use 0 if journal entries cannot be retrieved.

**cycle**: Use the cycle number N determined in Phase 1.2. If not a cycle review (ad-hoc, domain, or full audit), use `null`.

## 7.6.2 Emit the Metric

Call `ideate_emit_metric` with the following payload:

```json
{"timestamp":"<ISO8601>","event_type":"quality_summary","skill":"review","cycle":<N>,"findings":{"total":<N>,"by_severity":{"critical":<N>,"significant":<N>,"minor":<N>,"suggestion":<N>},"by_reviewer":{"code-reviewer":{"critical":<N>,"significant":<N>,"minor":<N>},"spec-reviewer":{"critical":<N>,"significant":<N>,"minor":<N>},"gap-analyst":{"critical":<N>,"significant":<N>,"minor":<N>}},"by_category":{"requirements_missed":<N>,"bugs_introduced":<N>,"principles_violated":<N>,"implementation_gaps":<N>,"other":<N>}},"work_items_reviewed":<N>,"andon_events":<N>}
```

- `timestamp`: ISO 8601 timestamp at the moment of emission.
- `event_type`: the string `"quality_summary"` (constant).
- `skill`: the string `"review"` (constant).
- `cycle`: integer cycle number N, or `null` for non-cycle reviews.
- All count fields: integers derived from 7.6.1.

## 7.6.3 Best-Effort Clause

If count derivation fails (e.g., summary artifact is missing, cannot be parsed, or the format does not match expected headings), or if the metric cannot be emitted, skip the quality_summary metric entirely and proceed to Phase 8 without interruption. Log `quality_summary metric skipped: {reason}` in the output so the user is aware.

Do not retry. Do not block the review on this step.

---

# Phase 8: Update Journal

Append a review journal entry via `ideate_append_journal`. This is strictly append — do not modify any existing entries.

Call `ideate_append_journal` with `("review", {date}, {entry_type}, {body})`. It appends a structured journal entry atomically.

If this tool call fails, stop and report: "The ideate MCP artifact server is required but not available. Verify MCP configuration."

The journal body format:

```markdown
## [review] {today's date} — Comprehensive review completed
Critical findings: {N}
Significant findings: {N}
Minor findings: {N}
Suggestions: {N}
Items requiring user input: {N}
Curator: {ran | skipped — no policy-grade findings}
```

Count findings from the summary, not from individual reviewers (to avoid double-counting findings that appear in multiple reviewer outputs).

---

# Phase 9: Present Findings to User

Present the review results to the user. Structure the presentation as follows:

## 9.1 Top-Level Assessment

State the overall verdict:
- If any critical findings exist: the project has critical issues that must be resolved.
- If significant findings exist but no critical: the project functions but has notable issues.
- If only minor findings and suggestions: the project meets its stated requirements.

State the finding counts by severity.

Work items reviewed: {N} (from review manifest)

## 9.2 Critical and Significant Findings

Present each critical and significant finding with enough context for the user to understand the issue without reading the full review artifacts. Include:
- What the problem is
- Where it is (file references)
- Which principle or work item it relates to
- The reviewer's suggested resolution

## 9.3 Findings Requiring User Decisions

For each finding that requires user input, present it as a clear question. Explain the context, the options (if identifiable), and the impact of each option.

Wait for the user to respond to each decision point. Record their answers.

## 9.4 Record User Decisions in Journal

After the user has responded to decision points, append their decisions via `ideate_append_journal`:

```markdown
## [review] {today's date} — User decisions recorded
- {Question}: {User's answer}
- {Question}: {User's answer}
```

## 9.5 Minor Findings and Suggestions

Briefly summarize minor findings and suggestions. Tell the user they are documented in the review artifacts for reference. Do not walk through each one unless the user asks.

## 9.6 Refinement Recommendation

If the summary includes a proposed refinement plan:

- Present the recommendation: "The review identified {N} critical and {N} significant findings. A refinement cycle is recommended to address them."
- Summarize what the refinement would cover.
- Suggest the next step: `/ideate:refine` with specific scope description.

If no refinement is needed:

- State: "No refinement cycle is needed. The project meets its stated requirements."
- Suggest the user evaluate the output directly.

---

# Metrics Instrumentation

After each agent spawn (via the Agent tool), emit one metric entry via `ideate_emit_metric`. Best-effort only: if the call fails, continue without interruption.

**Payload schema (one call per agent spawn):**

```json
{"timestamp":"<ISO8601>","skill":"review","phase":"<id>","cycle":null,"agent_type":"<type>","model":"<model>","work_item":null,"wall_clock_ms":<ms>,"turns_used":<N or null>,"context_files_read":["<path>",...],"input_tokens":<N or null>,"output_tokens":<N or null>,"cache_read_tokens":<N or null>,"cache_write_tokens":<N or null>,"mcp_tools_called":["<tool_name>",...],"finding_count":<N or null>,"finding_severities":{"critical":<N>,"significant":<N>,"minor":<N>} or null}
```

- `timestamp` — ISO 8601 when the agent was spawned.
- `skill` — `"review"` (constant for this skill).
- `phase` — phase identifier (e.g., `"4a"`, `"4b"`, `"7.2"`).
- `agent_type` — the agent definition name (e.g., `"code-reviewer"`, `"spec-reviewer"`, `"gap-analyst"`, `"journal-keeper"`, `"domain-curator"`).
- `model` — model string passed to Agent tool (e.g., `"sonnet"`, `"opus"`).
- `work_item` — `null` (review skill agents are not tied to individual work items).
- `wall_clock_ms` — elapsed ms between Agent tool invocation and return.
- `turns_used` — integer extracted from `tool_uses` in the Agent response `<usage>` block. This is the proxy for turns used. Extract it after each Agent tool call returns. If not available, set to `null`. Do NOT leave as `null` if the usage block is present — extract the integer value.
- `context_files_read` — absolute file paths explicitly provided in the agent's prompt.
- `input_tokens` — integer or null. Input token count from agent response metadata. Null if not available.
- `output_tokens` — integer or null. Output token count from agent response metadata. Null if not available.
- `cache_read_tokens` — integer or null. Prompt caching read tokens if available. Null if not available.
- `cache_write_tokens` — integer or null. Prompt caching write tokens if available. Null if not available.
- `mcp_tools_called` — array of strings. Names of MCP tools called to assemble context for this agent spawn (e.g., `["ideate_get_context_package", "ideate_get_work_item_context"]`). Empty array `[]` if no MCP tools were called.
- `finding_count` — optional (null if not available). For reviewer spawns (`code-reviewer`, `spec-reviewer`, `gap-analyst`): total number of findings across all severities produced by that reviewer. Null for `journal-keeper` and `domain-curator` entries, and null if the reviewer output cannot be parsed.
- `finding_severities` — optional (null if not available). For reviewer spawns: object with keys `critical`, `significant`, `minor` and integer values derived from parsing the reviewer's output. Null for `journal-keeper` and `domain-curator` entries, and null if the output cannot be parsed.

Before each Agent tool call, record which MCP tool calls (if any) were made to assemble context for that spawn. Include the tool names in the `mcp_tools_called` array. If no MCP tools were called, use an empty array `[]`.

Extract from agent response metadata if available. Set to null if token counts are not available in the response.

Record timestamp immediately before the Agent tool call; compute `wall_clock_ms` after it returns.

**Turns tracking and budget warning**: After each Agent tool call returns, extract `tool_uses` from the response `<usage>` block as `turns_used`. Use the maxTurns value from `{config}.agent_budgets` for each agent type (`code-reviewer`, `spec-reviewer`, `gap-analyst`, `journal-keeper`, `domain-curator`). If config was not loaded or the agent type is not present in `agent_budgets`, use the agent's frontmatter default. After recording the metric, if `turns_used` is non-null and the agent's maxTurns is known, compute the utilization: `turns_used / maxTurns`. If utilization > 0.80, append a warning to the Phase 8 journal entry (via `ideate_append_journal`):

> Agent {agent_type} used {turns_used}/{maxTurns} turns ({pct}%) — near budget limit

where `{pct}` is `round(turns_used / maxTurns * 100)`. This warning is best-effort — if the journal call fails, continue without interruption.

**Journal summary**: In Phase 8 (Update Journal), append via `ideate_append_journal` after the review entry:

> ## [review] {date} — Metrics summary
> Agents spawned: {N total} (code-reviewer, spec-reviewer, gap-analyst, journal-keeper, {curator if run})
> Total wall-clock: {total_ms}ms
> Models used: {list of distinct models}
> Slowest agent: {agent_type} — {ms}ms

If metrics could not be emitted, note "metrics unavailable" and omit the breakdown.

---

# Error Handling

## Subagent spawning unavailable

If the Agent tool is not available for spawning subagents, you cannot run reviewers in parallel. In this case, run all four reviews yourself, sequentially, following each agent's instructions. Write the output artifacts via `ideate_write_artifact` as you go. This is slower but produces the same artifacts. Maintain the Phase 4a/4b ordering: run code-reviewer, spec-reviewer, and gap-analyst first, then run journal-keeper last so it can cross-reference the other three outputs.

When reviewing sequentially yourself, follow each agent's checklist and output format exactly. Do not blend concerns — keep code quality, spec adherence, gap analysis, and decision synthesis in separate outputs. The separation is the point.

## Reviewer fails or times out

If a reviewer session fails or times out:
1. Note the failure in the summary ("code-quality review was not completed due to {reason}").
2. Proceed with the outputs that do exist.
3. Do not attempt to re-run the failed reviewer automatically. The user can re-run `/ideate:review` if they want a complete set.
4. Missing reviewer output means the summary will have blind spots. State which evaluation pillar is affected (requirements fulfillment or technical correctness).

## Missing artifacts

- Missing findings for the current cycle: proceed without them. The capstone review does not depend on incremental findings existing — it accounts for them when they do.
- Missing work items: this suggests execution was incomplete. Note this in the summary as a significant finding.
- Missing steering documents (beyond the required principles and overview): note the absence and review against whatever context is available.

## Curator fails

If the domain-curator agent fails to produce output:
1. Note the failure in the journal
2. Do not block the review presentation — continue to Phase 9
3. Note in the summary that domain artifacts were not updated this cycle
4. The user can re-run the curator manually by spawning the `ideate:domain-curator` agent directly

## No source code found

If the project source code cannot be located from the plan artifacts, ask the user:

> I cannot determine where the project source code is from the plan artifacts. What is the path to the project source code?

Do not proceed with the review without access to the source code. The review requires reading actual implementation, not just plan artifacts.

---

# Self-Check

Before completing this skill, verify all of the following:

1. **No artifact path references**: The skill contains zero references to paths like `.ideate/`, `.ideate/cycles/`, `.ideate/domains/`, `.ideate/work-items/`, or any other filesystem paths under the artifact directory. All artifact access goes through MCP tools.
2. **No filename references**: The skill does not reference filenames like `review-manifest.yaml`, `code-quality.yaml`, `spec-adherence.yaml`, `gap-analysis.yaml`, `decision-log.yaml`, `summary.yaml`, `metrics.jsonl`, `index.yaml`, or any other artifact filenames. Artifacts are referenced by type and designation.
3. **Output location via MCP**: Output locations are derived by the MCP server from type, cycle number, scope, and date parameters passed to `ideate_write_artifact`. The skill never constructs directory paths.
4. **Review manifest via tool**: The review manifest is retrieved via `ideate_get_review_manifest()`, not by reading a file path.
5. **Reviewer outputs by type/id**: Reviewer outputs are retrieved via `ideate_artifact_query({type: "cycle_summary", id: "...", cycle: N})`, not by reading file paths.
6. **Metrics via ideate_emit_metric**: All metric emissions use `ideate_emit_metric` with a payload object. No direct file appends.
7. **Domain check via MCP**: Domain existence and state are checked via `ideate_get_domain_state()`, not by checking filesystem existence.
8. **Review orchestration preserved**: The phase structure, reviewer spawn order (4a parallel, 4b sequential), curator logic, archival, and user presentation remain unchanged from the original.
