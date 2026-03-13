# Artifact Conventions

This document defines the file formats, schemas, naming conventions, and semantics for every artifact in the ideate artifact directory. All skills and agents follow these conventions when reading or writing artifacts.

---

## Artifact Directory Structure

```
{artifact-dir}/
├── manifest.json
├── steering/
│   ├── interview.md
│   ├── guiding-principles.md
│   ├── constraints.md
│   └── research/
│       └── {topic-slug}.md
├── plan/
│   ├── overview.md
│   ├── architecture.md
│   ├── modules/
│   │   └── {module-name}.md
│   ├── execution-strategy.md
│   └── work-items/
│       └── NNN-{name}.md
├── archive/
│   ├── incremental/
│   │   └── NNN-{name}.md
│   └── cycles/
│       └── NNN/
│           └── summary.md
├── domains/
│   ├── index.md
│   └── {domain-name}/
│       ├── policies.md
│       ├── decisions.md
│       └── questions.md
└── journal.md
```

---

## `manifest.json`

**Purpose**: Identifies the schema version of this artifact directory. Used by migration scripts to determine which upgrades to apply.

**Format**:
```json
{"schema_version": 1}
```

**Phases**: plan (write), never modified by other phases
**Semantics**: Written once during `/ideate:plan` directory scaffolding. Not read or checked by any skill at runtime. Updated only by migration scripts when the schema version advances.

---

## Steering Artifacts

### `steering/interview.md`

**Purpose**: Record of the planning conversation — the raw material from which principles and constraints are derived.

**Format**:
```markdown
# Interview Transcript — {date}

## Context
{What triggered this planning session.}

---

**Q: {Question asked by the tool}**
A: {User's answer, capturing substance not verbatim quotes.}

**Q: {Next question}**
A: {Answer}
```

**Refinement appending**:
```markdown
---
## Refinement Interview — {date}

**Context**: {What triggered this refinement — review findings, new requirements, etc.}

**Q: {Question}**
A: {Answer}
```

**Phases**: plan (write), execute (read), review (read), refine (append)
**Semantics**: Plan writes initial. Refine appends new section with date header. Never overwritten.

---

### `steering/guiding-principles.md`

**Purpose**: Decision framework — the "why" behind the project. Used as sanity checks to verify the project stays on track.

**Format**:
```markdown
# Guiding Principles

## 1. {Principle Name}
{One paragraph explaining why this matters and what it means for the project.}

## 2. {Principle Name}
{Explanation.}
```

**Count**: 5-15 principles per project.

**Refinement updates**:
```markdown
## N. {Principle Name}
{Updated explanation.}

> _Changed in refinement ({date}): {what changed and why}_
```

**Deprecation** (never silently delete):
```markdown
## N. {Principle Name} ~~[DEPRECATED]~~
{Original explanation.}

> _Deprecated ({date}): {rationale for deprecation}_
```

**Phases**: plan (write), execute (read), review (read), refine (update)
**Semantics**: Principles are never silently deleted. Changes are annotated with date and rationale.

---

### `steering/constraints.md`

**Purpose**: Hard boundaries on technology, design, and process.

**Format**:
```markdown
# Constraints

## Technology Constraints
1. **{Constraint name}.** {Explanation.}

## Design Constraints
N. **{Constraint name}.** {Explanation.}

## Process Constraints
N. **{Constraint name}.** {Explanation.}

## Scope Constraints
N. **{Constraint name}.** {Explanation.}
```

**Phases**: plan (write), execute (read), review (read), refine (update)

---

### `steering/research/{topic-slug}.md`

**Purpose**: Background research findings on a specific topic, produced by researcher agents.

**Naming**: kebab-case topic slug (e.g., `session-multiplexing.md`, `oauth2-providers.md`)

**Format**:
```markdown
# {Topic Title}

Research compiled: {date}
Scope: {What was investigated and why.}

## Summary
{2-3 sentence overview.}

## Key Facts
- {Fact 1}
- {Fact 2}

## Recommendations
{Approach to take and why. Multiple options with tradeoffs if applicable.}

## Risks
{Known issues, gotchas, limitations.}

## Sources
{URLs or file paths consulted.}
```

**Phases**: plan (write), execute (read), review (read), refine (write)
**Semantics**: Never overwritten. New research on the same topic gets a new file with a distinguishing suffix (e.g., `oauth2-providers-v2.md`).

---

## Plan Artifacts

### `plan/overview.md`

**Purpose**: High-level summary of what's being built (plan phase) or what's changing (refine phase).

**Format**: Prose with structural diagrams. Should cover:
- What we're building and why
- Key components
- Plugin/project structure
- Workflow description

**Phases**: plan (write), execute (read), review (read), refine (overwrite with change plan)
**Semantics**: During refine, this becomes a **change plan** focused on the delta, not a full project description.

---

### `plan/architecture.md`

**Purpose**: Technical architecture — components, relationships, data flow, interfaces.

**Format**: Structured sections:
1. Component Map (tables of skills, agents, external tools)
2. Data Flow (diagrams showing artifact flow between phases)
3. Skill Definitions (trigger, input, process, output, decision points per skill)
4. Agent Definitions (purpose, tools, model, input/output contracts per agent)
5. External Tooling (MCP servers, SDK components)
6. Module Decomposition Protocol (when to use, format, rules)
7. Review Architecture (layers, triggers, finding handling)
8. Artifact Directory Contract (read/write permissions per phase)

**Phases**: plan (write), execute (read), review (read), refine (update if architecture changes)

---

### `plan/modules/{module-name}.md`

**Purpose**: Intermediate decomposition level — module scope, interfaces, and boundary rules. Defined BEFORE work items are created.

**Naming**: kebab-case module name matching references in architecture.md.

**Format**:
```markdown
# Module: {Name}

## Scope
{What this module is responsible for. What it is NOT responsible for.}

## Provides
- `{export/interface/function signature}` — {description}
- `{another export}` — {description}

## Requires
- `{dependency}` (from: {module-name}) — {what it needs and why}

## Boundary Rules
- {What this module may and may not do}
- {Access restrictions}
- {Performance/security requirements specific to this module}

## Internal Design Notes
{Optional: data models, key algorithms, implementation approach.}
{Not binding — the decomposer may refine these when creating work items.}
```

**Interface Contract Rules**:
1. Every `Provides` entry referenced as a `Requires` by another module must have matching signatures.
2. Contracts are defined at module level BEFORE work items are created.
3. Conflicts between modules must be resolved by the architect before work items are finalized.

**Phases**: plan (write), execute (read), review (read), refine (update if scope changes)

---

### `plan/execution-strategy.md`

**Purpose**: How agents will execute the plan — mode, parallelism, grouping.

**Format**:
```markdown
# Execution Strategy

## Mode
{Sequential | Batched parallel | Full parallel (teams)}

## Parallelism
Max concurrent agents: {N}

## Worktrees
Enabled: {yes | no}
Reason: {why or why not}

## Review Cadence
{After every item | After every batch | At end only}

## Work Item Groups
Group 1 ({parallel | sequential}): NNN, NNN, NNN
Group 2 ({parallel | sequential}, depends on group N): NNN, NNN
...

## Dependency Graph
{ASCII diagram or description of dependency relationships}

## Agent Configuration
Model for workers: {sonnet | opus}
Model for reviewers: {sonnet | opus}
Permission mode: {acceptEdits | dontAsk}
```

**Valid modes**:
- **Sequential**: One item at a time. Low cost, slow. For small projects or highly interdependent work.
- **Batched parallel**: Groups of independent items via subagents. Medium cost, medium speed.
- **Full parallel (teams)**: Agent teams with shared task list. High cost, fast. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.

**Phases**: plan (write), execute (read), review (read), refine (overwrite for new cycle)

---

### `plan/work-items/NNN-{name}.md`

**Purpose**: Atomic executable task specification. Each is a self-contained unit of work.

**Naming**: 3-digit zero-padded number + kebab-case name. Examples: `001-plugin-manifest.md`, `042-auth-providers.md`.

**Numbering**: Sequential within a planning cycle. Refine continues from the highest existing number (e.g., if plan created 001-015, refine starts at 016).

**Format**:
```markdown
# NNN: {Title}

## Objective
{What this work item accomplishes. One paragraph.}

## Acceptance Criteria
- [ ] {Machine-verifiable criterion 1}
- [ ] {Machine-verifiable criterion 2}
- [ ] {Criterion N}

## File Scope
- `{path/to/file}` ({create | modify | delete})
- `{path/to/another}` ({create | modify | delete})

## Dependencies
- Depends on: {NNN, NNN | none}
- Blocks: {NNN, NNN | none}

## Implementation Notes
{Technical details, edge cases, constraints, patterns to follow.}

## Complexity
{Low | Medium | High}
```

**Constraints**:
- Non-overlapping file scope between concurrent work items. If two items touch the same file, they must be sequenced via dependency.
- Dependencies must form a DAG (no cycles).
- Acceptance criteria should be machine-verifiable where possible (test pass/fail, structural assertions, type checks). Subjective criteria signal unresolved ambiguity.

**Phases**: plan (write), execute (read), review (read), refine (write new items)

---

## Review Artifacts

### `reviews/incremental/NNN-{name}.md`

**Purpose**: Per-work-item review results produced during execution.

**Naming**: Matches the work item number and name.

**Producer**: code-reviewer agent during execution phase.

**Format**:
```markdown
## Verdict: {Pass | Fail}

{One-sentence summary of the overall assessment.}

## Critical Findings

Issues that will cause incorrect behavior, data loss, security vulnerabilities, or crashes in production.

### C1: {Short title}
- **File**: `path/to/file.ext:42`
- **Issue**: {Description of the problem}
- **Impact**: {What goes wrong if this is not fixed}
- **Suggested fix**: {Concrete suggestion}

## Significant Findings

Issues that indicate design problems, missing functionality, or violations of stated requirements.

### S1: {Short title}
- **File**: `path/to/file.ext:87`
- **Issue**: {Description}
- **Impact**: {What goes wrong}
- **Suggested fix**: {Concrete suggestion}

## Minor Findings

Issues that affect maintainability, readability, or consistency but do not cause incorrect behavior.

### M1: {Short title}
- **File**: `path/to/file.ext:15`
- **Issue**: {Description}
- **Suggested fix**: {Concrete suggestion}

## Unmet Acceptance Criteria

List any acceptance criteria from the work item spec that are not satisfied by the implementation.

- [ ] {Criterion text} — {Why it is not met}
```

If a severity section has no findings, include the header with "None." underneath. Do not omit sections.

**Verdict rule**: Fail if there are any Critical or Significant findings, or any unmet acceptance criteria. Otherwise Pass.

**Phases**: execute (write), review (read), refine (read)

---

### `reviews/final/code-quality.md`

**Purpose**: Comprehensive code review across the entire project.
**Producer**: code-reviewer agent during review phase.
**Format**: Same structure as incremental reviews (Verdict, C/S/M numbered findings with structured sub-fields, Unmet Acceptance Criteria) but scoped to the full project, focusing on cross-cutting concerns: consistency across modules, patterns spanning multiple work items, integration between components, and systemic issues.

```markdown
## Verdict: {Pass | Fail}

{One-sentence summary of the overall assessment.}

## Critical Findings

### C1: {Short title}
- **File**: `path/to/file.ext:42`
- **Issue**: {Description of the problem}
- **Impact**: {What goes wrong if this is not fixed}
- **Suggested fix**: {Concrete suggestion}

## Significant Findings

### S1: {Short title}
- **File**: `path/to/file.ext:87`
- **Issue**: {Description}
- **Impact**: {What goes wrong}
- **Suggested fix**: {Concrete suggestion}

## Minor Findings

### M1: {Short title}
- **File**: `path/to/file.ext:15`
- **Issue**: {Description}
- **Suggested fix**: {Concrete suggestion}

## Unmet Acceptance Criteria

- [ ] {Criterion text} — {Why it is not met}
```

If a section has no findings, include the header with "None." underneath. Do not omit sections.

### `reviews/final/spec-adherence.md`

**Purpose**: Verification that implementation matches architecture, principles, and acceptance criteria.
**Producer**: spec-reviewer agent.
**Format**:
```markdown
## Architecture Deviations

### D1: {Short title}
- **Expected**: {What the architecture specifies}
- **Actual**: {What the implementation does}
- **Evidence**: `path/to/file.ext:42` — {description of the deviation}

## Unmet Acceptance Criteria

### Work Item NNN: {name}
- [ ] {Criterion text} — {Why it is not met, with file references}

## Principle Violations

### P1: Principle {number} — {principle name}
- **Principle states**: {relevant excerpt}
- **Violation**: {What the implementation does that contradicts this}
- **Evidence**: `path/to/file.ext:15` — {specific code or pattern that violates}

## Principle Adherence Evidence

For each principle that IS followed, one line of evidence:
- Principle {number} — {principle name}: {specific evidence with file reference}

## Undocumented Additions

Code that exists in the implementation but is not described in any spec, architecture document, or work item.

### U1: {Short title}
- **Location**: `path/to/file.ext`
- **Description**: {What this code does}
- **Risk**: {Why undocumented additions are concerning in this case}

## Naming/Pattern Inconsistencies

### N1: {Short title}
- **Convention**: {The established pattern}
- **Violation**: `path/to/file.ext` — {how it deviates}
```

If a section has no findings, include the header with "None." underneath. Do not omit sections.

### `reviews/final/gap-analysis.md`

**Purpose**: Missing requirements, unhandled edge cases, blind spots.
**Producer**: gap-analyst agent.
**Format**:
```markdown
## Missing Requirements from Interview

### MR1: {Short title}
- **Interview reference**: {Quote or paraphrase from the interview, with approximate location}
- **Current state**: {What exists now, if anything}
- **Gap**: {What is missing}
- **Severity**: {Critical | Significant | Minor}
- **Recommendation**: {Address now | Defer} — {Rationale}

## Unhandled Edge Cases

### EC1: {Short title}
- **Component**: `path/to/file.ext`
- **Scenario**: {Description of the edge case}
- **Current behavior**: {What happens now — crash, silent failure, incorrect result, untested}
- **Expected behavior**: {What should happen}
- **Severity**: {Critical | Significant | Minor}
- **Recommendation**: {Address now | Defer} — {Rationale}

## Incomplete Integrations

### II1: {Short title}
- **Interface**: {Name of the integration point}
- **Producer**: `path/to/producer.ext`
- **Consumer**: `path/to/consumer.ext`
- **Gap**: {What is missing — error handling, format mismatch, missing tests, etc.}
- **Severity**: {Critical | Significant | Minor}
- **Recommendation**: {Address now | Defer} — {Rationale}

## Missing Infrastructure

### MI1: {Short title}
- **Category**: {Error handling | Logging | Configuration | Deployment | Documentation | Other}
- **Gap**: {What is missing}
- **Impact**: {What goes wrong without it}
- **Severity**: {Critical | Significant | Minor}
- **Recommendation**: {Address now | Defer} — {Rationale}

## Implicit Requirements

### IR1: {Short title}
- **Expectation**: {What a reasonable user would expect}
- **Current state**: {Whether this expectation is met, partially met, or unmet}
- **Gap**: {What is missing}
- **Severity**: {Critical | Significant | Minor}
- **Recommendation**: {Address now | Defer} — {Rationale}
```

If a section has no findings, include the header with "None." underneath. Do not omit sections.

### `reviews/final/decision-log.md`

**Purpose**: Synthesized project history — decisions, open questions, and cross-references between reviewer findings.
**Producer**: journal-keeper agent.
**Format**:
```markdown
## Decision Log

### Planning Phase

#### DL1: {Decision title}
- **When**: {Phase — context}
- **Decision**: {What was decided}
- **Rationale**: {Why}
- **Alternatives**: {If recorded, otherwise omit this line}
- **Implications**: {What this affects}

### Execution Phase

#### DL2: {Decision title}
...

### Review Phase

#### DL3: {Decision title}
...

---

## Open Questions

### OQ1: {Question title}
- **Question**: {Specific question}
- **Source**: {Where this came from}
- **Impact**: {What is affected}
- **Who answers**: {User | Technical investigation | Design review}
- **Consequence of inaction**: {What happens if ignored}

## Cross-References

### CR1: {Topic}
- **Code review**: {Finding ID and summary}
- **Spec review**: {Finding ID and summary, or "No related finding"}
- **Gap analysis**: {Finding ID and summary, or "No related finding"}
- **Connection**: {How these findings relate and what the combined picture suggests}
```

If a section has no findings, include the header with "None." underneath. Do not omit sections. Only include cross-references where the connection is substantive.

### `reviews/final/summary.md`

**Purpose**: Cross-reviewer synthesis with prioritized findings.
**Producer**: review skill (synthesizes all reviewer outputs).
**Format**:
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

**Phases**: review (write), refine (read)

---

## Journal

### `journal.md`

**Purpose**: Running log of all project activity across all phases.

**Format**:
```markdown
# Project Journal

## [{phase}] {date} — {title}
{Content specific to the entry type.}
```

**Phase tags**: `[plan]`, `[execute]`, `[review]`, `[refine]`

**Entry types by phase**:

**Plan**:
```markdown
## [plan] {date} — Planning session completed
{Summary of what was planned, key decisions, deferred questions.}
```

**Execute** (per item):
```markdown
## [execute] {date} — Work item NNN: {title}
Status: {complete | complete with rework}
{Deviations from plan, notable decisions.}
```

**Execute** (completion):
```markdown
## [execute] {date} — Execution complete
Items completed: {N}/{total}
Items requiring rework: {N}
Outstanding issues: {list or "none"}
```

**Review**:
```markdown
## [review] {date} — Comprehensive review completed
Critical findings: {N}
Significant findings: {N}
Minor findings: {N}
Suggestions: {N}
Items requiring user input: {N}
```

**Refine**:
```markdown
## [refine] {date} — Refinement planning completed
Trigger: {review findings | new requirements | user request}
Principles changed: {list or "none"}
New work items: {NNN-NNN}
{Summary of what this refinement cycle addresses.}
```

**Semantics**: STRICTLY APPEND-ONLY. No phase ever edits or deletes existing entries. Entries are chronologically ordered.

**Phases**: plan (init), execute (append), review (append), refine (append)
