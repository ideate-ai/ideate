# Ideate

A Claude Code plugin providing a structured SDLC workflow. Ideate takes a rough idea through planning, execution, review, and refinement — accumulating knowledge across cycles in a domain layer so later cycles get faster, not slower.

## Plugin structure

```
agents/          # Specialized agents (code-reviewer, architect, domain-curator, etc.)
skills/          # User-invocable skills (plan, execute, review, refine, brrr)
scripts/         # Utility scripts (validate-specs.sh, migrate-to-optimized.sh)
specs/           # Ideate's own artifact directory — uses the same structure it creates
```

## Skills

| Skill | What it does |
|---|---|
| `/ideate:plan` | Interview → research → architecture → work items → domain bootstrap |
| `/ideate:execute` | Build work items with per-item incremental review |
| `/ideate:review` | Capstone review: cycle (default), `--domain`, `--full`, or natural language scope |
| `/ideate:refine` | Plan the next cycle of changes |
| `/ideate:brrr` | Autonomous execute → review → refine loop until convergence |

## Artifact structure

Skills produce artifacts in a user-specified directory (conventionally `specs/`):

```
specs/
├── manifest.json           # Schema version identifier
├── steering/               # Guiding principles, constraints, research, interviews
├── plan/                   # Architecture, modules, work items, execution strategy
├── journal.md              # Append-only project history
├── archive/
│   ├── incremental/        # Per work-item reviews (written by execute)
│   └── cycles/{NNN}/       # Capstone review suites (written by review)
└── domains/
    ├── index.md            # Domain registry + current cycle number
    └── {name}/             # policies.md, decisions.md, questions.md per domain
```

`archive/` is immutable once written. `domains/` is maintained by the domain-curator agent after each review cycle — it distills policies, decisions, and open questions from the archive with citations back to source files.

## Development workflow

Ideate uses its own workflow to develop itself. The `specs/` directory is the artifact directory for ideate's own planning and review.

- Work items: `specs/plan/work-items/NNN-{name}.md`
- Cycle reviews: `specs/archive/cycles/{NNN}/`
- Domain knowledge: `specs/domains/` (4 domains: workflow, artifact-structure, agent-system, project-boundaries)

To run a review cycle on ideate itself: `/ideate:review specs/`

## Key conventions

- All archive paths are absolute in skill prompts — never relative
- Incremental reviews go to `archive/incremental/`, not `reviews/incremental/`
- The domain curator uses opus; all other agents default to sonnet unless overridden
- `spawn_session` (outpost) is an optional enhancement; Agent tool is the primary spawning mechanism
- `DEFER` (not `DEFERRED`) is the proxy-human deferral signal that brrr checks for
