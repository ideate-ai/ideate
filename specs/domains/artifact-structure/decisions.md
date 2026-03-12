# Decisions: Artifact Structure

## D-5: All artifact files are Markdown; no binary or structured-data formats in the artifact directory
- **Decision**: Every artifact (steering docs, plan files, reviews, journal) is a Markdown file; structure is expressed through headings, lists, and fenced code blocks, not JSON or YAML files.
- **Rationale**: Markdown files are human-readable and auditable, which the interview established as a requirement ("artifacts should be readable and auditable"); they are also directly usable as agent input without parsing.
- **Source**: specs/plan/work-items/011-artifact-conventions.md, specs/steering/interview.md (2026-03-08)
- **Status**: settled

## D-6: Module spec layer is optional for small projects
- **Decision**: Projects with fewer than 5 logical components skip the `plan/modules/*.md` layer and decompose directly from architecture to work items; the module layer is required when components have non-trivial interfaces between them.
- **Rationale**: Constraint C-8 (Progressive Decomposition) requires the tool to detect scale and skip intermediate levels when unnecessary to avoid overhead on small projects.
- **Source**: plan/architecture.md §6 (When to Use Modules), constraint C-8
- **Status**: settled

## D-7: specs/artifact-conventions.md is plugin documentation, not a per-project artifact
- **Decision**: The canonical artifact format reference lives in the plugin's own `specs/` directory, not inside a user project's artifact directory.
- **Rationale**: Format conventions apply globally to all projects using ideate; per-project duplication would diverge; the conventions file is a plugin-level contract.
- **Assumes**: Users can locate the conventions file by examining the plugin directory.
- **Source**: specs/plan/work-items/011-artifact-conventions.md (File Scope note)
- **Status**: settled
