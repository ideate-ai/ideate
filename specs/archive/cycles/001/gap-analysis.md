# Gap Analysis — Cycle 001 (brrr)

**Scope**: WI-101 (Fix residual documentation inconsistencies). Full review cycle.

## Verdict: Pass

No critical or significant gaps. One minor gap found: `brrr/phases/review.md` hardcodes the legacy interview path without the `steering/interviews/` fallback used by the review skill.

## Missing Requirements

None critical or significant.

## Unhandled Edge Cases

None critical or significant.

## Incomplete Integrations

None critical or significant.

## Missing Infrastructure

None critical or significant.

## Minor Gaps

### MG1: `skills/brrr/phases/review.md` passes `steering/interview.md` without `steering/interviews/` fallback

- **Location**: `skills/brrr/phases/review.md:143` and `:171` — gap-analyst and journal-keeper prompts both reference `{artifact_dir}/steering/interview.md` only.
- **Context**: `skills/review/SKILL.md:309` correctly handles both paths: "read `{artifact-dir}/steering/interview.md` or the latest refine interview file from `{artifact-dir}/steering/interviews/` if that directory exists." The brrr phase document hardcodes only the legacy path.
- **Impact**: For projects that have migrated to the `steering/interviews/` structure (including ideate's own `specs/` directory, which has no `interview.md`), the gap-analyst and journal-keeper spawned by brrr will receive a path to a non-existent file. They may find nothing, silently skip interview requirements context, or need to discover the interviews directory themselves.
- **Severity**: Minor — agents can adapt by checking the filesystem, and the domain layer provides equivalent context for most purposes.
- **Recommendation**: Update both agent prompt blocks in `brrr/phases/review.md` to mirror the dual-path instruction used in `skills/review/SKILL.md:309`.

### MG2: `specs/plan/architecture.md` does not list `domain-curator` agent

- **Location**: `specs/plan/architecture.md` §1 Agents table
- **Context**: The domain-curator agent (`agents/domain-curator.md`) is invoked by the review skill after journal-keeper. It was added after the architecture document was last updated.
- **Impact**: Documentation staleness — a developer reading only the architecture document would not know the ninth agent exists.
- **Severity**: Minor — the README, review skill, and domain files all document it correctly.
- **Recommendation**: Add domain-curator row to the agents table in `specs/plan/architecture.md`.
