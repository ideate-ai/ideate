## Verdict: Fail

One WI-154 acceptance criterion is unmet: `deleteStaleRows` uses raw SQL with table-name interpolation. WI-144 contains stale criterion text referencing superseded edge type names. The Drizzle write path is consistent with Principle 8 — the MCP server's role is to build the SQLite index from YAML, which is the intended architecture.

## Architecture Adherence

The cycle 017 implementation aligns with the architecture. The MCP server component correctly reads YAML artifacts and maintains a SQLite runtime index. The Drizzle ORM integration (WI-154) replaces raw SQL in the write path (upsertRow, upsertEdge, upsertFileRef). Edge type registry in schema.ts is consistent with what indexer.ts extracts from YAML. Directory structure in config.ts IDEATE_SUBDIRS now lists `cycles` instead of `archive/cycles`, matching the WI-155 design decision.

## Principle Adherence

**Principle 8 (Durable Knowledge Capture)**: Not violated. The Drizzle write path writes to SQLite as part of rebuilding the derived index. The MCP server's explicit purpose is: read YAML → write SQLite index. This is the intended design, not a bypass of the YAML-source-of-truth principle.

**Principle 4 (Parallel-First Design)**: Not applicable to this cycle.

**All other principles**: No violations found.

## Constraint Adherence

**Constraint 2 (File-based coordination)**: The indexer reads YAML and writes SQLite. This is consistent with "each skill reads what it needs from artifacts — either directly from YAML files or via MCP tools backed by the SQLite runtime index." The MCP server is the tool that maintains the SQLite index; this does not violate the constraint.

## Unmet Acceptance Criteria

### WI-154: deleteStaleRows raw SQL
- [ ] "deleteStaleRows uses Drizzle delete().where() instead of raw SQL" — `indexer.ts:396-417` still uses `db.prepare(...)` with two raw SQL statements containing string-interpolated table names.
- [ ] "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts" — lines 400 and 406 violate this criterion.
- **Note**: `detectCycles` (lines 425-427) also uses raw SQL, but the WI-154 criteria do not explicitly require Drizzle for read-only operations. The "No interpolation" criterion is broader and does cover `deleteStaleRows`. `detectCycles` is a read path and the criterion may not have been intended to apply to it, but the text is unambiguous.

### WI-144 (residual): Stale edge type names in criterion text
- [ ] WI-144 criterion at `plan/work-items.yaml` line ~1465 still lists `addresses` and `amends` as edge type names. WI-153 renamed these to `addressed_by` and `amended_by`. WI-159 updated the `idx_edges_composite` criterion in WI-144 but did not update the edge type names. The implementation is correct per WI-153; the spec text is stale.

## Naming and Consistency Issues

### Two exports named `CURRENT_SCHEMA_VERSION`
- `mcp/artifact-server/src/config.ts` exports `CURRENT_SCHEMA_VERSION = 2` (IdeateConfig JSON schema version)
- `mcp/artifact-server/src/schema.ts` exports `CURRENT_SCHEMA_VERSION = 3` (SQLite user_version)
- These are distinct versioning schemes for different scopes. Not a functional conflict. However, a consumer importing both would encounter a name collision. This is a minor naming clarity issue — the constants should have distinct, scope-indicating names (e.g., `CONFIG_SCHEMA_VERSION` and `DB_SCHEMA_VERSION`).

## Implementation vs Spec Notes

**WI-155 cycle directory change**: The architecture document has not been updated to reflect the `cycles/` (flat) vs `archive/cycles/` (nested) change made in WI-155. `plan/architecture.md` may still reference the old layout. This creates a documentation-implementation divergence that will confuse future workers reading the architecture.

**WI-151 log message**: The startup log in `index.ts` uses `stats.files_scanned` which may not match the field name specified in WI-151 acceptance criteria. Minor.
