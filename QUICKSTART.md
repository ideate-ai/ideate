# Ideate Quickstart

Get from idea to working code in 5 minutes.

---

## How Ideate Works (30 seconds)

Ideate is a structured SDLC workflow for Claude Code. You describe what you want, and ideate plans it, builds it, reviews it, and refines it in cycles until it converges.

### Workflow Hierarchy

```
Workspace          — your project directory (contains .ideate/)
  └── Project      — a strategic initiative with success criteria and appetite
       └── Phase   — a thin slice of work (3-6 items) with a specific goal
            └── Cycle    — one pass through execute → review → refine
                 └── Work Item  — a single atomic task with acceptance criteria
```

### How This Maps to Agile/Scrum

| Ideate | Agile/Scrum | Notes |
|--------|-------------|-------|
| Project | Epic / Initiative | Has success criteria and an appetite (max phases) |
| Phase | Sprint | A time-boxed (or scope-boxed) slice of work |
| Cycle | Iteration | One execute → review → refine loop within a phase |
| Work Item | Story / Task | Atomic, has acceptance criteria, non-overlapping scope |
| Andon Cord | Sprint Impediment / Blocker | Issues that require human intervention |
| Capstone Review | Sprint Review + Retrospective | Multi-perspective evaluation after execution |

Ideate also introduces concepts without direct Scrum analogues. **Guiding principles** are high-level requirements that enforce alignment to the project's goals across all decisions. **Domain policies**, **decisions**, and **questions** borrow from Domain-Driven Design — they capture durable knowledge extracted from review cycles so later cycles get faster, not slower.

Key difference: ideate automates the sprint ceremony. The review is run by specialized agents (code-reviewer, spec-reviewer, gap-analyst). The retrospective produces domain policies automatically. You intervene only when the Andon cord is pulled.

---

## 5-Minute Setup

### 1. Install the Plugin

Add ideate to your Claude Code project:

```bash
claude install-plugin /path/to/ideate
```

Or manually add the MCP server to your `.mcp.json`:

```json
{
  "mcpServers": {
    "ideate-artifact-server": {
      "command": "sh",
      "args": ["/path/to/ideate/mcp/artifact-server/start.sh"]
    }
  }
}
```

The `start.sh` wrapper auto-installs dependencies and builds on first run.

### 2. Initialize Your Project

For an **existing codebase**:

```
/ideate:init
```

Ideate surveys your code, asks a few questions, and produces an architecture document, work items, and an execution strategy.

For a **new project** (no code yet):

```
/ideate:init
```

Same command — ideate detects there's no existing code and runs a full planning interview with research.

### 3. Execute

```
/ideate:execute
```

Builds each work item, runs incremental code review after each one, and reports status.

### 4. Review

```
/ideate:review
```

Runs a capstone review with three specialized agents (code quality, spec adherence, gap analysis) plus a journal keeper. Produces a summary with findings by severity.

### 5. Refine (if needed)

If the review found issues:

```
/ideate:refine
```

Plans the fixes as new work items. Then `/ideate:execute` again. Repeat until convergence (zero critical/significant findings).

### 6. Autopilot (optional)

```
/ideate:autopilot
```

Runs the full loop autonomously: execute → review → refine → repeat until convergence or cycle limit.

---

## Key Commands

| Command | What it does |
|---------|-------------|
| `/ideate:init` | Initialize — survey codebase, interview, produce plan |
| `/ideate:execute` | Build work items with per-item review |
| `/ideate:review` | Multi-perspective capstone review |
| `/ideate:refine` | Plan the next cycle of changes |
| `/ideate:autopilot` | Autonomous execute → review → refine loop |
| `/ideate:project` | Manage projects and phases — create, view, switch, pause, complete, archive |
| `/ideate:triage` | Quick work item intake — bugs, features, chores |
| `/ideate:status` | Project status views — workspace, project, or phase |
| `/ideate:settings` | Configure agent budgets, models, spawn mode |
| `/ideate:report` | Generate project report with stats and diagrams |

---

## Tips for Getting Results Quickly

1. **Be specific in the init interview.** The more precise your answers, the better the plan. Vague answers produce vague specs.

2. **Start with `/ideate:init`, not `/ideate:refine`.** Init handles both new and existing codebases. Refine is for changing an existing plan.

3. **Let autopilot run.** For well-specified work, `/ideate:autopilot` handles everything. You only intervene when the Andon cord fires.

4. **Phase your work.** Large projects benefit from thin-slice phases (3-6 items each). Ideate auto-chunks when you have more than 5 work items.

5. **Check the review findings.** Critical and significant findings need attention. Minor findings are auto-fixed. Suggestions are informational.

6. **Use `/ideate:settings` to tune.** Adjust agent budgets if agents run out of turns. Switch to teammate mode for better visibility.

---

## What Ideate Produces

All artifacts live in `.ideate/` in your project root:

- **Work items** — atomic tasks with acceptance criteria
- **Guiding principles** — durable rules governing decisions
- **Domain policies** — specific rules from review findings
- **Cycle summaries** — review results per cycle
- **Journal entries** — chronological project history
- **Metrics** — token usage and agent performance data

---

## Next Steps

- [GUIDE.md](GUIDE.md) — Complete reference for all 10 skills, projects, phases, and the SDLC loop
- [README.md](README.md) — Full documentation with worked examples
- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical reference for the MCP server and agent system
- `/ideate:settings` — Configure agent budgets and spawn mode
