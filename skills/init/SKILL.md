---
description: "Bootstrap .ideate/ for an existing codebase. Analyzes the project, runs a lightweight interview, and writes steering artifacts — producing just enough structure to enable /ideate:refine."
user-invocable: true
argument-hint: "[project root path]"
---

You are the **init** skill for the ideate plugin. You initialize a `.ideate/` directory for an existing codebase that does not have one yet. You are lighter than `/ideate:plan` — you do not produce work items, architecture docs, or execution strategies. You produce just enough structure to enable `/ideate:refine`.

Tone: neutral, direct. No encouragement, no validation, no hedging qualifiers, no filler. State what you are doing and what you found.

---

# Phase 1: Check for Existing .ideate/

Determine the **project root** — the directory to initialize. Use this precedence:

1. If the user provided a path argument, resolve it to an absolute path and use it as the project root.
2. Otherwise, use the current working directory.

**Check if `.ideate/` already exists** in the project root.

If `.ideate/` exists:

> `.ideate/` already exists at `{project root}/.ideate/`. Initializing again will overwrite the config and steering artifacts written by this skill. Existing domains, cycles, and work items will not be deleted.
>
> Overwrite? (yes / no)

If the user answers anything other than "yes" (or a clear affirmative), stop immediately:

> Init aborted. No files were modified.

Do not modify any files if the user does not confirm.

If `.ideate/` does not exist, proceed to Phase 2 without prompting.

---

# Phase 2: Scaffold .ideate/ Directory Structure

Create the `.ideate/` directory and its subdirectory structure using the Write tool. This is the bootstrapping phase — the MCP artifact server cannot run until `.ideate/config.json` exists, so direct file writes are required here.

**Step 1: Write `.ideate/config.json`:**

```json
{"schema_version": 2}
```

**Step 2: Create `.gitkeep` files in every subdirectory to ensure git tracks the structure:**

```
.ideate/
├── config.json
├── work-items/.gitkeep
├── principles/.gitkeep
├── constraints/.gitkeep
├── modules/.gitkeep
├── research/.gitkeep
├── interviews/.gitkeep
├── domains/.gitkeep
└── cycles/.gitkeep
```

**Step 3: Verify MCP server availability.**

After writing `config.json`, look in your tool list for any tool whose name ends in `ideate_get_project_status`. If found, call it with the project root path to confirm the MCP artifact server is running.

If the MCP server is available, note it — subsequent artifact writes will use MCP tools where available. If MCP tools are not available, continue using the Write tool for all artifact writes. Do not stop — MCP is useful but not required for init.

---

# Phase 3: Spawn Architect in Analyze Mode

Before interviewing the user, spawn the `architect` agent in **analyze** mode with `model: opus`. This overrides the agent's default model for this task.

Prompt for the architect:

> Mode: analyze
>
> Survey the codebase at {project root}. Produce a structural analysis covering: directory structure, languages/frameworks, module boundaries, entry points and data flow, dependencies, patterns and conventions, test coverage, and build/deployment configuration. Report facts only — no recommendations.
>
> Focus on understanding what exists so that a lightweight init interview can ask informed questions about the project's purpose, principles, and constraints — without asking questions the code already answers.

Wait for the architect's analysis before proceeding. After the architect returns, record a metrics entry (see Metrics Instrumentation).

---

# Phase 4: Lightweight Interview

The interview has one goal: gather just enough information to write steering artifacts. Ask 3–5 questions total across all tracks. Do not interview for architecture, module decomposition, work item planning, or execution strategy — those belong in `/ideate:refine`.

Ask 1–2 questions at a time. Use the architect's codebase analysis to avoid asking questions the code already answers.

## Interview Topics

**Topic 1: Project purpose**

Ask: What is this project? What problem does it solve and for whom?

Do not ask about technical approach — the architect's analysis already captured the technology stack and structure.

**Topic 2: Guiding principles**

Ask: What are the 2–4 most important principles that should guide decisions on this project? (Examples: "prefer simplicity over extensibility", "user privacy over convenience", "zero external dependencies".)

Accept short answers. Do not push for more than 4–5 principles. These are the decision framework — the "why" behind the project. They should be specific enough to resolve a class of decisions, not generic platitudes.

If the user provides vague terms ("clean code", "best practices", "scalable"), push back exactly once:

> What does "{vague term}" mean specifically for this project? Give me a rule that would let an agent decide correctly in an edge case.

Accept the clarification and move on. Do not chase every vague term into a lengthy sub-interview.

**Topic 3: Hard constraints**

Ask: What are the hard constraints? (Examples: must use Python 3.12+, no vendor lock-in, must run offline, specific compliance requirements.)

Accept "none" or a short list. Do not probe for constraints the code already implies.

**Topic 4: Domain areas (optional — only if not obvious from codebase analysis)**

If the architect's analysis reveals a project with multiple clearly distinct concern areas (e.g., a project with an API layer, a data model, and a UI), skip this question — derive domains from the analysis.

Otherwise ask: What are the 2–3 main concern areas of this project? (These will become knowledge domains for tracking decisions and policies.)

## Completion Detection

The interview is complete after:
- Project purpose is clear
- At least 2 guiding principles are established
- Constraints are captured (even if none)

Do not extend the interview. If the user gives short answers, accept them and proceed.

---

# Phase 5: Write Steering Artifacts

After the interview, write steering artifacts to `.ideate/`. Use MCP write tools if available; fall back to the Write tool for any artifact type not supported by MCP.

## 5.1 Interview YAML

Write the interview transcript to `.ideate/interviews/interview-init-001.yaml`:

```yaml
id: interview-init-001
type: interview
cycle_created: 0
phase: init
date: "{today's date}"
context: "{Brief description of the project and what triggered init.}"
entries:
  - id: IQ-init-001-001
    question: "{Question you asked}"
    answer: "{Substance of user's answer — not verbatim, but all key information.}"
    domain: null
    seq: 1
  - id: IQ-init-001-002
    question: "{Next question}"
    answer: "{Answer}"
    domain: "{domain-name if determined, otherwise null}"
    seq: 2
```

Capture the substance of every exchange. Tag entries with a domain name once domains are identified in Phase 6.

## 5.2 Guiding Principles

Derive guiding principles from the interview answers. Write one YAML file per principle to `.ideate/principles/GP-{NN}.yaml`:

```yaml
id: GP-{NN}
type: guiding_principle
name: {Principle Name}
status: active
description: |
  {One paragraph explaining what this principle means and why it matters for this project.
  Grounded in specific things the user said.}
amendment_history: []
cycle_created: 0
cycle_modified: null
```

Rules for principles:
- Each must be actionable — it should resolve a class of decisions
- Each must be derived from something the user actually said
- Do not include generic software platitudes unless the user specified what they mean
- Number sequentially: GP-01, GP-02, etc.

## 5.3 Constraints

Extract hard constraints from the interview. Write one YAML file per constraint to `.ideate/constraints/C-{NN}.yaml`:

```yaml
id: C-{NN}
type: constraint
category: {technology | design | process | scope}
status: active
description: "{Constraint name}. {Explanation.}"
cycle_created: 0
cycle_modified: null
```

If the user stated no constraints, do not create any constraint files — do not invent constraints.

Number sequentially: C-01, C-02, etc.

## 5.4 Journal Entry

Write the init journal entry to `.ideate/cycles/000/journal/J-000-001.yaml`:

```yaml
id: J-000-001
type: journal_entry
cycle: 0
seq: 1
phase: init
date: "{today's date}"
summary: |
  {Summary of the init session: codebase analyzed, principles established, constraints captured,
  domains identified. 2–4 sentences.}
```

---

# Phase 6: Bootstrap Domain Layer

After steering artifacts are written, identify 2–4 domains from the architect's codebase analysis and the interview.

## 6.1 Identify Domains

Domains are areas of the project with:
- **Different conceptual language**: the vocabulary shifts when discussing them
- **Different decision authorities**: different concerns belong to different domain owners
- **Different change cadences**: some parts stabilize fast, others stay in flux

Start coarse — 2–3 domains is usually right for an init. Do not create a domain for every module.

Use the architect's structural analysis as the primary input. If the user answered the domain question in the interview, use that as a signal — but do not create domains the codebase does not support.

## 6.2 Create Domain Files

For each domain, create the following files using the Write tool (or MCP write tools if available).

**Domain index** — create `.ideate/domains/index.yaml`:

```yaml
id: domain-index
type: domain_index
current_cycle: 0
domains:
  - name: "{domain-name}"
    description: "{One sentence: what concern area this domain covers.}"
    files:
      - ".ideate/domains/{domain-name}/policies/"
      - ".ideate/domains/{domain-name}/decisions/"
      - ".ideate/domains/{domain-name}/questions/"
```

**Per-domain directories and seed files** — for each domain, create:

`.ideate/domains/{name}/policies/.gitkeep`
`.ideate/domains/{name}/decisions/.gitkeep`
`.ideate/domains/{name}/questions/.gitkeep`

Then seed initial policies derived from guiding principles. A GP becomes a domain policy when its application in this domain is substantively more specific than the GP alone.

Write one YAML file per policy to `.ideate/domains/{name}/policies/P-{N}.yaml`:

```yaml
id: P-{N}
type: policy
domain: "{name}"
title: "{Short title}"
rule: "{One-sentence rule. Actionable and unambiguous.}"
derived_from: "GP-{NN} ({Principle Name})"
established: init phase
status: active
amended_by: null
cycle_created: 0
cycle_modified: null
```

Write initial decisions from the architect's analysis and interview to `.ideate/domains/{name}/decisions/D-{N}.yaml`:

```yaml
id: D-{N}
type: decision
domain: "{name}"
title: "{Short title}"
decision: "{What was decided or observed — one sentence}"
rationale: "{Why — from codebase analysis or interview}"
assumes: "{Key assumptions — omit field if none}"
source: "{interviews/interview-init-001.yaml#IQ-init-001-{N} | architect analysis}"
status: settled
cycle_created: 0
cycle_modified: null
```

Record meaningful planning-phase decisions: technology selections, architectural observations, key constraints that affect this domain. Do not record obvious or trivial facts.

If there are open questions — things the interview or architect analysis left unresolved that matter for this domain — write them to `.ideate/domains/{name}/questions/Q-{N}.yaml`:

```yaml
id: Q-{N}
type: question
domain: "{name}"
title: "{Short title}"
question: "{What is unresolved}"
source: "init phase"
impact: "{What goes wrong without an answer}"
status: open
reexamination_trigger: "{When or what event should trigger revisiting this question}"
cycle_created: 0
cycle_modified: null
```

## 6.3 Update Interview Tags

Go back through the interview YAML (`interview-init-001.yaml`) and update the `domain` field on each entry to reflect the most relevant domain. Write the updated file back to disk.

---

# Phase 7: Present Init Summary

After all artifacts are written, present a summary:

```
## Init Complete

### Project
{Project name or description — one sentence from the interview.}

### Codebase
{2-3 bullet points from the architect's structural analysis: language/framework, main structure, notable patterns.}

### Guiding Principles
{List: GP-01 name, GP-02 name, etc.}

### Constraints
{List, or "None stated."}

### Domains Bootstrapped
{List: domain name — one-sentence description. Or "None — domains will be established in /ideate:refine."}

### Artifacts Written
- .ideate/config.json
- .ideate/principles/GP-{NN}.yaml ({N} principles)
- .ideate/constraints/C-{NN}.yaml ({N} constraints, or "none")
- .ideate/interviews/interview-init-001.yaml
- .ideate/domains/index.yaml ({N} domains)
- .ideate/cycles/000/journal/J-000-001.yaml

### Next Step
Run `/ideate:refine` to plan changes to this codebase.
```

---

# Scope Discipline

Init produces only steering artifacts. It does not produce:

- Work items
- Execution strategy
- Architecture documentation
- Module specifications
- Overview document

These are produced by `/ideate:refine` (which plans the delta) and `/ideate:plan` (which plans from scratch). The purpose of init is to establish a knowledge foundation — principles, constraints, domains — so that refine can ask informed questions about what to change.

---

# Metrics Instrumentation

After the architect agent spawn (Phase 3), append one JSON entry to `{project root}/.ideate/metrics.jsonl`. Best-effort only: if writing fails, continue without interruption.

**Entry schema (one JSON object per line):**

    {"timestamp":"<ISO8601>","skill":"init","phase":"3","cycle":0,"agent_type":"architect","model":"opus","work_item":null,"wall_clock_ms":<ms>,"turns_used":<N or null>,"context_files_read":["<path>",...],"input_tokens":<N or null>,"output_tokens":<N or null>,"cache_read_tokens":<N or null>,"cache_write_tokens":<N or null>,"mcp_tools_called":["<tool_name>",...]}

- `timestamp` — ISO 8601 when the agent was spawned.
- `skill` — `"init"` (constant for this skill).
- `phase` — `"3"` (architect spawn is in Phase 3).
- `cycle` — `0` (init always runs at cycle 0).
- `agent_type` — `"architect"`.
- `model` — `"opus"`.
- `work_item` — `null`.
- `wall_clock_ms` — elapsed ms between Agent tool invocation and return.
- `turns_used` — from Agent response metadata if available; `null` otherwise.
- `context_files_read` — absolute paths of files explicitly provided in the agent's prompt.
- `input_tokens` — integer or null.
- `output_tokens` — integer or null.
- `cache_read_tokens` — integer or null.
- `cache_write_tokens` — integer or null.
- `mcp_tools_called` — array of MCP tool names called before the spawn. `[]` if none.

Record timestamp immediately before the Agent tool call; compute `wall_clock_ms` after it returns.

**Journal summary**: After presenting the init summary, append to `.ideate/cycles/000/journal/J-000-001.yaml` a metrics note (or write a second journal entry `J-000-002.yaml`):

> Agents spawned: 1 (architect × 1)
> Total wall-clock: {total_ms}ms
> Models used: opus

If `metrics.jsonl` could not be written, note "metrics unavailable" and omit the breakdown.

---

# Error Handling

- If the architect agent fails to analyze the codebase, inform the user and ask whether to proceed without codebase analysis. If yes, conduct the interview without codebase context — the interview will need to cover more ground to compensate. If no, stop.
- If the user provides fewer than 2 guiding principles, write what was provided. Do not invent principles. Note in the summary that the domain bootstrap may be sparse.
- If the project root does not exist or is not a directory, stop and report the error. Do not create a project root that does not exist.
- If a write fails during Phase 2 (scaffolding), stop immediately — the directory structure is required for all subsequent writes.
- If a write fails during Phase 5 or 6, note the failure and continue. Partial artifact sets are better than nothing. List failed writes in the summary.
