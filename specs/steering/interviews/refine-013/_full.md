## Refinement Interview — 2026-03-22

**Context**: Requirement evolution — user wants custom model support (Ollama) for ideate workflows.

**Q: What changes are you looking to make?**
A: Enhance support for custom models. Currently ideate has rules around using specific Anthropic models for specific tasks. User wants to easily override this behavior to use with Ollama.

**Q: Global model mapping (sonnet->X, opus->Y) vs per-agent/per-task granularity?**
A: Global mapping to start (per-project), stored in .ideate.json.

**Q: Where should configuration live?**
A: .ideate.json.

**Q: Three tiers (haiku/sonnet/opus) using existing frontmatter vocabulary — tier-based mapping in .ideate.json?**
A: Yes. Should also consider lightweight models like haiku. Tier-based mapping fits cleanly into frontmatter formats that currently exist.

**Q: Skills currently hardcode `claude-opus-4-6` — replacing with tier name `opus` loses ability to pin specific Anthropic model versions. Acceptable?**
A: No, we shouldn't lose that ability. Research how Claude Code handles custom models at runtime.

**[Research phase: researcher agent investigated Claude Code custom model support]**

**Q: Research found that `ANTHROPIC_DEFAULT_*_MODEL` env vars already remap tier aliases, and `ANTHROPIC_BASE_URL` handles endpoint routing. The proposed `.ideate.json` model config would duplicate existing Claude Code mechanisms while building on undocumented model string passthrough behavior. Technical analysis recommends documentation over code changes. Worth proceeding?**
A: Good reason not to proceed. Could always create a script to manage the env prior to starting up Claude.

**Q: Two things could still come out of this: (1) Documentation in README about custom model configuration via env vars, (2) Replacing hardcoded `claude-opus-4-6` with tier name `opus` so the existing env var mechanism works correctly. Proceed with both?**
A: Yes, do both.

**Q: Do existing guiding principles still hold?**
A: Yes.
