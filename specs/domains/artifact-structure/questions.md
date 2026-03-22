# Questions: Artifact Structure

## Q-4: Five work item number prefixes have duplicate files (055, 056, 059, 060, 061)
- **Question**: Work items 055, 056, 059, 060, and 061 each have two files in `specs/plan/work-items/` (e.g., `055-move-roles-system.md` and `055-move-roles-to-outpost.md`). Should superseded draft files be deleted, retaining only the executed version?
- **Source**: archive/cycles/001/gap-analysis.md IN1, archive/cycles/001/decision-log.md D7+OQ4
- **Impact**: The execute and brrr skills glob `plan/work-items/*.md` and match journal entries and review files by number prefix; duplicate prefixes create ambiguous ordering for five numbers on any future execution run.
- **Status**: open
- **Reexamination trigger**: Next attempt to run `/ideate:execute` or `/ideate:brrr` against these specs; gap analyst rated this "address now."

## Q-5: CLAUDE.md absent from the ideate repository root
- **Question**: Outpost received a `CLAUDE.md` as a first-class deliverable (WI-052 AC2). ideate has none. Should one be created covering plugin purpose, skill and agent directory layout, artifact directory convention, and development workflow?
- **Source**: archive/cycles/001/gap-analysis.md G2, archive/cycles/001/decision-log.md OQ3
- **Impact**: Developers opening ideate in Claude Code have no project-level context; the "dogfood" workflow (using ideate to improve itself) is degraded; violates GP-8 (Durable Knowledge Capture) at the project entry point.
- **Status**: resolved
- **Resolution**: CLAUDE.md now exists at the ideate repository root; cycle 003 gap-analysis references it as an existing file requiring updates.
- **Resolved in**: cycle 003

## Q-12: Ad-hoc migration scripts not removed despite interview intent
- **Question**: The refine-003 interview stated `scripts/migrate-to-cycles.sh` and `scripts/migrate-to-domains.sh` "will be removed." No work item was created and the scripts remain on disk. The README Migration section still documents `migrate-to-domains.sh`. Should they be removed in the next cycle?
- **Source**: archive/cycles/003/decision-log.md D6, OQ4; archive/cycles/003/gap-analysis.md MR1
- **Impact**: Stale scripts and documentation persist; user decision required to confirm removal intent and scope.
- **Status**: resolved
- **Resolution**: Both scripts deleted and artifact-conventions.md stale path references fixed by WI-091 in cycle 006.
- **Resolved in**: cycle 006

## Q-13: Schema version 1 structural invariants not defined
- **Question**: `manifest.json` documents `schema_version: 1` but no artifact enumerates which files, directories, and structural invariants constitute a v1-compliant artifact directory. Without this definition, migration scripts cannot determine what to upgrade.
- **Source**: archive/cycles/003/decision-log.md OQ5; archive/cycles/003/gap-analysis.md MR2, MI1
- **Impact**: The manifest's stated purpose (enabling targeted migration) is not achievable until v1 is defined.
- **Status**: open
- **Reexamination trigger**: When the first migration script is being written.

## Q-16: findings.by_reviewer.{reviewer}.suggestion has no consumer
- **Question**: The `suggestion` key was added to `by_reviewer` sub-objects during WI-093 rework for schema symmetry with `by_severity`. Should it be retained as-is, or should derivation rules explicitly document that `by_reviewer.suggestion` is populated but intentionally has no current consumer?
- **Source**: archive/cycles/006/decision-log.md D10, OQ3; archive/cycles/006/summary.md Minor M4
- **Impact**: No functional failure. Undocumented schema intent accumulates as technical debt: future implementers cannot determine whether the field is reliably populated or safely ignorable.
- **Status**: open
- **Reexamination trigger**: When a consumer of `by_reviewer` is being built, or when the derivation rules for quality_summary are next revised.

## Q-17: skills/refine/SKILL.md inline metrics schema omits the cycle field
- **Question**: Should `skills/refine/SKILL.md:373` add `"cycle": null` between `"phase"` and `"agent_type"` to match the canonical schema in `specs/artifact-conventions.md:719`?
- **Source**: archive/cycles/006/decision-log.md OQ4; archive/cycles/006/code-quality.md M4
- **Impact**: Refine skill entries written without a `cycle` field are bucketed as `(none)` by report.sh — a distinct bucket from entries that write `"cycle": null`. The per-cycle breakdown in report.sh may split a single logical bucket into two rows for any project that uses the refine skill.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; one-line fix to the inline schema example.

## Q-18: report.sh is absent from README.md and both plugin manifests
- **Question**: Should `README.md` include a section documenting `scripts/report.sh`, analogous to the existing Validation and Migration Tools section? Should the plugin manifests also reference it?
- **Source**: archive/cycles/006/gap-analysis.md MG3; archive/cycles/006/decision-log.md OQ7
- **Impact**: A user installing ideate has no documented path to discover the reporting script. The observability feature delivered by WI-094 is invisible at the user-facing entry point; the only reference is an internal citation in `specs/artifact-conventions.md`.
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; additive README section, no design decision required.
