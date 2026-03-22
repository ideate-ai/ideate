# Refinement Interview — 2026-03-20 — Cross-Cutting

**Context**: Cycle 003 closed with no critical findings and three significant findings (all manifest.json documentation propagation gaps). This refinement addresses those gaps, adds a metrics schema extension for token and RAG tracking, adds quality event emission from the review skill, and introduces a reporting script.

---

**Q: Are you here to address the cycle 003 findings, extend the project, or both?**
A: Both — address the cycle 003 findings and add new metrics/reporting capabilities.

**Q: Do the guiding principles still hold?**
A: Yes, all principles unchanged.

**Q: Confirm migration script removal — migrate-to-cycles.sh and migrate-to-domains.sh should be deleted along with the README migration section?**
A: Yes, confirmed.

**Q: What form should the metrics tooling take?**
A: Shell script in scripts/ outputting a human-readable report with actionable insights about how well the tool is working.

**Q: Extending the metrics schema to capture token counts — is that acceptable?**
A: Yes, these are valuable metrics. Token fields, cache fields, and MCP tools called per agent spawn.

**Q: For qualitative metrics (requirements missed, bugs introduced, principles violated) — the review skill already produces structured findings. Should it emit a quality event to metrics.jsonl after each cycle?**
A: Yes, that works. Open to other suggestions as they arise.

**Q: For RAG vs flat-file tracking — skill/phase level or per-agent-spawn level?**
A: Both — skill/phase is important, and understanding how well individual agents perform. Per-agent-spawn granularity with skill/phase context.
