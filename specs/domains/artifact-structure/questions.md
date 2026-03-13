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
- **Status**: open
- **Reexamination trigger**: Next refinement cycle; user confirmation needed.

## Q-13: Schema version 1 structural invariants not defined
- **Question**: `manifest.json` documents `schema_version: 1` but no artifact enumerates which files, directories, and structural invariants constitute a v1-compliant artifact directory. Without this definition, migration scripts cannot determine what to upgrade.
- **Source**: archive/cycles/003/decision-log.md OQ5; archive/cycles/003/gap-analysis.md MR2, MI1
- **Impact**: The manifest's stated purpose (enabling targeted migration) is not achievable until v1 is defined.
- **Status**: open
- **Reexamination trigger**: When the first migration script is being written.
