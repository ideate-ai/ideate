# Refinement Interview — 2026-03-21

**Context**: Critical analysis of ideate plugin quality and token usage identified 5 quality improvements, 5 token efficiency wins, and 3 structural risks. User confirmed all items. This cycle addresses quality improvements and structural risks. Token efficiency deferred to Cycle B.

---

**Q: Do the guiding principles still apply as-is?**
A: Yes, all 12 principles hold unchanged.

**Q: For proxy-human deferrals in brrr — should significant deferrals interrupt the loop or just be logged?**
A: Andon behavior should be mode-relative. In brrr, log deferrals visibly (in cycle status messages and the activity report) without interrupting the loop. The existing interrupt-and-ask behavior stays for standalone execute.

**Q: Should quality improvements and token efficiency go in one cycle or split?**
A: Split. Cycle A covers quality improvements and structural risks. Token efficiency (context package to file, lazy research loading, metrics schema dedup, refine architect skip, brrr refine dedup) deferred to Cycle B.

**Q: Any constraint on the RAG/MCP tooling?**
A: Continue using the RAG (ideate MCP artifact server) to keep the domain layer clean — specifically, domain-curator should use semantic search before writing new policies to detect duplicates.

**Q: Any scope boundaries?**
A: All changes are to markdown files (skill definitions, agent definitions, artifact conventions). No code changes. No changes to steering/guiding-principles.md or steering/constraints.md.
