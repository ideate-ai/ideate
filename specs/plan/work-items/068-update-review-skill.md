# 068: Update review skill with mode selector and curator phase

## Objective
Rewrite `skills/review/SKILL.md` to support multiple review modes (cycle, domain, full audit, ad-hoc), use mode-aware context loading, write output to the new archive paths, and spawn the domain curator as a final phase.

## Acceptance Criteria
- [ ] Phase 1 replaced with mode selector: parses artifact dir + flags (no args = cycle, --domain, --full, natural language = ad-hoc); determines output directory
- [ ] Phase 2 replaced with mode-aware context loading (2.1 always, 2.2 cycle, 2.3 domain, 2.4 full, 2.5 ad-hoc, 2.6 source survey); includes legacy fallback
- [ ] Phase 3 sets output directory from mode (archive/cycles/{N}/, archive/adhoc/{date-slug}/)
- [ ] Phase 4a reviewer prompts updated to use {output-dir}/ and archive/incremental/
- [ ] Phase 4b journal-keeper updated to use {output-dir}/ and archive/incremental/
- [ ] Phase 5 and Phase 6 paths updated to {output-dir}/
- [ ] New Phase 7: Spawn Domain Curator — eligibility check (always for cycle, conditional for ad-hoc), spawns domain-curator with model: claude-opus-4-6, updates domains/index.md after completion
- [ ] Old Phase 7 renumbered to Phase 8, old Phase 8 to Phase 9
- [ ] Curator: {ran | skipped} added to journal entry format
- [ ] Error handling updated with curator failure case and archive path corrections
- [ ] Frontmatter description and argument-hint updated to reflect mode selector

## File Scope
- `skills/review/SKILL.md` (modify)

## Dependencies
- Depends on: 063
- Blocks: 071

## Complexity
High
