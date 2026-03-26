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

## Quick Start

```
/ideate:plan
```

Ideate interviews you about what you want to build, spawns background research agents, produces an architecture and work item plan, and bootstraps the domain knowledge layer. Everything lands in a `specs/` directory (or a path you specify) in your project root.

After planning:

```
/ideate:execute specs/
```

Builds all work items, writing incremental reviews as each completes. Then run a capstone review:

```
/ideate:review specs/
```

And plan the next round of changes:

```
/ideate:refine specs/
```

Or let it run autonomously until convergence:

```
/ideate:brrr specs/
```

---

## Skills

| Skill | What it does |
|-------|-------------|
| `/ideate:plan` | Interview → research → architecture → work items → domain bootstrap |
| `/ideate:execute` | Build work items with per-item incremental review |
| `/ideate:review` | Capstone review: cycle (default), `--domain`, `--full`, or natural language scope |
| `/ideate:refine` | Plan the next cycle of changes from review findings or new requirements |
| `/ideate:brrr` | Autonomous execute → review → refine loop until convergence |

---

## Worked Example

A single cycle traces through four phases: plan, execute, review, refine. The artifacts below are real files from `.ideate/`.

### Phase 1 — Plan

`/ideate:plan` interviews you, spawns research agents, produces architecture and work items. Each work item is a YAML file written to `.ideate/work-items/`:

```yaml
id: WI-220
type: work_item
title: Skill integration for hook event emission
status: pending
complexity: medium
scope:
  - {path: skills/plan/SKILL.md, op: modify}
  - {path: skills/execute/SKILL.md, op: modify}
depends:
  - "219"
criteria:
  - "skills/plan/SKILL.md emits plan.complete event via ideate_emit_event after Phase 8"
  - "skills/execute/SKILL.md emits work_item.started before each work item execution"
  - "All event emissions use ideate_emit_event MCP tool call"
  - "All event emissions are best-effort: if the tool call fails, skill continues without interruption"
cycle_created: 1
```

### Phase 2 — Execute

`/ideate:execute .ideate/` builds each work item and writes journal entries and per-item findings. A journal entry:

```yaml
id: J-026-002
type: journal_entry
phase: execute
date: "2026-03-22"
cycle_created: 26
title: "Work item 122: Fix code-reviewer agent startup-failure description"
content: "Status: complete"
```

### Phase 3 — Review

`/ideate:review .ideate/` runs a capstone review across all work items and writes a cycle summary to `.ideate/cycles/{NNN}/CS-{NNN}.yaml`:

```yaml
id: CS-027
type: cycle_summary
cycle_created: 27
title: "Review Summary — Cycle 027"
overview: >
  Cycle 027 implemented 6 features (16 work items): build-on-startup, init skill, telemetry schema,
  reporting scripts, SDLC hooks, and v2 cleanup. All new source files exist, TypeScript builds cleanly,
  all report scripts are executable.
findings:
  critical: 0
  significant: 3
  minor: 2
  suggestions: 2
significant_findings:
  - reviewer: spec-reviewer
    description: "agents/journal-keeper.md references archive/incremental/ paths instead of .ideate/cycles/{NNN}/"
    status: resolved
refinement_needed: false
```

Individual findings are written to `.ideate/cycles/{NNN}/findings/`:

```yaml
id: FI-015-001
type: finding
cycle: 15
reviewer: code-reviewer
severity: minor
title: In-fence verdict placeholder could be rendered literally
description: |
  File: agents/spec-reviewer.md
  Issue: Template in output code block used a concrete example instead of placeholder.
  Suggested fix: Already fixed.
work_item: WI-102
```

### Phase 4 — Refine

`/ideate:refine .ideate/` plans the next cycle. A refine journal entry summarizes what changed:

```yaml
id: J-027-001
type: journal_entry
phase: refine
date: "2026-03-22"
cycle_created: 27
title: Refinement planning completed
content: |
  Trigger: Cycle 010 minor findings (Q-31) + deferred design questions Q-26, Q-27, Q-3
  New work items: WI-125 through WI-128
  Closes Q-3 (spawn_session ordering), Q-26 (smoke test infra failure), Q-27 (library projects)
```

The cycle then repeats from execute.

---

## Context Loading

What each skill reads and writes through MCP tools:

| Skill | MCP Tools Read | MCP Tools Written | Key Artifacts |
|-------|---------------|-------------------|---------------|
| `plan` | `get_context_package` | `write_work_items`, `append_journal` | overview, architecture, work items |
| `execute` | `get_work_item_context`, `get_execution_status` | `append_journal`, `emit_event` | findings, journal entries |
| `review` | `get_review_manifest`, `get_context_package` | `archive_cycle`, `append_journal` | cycle summary, findings |
| `refine` | `get_context_package`, `get_domain_state` | `write_work_items`, `append_journal` | new work items |
| `brrr` | all of the above | all of the above | autonomous loop |

Skills access artifacts exclusively through MCP tools. Direct file reads by skills are not permitted.

---

## Artifact Directory Structure

All artifacts live in one directory (conventionally `specs/` in the project root, but user-configurable):

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

`archive/` is immutable once written. `domains/` is maintained by the domain-curator agent after each review cycle.

### Interview Structure

Between cycles, `refine` captures structured interview data in `.ideate/interviews/refine-{NNN}/`. Each directory contains one YAML file per domain plus a `_general.yaml` for cross-domain questions.

**File naming**: `.ideate/interviews/refine-{NNN}/{domain-name}.yaml` and `.ideate/interviews/refine-{NNN}/_general.yaml`

**Entry format** (each entry in the `entries` list):

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier, e.g. `IQ-027-001` |
| `question` | string | The question asked during the interview |
| `answer` | string | User's answer |
| `domain` | string or null | Domain this entry belongs to, or null for cross-domain |
| `seq` | integer | Sequence number within the interview |

A real example from `.ideate/interviews/refine-027/_general.yaml`:

```yaml
id: interviews/refine-027/_general
type: interview
cycle: 27
entries:
  - id: IQ-027-001
    question: What changes do you want to make?
    answer: "Six areas: (1) Fix specs/ vs .ideate/ defect in skill validation. (2) Plan vs refine discussion — decided to keep separate, add init skill. (3) Telemetry for PPR weight tuning. (4) Build on first MCP startup. (5) Reporting scripts. (6) SDLC hooks for external integrations."
    domain: null
    seq: 1
  - id: IQ-027-003
    question: Plan vs refine — merge or keep separate?
    answer: "Keep separate. Plan is greenfield (no code exists). Init + refine covers existing codebases. Three entry points: plan (new project), init (existing code, no .ideate/), refine (existing .ideate/)."
    domain: null
    seq: 3
```

---

## Configuration

### MCP artifact server (required)

The ideate artifact server must be configured as an MCP server in your Claude Code settings. Skills access artifacts exclusively through MCP tools — direct file reads are not permitted (GP-8).

```json
{
  "mcpServers": {
    "ideate-artifact-server": {
      "command": "node",
      "args": ["/path/to/ideate/mcp/artifact-server/dist/index.js"]
    }
  }
}
```

Build the server first:

```bash
cd mcp/artifact-server
npm install
npm run build
```

### Model tiers

Ideate uses three model tiers:

| Tier | Default | Used for |
|------|---------|----------|
| `sonnet` | `claude-sonnet-4-6` | Most agents: workers, reviewers, researchers |
| `opus` | `claude-opus-4-6` | Architect, decomposer, domain-curator, proxy-human |
| `haiku` | `claude-haiku-4-5-20251001` | Not currently used |

#### Custom models

Override each tier independently with environment variables:

| Variable | Tier overridden |
|----------|----------------|
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Sonnet (workers, reviewers, researchers) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Opus (architect, decomposer, domain-curator) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Haiku (reserved, not currently assigned) |

Set `ANTHROPIC_BASE_URL` to route all requests to a custom or local endpoint (e.g., Ollama):

**Minimum model requirements**: 64k+ context window, tool-use support, instruction-following. Models that do not support tool calls cannot invoke MCP tools and will fail.

**Known limitations**:
- `ANTHROPIC_BASE_URL` applies to the entire Claude Code session. You cannot mix Anthropic API models and local models in a single run.
- If you configure models via `settings.json`'s `env` block rather than shell exports, the values apply only when Claude Code is launched from that settings context. Verify the env block is picked up by checking `claude doctor` or running a quick test invocation.

**Example — Ollama with Qwen3**:

```bash
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_API_KEY=ollama
export ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3:30b
export ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3:235b
export ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen3:8b
```

**Note**: `ANTHROPIC_BASE_URL` applies to the entire session — you cannot mix Anthropic and Ollama agents within a single run.

---

## Domain Layer

Domains are knowledge units — areas of the project with distinct conceptual language, different decision authorities, or different change cadences. Each domain has three files:

- **`policies.md`** — Durable rules future workers must follow
- **`decisions.md`** — Significant choices with rationale and archive citations
- **`questions.md`** — Open and resolved questions

The domain-curator agent maintains these files automatically after each review cycle. A domain policy links to the decision that established it, which links back to the specific archive file and finding. The chain: `policies.md#P-7` → `decisions.md#D-15` → `archive/cycles/003/code-quality.md#C3`.

Typical project: 2–4 domains. Start coarse. See the [design notes](#design-notes) for when and how to split.

---

## Review Modes

| Invocation | Mode | Output |
|-----------|------|--------|
| `/ideate:review` | Cycle review | `archive/cycles/{N}/` |
| `/ideate:review --domain architecture` | Domain review | `archive/adhoc/{date}-domain-architecture/` |
| `/ideate:review --full` | Full audit | `archive/adhoc/{date}-full-audit/` |
| `/ideate:review "how does auth fit the model"` | Ad-hoc | `archive/adhoc/{date}-{slug}/` |

---

## Validation Scripts

### `validate-specs.sh`

```bash
./scripts/validate-specs.sh <subcommand> [artifact-dir]
```

| Subcommand | What it checks |
|-----------|---------------|
| `dag` | Dependency cycle detection |
| `overlap` | File scope conflicts between concurrent work items |
| `coverage` | All items have criteria and scope |
| `groups` | Topological sort: execution groups by dependency depth |
| `lint` | Vague acceptance criteria terms |
| `all` | All subcommands |

### `migrate-to-v3.sh`

Migrates an existing artifact directory to the v3 YAML-backed structure.

```bash
./scripts/migrate-to-v3.sh [--dry-run] [--verbose] path/to/specs
```

---

## Reporting Scripts

All reporting scripts require Python 3 on PATH. Each reads a `metrics.jsonl` file produced by the ideate runtime. If no file argument is supplied, the script auto-discovers it by walking up from CWD looking for `.ideate.json`.

### `report.sh`

Full metrics report: executive summary, per-cycle breakdown, per-task breakdown, phase analysis, agent performance, RAG vs flat-file MCP usage, and quality trends.

```bash
./scripts/report.sh [METRICS_FILE]
```

### `report-cycle.sh`

Cycle-focused report: cycle-over-cycle quality trends, convergence speed, and first-pass acceptance rate.

```bash
./scripts/report-cycle.sh [METRICS_FILE]
```

### `report-cost.sh`

Token cost report: per-work-item token cost, per-cycle token cost with phase breakdown, and cycle-over-cycle cost trends with optional dollar estimates.

```bash
./scripts/report-cost.sh [METRICS_FILE]
```

### `report-executive.sh`

High-level executive summary: project summary, quality metrics, cost summary, and ROI indicators (rework rate trend, convergence speed trend, tokens-per-finding, first-pass rate trend).

```bash
./scripts/report-executive.sh [METRICS_FILE]
```

---

## Design Notes

The rationale for the archive/domain separation, interview structure, and the GP → domain policy derivation pattern is documented in `specs/steering/research/domain-knowledge-layer.md`.

For deep technical documentation covering the MCP artifact server schema, indexer pipeline, tool architecture, and graph model, see [ARCHITECTURE.md](ARCHITECTURE.md).

Ideate's own development artifacts (work items, cycle reviews, domain knowledge) are in `specs/`.

---

For orchestration infrastructure (session spawning, remote workers, parallel execution at scale), see the companion project **[Outpost](https://github.com/devnill/outpost)**.
