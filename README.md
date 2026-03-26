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

Pin specific versions via environment variables:

```bash
export ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4-6
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6
```

### Custom endpoints (Ollama)

```bash
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_API_KEY=ollama
export ANTHROPIC_DEFAULT_SONNET_MODEL=qwen3:30b
export ANTHROPIC_DEFAULT_OPUS_MODEL=qwen3:235b
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
