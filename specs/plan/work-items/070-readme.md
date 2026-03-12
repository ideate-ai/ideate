# 070: Write README

## Objective
Replace `README.md` with comprehensive documentation of the full ideate artifact system, methodology, and skill reference — serving as the primary reference for practitioners using ideate.

## Acceptance Criteria
- [ ] README.md at project root documents: what ideate is, artifact directory structure (annotated tree), domain layer (policies/decisions/questions formats, GP→domain policy derivation, granularity guidelines), archive (immutability, archive vs. domain relationship, tracing a policy to its origin), interview structure (per-cycle per-domain files, _full.md, citation format, context loading table), domain curator (when it runs, what it does, policy-grade threshold, conflict handling, bootstrapping), review modes (full table of invocations/agents/output), skill reference (one section per skill with context loaded + what it writes + domain interaction), plan artifact decay, migration guide, worked example
- [ ] Worked example is concrete: uses real file snippets, traces one full cycle from plan through curator run
- [ ] Tone is factual and direct — no marketing language, no hedging

## File Scope
- `README.md` (modify)

## Dependencies
- Depends on: 063, 064, 066, 067, 068, 069
- Blocks: none

## Complexity
High
