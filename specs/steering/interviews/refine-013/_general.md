## Refinement Interview — 2026-03-22 (General)

**Context**: Custom model support investigation led to documentation-only approach after technical analysis showed existing Claude Code env vars already solve the problem.

**Q: Global model mapping vs per-agent granularity?**
A: Global mapping per-project in .ideate.json.

**Q: Tier-based mapping using haiku/sonnet/opus vocabulary?**
A: Yes, three tiers using existing frontmatter vocabulary.

**Q: After research and critical analysis — is the `.ideate.json` model config feature worth building given Claude Code's existing env var support and undocumented passthrough behavior?**
A: No. Documentation + hardcoded model string cleanup instead.

**Q: Principles still hold?**
A: Yes, all unchanged.
