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

## D-25: Domain-curator performs RAG deduplication check before creating new policies
- **Decision**: The domain-curator agent uses MCP semantic search against existing domain policy files before writing a new policy entry, to detect near-duplicate or overlapping policies that should be amended rather than duplicated.
- **Rationale**: Decided during refine-008 interview to prevent policy accumulation as the domain layer grows across cycles.
- **Source**: archive/cycles/003/decision-log.md D3
- **Status**: settled

## D-38: code-reviewer.md not updated when startup-failure protocol changed in cycle 009
- **Decision**: WI-121 replaced the unconditional-Andon startup-failure rule with a diagnose-and-fix protocol in the two skill files and P-22, but `agents/code-reviewer.md` (~line 91) was explicitly excluded from scope. The code-reviewer agent still instructs that startup failure is "scope-changing — this is an Andon-level issue," contradicting the new protocol.
- **Rationale**: The scoping decision (D-36) treated the code-reviewer update as secondary. The gap analyst rated this Significant because the code-reviewer is used in every execution cycle and its incorrect description of expected downstream handling creates a documented inconsistency.
- **Source**: archive/cycles/009/gap-analysis.md SG1; archive/cycles/009/decision-log.md DL-2, DL-4
- **Status**: settled

## D-40: code-reviewer.md updated to describe diagnose-and-fix protocol, closing Q-28
- **Decision**: WI-122 replaced the stale phrase "treat it as scope-changing — this is an Andon-level issue" at `agents/code-reviewer.md:91` with language describing the current protocol: "The executor will diagnose the root cause and attempt a surgical fix before routing to Andon if the cause is unfixable." The finding title convention ("Startup failure after [work item name]") was preserved.
- **Rationale**: D-38 documented the inconsistency; D-36 had explicitly deferred this file as secondary. The gap analyst rated it Significant because the code-reviewer is invoked in every execution cycle and its stale instructions would lead any code-reviewer agent to describe the wrong expected executor behavior.
- **Source**: archive/cycles/010/decision-log.md D-40; archive/cycles/010/spec-adherence.md WI-122
- **Status**: settled

## D-47: code-reviewer.md smoke test generalized from startup-command-specific to context-appropriate demo heuristic
- **Decision**: WI-126 replaced the startup-specific smoke test instruction in `agents/code-reviewer.md:84-92` with a heuristic based on "what would a reasonable person be expected to do to demo the work they just did?" Five example types are listed as non-exhaustive: startup command, CLI --help/--version, library build/test suite, e2e test, and config/doc validation.
- **Rationale**: The prior agent instruction assumed every project has a startup command, making the smoke test step structurally inert for library projects, CLI tools, and documentation-only work items. The demo heuristic resolves Q-27 without enumerating an exhaustive type list and aligns with GP-9 (Domain Agnosticism).
- **Assumes**: The code-reviewer determines the appropriate smoke test from context at review time; the five listed examples are illustrative, not exhaustive.
- **Source**: archive/cycles/011/decision-log.md D-44; archive/cycles/011/review-manifest.md WI-126
- **Status**: settled

## D-50: Hardcoded `claude-opus-4-6` model IDs replaced with tier alias `opus` across all skill files
- **Decision**: WI-130 replaced all 12 occurrences of the hardcoded model string `claude-opus-4-6` with the tier alias `opus` in 5 files (skills/plan/SKILL.md, skills/refine/SKILL.md, skills/review/SKILL.md, skills/brrr/phases/execute.md, specs/plan/architecture.md). This makes `ANTHROPIC_DEFAULT_OPUS_MODEL` env var work correctly for version pinning and custom model routing.
- **Rationale**: Hardcoded model IDs bypass Claude Code's env var mechanism for model selection. P-11 already establishes that model defaults are set in frontmatter and overrides are applied at spawn time — but the override values themselves were specific model IDs rather than tier aliases, defeating the env var indirection.
- **Source**: archive/cycles/013/decision-log.md D-47; archive/cycles/013/review-manifest.md WI-130
- **Status**: settled
