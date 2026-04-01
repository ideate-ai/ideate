# Ideate User Guide

A complete reference for using the ideate plugin to manage software projects through structured planning, execution, review, and refinement.

For installation and a 5-minute walkthrough, see [README.md](README.md) and [QUICKSTART.md](QUICKSTART.md).

---

## The SDLC Loop

Ideate follows a repeating cycle:

```
/ideate:init  →  /ideate:execute  →  /ideate:review  →  /ideate:refine  → (repeat)
```

1. **Init** sets up the project — interviews you, researches unknowns, produces an architecture and work items.
2. **Execute** builds the work items, reviewing each one as it completes.
3. **Review** runs a comprehensive multi-perspective evaluation of all completed work.
4. **Refine** plans corrections or new work based on review findings or changed requirements.

The cycle repeats until the review finds no critical or significant issues — that is **convergence**. You can run this loop manually or let `/ideate:autopilot` handle it autonomously.

---

## Projects and Phases

### Projects

A **project** is the top-level container for all work. It has a name, intent (what you're building and why), and an appetite (effort budget as an integer, default 6).

```
/ideate:project show          # View the active project (default)
/ideate:project create        # Create a new project
/ideate:project list          # List all projects
/ideate:project view PR-001   # Detailed view of a specific project
/ideate:project switch PR-002 # Switch active project
/ideate:project pause         # Pause the active project
/ideate:project complete      # Mark project done
/ideate:project archive       # Archive a project
```

### Phases

A **phase** groups related work items within a project. Each phase has a type that signals its purpose:

| Type | Purpose |
|------|---------|
| `research` | Investigation, discovery, reducing unknowns |
| `design` | Architecture, interface design, planning |
| `implementation` | Building, coding, testing |
| `spike` | Time-boxed exploration with a specific question |

```
/ideate:project phase create          # Create a new phase
/ideate:project phase list            # List phases in current project
/ideate:project phase start PH-003   # Activate a phase
/ideate:project phase complete        # Mark current phase done
/ideate:project phase abandon "reason" # Abandon phase with reason
/ideate:project phase reorder         # Reorder horizon phases
```

When you start a new phase while the current one has incomplete work, ideate asks what to do — carry items forward to the new phase or cancel them.

### Horizons

The **horizon** is your roadmap. It lists upcoming phases in order. When a phase completes, `/ideate:refine` promotes the next horizon item to the active phase. You can reorder the horizon with `/ideate:project phase reorder`.

---

## Starting a Project

### New project on an existing codebase

```
/ideate:init
```

Init detects your existing code and runs a lightweight interview to understand what you want to build. It surveys the codebase, asks about your goals and constraints, then produces:

- **Guiding principles** — the rules your project follows
- **Constraints** — technical and process boundaries
- **Architecture** — component map and data flow
- **Work items** — atomic tasks with acceptance criteria

### New project from scratch

```
/ideate:init
```

Without existing code, init runs a full planning interview — deeper questions about technology choices, user experience, data models, and deployment. It may spawn research agents to investigate unfamiliar topics.

---

## Quick Intake with Triage

Not everything needs full planning. `/ideate:triage` creates work items from a single line:

```
/ideate:triage bug: login fails on Safari after OAuth redirect
/ideate:triage feature: add CSV export to reports page
/ideate:triage spike: investigate whether WebSockets can replace polling for real-time updates
/ideate:triage maintenance: upgrade TypeScript to 5.5 and fix type errors
/ideate:triage chore: update dependencies to latest versions
```

Triage auto-detects the work item type and assesses whether the description is clear enough. If it is, it generates a work item immediately and asks for confirmation. If it's ambiguous, it asks 1-2 targeted follow-up questions.

### Work item types

| Type | What it is | How it affects execution |
|------|-----------|------------------------|
| `feature` | New capability | Full context, full review |
| `bug` | Something broken | Focused context, code review only |
| `spike` | Research question | Full context, research-quality review |
| `maintenance` | Infrastructure work | Minimal context, full review |
| `chore` | Cleanup, dependency updates | Minimal context, lighter review possible |

Triage items are created at **intake quality** — they may lack full file scope or detailed acceptance criteria. Run `/ideate:refine` to elaborate them to execution-ready specs before building.

---

## Execution

```
/ideate:execute
```

Execute reads the plan and builds each work item. It presents the execution plan (item list, dependency graph, parallelism mode) and waits for your confirmation before starting.

### How it works

1. Work items are executed in dependency order, potentially in parallel
2. Each completed item gets an **incremental review** immediately (code quality check)
3. Review findings are handled automatically — minor fixes applied silently, significant fixes applied with journal logging
4. Critical issues that can't be resolved from the spec trigger the **Andon cord**

### The Andon cord

If execution hits an issue that the specs and principles don't answer, it stops and asks you. This only happens for genuinely unresolvable problems — not routine decisions. Issues are batched and presented between dependency groups.

### Proportional review

Review depth scales with the work's risk level. The default is full review (all reviewers). When both severity and priority are low, the executor may propose reduced review — but it must log the reasoning and get confirmation first.

---

## Review

```
/ideate:review           # Cycle review (default)
/ideate:review --domain workflow  # Domain-specific review
/ideate:review --full    # Full audit
```

The capstone review spawns three specialized reviewers in parallel:

| Reviewer | Focus |
|----------|-------|
| **code-reviewer** | Correctness, quality, security, test coverage |
| **spec-reviewer** | Does the code match the plan and principles? |
| **gap-analyst** | What's missing that should exist? |

After all three complete, a **journal-keeper** synthesizes their findings into a decision log. Then the **domain curator** distills durable knowledge (policies, decisions, open questions) into the domain layer.

### Convergence

A cycle **converges** when:
- **Condition A**: Zero critical and zero significant findings
- **Condition B**: No guiding principle violations

Both must be true simultaneously. If either fails, a refinement cycle is needed.

### Circuit breaker

If a phase exceeds 5 review cycles without converging, the circuit breaker trips. This prevents infinite loops — it means the phase goal may need restructuring.

---

## Refinement

```
/ideate:refine
```

Refine plans the next cycle of changes. It can be triggered by:
- Review findings that need correction
- New requirements or changed understanding
- Bugs discovered in production

Refine interviews you about what changed, checks whether guiding principles still hold, and produces new work items. It does not re-plan everything — only the delta.

---

## Autonomous Mode

```
/ideate:autopilot
/ideate:autopilot --max-cycles 10   # Override the default cycle limit
```

Autopilot runs the full execute → review → refine loop without interruption until convergence or the cycle limit (default: 20, override with `--max-cycles N`). You step back after confirming the initial plan.

During autopilot:
- Routine decisions are handled automatically
- Andon events go to the **proxy-human** agent, which evaluates against guiding principles and makes binding decisions
- Each cycle's findings, fixes, and decisions are logged in the journal
- Progress is reported at natural pause points

Autopilot stops when:
- **Convergence** — zero critical/significant findings and no principle violations
- **Cycle limit** — max cycles reached without convergence
- **Circuit breaker** — phase cycle budget exhausted
- **Appetite exhausted** — project has consumed its phase budget

---

## Status Views

```
/ideate:status              # Workspace overview (default)
/ideate:status project      # Project deep-dive
/ideate:status phase        # Current phase detail
```

Status is read-only. The MCP server formats the output — the skill just passes through the result.

| View | What it shows |
|------|--------------|
| `workspace` | Cycle number, work item counts, findings, open questions, active project/phase |
| `project` | Project name/intent/appetite, current phase progress, horizon |
| `phase` | Phase name/type/status, work items table with dependencies |

---

## Configuration

```
/ideate:settings                    # Interactive menu
/ideate:settings agents             # Jump to agent budgets
/ideate:settings ppr                # Jump to PPR weights
/ideate:settings spawn              # Jump to spawn mode
/ideate:settings appetite           # Jump to appetite setting
/ideate:settings circuit-breaker    # Jump to circuit breaker threshold
```

Interactive menu for adjusting:

- **Agent budgets** — max turns per agent type (e.g., architect: 160, code-reviewer: 80)
- **Model overrides** — use a different model for specific agents
- **PPR weights** — tune how context is assembled (edge type weights, token budget)
- **Spawn mode** — subagent (default) or teammate (agent teams)
- **Appetite** — project effort budget
- **Circuit breaker** — review cycle threshold per phase

Settings are stored in the project's configuration and persist across sessions.

---

## Key Concepts

### The artifact directory

Ideate stores all project data in `.ideate/` at your project root. This includes work items, findings, policies, decisions, journal entries, and configuration. The data is in YAML format and version-controlled with your code.

You never need to edit these files directly — all access goes through the MCP artifact server, which maintains a SQLite index for fast queries.

### Domain knowledge layer

As your project evolves through cycles, ideate accumulates **domain knowledge**:

- **Policies** — durable rules that future work must follow (e.g., "all MCP write handlers must use atomic patterns")
- **Decisions** — recorded choices with context (e.g., "chose Drizzle ORM for query building because...")
- **Questions** — unresolved issues awaiting investigation

The domain curator maintains this layer after each review cycle. It prevents the same issues from recurring — knowledge persists across context windows.

### PPR context assembly

When executing a work item, ideate uses **Personalized PageRank** to assemble relevant context. Starting from the work item, it walks the artifact graph (dependencies, policies, research, findings) and ranks everything by relevance within a token budget. This means workers get the most relevant context without being overwhelmed.

### Spec sufficiency

A spec is sufficient when two independent runs given the same spec would produce functionally equivalent output. Ideate enforces this at execution time — no work item enters execution until its spec meets this bar. The path to sufficiency involves research, interviews, and iterative refinement.

### Cycles

A **cycle** is one pass through execute → review → (refine if needed). Each cycle has a number, produces findings, and advances the project toward convergence. The cycle history is preserved in the journal and domain layer.

---

## Reporting

```
/ideate:report ./reports/    # Generate markdown report
/ideate:report ./reports/ --pdf  # Generate markdown + PDF
/ideate:report ./reports/ --cycles 3-7  # Scope to cycles 3 through 7
```

Generates project reports with statistics, diagrams, and change summaries. Output is markdown with embedded mermaid diagrams.

---

## Hooks

Hooks let you run shell commands or inject prompts in response to lifecycle events. Configure them in `.ideate/hooks.json`:

```json
{
  "hooks": [
    {
      "event": "work_item.completed",
      "type": "command",
      "value": "curl -X POST https://slack.example.com/webhook -d '{\"text\": \"${WORK_ITEM_ID} completed: ${VERDICT}\"}'",
      "enabled": true
    },
    {
      "event": "review.complete",
      "type": "prompt",
      "value": "Review cycle ${CYCLE_NUMBER} finished with ${FINDING_COUNT} findings.",
      "enabled": true
    }
  ]
}
```

### Available events

| Event | When it fires | Variables |
|-------|--------------|-----------|
| `plan.complete` | After `/ideate:init` or `/ideate:refine` finishes planning | — |
| `work_item.started` | Before a worker begins a work item | `WORK_ITEM_ID`, `WORK_ITEM_TITLE` |
| `work_item.completed` | After a work item passes review | `WORK_ITEM_ID`, `VERDICT` (pass/rework/fail) |
| `review.finding` | When a reviewer emits a finding | — |
| `review.complete` | After capstone review finishes | `CYCLE_NUMBER`, `FINDING_COUNT` |
| `cycle.converged` | When a cycle meets convergence conditions | `CYCLE_NUMBER`, `TOTAL_CYCLES` |
| `andon.triggered` | When execution hits an unresolvable issue | `PHASE`, `REASON` |

### Hook types

- **command** — Runs a shell command via `spawnSync` (no shell interpretation — arguments are parsed and passed directly for security). 30-second timeout.
- **prompt** — Returns a variable-substituted string. Useful for injecting context into agent prompts.

### Variables

Use `${VARIABLE_NAME}` in the `value` field. Variables are substituted before execution. Unrecognized variables are left as-is.

### Disabling hooks

Set `"enabled": false` on any hook to skip it without removing the configuration.

---

## Workflow Summary

| I want to... | Use |
|--------------|-----|
| Start a new project | `/ideate:init` |
| Manage projects and phases | `/ideate:project` |
| Log a bug or quick task | `/ideate:triage` |
| Build planned work items | `/ideate:execute` |
| Review completed work | `/ideate:review` |
| Plan changes or fixes | `/ideate:refine` |
| Run the full loop autonomously | `/ideate:autopilot` |
| Check project status | `/ideate:status` |
| Adjust configuration | `/ideate:settings` |
| Generate a report | `/ideate:report` |
