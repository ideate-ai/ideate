# Decisions: Agent System

## D-8: Eight agents defined in ideate: researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, proxy-human
- **Decision**: These eight agents cover all delegation needs for ideate's SDLC workflow; manager agent was moved to outpost in the architectural split.
- **Rationale**: Manager handles MCP team coordination — an orchestration concern, not an SDLC concern; proxy-human handles Andon events within brrr cycles, which is SDLC (archive/cycles/001/decision-log.md D5).
- **Source**: plan/architecture.md §1 Agents table, archive/cycles/001/decision-log.md D5
- **Status**: settled

## D-9: proxy-human has full authority except where guiding principles genuinely conflict or external information is required
- **Decision**: During autonomous brrr cycles, proxy-human makes binding Andon decisions; it must not rubber-stamp, must evaluate against guiding principles, and may only defer when two principles conflict or when external credentials/information are genuinely required.
- **Rationale**: The user specified "full authority — it uses the guiding principles as source of truth" in the 2026-03-10 interview; the agent is explicitly not a rubber-stamp.
- **Source**: specs/plan/work-items/036-proxy-human-agent.md AC5, specs/steering/interview.md (2026-03-10)
- **Status**: settled

## D-10: journal-keeper runs sequentially after the other three capstone reviewers complete
- **Decision**: In the review skill, code-reviewer, spec-reviewer, and gap-analyst run in parallel first; journal-keeper runs after they complete so it can synthesize their findings alongside the journal.
- **Rationale**: WI-019 was created specifically to fix this: the original parallel execution meant journal-keeper could not read the other reviewers' outputs (journal 2026-03-08 WI-019 entry).
- **Source**: specs/plan/work-items/019-review-skill-fix.md, journal.md [execute] 2026-03-08 WI-019
- **Status**: settled

## D-11: Researcher agent has Write tool access and saves findings directly to the specified artifact path
- **Decision**: Researcher writes its structured report to `steering/research/{topic-slug}.md` directly, rather than returning content to the invoking skill to write.
- **Rationale**: WI-020 was created to fix the original design: without Write access, the researcher had to return content inline, which the plan skill then had to handle conditionally; direct write is simpler and more consistent with artifact-directory coordination (journal 2026-03-08 WI-020 entry).
- **Source**: specs/plan/work-items/020-researcher-write-tool.md, journal.md [execute] 2026-03-08 WI-020
- **Status**: settled

## D-20: Stale artifact path references in agent definitions silently degrade every review cycle
- **Decision**: Three agent definitions (`agents/spec-reviewer.md`, `agents/gap-analyst.md`, `agents/journal-keeper.md`) reference `reviews/incremental/`, the pre-archive-layer path. The correct path is `archive/incremental/`. The stale references were not caught during path-cleanup work items in cycles 002 and 006 (WI-091 fixed artifact-conventions.md; WI-097 fixed skills/refine/SKILL.md; agent definitions were out of scope both times).
- **Rationale**: Cycle 006 gap-analyst elevated the finding to significant because the degradation compounds: every review cycle run by these three agents silently skips incremental review context, breaking the deduplication instruction in spec-reviewer and the synthesis instruction in journal-keeper.
- **Assumes**: Path cleanup work items must be scoped to cover all files that embed artifact directory path strings, not just the primary target file.
- **Source**: archive/cycles/006/gap-analysis.md SG2; archive/cycles/006/decision-log.md D16, OQ2
- **Policy**: P-19
- **Status**: settled
