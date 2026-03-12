# Ideate

A Claude Code plugin for structured LLM-assisted software development. Ideate takes a rough idea and produces exhaustively detailed specs, executes them with continuous review, and accumulates knowledge across refinement cycles — so later cycles get faster and more accurate, not slower.

The core loop: **plan → execute → review → refine → repeat**. A domain knowledge layer makes this loop sustainable over many cycles by distilling decisions, policies, and open questions into a searchable, citeable index that grows more useful with each iteration.

---

## Installation

```bash
claude plugin add /path/to/ideate
```

Or clone the repository and add it manually to your Claude Code plugin search path.

**Prerequisites**: [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on PATH.

---

## Commands

| Command | Description |
|---|---|
| `/ideate:plan` | Interview → research → architecture → work items → domain bootstrap |
| `/ideate:execute` | Build work items with per-item incremental review |
| `/ideate:review` | Capstone review: cycle (default), domain, full audit, or ad-hoc |
| `/ideate:refine` | Plan the next cycle of changes from review findings or new requirements |
| `/ideate:brrr` | Autonomous loop: execute → review → refine until convergence |

---

## Artifact Directory Structure

All artifacts live in one directory (conventionally `specs/` in the project root, but user-configurable). The structure below is the full layout after several cycles.

```
{artifact-dir}/
│
├── steering/                          # User intent and constraints — never auto-modified
│   ├── guiding-principles.md          # Decision framework derived from planning interview
│   ├── constraints.md                 # Hard non-negotiable boundaries
│   ├── research/                      # Background research from researcher agents
│   │   └── {topic-slug}.md
│   └── interviews/                    # Per-cycle, per-domain interview files
│       ├── plan/                      # Planning interview, split by domain after domain creation
│       │   ├── _full.md               # Compiled transcript (human reading only, never loaded)
│       │   ├── _general.md            # Pre-domain and cross-cutting questions
│       │   └── {domain-name}.md       # Questions tagged to a specific domain
│       └── refine-{NNN}/              # One directory per refinement cycle
│           ├── _general.md
│           └── {domain-name}.md
│
├── plan/                              # Specs produced by /ideate:plan
│   ├── overview.md                    # Project description and component summary
│   ├── architecture.md                # Component map, data flow, interface contracts
│   ├── modules/                       # Per-module specs (projects with 5+ modules)
│   │   └── {module-name}.md
│   ├── execution-strategy.md          # Parallelism, ordering, agent configuration
│   └── work-items/                    # Atomic executable tasks
│       └── NNN-{name}.md
│
├── journal.md                         # Append-only project history
│
├── archive/                           # All generated artifacts — immutable once written
│   ├── incremental/                   # Per work-item reviews from /ideate:execute
│   │   └── NNN-{name}.md
│   ├── cycles/                        # Capstone review suites, one directory per cycle
│   │   └── {NNN}/
│   │       ├── code-quality.md
│   │       ├── spec-adherence.md
│   │       ├── gap-analysis.md
│   │       ├── decision-log.md
│   │       └── summary.md
│   └── adhoc/                         # Targeted and ad-hoc review outputs
│       └── {YYYYMMDD-slug}/
│           └── review.md
│
└── domains/                           # Distilled knowledge — summaries + citations to archive/
    ├── index.md                        # Domain registry, current cycle number, scope descriptions
    └── {domain-name}/
        ├── policies.md                 # Durable rules: what future workers must follow
        ├── decisions.md               # Decisions: brief summary + archive citation per decision
        └── questions.md               # Open and resolved questions + archive citations
```

---

## The Domain Layer

### What domains are

Domains are knowledge units — areas of the project with distinct conceptual language, different decision authorities, or different change cadences. They are not the same as code modules. A domain like `data-model` might span multiple code modules; a code module might touch two domains.

Typical project: 2–4 domains. Start coarse. Signals to split a domain:
- More than 10 decisions in one domain after the first review cycle
- A cluster of questions that does not relate to the other decisions in that domain
- A new stakeholder group emerges with a distinct subset of concerns

### The three domain files

**`policies.md`** — Durable rules that future workers must follow. A policy must be:
- **Actionable**: stateable as a rule ("all database access uses the shared connection pool")
- **Durable**: expected to hold going forward, not provisional to one cycle
- **Future-applicable**: relevant to work that does not exist yet
- **Non-obvious**: not already captured by a guiding principle

```markdown
## P-7: Database connection pooling
All database access uses the shared connection pool. No direct connections.
- **Derived from**: GP-2 (Minimal Inference), GP-8 (Durable Knowledge Capture)
- **Established**: cycle 003, decision D-15
- **Status**: active
```

**`decisions.md`** — A registry of significant choices, each with enough rationale to apply correctly in edge cases. Entries cite the archive for deep dives.

```markdown
## D-15: Connection pooling required
- **Decision**: All database access uses the shared connection pool. Direct connections prohibited.
- **Rationale**: Connection exhaustion observed at 50 concurrent users in cycle 002 load tests.
  Shared pool prevents resource leaks under concurrency without per-request overhead.
- **Assumes**: Max ~100 concurrent users (per interview constraints). Revisit if this changes.
- **Source**: archive/cycles/003/code-quality.md#C3
- **Policy**: policies.md#P-7
- **Status**: settled
```

**`questions.md`** — Open and resolved questions. Open questions represent gaps where uncertainty has impact; resolved questions preserve the reasoning that closed them.

```markdown
## Q-12: Pool size under high write load
- **Question**: Is the default pool size (20) sufficient for the projected write throughput?
- **Source**: archive/cycles/003/gap-analysis.md#G-8
- **Impact**: Degraded write performance if pool exhausts under peak load.
- **Status**: open
- **Reexamination trigger**: if write throughput requirements increase beyond current estimates
```

### GP → domain policy derivation

Guiding principles (`steering/guiding-principles.md`) are universal. They apply across all domains equally. A GP becomes a domain policy when its application in a specific domain is substantively more specific than the GP alone — when the domain-specific rule is more actionable than "follow GP-N."

Example: GP-8 ("Durable Knowledge Capture") applies everywhere. In the `data-model` domain, it generates policy P-3 ("every schema migration must have a corresponding rollback procedure documented in decisions.md before the migration runs"). That specificity is the domain policy. The GP stays universal.

If the GP applies identically everywhere, it stays a GP and does not generate domain policies.

### Domain granularity

A project should have 2–4 domains after planning. This is coarser than you might expect. Prefer domains that last across many refinement cycles over fine-grained domains that only exist for one.

Cross-cutting concerns (things that genuinely span all domains, like logging conventions or error propagation rules) stay in guiding principles, not in any domain.

---

## The Archive

`archive/` is the immutable audit trail. Everything written there is permanent — agents read from it, never modify it.

- **`archive/incremental/`** — Per work-item code reviews written by `/ideate:execute` as each work item completes. Named `NNN-{name}.md` to match the work item.
- **`archive/cycles/{NNN}/`** — Full capstone review suite from each `/ideate:review` cycle. One directory per cycle, numbered sequentially.
- **`archive/adhoc/{date-slug}/`** — Targeted and ad-hoc review outputs from non-cycle `/ideate:review` invocations.

**Archive vs. domain files**: The archive is the canonical record. The domain files are the distilled index. An agent reading `decisions.md` gets the essential facts; it follows the archive citation when full context is needed. Content is never duplicated between layers. If you see the same text in both a domain file and an archive file, something went wrong.

**Tracing a policy to its origin**: every domain policy (`P-N`) links to the decision that established it (`D-N`), which links to an archive file and finding ID. The chain: `policies.md#P-7` → `decisions.md#D-15` → `archive/cycles/003/code-quality.md#C3` → the original finding text.

---

## Interview Structure

### Per-cycle, per-domain files

Planning and refinement interviews are split into per-domain files after domain creation. This keeps context loading precise: a feature-fit review on API contracts loads only `interviews/plan/api-contracts.md` and `interviews/refine-*/api-contracts.md` — not the full interview history.

```
steering/interviews/
├── plan/
│   ├── _full.md              # Complete transcript — human reading, never auto-loaded
│   ├── _general.md           # Pre-domain and cross-cutting questions
│   ├── architecture.md       # Questions tagged to architecture domain
│   └── data-model.md         # Questions tagged to data-model domain
├── refine-001/
│   ├── _general.md
│   └── api-contracts.md
└── refine-002/
    └── ...
```

`_full.md` is for human reading and reference. Skills load the domain-specific files and `_general.md` — not `_full.md`.

### When files are created

**Plan interview**: Conducted as a single conversation. After domain creation, the plan phase splits it into per-domain files, adding question IDs and domain tags (`<!-- domains: architecture, data-model -->`). `_full.md` is the original transcript preserved for readability.

**Refine interviews**: Same process — conducted as one conversation, then split by the domain curator after the cycle review.

### Citations

Domain `decisions.md` entries reference specific interview questions:
```
- **Source**: steering/interviews/plan/data-model.md#Q3
```

### Context loading by skill

| Skill | Interview context loaded |
|---|---|
| `/ideate:plan` | `interviews/plan/_general.md` + all domain files as created |
| `/ideate:execute` | Not loaded directly — workers receive domain policies instead |
| `/ideate:review` (cycle) | Curator reads current-cycle interview files for splitting |
| `/ideate:refine` | Current-cycle refine files + prior cycles' domain-matched files |
| Feature-fit review | Domain-matched interview files for relevant domains only |

---

## The Domain Curator

The domain curator (`agents/domain-curator.md`) is a dedicated agent that maintains the domain layer. It runs automatically at the end of each review cycle.

### When it runs

- **After cycle reviews**: always.
- **After ad-hoc reviews**: only if the review produced policy-grade, question-grade, or conflict-grade findings.

### What it does

1. Reads completed review output files
2. Reads existing domain files and `domains/index.md`
3. Reads `steering/guiding-principles.md`
4. Classifies each finding/decision by domain and grade
5. Appends to `decisions.md` for each relevant domain
6. Promotes policy-grade decisions to `policies.md`
7. Updates `questions.md` (marks resolved, appends new)
8. Creates new domain directories when a distinct cluster emerges
9. Flags conflicts rather than silently updating policies

### Policy-grade threshold

A decision becomes a policy only if it meets all four criteria:
1. **Actionable** — stateable as a rule a worker can follow
2. **Durable** — expected to hold going forward, not provisional to this cycle
3. **Future-applicable** — relevant to work items that don't exist yet
4. **Non-obvious** — not already captured by an existing guiding principle or active policy

### Policy conflicts

When a finding contradicts an existing active policy:
1. The existing policy status is set to `provisional — under review`
2. The contradicting decision is recorded in `decisions.md` with status `provisional`
3. A new entry is added to `questions.md` for user resolution
4. The curator does NOT silently overwrite the existing policy

Conflict resolution is a human decision. The curator surfaces the conflict; the user resolves it.

### Bootstrapping

On the first run (after `/ideate:plan`), the curator creates sparse initial domain files from planning-phase decisions. Workers in cycle 1 start with real policy context — not just guiding principles.

After the first cycle review, the curator validates, amends, or confirms plan-phase policies against actual implementation. This is the richest curator run.

---

## Review Modes

`/ideate:review` is scope-aware. The mode is determined from the invocation arguments.

| Invocation | Mode | Agents | Output |
|---|---|---|---|
| `/ideate:review` | Cycle review | code-reviewer, spec-reviewer, gap-analyst, journal-keeper, curator | `archive/cycles/{N}/` |
| `/ideate:review --domain architecture` | Domain review | code-reviewer + gap-analyst (scoped) | `archive/adhoc/{date}-domain-architecture/` |
| `/ideate:review --full` | Full audit | All agents, all domains loaded | `archive/adhoc/{date}-full-audit/` |
| `/ideate:review "how does auth fit the model"` | Ad-hoc | architect (analyze) + spec-reviewer | `archive/adhoc/{date}-how-does-auth-fit-the-model/` |
| `/ideate:review --domain testing --scope "coverage gaps"` | Targeted domain | gap-analyst scoped to testing domain | `archive/adhoc/{date}-{slug}/` |

**Cycle review** is the default and runs after `/ideate:execute` completes. It processes the full set of incremental reviews from the current cycle against the domain policies, architecture, and source code.

**Domain review** scopes the review to one domain's policies, decisions, and source files. Useful for spot-checking a specific area without running a full capstone.

**Full audit** loads all domain policies, all domain questions, and the latest cycle summary. It does not re-read all raw archive — the domain layer already distills the history.

**Ad-hoc** (natural language) classifies intent — feature-fit, integration check, retrospective — and selects the appropriate agent set. Output routes to `archive/adhoc/`.

---

## Skill Reference

### `/ideate:plan`

**What it does**: Conducts a structured interview, spawns background researcher agents, produces architecture, decomposes into work items, and bootstraps the domain layer.

**Context loaded**: User interview (conducted live). Background research (async). Guiding principles and constraints derived from interview.

**What it writes**:
- `steering/guiding-principles.md`
- `steering/constraints.md`
- `steering/research/{topic}.md`
- `steering/interviews/plan/` (per-domain interview files)
- `plan/overview.md`
- `plan/architecture.md`
- `plan/modules/{name}.md` (projects with 5+ modules)
- `plan/execution-strategy.md`
- `plan/work-items/NNN-{name}.md`
- `journal.md` (initialized)
- `domains/index.md`
- `domains/{name}/policies.md`, `decisions.md`, `questions.md`

**Domain layer interaction**: Creates the initial domain structure as the final phase of planning. Planning decisions are the first entries in `decisions.md`.

---

### `/ideate:execute`

**What it does**: Reads the plan and builds it. Spawns worker agents per the execution strategy. Reviews each work item incrementally as it completes.

**Context loaded**:
- `plan/execution-strategy.md`
- `plan/overview.md`
- `plan/architecture.md`
- `steering/guiding-principles.md`
- `steering/constraints.md`
- `plan/modules/*.md`
- `plan/work-items/*.md`
- `steering/research/*.md`
- `journal.md`
- Domain policies for relevant domains (optional supplemental context for workers)

**What it writes**:
- `archive/incremental/NNN-{name}.md` — one per completed work item
- `journal.md` entries (append-only)

**Domain layer interaction**: Workers optionally receive relevant domain policies (based on work item file scope → domain mapping). The execute skill does not write to or modify domain files.

**Execution modes**: Sequential, batched parallel, or full parallel (teams with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). All modes support worktree isolation.

---

### `/ideate:review`

**What it does**: Runs a comprehensive, multi-perspective evaluation of completed work. Mode is determined from arguments. Spawns reviewers and the domain curator.

**Context loaded** (cycle review):
- `steering/guiding-principles.md`, `constraints.md`, `plan/architecture.md`, `plan/overview.md`
- `domains/*/policies.md` (all domain policies)
- `archive/incremental/*.md` (current cycle's incremental reviews)
- `plan/work-items/*.md`
- Project source code (via Glob)

**Context loaded** (domain review): domain-specific policies, decisions, questions, and associated source files.

**Context loaded** (full audit): all domain policies, all domain questions, latest cycle summary, source code.

**What it writes**:
- `archive/cycles/{N}/` (cycle reviews): code-quality.md, spec-adherence.md, gap-analysis.md, decision-log.md, summary.md
- `archive/adhoc/{date-slug}/` (targeted reviews): review.md
- `domains/*/` updated by curator (cycle reviews always; ad-hoc reviews if policy-grade findings)
- `domains/index.md` cycle counter updated
- `journal.md` entry (append-only)

**Domain layer interaction**: The domain curator runs as the final phase after journal-keeper. After cycle reviews, it unconditionally processes all findings. After ad-hoc reviews, it runs only if policy-grade, question-grade, or conflict-grade findings exist.

---

### `/ideate:refine`

**What it does**: Plans changes to an existing codebase. Interviews the user about what to change, checks for conflicts with existing architecture and principles, produces new work items.

**Context loaded**:
- `steering/guiding-principles.md`, `constraints.md`
- `plan/overview.md`, `plan/architecture.md`, `plan/modules/*.md`
- `plan/work-items/*.md`, `plan/execution-strategy.md`
- `steering/research/*.md`
- `journal.md`
- `domains/index.md`
- `domains/*/policies.md` (all domains — current settled state)
- `domains/*/questions.md` (all domains — open questions)
- `archive/cycles/{N}/summary.md` (latest cycle summary)
- *Does NOT load all incremental reviews — the domain layer already distills history*

**What it writes**:
- `steering/interviews/refine-{NNN}/` (new interview files, per domain)
- `steering/guiding-principles.md` (updated if principles changed)
- `steering/constraints.md` (updated if constraints changed)
- `plan/overview.md` (overwritten with change plan)
- `plan/architecture.md` (updated if changed)
- `plan/work-items/NNN-{name}.md` (new work items)
- `plan/execution-strategy.md` (new strategy for this cycle)
- `journal.md` (append-only)

**Domain layer interaction**: Reads domain policies and questions as the primary context for current project state. Does not write to domain files — that is the curator's job after the next review cycle.

---

### `/ideate:brrr`

**What it does**: Autonomous SDLC loop. Executes all pending work items, runs a comprehensive review, refines if findings exist, and repeats until zero critical/significant findings and all guiding principles are satisfied — or until `--max-cycles` is reached.

**Arguments**: `[artifact directory path] [--max-cycles N]` (default: 20 cycles)

**Andon events**: Routed to the `proxy-human` agent instead of surfacing to the user. The proxy-human reads the guiding principles and constraints to make decisions autonomously.

**Convergence**: Requires both (a) zero critical and significant findings AND (b) all guiding principles satisfied simultaneously in the same cycle.

**What it writes**: Same as execute + review combined, per cycle. Also writes `brrr-state.md` (session state) and `proxy-human-log.md` (autonomous decisions).

---

## Plan Artifact Decay

Plan files and domain files have different roles as a project matures.

| Artifact | Young project | Mature project |
|---|---|---|
| `plan/architecture.md` | Primary steering context | Historical record of original design |
| `plan/overview.md` | Describes what's being built | Describes what was originally intended |
| `domains/*/policies.md` | Sparse, derived from GPs | Rich, current settled state |
| `domains/*/decisions.md` | Few entries | Full evolutionary record with archive citations |

The original plan describes the system as it was designed. After many refinement cycles, it may describe something that no longer quite exists. The domain layer is the living record — updated by the curator with every cycle.

**Structural consequence**: the living architecture belongs in `domains/architecture/policies.md`, not only in `plan/architecture.md`. The plan file is the snapshot at project start (immutable reference). The domain file is current truth (curator-maintained).

Skills load accordingly:
- **Refine**: loads domain policies (current), not original plan/architecture (historical)
- **Capstone reviewers**: load domain policies + current cycle artifacts, not original plan
- **Plan files**: cited in `decisions.md` entries as sources, not loaded as active steering

---

## Migration

If you have an existing ideate artifact directory using the old `reviews/` structure, use the migration script to move to the new `archive/` + `domains/` layout.

```bash
./scripts/migrate-to-domains.sh path/to/artifact-dir
```

**What it does**:
1. Creates `archive/incremental/` and copies `reviews/incremental/*.md` there
2. Creates `archive/cycles/001/` and copies `reviews/final/*.md` there
3. Runs the domain curator (via `claude -p`) to bootstrap `domains/` from existing archive content
4. Prints a summary of domains created, policies written, decisions recorded

**What it does NOT do**:
- Delete the original `reviews/` directory — verify the migration first, then delete manually
- Modify any existing files — it only copies and creates

**After migration**:
1. Review `domains/` to verify the bootstrap looks correct
2. Delete `reviews/` if satisfied
3. Move `steering/interview.md` to `steering/interviews/legacy.md` (optional, preserves history; future refine sessions use per-domain interview files)

---

## Worked Example

This walkthrough traces one full cycle on a hypothetical project: a CLI tool that converts markdown files to PDF.

### 1. Plan phase

```
/ideate:plan
```

After the interview, the plan phase creates:

```
specs/steering/guiding-principles.md    # 8 principles derived from interview
specs/steering/constraints.md          # Python 3.12+, no GUI frameworks
specs/plan/architecture.md             # Parser → Renderer → CLI modules
specs/plan/work-items/001-parser.md    # Parse markdown AST
specs/plan/work-items/002-renderer.md  # Convert AST to PDF via weasyprint
specs/plan/work-items/003-cli.md       # Click CLI wrapper
```

Then the domain bootstrap (Phase 8) creates:

```
specs/domains/index.md
    current_cycle: 0
    Domains: rendering, cli-ux

specs/domains/rendering/policies.md
    ## P-1: WeasyPrint is the PDF engine
    Use WeasyPrint for all PDF rendering. No alternative rendering backends.
    - Derived from: GP-2 (Minimal Inference), interview decision Q7
    - Established: planning phase
    - Status: active

specs/domains/rendering/decisions.md
    ## D-1: WeasyPrint chosen over ReportLab
    - Decision: WeasyPrint renders HTML→PDF, enabling CSS-driven layout. ReportLab requires
      programmatic layout definition which duplicates the markdown rendering logic.
    - Rationale: CSS-based layout reuses existing markdown→HTML conversion; avoids maintaining
      a parallel layout system. Confirmed by user in interview Q7.
    - Source: plan/architecture.md, steering/interviews/plan/rendering.md#Q7
    - Status: settled

specs/domains/cli-ux/policies.md
    ## P-2: Single output path argument
    The CLI accepts exactly one output path argument. No interactive prompts.
    - Derived from: GP-3 (Guiding Principles Over Implementation Details)
    - Established: planning phase
    - Status: active
```

### 2. Execute phase

```
/ideate:execute specs/
```

Each work item completes and gets an incremental review:

```
specs/archive/incremental/001-parser.md      # Verdict: Pass. Minor: missing docstring on _parse_links.
specs/archive/incremental/002-renderer.md    # Verdict: Pass. No findings.
specs/archive/incremental/003-cli.md         # Verdict: Fail. Significant: --output flag missing validation.
```

The execute skill fixes the CLI finding (within scope) and reworks the item. Journal updated.

### 3. Review phase

```
/ideate:review specs/
```

Mode: cycle review (no arguments). Cycle number: 001 (from domains/index.md current_cycle: 0 + 1).

Three reviewers spawn in parallel, write to `specs/archive/cycles/001/`. Then journal-keeper. Then domain curator.

**Curator run** (after journal-keeper):

Findings from `specs/archive/cycles/001/gap-analysis.md`:
- G-1: No test suite. Significant gap.
- G-2: No error handling for malformed markdown input. PDF rendering will throw uncaught exceptions.

Findings from `specs/archive/cycles/001/code-quality.md`:
- C-1: WeasyPrint CSS loading is hardcoded to `./styles/default.css`. Should be configurable.

Curator classifications:
- G-1 → question-grade in `cli-ux` domain (testing strategy unresolved)
- G-2 → policy-grade in `rendering` domain (error handling rule for rendering pipeline)
- C-1 → decision-grade in `rendering` domain (hardcoded path recognized as debt)

Curator writes:

```
# After curator run, domains/rendering/ gains:

decisions.md:
## D-2: CSS path hardcoded in cycle 001
- Decision: WeasyPrint CSS path is currently hardcoded to ./styles/default.css.
- Rationale: Expedient choice during cycle 001 implementation. Recognized as technical debt.
- Source: archive/cycles/001/code-quality.md#C-1
- Status: settled (known debt — see Q-1)

policies.md:
## P-3: Rendering errors must not propagate as exceptions to CLI
All errors from WeasyPrint must be caught, logged, and converted to a user-readable error message
before exit. Uncaught rendering exceptions are prohibited.
- Derived from: GP-5 (Continuous Review), gap finding G-2
- Established: cycle 001
- Status: active

questions.md:
## Q-1: CSS path configurability
- Question: Should the CSS path be a CLI flag, a config file entry, or both?
- Source: archive/cycles/001/code-quality.md#C-1, decisions.md#D-2
- Impact: Users cannot use custom stylesheets without modifying source code.
- Status: open
- Reexamination trigger: user requests custom styling support


# domains/cli-ux/ gains:

questions.md:
## Q-2: Test suite absent
- Question: What is the testing strategy? Unit tests for parser, integration tests for rendering, or end-to-end CLI tests?
- Source: archive/cycles/001/gap-analysis.md#G-1
- Impact: No automated regression detection. Bugs in future cycles are harder to catch.
- Status: open
- Reexamination trigger: before next execute cycle

# domains/index.md updated:
current_cycle: 1
```

### 4. Refine phase

```
/ideate:review specs/
```

The refine skill loads `domains/*/policies.md` and `domains/*/questions.md` — not the full archive. It presents the open questions (Q-1, Q-2) to the user, produces new work items to add tests and make CSS configurable, and writes a new execution strategy.

The cycle repeats. Each subsequent review is scoped to the current cycle's incremental reviews plus the domain policy layer — not all prior history.

---

## Design Notes

The design rationale for this system is documented in `specs/steering/research/domain-knowledge-layer.md`. That document covers the problem statement, the archive/domain separation rationale, the interview structure design, and the open questions that shaped the final implementation.

---

For orchestration infrastructure (session spawning, remote workers, parallel execution at scale), see the companion project **[Outpost](https://github.com/devnill/outpost)**.
