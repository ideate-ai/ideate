## Verdict: Fail

`deleteStaleRows` uses raw SQL with table-name interpolation, violating a WI-154 acceptance criterion. Migration finding objects produced by `migrateArchiveCycles` omit required fields, producing corrupt records when indexed. All 101 tests pass.

## Critical Findings

None.

## Significant Findings

### S1: `deleteStaleRows` uses raw SQL with string-interpolated table names
- **File**: `mcp/artifact-server/src/indexer.ts:400,406`
- **Issue**: `deleteStaleRows` uses `db.prepare(\`SELECT id, file_path FROM ${table}\`)` and `db.prepare(\`DELETE FROM ${table} WHERE id = ?\`)` with the table name as a template literal variable. WI-154 acceptance criterion states: "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts." This criterion is unmet.
- **Impact**: The criterion was specifically added to eliminate the SQL injection vector that Drizzle ORM was adopted to fix. While `ALL_TYPED_TABLES` is an internal constant (not user-controlled), the criterion is absolute and the implementation violates it.
- **Suggested fix**: Replace with Drizzle `db.delete(table).where(eq(table.id, row.id))` after resolving the dynamic table reference using `TYPE_TO_DRIZZLE_TABLE`.

### S2: Migration finding objects omit `work_item` and `verdict` — produces corrupt indexed records
- **File**: `scripts/migrate-to-v3.ts:1034-1048`
- **Issue**: The `obj` literal produced in `migrateArchiveCycles` omits `work_item` and `verdict`. The findings table schema declares both as `NOT NULL`. When the indexer's `buildRow` processes these YAML files, it substitutes `toStrOrNull(doc.work_item) ?? ""` and `toStrOrNull(doc.verdict) ?? ""`, inserting empty-string values into NOT NULL columns. All migrated findings will have `work_item = ""` and `verdict = ""` in the index.
- **Impact**: MCP queries filtering by `work_item` or `verdict` on migrated findings return meaningless results. The migration produces structurally-valid YAML but semantically-corrupt data.
- **Suggested fix**: `migrateArchiveCycles` must extract `work_item` from the heading prefix (e.g., "NNN" from `### C1: title` in the context of a review file associated with a specific work item) and derive `verdict` from the review file's `## Verdict:` line.

## Minor Findings

### M1: `addressed_by` registry claims `domain_question` as a source type but `domainQuestions` table has no `addressed_by` column
- **File**: `mcp/artifact-server/src/schema.ts:EDGE_TYPE_REGISTRY`, `mcp/artifact-server/src/db.ts`
- **Issue**: `EDGE_TYPE_REGISTRY.addressed_by.source_types` includes `"domain_question"`, but the `domainQuestions` Drizzle table definition does not include an `addressed_by` column. The `findings` table has the column; `domainQuestions` does not.
- **Impact**: No runtime failure — `extractEdges` reads `doc.addressed_by` directly from YAML and creates a row in the `edges` table regardless of the column's presence. The column-based denormalization is simply absent for `domain_question` sources. Queries that look up `addressed_by` via the `domainQuestions` table column will find nothing.
- **Suggested fix**: Either add `addressed_by TEXT` to the `domainQuestions` table and the raw SQL schema, or remove `domain_question` from `EDGE_TYPE_REGISTRY.addressed_by.source_types`.

### M2: `user_version` pragma inside transaction — confirmed non-issue in better-sqlite3
- **File**: `mcp/artifact-server/src/schema.ts:~564`
- **Issue**: `db.pragma('user_version = ...')` is called inside a `db.transaction()` block. In standard SQLite, `PRAGMA user_version` changes are transactional when issued as SQL statements. Testing confirms better-sqlite3 handles this correctly — the pragma rolls back on transaction abort. Not a bug.
- **Note**: Investigated and confirmed non-issue. Documented here to close out the pre-review concern.

## Unmet Acceptance Criteria

- [ ] WI-154: "deleteStaleRows uses Drizzle delete().where() instead of raw SQL" — `deleteStaleRows` still uses `db.prepare(...)` with raw SQL.
- [ ] WI-154: "No column names or table names are interpolated as strings in SQL anywhere in indexer.ts" — lines 400 and 406 in `deleteStaleRows` interpolate table names via template literals.
