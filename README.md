# ideate

A Claude Code plugin that provides a structured SDLC workflow for taking rough ideas and producing specs detailed enough for flawless LLM execution. Ideate scales vibe coding from feature-level to application-level by exhaustively exploring and documenting every aspect of an idea, then executing against those specs with continuous review.

The workflow follows four phases -- plan, execute, review, refine -- each backed by specialized agents (researcher, architect, decomposer, reviewers) that collaborate to produce and validate artifacts.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and available on PATH

## Installation

Add the plugin directly from the repository:

```bash
claude plugin add /path/to/ideate
```

Or clone the repository and add it manually to your Claude Code plugin search path.

## MCP Server Setup (Optional)

The session-spawner MCP server enables recursive Claude Code session invocation, which is required for parallel work item decomposition and execution. The plugin works without it, but recursive decomposition will be unavailable.

### 1. Install dependencies

```bash
cd /path/to/ideate/mcp/session-spawner
pip install -r requirements.txt
```

### 2. Register the MCP server

```bash
claude mcp add ideate-session-spawner -- python /path/to/ideate/mcp/session-spawner/server.py
```

See [mcp/session-spawner/README.md](mcp/session-spawner/README.md) for detailed configuration options, safety mechanisms, and environment variables.

## Commands

| Command | Description |
|---------|-------------|
| `/ideate:plan` | Interview the user, research the domain, decompose into architecture and work items |
| `/ideate:execute` | Build the project by working through plan work items with incremental review |
| `/ideate:review` | Run a comprehensive multi-perspective evaluation of the completed project |
| `/ideate:refine` | Plan changes to an existing codebase based on review findings or new requirements |

## Artifact Directory Structure

All artifacts are written to a `specs/` directory (configurable) in the project root:

```
specs/
├── steering/
│   ├── interview.md          # Planning conversation transcript
│   ├── guiding-principles.md # Derived principles from the interview
│   ├── constraints.md        # Technical and process constraints
│   └── research/             # Domain research findings
│       └── {topic-slug}.md
├── plan/
│   ├── overview.md           # High-level plan summary
│   ├── architecture.md       # System architecture
│   ├── modules/              # Module-level design docs
│   │   └── {module-name}.md
│   ├── execution-strategy.md # Ordering and parallelism strategy
│   └── work-items/           # Individual implementation tasks
│       └── NNN-{name}.md
├── reviews/
│   ├── incremental/          # Per-work-item review results
│   │   └── NNN-{name}.md
│   └── final/                # Comprehensive review artifacts
│       ├── code-quality.md
│       ├── spec-adherence.md
│       ├── gap-analysis.md
│       ├── decision-log.md
│       └── summary.md
└── journal.md                # Running log of execution progress
```

## Quick Start

```
/ideate:plan "my idea"
```

Answer the interview questions. Ideate researches the domain, produces an architecture, and decomposes the work into ordered items.

```
/ideate:execute
```

Builds the project by working through each work item, with incremental reviews after each.

```
/ideate:review
```

Runs a comprehensive multi-perspective review covering code quality, spec adherence, and gap analysis.

## License

MIT
