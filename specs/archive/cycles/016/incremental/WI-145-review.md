# WI-145 Incremental Review

**Verdict: Pass** (after fixes)
**Cycle: 17**
**Reviewer: code-reviewer**

## Acceptance Criteria

- [x] `embeddings.ts`, `chunker.ts`, `retrieval.ts` deleted
- [x] `indexer.ts` rewritten: `rebuildIndex(db, ideateDir)` and `detectCycles(db)`
- [x] `rebuildIndex`: SHA-256 hash skip, UPSERTs into typed tables, edge extraction, node_file_refs, stale-row deletion, single transaction
- [x] `detectCycles`: Kahn's algorithm on depends_on edges
- [x] `tools.ts` stripped to empty TOOLS array and stub handleTool
- [x] `index.ts`: resolves .ideate/, SQLite at .ideate/index.db, WAL+busy_timeout, createSchema+rebuildIndex, chokidar watcher
- [x] `package.json`: `@xenova/transformers` removed, `yaml` added
- [x] No dead imports from deleted modules
- [x] `npm run build` succeeds

## Findings

### M1 (resolved): Dead `createSchema` import in indexer.ts
Removed — callers are responsible for calling `createSchema` before `rebuildIndex`.

### M2 (resolved): `PRAGMA journal_mode = WAL` in createSchema
Removed from `schema.ts` — WAL is set exclusively in `index.ts` before startup.

### S1 (deferred to WI-147): No tests for rebuildIndex/detectCycles
Test suite is WI-147 scope; not a WI-145 failure.
