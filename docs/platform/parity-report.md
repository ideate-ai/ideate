# Backend Parity Report

**Project**: PR-003 (Migration Tool Refinement)
**Date**: 2026-04-03
**Phase**: PH-025 (Production Validation)

---

## Executive Summary

The equivalence test suite (PH-024) runs successfully against the synthetic fixture (20 artifacts) when both adapters are live. However, running against the live server reveals a **fundamental data model mismatch** between how the migration tool stores data in Neo4j and how the RemoteAdapter retrieves it.

**Verdict**: Parity is **not yet achieved**. One blocking issue must be resolved before the backends can be considered equivalent.

---

## Blocking Issue: `content` Field Null on Migrated Nodes

### Root Cause

The RemoteAdapter's `mapGqlNodeToNode()` reconstructs the `properties` bag by parsing the `content` field as JSON (`remote/index.ts:90-103`). The server's `artifact` GraphQL query returns `content: null` for all nodes imported by the migration tool.

The migration tool (`ideate-server/src/migration/writer.ts`) stores YAML fields as individual Neo4j node properties (e.g., `title`, `status`, `criteria` as separate properties on the Neo4j node). It does **not** store a serialized JSON blob in a `content` property.

The RemoteAdapter was designed for nodes created via `putNode`, which stores `JSON.stringify(input.properties)` as the `content` field. Migration-imported nodes use a different storage model.

### Impact

- `getNode()` returns `properties: {}` for all migrated nodes
- `readNodeContent()` returns empty string for all migrated nodes
- All equivalence tests comparing `properties` fail (100% of getNode, queryNodes, etc.)
- `batchMutate` results differ (server doesn't return results array in the expected format)
- `nextId` diverges (different ID generation strategies)

### Resolution Options

| Option | Description | Effort | Risk |
|--------|-------------|--------|------|
| **A: Server stores content blob** | Migration writer stores `JSON.stringify(yamlDoc)` as a `content` property on each Neo4j node, alongside the individual properties | Medium | Low — additive change |
| **B: RemoteAdapter reads individual properties** | RemoteAdapter's `getNode` query requests all individual properties and reconstructs the properties bag from them | High | Medium — requires knowing all property names per type |
| **C: Server resolves content at query time** | Server's `artifact` resolver assembles `content` from individual Neo4j properties before returning | Medium | Low — transparent to both migration and RemoteAdapter |

**Recommendation**: Option A or C. Option A is simplest — add a `content` property during migration that mirrors what `putNode` stores. Option C is more robust but requires server-side changes.

---

## Test Results Summary

### Synthetic Fixture (20 artifacts, Docker stack)

| Suite | Tests | Pass | Fail | Skip |
|-------|-------|------|------|------|
| equivalence-setup | 8 | 8 | 0 | 0 |
| equivalence-crud | ~60 | ~5 | ~55 | 0 |
| equivalence-query | ~40 | ~2 | ~38 | 0 |
| equivalence-traverse | ~15 | 0 | 15 | 0 |
| equivalence-batch | ~12 | 5 | 7 | 0 |
| equivalence-null | ~29 | ~8 | ~21 | 0 |

The setup sanity checks pass (both adapters can retrieve nodes by ID and agree on metadata). All failures trace back to the `content: null` / `properties: {}` divergence.

### Failure Categories

| Category | Count | Root Cause |
|----------|-------|------------|
| properties mismatch | ~80 | content field null on migrated nodes |
| readNodeContent empty | 19 | content field null |
| batchMutate format | 2 | server returns different result structure |
| nextId divergence | 3 | different ID generation strategies |
| archiveCycle | 1 | server error on archive operation |

---

## Known Divergences (Documented)

### T-13: SQLite Null-to-Default Coercion

The SQLite indexer uses `?? ''` in several places, coercing null values to empty strings. Neo4j stores null as-is. One confirmed case:

- **ME-002 event_name**: SQLite returns `agent_type` fallback (`"reviewer"`), Neo4j stores null

This is a minor, accepted divergence. Fix: update the indexer `??` chain to preserve null.

---

## Infrastructure Findings

### Docker Compose Path Resolution

The `docker-compose.test.yml` default path for `IDEATE_SERVER_PATH` was `../../ideate-server` (resolves inside the ideate repo), but the server is at `../../../ideate-server` (sibling repo). Fixed during this phase.

### Server Healthcheck

The original `curl`-based healthcheck failed because `node:22-slim` doesn't include curl. Fixed to use `node -e "require('http').get(...)"`.

---

## Acceptance Criteria Assessment

| Criterion | Status |
|-----------|--------|
| 100% YAML-to-SQLite/Neo4j parity | **Not met** — content field gap |
| Audit SQLite indexer for latent defects | **Met** — schema v5, T-13 documented |
| Equivalence tests proving identical results | **Partially met** — tests exist and run, but fail due to content field gap |

---

## Recommended Next Steps

1. **Fix content field gap** (Option A or C) — this is the blocking issue for parity
2. **Fix nextId divergence** — align ID generation strategy between LocalAdapter and server
3. **Fix batchMutate response format** — align server response with StorageAdapter contract
4. **Re-run equivalence suite** — verify parity after fixes
5. **Fix T-13 coercion** — update indexer to preserve null values
