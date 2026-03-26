## Refinement Interview — 2026-03-23

**Context**: Phase 1 of v3 architecture overhaul — YAML schema, SQLite runtime index, rebuild pipeline, migration script. Continuing from the v3 direction decided earlier in the refine-016 session. 7 research reports already complete.

**Q: Guiding principles still hold?**
A: Yes.

**Q: Existing 7 MCP read tools — rewrite against new index in this phase, or remove and recreate later?**
A: Remove them entirely. They were built against the markdown backend. Recreate intentionally as needed in later phases. If they're not needed for this phase, they shouldn't exist.

**Q: Directory structure — mirror current specs/ layout or reorganize?**
A: Create `.ideate/` directory at project root alongside `.git/`. Type-organized directories (work-items/, findings/, policies/) instead of phase-organized (steering/, plan/, archive/).

**Q: Coexistence with old format during transition?**
A: Hard cutover. No coexistence. Migration converts once, new format is source of truth. Skills break until Phase 4 — accepted.

**Q: Artifact format — YAML with markdown body, or pure YAML?**
A: YAML everywhere. No markdown bodies. Markdown is human-readable but YAML is more compact and easier to parse. Create tools to convert to human-readable markdown for reporting tasks.

**Q: Journal — database-only or flat file?**
A: Flat YAML file. SQLite is purely for fast lookups and indexing.

**Q: Archive structure — type-organized or cycle-organized?**
A: Keep archive/cycles/{NNN}/ for cycle-scoped review artifacts to avoid massive directories. Everything is indexed in SQLite for cross-cycle queries.
