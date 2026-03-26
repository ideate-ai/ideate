# Refine Interview — Cycle 024 (General)

**Date**: 2026-03-25
**Context**: Post-cycle-023 cleanup. User resolved two open questions requiring decisions.

**Q: Q-44 — Which journal migration layout is authoritative?**
A: YAML should be the source of truth. handleAppendJournal should write per-entry YAML files to .ideate/cycles/{NNN}/journal/. journal.md is no longer written by the tool.

**Q: Q-51 — Does the "No interpolation" criterion apply to detectCycles?**
A: Yes — convert detectCycles to Drizzle. Raw SQL isn't a great habit to be in.

**Q: Q-79 — Write tools YAML serialization uses string concatenation?**
A: False positive. handleWriteWorkItems already uses stringifyYaml (yaml library) at line 473. Closed.
