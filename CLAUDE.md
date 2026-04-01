# Ideate

A Claude Code plugin providing a structured SDLC workflow. Ideate takes a rough idea through planning, execution, review, and refinement — accumulating knowledge across cycles in a domain layer so later cycles get faster, not slower.

## Plugin structure

```
agents/          # Specialized agents (code-reviewer, architect, domain-curator, etc.)
skills/          # User-invocable skills (plan, execute, review, refine, autopilot)
scripts/         # Utility scripts (validate-specs.sh, migrate-to-optimized.sh)
.ideate/          # Ideate's own artifact directory — uses the same structure it creates
```

## Skills

| Skill | What it does |
|---|---|
| `/ideate:init` | Initialize a project — auto-detects existing codebase (survey + lightweight interview) vs new project (full interview, research, architecture, work items) |
| `/ideate:execute` | Build work items with per-item incremental review |
| `/ideate:review` | Capstone review: cycle (default), `--domain`, `--full`, or natural language scope |
| `/ideate:refine` | Plan the next cycle of changes |
| `/ideate:autopilot` | Autonomous execute → review → refine loop until convergence |
| `/ideate:project` | Manage projects and phases — create, view, switch, complete, archive |
| `/ideate:triage` | Quick work item intake — bug reports, feature requests, chores |
| `/ideate:status` | Project status views — workspace, project, or phase perspective |
| `/ideate:settings` | Interactive configuration for agent budgets, model overrides, and PPR weights |

## Artifact structure

Skills produce YAML artifacts in `.ideate/`, accessed exclusively through MCP tools:

```
.ideate/
├── config.json              # Schema version, agent budgets, PPR config
├── projects/                # PR-{NNN}.yaml per project
├── phases/                  # PH-{NNN}.yaml per phase (scoped within a project)
├── plan/                    # architecture.yaml, overview.yaml, execution-strategy.yaml
├── steering/                # guiding-principles.yaml, constraints.yaml, research/
├── work-items/              # WI-{NNN}.yaml per work item
├── principles/              # GP-{NN}.yaml per guiding principle
├── constraints/             # C-{NN}.yaml per constraint
├── policies/                # P-{NN}.yaml per domain policy
├── decisions/               # D-{NN}.yaml per domain decision
├── questions/               # Q-{NN}.yaml per domain question
├── interviews/              # refine-{NNN}/ per cycle
├── cycles/                  # {NNN}/ per cycle (findings, journal entries, summaries)
├── modules/                 # Module specs (if used)
└── research/                # RF-*.yaml research findings
```

All artifacts are YAML files with one file per artifact. The domain layer (policies, decisions, questions) is maintained by the domain-curator agent after each review cycle. `cycles/` contains immutable cycle-scoped artifacts (findings, journal entries, summaries).

## Development workflow

Ideate uses its own workflow to develop itself. The `.ideate/` directory is the artifact directory for ideate's own planning and review.

- Work items: `.ideate/work-items/WI-{NNN}.yaml`
- Cycle reviews: `.ideate/cycles/{NNN}/`
- Domain knowledge: `.ideate/policies/`, `.ideate/decisions/`, `.ideate/questions/` (4 domains: workflow, artifact-structure, agent-system, project-boundaries)

To run a review cycle on ideate itself: `/ideate:review`

**Changes to ideate must go through the refinement cycle** (`/ideate:refine` → `/ideate:execute`), not direct code edits. Ideate uses its own structured SDLC workflow for self-development.

## Key conventions

- The domain curator uses opus; all other agents default to sonnet unless overridden
- `spawn_session` (outpost) is an optional enhancement; Agent tool is the primary spawning mechanism
- `DEFER` (not `DEFERRED`) is the proxy-human deferral signal that autopilot checks for

## Self-Check

| Acceptance criterion | Status |
|----------------------|--------|
| `projects/` directory in artifact structure diagram | Done |
| `phases/` directory in artifact structure diagram | Done |
| Zero references to `ideate_get_project_status` | Done — not present |
| Zero references to `ideate_bootstrap_project` | Done — not present |
