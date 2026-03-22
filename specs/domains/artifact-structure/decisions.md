# Decisions: Artifact Structure

## D-5: All artifact files are Markdown; no binary or structured-data formats in the artifact directory
- **Decision**: Every artifact (steering docs, plan files, reviews, journal) is a Markdown file; structure is expressed through headings, lists, and fenced code blocks, not JSON or YAML files.
- **Rationale**: Markdown files are human-readable and auditable, which the interview established as a requirement ("artifacts should be readable and auditable"); they are also directly usable as agent input without parsing.
- **Source**: specs/plan/work-items/011-artifact-conventions.md, specs/steering/interview.md (2026-03-08)
- **Status**: settled
- **Amended**: cycle 003 — manifest.json is a deliberate exception; see D-17.

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

## D-17: manifest.json is the artifact directory schema version marker
- **Decision**: Every artifact directory contains a `manifest.json` at its root with `{"schema_version": N}`. This is the sole non-Markdown file in the artifact directory, amending D-5. The manifest is informational only — no skill checks or enforces the version at runtime. Migration scripts read it; the workflow does not.
- **Rationale**: Two prior breaking schema changes required ad-hoc migration scripts. A persistent version marker lets future migration scripts detect the schema version and apply targeted upgrades without guessing directory structure.
- **Assumes**: Schema version 1 represents the current artifact directory layout; prior migrations are not retroactively numbered.
- **Source**: archive/cycles/003/decision-log.md D1, D3, D4
- **Status**: settled

## D-18: Skills are not versioned and do not enforce version compatibility
- **Decision**: Versioning applies only to the artifact directory schema. Skills do not carry version numbers and do not check `schema_version` at invocation time.
- **Rationale**: Skills do not yet need migration or quality gates; keeping versioning scope narrow reduces complexity.
- **Source**: archive/cycles/003/decision-log.md D2
- **Status**: settled

## D-21: The canonical key for artifact directory in .ideate.json is artifactDir (camelCase)
- **Decision**: The `.ideate.json` configuration file uses `artifactDir` (camelCase) as the key for the artifact directory path. Any script, skill, or documentation that reads or documents this key must use camelCase. Snake_case (`artifact_dir`) is incorrect and caused two critical bugs in the cycle 004 capstone review of report.sh.
- **Rationale**: WI-095 was created specifically to fix a snake_case/camelCase mismatch introduced in the WI-094 planning note. All skills consistently use `artifactDir`; the planning note for report.sh auto-discovery used `artifact_dir`, which was not caught during planning.
- **Source**: archive/cycles/006/decision-log.md D6; archive/cycles/006/review-manifest.md (WI-095 entry)
- **Status**: settled

## D-22: quality_summary event stores severity counts at findings.by_severity, not at top level
- **Decision**: The `quality_summary` event in `metrics.jsonl` stores per-severity counts nested under `findings.by_severity.{critical,significant,minor,suggestion}` and per-reviewer breakdowns under `findings.by_reviewer.{reviewer}.{severity}`. Severity counts are not present at the top level of the event object.
- **Rationale**: The nested structure was specified in WI-093 and documented in `specs/artifact-conventions.md`. Consumers (e.g., report.sh) must read `findings.by_severity.*` — a top-level severity key will always be absent.
- **Assumes**: The `by_reviewer` sub-objects include `suggestion` for schema symmetry; no current consumer parses `by_reviewer` (see Q-16).
- **Source**: archive/cycles/006/decision-log.md D3, D10; archive/cycles/006/gap-analysis.md SG1
- **Status**: settled

## D-26: WI-112 rework set quality_summary skill field to "review" — contradicts artifact-conventions.md
- **Decision**: During WI-112 execution, the `skill` field in the brrr-emitted quality_summary event was changed from `"brrr"` to `"review"`, documented as "for schema parity" with the standalone review skill. This contradicts `artifact-conventions.md:735`, which specifies the field should be `"review"` or `"brrr"` depending on the emitter.
- **Rationale**: Documented in `archive/incremental/112-brrr-review-quality-summary.md` as a schema parity choice. The capstone gap-analyst flagged this as significant because it defeats per-skill attribution in report.sh.
- **Source**: archive/cycles/003/decision-log.md D6, OQ1; archive/cycles/003/gap-analysis.md II1
- **Status**: settled
- **Amended**: cycle 004 — WI-113 changed the field back to `"brrr"`, resolving the contradiction. See D-27.

## D-27: WI-113 resolved quality_summary skill field contradiction
- **Decision**: Changed `"skill":"review"` to `"skill":"brrr"` at `skills/brrr/phases/review.md:235`, aligning with the canonical two-value enum in `artifact-conventions.md:735`. This closes the D-26 provisional status and resolves Q-14.
- **Rationale**: `artifact-conventions.md` specifies the `skill` field as `"review"` or `"brrr"` depending on emitter. The WI-112 "schema parity" rationale was incorrect — it defeated per-skill attribution in report.sh.
- **Source**: archive/cycles/004/decision-log.md D1, CR1
- **Status**: settled

## D-28: report.sh reads flat severity keys but quality_summary nests them under findings.by_severity
- **Decision**: `scripts/report.sh` lines 207-209 and 376-378 read `qe.get('critical', 0)` directly from the quality_summary event, but WI-093 defined the schema with severity counts nested at `findings.by_severity.{critical,significant,minor}`. Both the Per-Cycle Breakdown and Quality Trends sections silently display zeros. WI-114 will fix both locations.
- **Rationale**: Root cause is a spec-level inconsistency: WI-094's planning note implied flat keys while WI-093's SKILL.md defined nested structure. The executor implemented conflicting assumptions from two separately-planned work items.
- **Source**: archive/cycles/004/code-quality.md C1, C2; archive/cycles/004/spec-adherence.md S1; archive/cycles/004/decision-log.md D3
- **Status**: settled

## D-29: report.sh auto-discovery reads snake_case key, second instance of the D-21 pattern
- **Decision**: `discover_metrics()` at `scripts/report.sh:83` reads `config.get('artifact_dir')` (snake_case). All skills and the MCP server write `artifactDir` (camelCase). Auto-discovery fails for every real project. WI-114 will fix the lookup to accept both forms.
- **Rationale**: This is the same class of bug as D-21 (the WI-095 fix). The WI-094 planning note used snake_case; the codebase convention is camelCase. Planning did not cross-reference D-21 when specifying report.sh.
- **Source**: archive/cycles/004/code-quality.md S1; archive/cycles/004/spec-adherence.md S2; archive/cycles/004/decision-log.md D4
- **Status**: settled

## D-30: metrics.jsonl absent from artifact-conventions.md despite being written by all five skills
- **Decision**: `artifact-conventions.md` is the authoritative artifact schema reference but has no entry for `metrics.jsonl` — neither in the directory tree nor in a schema section. WI-092 and WI-093 extended the metrics schema without corresponding documentation in the conventions file. WI-115 will add both the directory tree entry and a full specification section.
- **Rationale**: The gap-analyst rated this significant because `artifact-conventions.md` is the first place a new contributor looks for artifact schemas. A file written by all five skills and consumed by report.sh must appear there.
- **Source**: archive/cycles/004/gap-analysis.md G-S1; archive/cycles/004/code-quality.md M2; archive/cycles/004/decision-log.md D5
- **Status**: settled

## D-32: Cycle 005 confirmed all seven cycle 004 findings resolved
- **Decision**: All three reviewers (code-quality, spec-adherence, gap-analyst) returned Pass with zero critical and zero significant findings. The seven cycle 004 findings targeted by WI-095, WI-096, and WI-097 are confirmed fixed: report.sh severity key path (C1/C2), auto-discovery key name (S1/S2), fmt_ms zero handling (OQ5), metrics.jsonl documentation gap (G-S1), and stale refine paths (M1).
- **Rationale**: Cycle 005 was a targeted correction cycle (brrr cycle 2) with no new features or design changes. All acceptance criteria met. Three minor documentation gaps remain as carry-forward items (Q-22, Q-23, Q-15 reopened).
- **Source**: archive/cycles/005/summary.md; archive/cycles/005/decision-log.md D6
- **Status**: settled
