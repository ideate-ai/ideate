# 011: Artifact Conventions and Templates

## Objective
Define the artifact directory contract — file formats, schemas, naming conventions, and template examples for every artifact type. This serves as the reference that all skills and agents follow when reading or writing artifacts.

## Acceptance Criteria
- [ ] `specs/artifact-conventions.md` exists in the plugin directory (not in a project's artifact dir — this is plugin documentation)
- [ ] Documents every artifact file:
  - `steering/interview.md` — Q&A format, refinement interview appending convention
  - `steering/guiding-principles.md` — numbered principles, refinement change notes
  - `steering/constraints.md` — categorized constraints
  - `steering/research/{topic-slug}.md` — structured research report format
  - `plan/overview.md` — project overview vs change plan (refine)
  - `plan/architecture.md` — architecture document format
  - `plan/modules/{name}.md` — module spec format (Provides, Requires, Boundary Rules)
  - `plan/execution-strategy.md` — mode, parallelism, worktrees, review cadence, groups, agent config
  - `plan/work-items/NNN-{name}.md` — work item format with all required sections
  - `reviews/incremental/NNN-{name}.md` — per-item review format
  - `reviews/final/{type}.md` — comprehensive review output formats
  - `reviews/final/summary.md` — synthesis format
  - `journal.md` — append-only, phase-tagged entries
- [ ] Each artifact entry specifies: purpose, format/schema, which phases read it, which phases write it, append-only vs overwrite semantics
- [ ] Work item numbering convention defined: 3-digit zero-padded, continuing from highest existing in refinement cycles
- [ ] Module spec format fully specified with examples
- [ ] Execution strategy format fully specified with all valid options
- [ ] Template examples provided for complex formats (work items, module specs, execution strategy)

## File Scope
- `specs/artifact-conventions.md` (create)

## Dependencies
- Depends on: 001
- Blocks: 005, 006, 007, 008

## Implementation Notes
This document is the contract that makes file-based coordination work. Every skill and agent must agree on file formats, locations, and semantics. Ambiguity here causes inter-phase failures.

Key conventions:
- All artifacts are Markdown
- `journal.md` is strictly append-only — no phase ever overwrites or edits existing entries
- Work items use 3-digit zero-padded numbers (001, 002, ... 999)
- Module specs use kebab-case names matching the module name in architecture.md
- Research files use topic-slug naming (kebab-case summary of the research topic)
- Execution strategy enumerates all valid options for each field
- Guiding principles deprecation: principles are never silently deleted — they are marked deprecated with rationale and date

The module spec format is new to v2 and must be defined precisely:
```markdown
# Module: {Name}

## Scope
{What this module is responsible for.}

## Provides
- `{interface/export}` — {brief description}

## Requires
- `{dependency}` (from: {module-name}) — {brief description}

## Boundary Rules
- {Rule about what this module may and may not do}

## Internal Design Notes
{Optional: implementation approach, data models, key algorithms}
```

## Complexity
Medium
