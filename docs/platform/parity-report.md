# Backend Parity Report

**Project**: PR-003 (Migration Tool Refinement)
**Date**: 2026-04-03 (updated)
**Phase**: PH-025 (Production Validation)

---

## Executive Summary

Two blocking issues prevent full backend parity. The first (content field null) was fixed during this session. The second (properties scope divergence) requires a design decision.

**Test results after content fix**: 54/114 pass, 60 fail. All `readNodeContent` tests pass (19/19). All `getNode` tests still fail due to properties scope mismatch.

---

## Issue 1: Content Field Null (FIXED)

**Status**: Fixed in ideate-server transformer.ts

The migration tool was not storing a `content` JSON blob on Neo4j nodes. The RemoteAdapter's `mapGqlNodeToNode` parses this field to reconstruct properties. Without it, `properties: {}` for all migrated nodes.

**Fix**: Added `rawProps["content"] = JSON.stringify(parsed)` in `transformer.ts` before content hash computation. Also updated RemoteAdapter to strip metadata keys (`id`, `type`, `status`, `cycle_created`, `cycle_modified`, `content_hash`, `token_count`, `content`) from the parsed content before merging into properties.

---

## Issue 2: Properties Scope Divergence (OPEN)

**Status**: Design decision needed

After the content fix, a structural mismatch remains:

| Adapter | Properties source | Includes |
|---------|------------------|----------|
| **LocalAdapter** | SQLite extension table columns | Only columns defined in the schema (e.g., work_item: `title`, `resolution`, `work_item_type`, `complexity`) |
| **RemoteAdapter** | Full YAML content blob (minus metadata) | ALL YAML fields (e.g., work_item: `title`, `resolution`, `scope`, `criteria`, `depends`, `blocks`, `governed_by`, ...) |

The LocalAdapter reader (`reader.ts`) constructs properties from the extension table row columns. Fields like `scope`, `criteria`, `depends`, `blocks`, `governed_by` are stored as edges or in the raw YAML file, not in extension table columns.

### Resolution Options

| Option | Description | Effort |
|--------|-------------|--------|
| **A: LocalAdapter reads YAML** | LocalAdapter `getNode` reads the YAML file content and parses all fields into properties (like RemoteAdapter parses the content blob) | Medium |
| **B: RemoteAdapter filters to extension columns** | RemoteAdapter strips content to only the columns that match extension table schema | High — requires per-type column lists |
| **C: Both return raw content as properties** | Both adapters store and return `JSON.stringify(allFields)` as properties, using content as the canonical source | Medium |

**Recommendation**: Option A. The LocalAdapter already has `readNodeContent` which reads the YAML file. Use the same mechanism in `getNode` to populate properties from the full YAML, falling back to extension columns for computed/derived values.

---

## Test Results (After Content Fix)

| Suite | Total | Pass | Fail |
|-------|-------|------|------|
| equivalence-setup | 8 | 8 | 0 |
| equivalence-crud | 66 | 40 | 26 |
| equivalence-query | ~40 | ~6 | ~34 |
| equivalence-traverse | ~15 | TBD | TBD |
| equivalence-batch | ~12 | ~5 | ~7 |
| equivalence-null | ~29 | TBD | TBD |

### What passes now
- All `readNodeContent` tests (19/19) — content blob populated correctly
- All `readNodeContent` cross-adapter comparisons (id and type match)
- Setup sanity checks (8/8)
- Edge tests for nodes with matching properties (some)
- Schema v5 extension column tests (where both adapters return the column value)

### What still fails
- All `getNode` comparisons — properties scope mismatch
- All `queryNodes` comparisons — node metadata in results has different summaries
- `getEdges` — edge sets differ (migration creates containment edges not present in SQLite)
- `batchMutate` — server returns different result structure
- `nextId` — different ID generation strategies
- `getConvergenceData` — findings_by_severity counts differ

---

## Changes Made This Session

### ideate-server (server repo)
- `src/migration/transformer.ts`: Added `rawProps["content"] = JSON.stringify(parsed)` to store content blob on migrated nodes

### ideate (plugin repo)
- `mcp/artifact-server/src/adapters/remote/index.ts`: Strip metadata keys from parsed content blob in `mapGqlNodeToNode`
- `mcp/artifact-server/docker-compose.test.yml`: Fixed server volume path (../../ -> ../../../), curl healthcheck -> node http.get, tsx watch -> tsx direct
- `mcp/artifact-server/package.json`: Added `--no-file-parallelism` to test:equivalence script

---

## Recommended Next Steps

1. **Design decision**: Choose Option A, B, or C for properties scope alignment
2. **Implement the chosen option** — likely a new refinement cycle
3. **Align edge sets** — LocalAdapter extracts edges from YAML fields at index time; RemoteAdapter gets edges from Neo4j relationships (which include containment edges the LocalAdapter doesn't create)
4. **Align nextId** — different ID generation strategies need reconciliation
5. **Re-run equivalence suite** after fixes
