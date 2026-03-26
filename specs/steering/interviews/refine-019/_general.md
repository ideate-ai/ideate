## Refinement Interview — 2026-03-24

**Context**: Cycle 018 execution surfaced an Andon cord issue: three archive types (`decision_log`, `cycle_summary`, `review_manifest`) produced by the migration script have no registered schema in the indexer and are silently dropped. Codebase analysis revealed nine additional unregistered types with the same problem. User directed: formally define all unregistered types with strict schemas; nothing should be dropped.

**Q: The 10 unregistered types all share the same shape — content blobs with optional title and cycle fields. Should they each get a separate table, or share a single `document_artifacts` table with the `type` field distinguishing them?**
A: A single `document_artifacts` table with a type enum makes sense.

**Q: `module_spec` has an existing table but the migration populates it with `title`+`content` instead of the structured fields `name`, `scope`, `provides`, `requires`, `boundary_rules`. Should this cycle fix the migration to output the correct structured fields?**
A: Yes. We should have a structured schema. Fix this to match the intention of having strict structure for easy parsing.
