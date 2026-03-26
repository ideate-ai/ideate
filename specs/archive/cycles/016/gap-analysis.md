## Summary

Three significant gaps: the migration script omits three of its fifteen acceptance criteria (journal, archive cycles, metrics); the watcher's ignored pattern makes incremental rebuild non-functional; and `rebuildIndex` provides no error signal when YAML files fail to parse. Three minor gaps: no schema-migration path for existing databases, silent YAML parse failures produce no diagnostic, and the `addresses`/`amends` edge types have no extraction mechanism.

---

## Missing Requirements

### G1 (Significant): Migration script omits journal, archive cycle, and metrics conversion steps
- **Source**: WI-146 acceptance criteria
- **Gap**: `runMigration` calls six functions (`writeConfig`, `migrateGuidingPrinciples`, `migrateConstraints`, `migrateWorkItems`, `migrateDomains`, `migrateResearch`). Three WI-146 criteria are absent:
  - Convert `archive/cycles/{NNN}/*.md` to `.ideate/archive/cycles/{NNN}/` YAML
  - Convert `journal.md` to `.ideate/journal.yaml` (array of journal_entry documents)
  - Copy `metrics.jsonl` to `.ideate/metrics.jsonl`
- **Impact**: Running the migration against the live `specs/` directory produces an incomplete `.ideate/` directory. The SQLite index will contain no journal entries, no archive-cycle findings, and no metrics events. MCP tools that query these tables (Phase 2) will return empty results for historical data.

### G2 (Significant): Watcher never fires for `.ideate/` changes — incremental rebuild is absent
- **Source**: WI-145 acceptance criteria; architecture doc section "SQLite rebuild pipeline"
- **Gap**: The `ignored: /(^|[/\\])\../` pattern in `watcher.ts:24` causes chokidar to treat `.ideate/` itself as a hidden directory and suppress all events from it. The `rebuildIndex` callback in `index.ts:35` is never invoked after startup.
- **Impact**: The incremental rebuild requirement is unmet. The server holds a snapshot of the YAML state at startup time. Any subsequent writes (by migration, by manual editing, by future MCP write tools) are invisible until the server restarts.

---

## Edge Cases Not Handled

### G3 (Minor): No error signal when YAML files fail to parse
- **Source**: Implicit — callers of `rebuildIndex` cannot distinguish between "zero YAML files" and "all files failed to parse"
- **Gap**: `rebuildIndex` at `indexer.ts:551` silently continues on YAML parse failure (`if (!parsed || typeof parsed !== "object") continue`). The returned `RebuildStats` has no `files_failed` or `parse_errors` field.
- **Impact**: If a malformed YAML file is written, the node disappears from the index silently. Operators see `files_updated: 0` and assume there is nothing to index.

### G4 (Minor): No `id` uniqueness check across artifact types
- **Source**: Architecture document — artifact IDs must be unique
- **Gap**: `buildCommonFields` at `indexer.ts:113` falls back to `file_path` as `id` when no `id` field is present. Two YAML files at different paths with manually-assigned duplicate IDs will silently overwrite each other in the typed table during upsert.
- **Impact**: ID collisions are not surfaced to the operator. Data from one file silently replaces data from another.

---

## Incomplete Integrations

### G5 (Minor): No schema upgrade path for existing `.ideate/index.db`
- **Source**: Architecture document; `CURRENT_SCHEMA_VERSION` constant
- **Gap**: `createSchema` uses `CREATE TABLE IF NOT EXISTS` throughout (`schema.ts`). If the schema changes in a future cycle (new column, new table), the existing database file is not upgraded — the new DDL silently has no effect. There is no version table in the database and no migration runner.
- **Impact**: Deployments that ran Phase 1 will carry stale DB schema when Phase 2 DDL is applied. The migration path is: delete `index.db` and let the server rebuild — but this is not documented and would be non-obvious to operators.

### G6 (Minor): `addresses` and `amends` edge types have no extraction path
- **Source**: WI-148 — edge type registry; `EDGE_TYPE_REGISTRY` in `schema.ts`
- **Gap**: Both `addresses` (work item → finding/domain_question) and `amends` (domain_policy → domain_policy) have `yaml_field: null`. The `extractEdges` function skips entries with `yaml_field === null`. No alternative extraction mechanism exists. These edges can only be inserted by code that calls `upsertEdge` directly — no such call site exists in the codebase.
- **Impact**: The `addresses` and `amends` edge types are defined in the registry but cannot appear in the live database from YAML content alone. Queries against these edge types will always return empty results until Phase 2 adds explicit write tools.

---

## Infrastructure Absent

None beyond the items above. The Phase 1 scope explicitly deferred MCP tool exposure and skill integration to later phases. The absent tools are by design, not gaps.

---

## Implicit Expectations Unaddressed

### G7 (Minor): No recovery if `rebuildIndex` fails at startup
- **Source**: Implicit production expectation
- **Gap**: `index.ts` calls `rebuildIndex(db, ideateDir)` synchronously at startup with no error handling. If the YAML directory is unreadable, `rebuildIndex` propagates an exception that becomes an unhandled rejection, crashing the process. The server never becomes available.
- **Impact**: A single permission error or disk issue during startup permanently prevents the MCP server from starting. There is no fallback to "start with empty index" mode.
