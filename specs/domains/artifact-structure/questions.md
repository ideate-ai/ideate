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
- **Status**: open
- **Reexamination trigger**: Next time ideate is opened in Claude Code for development work.
