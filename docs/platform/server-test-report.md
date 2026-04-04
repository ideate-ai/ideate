# ideate-server Integration Test Report

**Date**: 2026-04-03
**Test suite**: StorageAdapter contract tests (`remote-contract.test.ts`)
**Server**: ideate-server @ localhost:4000
**Result**: 87 pass / 17 fail (104 total)

---

## How to reproduce

From the ideate plugin repo:
```bash
cd mcp/artifact-server
npx vitest run src/__tests__/remote-contract.test.ts --reporter=verbose
```

Requires ideate-server running on localhost:4000 with Neo4j available.

---

## Previously fixed (no longer failing)

- **Enum case on data fields** — Server now correctly uppercases NodeType, EdgeType, WorkItemComplexity enums when returning data from Neo4j. Fixed.
- **MutationStatus enum** — Response status enums (CREATED, UPDATED, DELETED) are now correctly UPPER_CASE. Fixed.
- **Immutable field validation** — patchNode now rejects `id`, `type`, `cycle_created` mutations. Fixed.
- **readNodeContent** — Returns non-empty content for existing nodes. Fixed.
- **getNode title** — Title property now returned correctly. Fixed.

---

## Open failures (17 tests, 8 distinct issues)

### 1. putNode returns "updated" for new nodes (2 tests)

**Tests**:
- `CRUD > putNode creates a new node (status: created)`
- `Idempotency > putNode twice with same ID updates the node (status: updated on second call)`

**What happens**: putNode always returns `status: "updated"` regardless of whether the node existed. The first call should return `"created"`, the second `"updated"`.

**Expected**: Distinguish create from update. Use `OPTIONAL MATCH` before `MERGE` to detect whether the node existed:
```cypher
OPTIONAL MATCH (existing {artifact_uid: $uid})
WITH existing IS NOT NULL AS existed
MERGE (n {artifact_uid: $uid})
SET n += $properties
RETURN existed
```
Return `CREATED` when `existed` is false, `UPDATED` when true.

---

### 2. Queries return data from other tenants (4 tests)

**Tests**:
- `Query > queryNodes returns nodes matching the type filter`
- `Query > queryNodes respects pagination (limit + offset)`
- `Query > queryNodes filters by status`
- `Query > countNodes groups nodes by type`

**What happens**: The contract tests create nodes under `org_id: "contract-test-org"` / `codebase_id: "contract-test-cb"`. Query results include nodes from other orgs (migrated data under `dev-org`). The test-created nodes are buried in results from other tenants.

**Expected**: All query resolvers must filter by the authenticated org_id from the auth context. Nodes from other organizations must be invisible. This is a fundamental multi-tenancy requirement.

**Fix**: Add `WHERE n.org_id = $orgId` to every query resolver's Cypher. The `$orgId` comes from the request's auth context.

For `countNodes`: the `key` field in results should use lowercase type names (e.g., `guiding_principle` not `GuidingPrinciple`) to match the adapter's `NodeType` enum.

---

### 3. PPR traversal fails on tenant nodes (2 tests)

**Tests**:
- `Traversal > traverse with a valid seed ID returns a TraversalResult`
- `Traversal > traverse with empty seed_ids returns an empty result`

**What happens**: `assembleContext` query runs PPR, which traverses Organization and Codebase nodes. These nodes have type `"ORGANIZATION"` which is not a valid member of the `NodeType` GraphQL enum. Error: `Enum "NodeType" cannot represent value: "ORGANIZATION"`.

**Expected**: Either:
- **(a)** Add `ORGANIZATION` and `CODEBASE` to the `NodeType` enum in `schema.graphql`, or
- **(b)** Filter tenant-level nodes out of PPR results before returning — they are structural containers, not content artifacts.

**Recommended**: Option (b). Tenant nodes should not appear in context assembly results. Add a post-PPR filter:
```typescript
rankedNodes = rankedNodes.filter(rn => 
  !["Organization", "Codebase"].includes(rn.node.labels?.[0])
);
```

---

### 4. batchMutate returns errors for valid input (3 tests)

**Tests**:
- `Batch > batchMutate creates multiple nodes atomically`
- `Batch > batchMutate creates edges provided alongside nodes`
- `Batch > batchMutate handles empty node list without error`

**What happens**: batchMutate returns `{ errors: [{ id: "", message: "..." }] }` for inputs that should succeed, including an empty node list. The contract expects `{ created: [...], errors: [] }` for valid input and `{ created: [], errors: [] }` for empty input.

**Expected**: 
- Valid nodes: all created, `errors` array is empty
- Empty input: `{ created: [], errors: [] }` — not an error

**Fix**: Debug the batchMutate resolver. Check if input validation, Cypher execution, or response mapping is producing the spurious error. The empty-input case should short-circuit with a success response.

---

### 5. nextId does not increment after node creation (1 test)

**Test**: `ID generation > nextId for work_item increments after a node is created`

**What happens**: `nextId("work_item")` returns `WI-001` both before and after creating a node with that ID. The ID generator is not scanning existing nodes.

**Expected**: After creating `WI-001`, `nextId("work_item")` returns `WI-002`.

**Fix**: Query Neo4j for the max existing ID of the given type within the org:
```cypher
MATCH (n:WorkItem)
WHERE n.org_id = $orgId
RETURN max(toInteger(replace(n.id, 'WI-', ''))) AS maxNum
```
Return `WI-{maxNum + 1}` zero-padded to 3 digits.

---

### 6. archiveCycle response format mismatch (1 test)

**Test**: `archiveCycle > archiveCycle is a no-op (returns a summary string) when cycle has no artifacts`

**What happens**: Server returns `"Archived cycle 99 via remote server."`. Contract test asserts the string contains `"0"` (e.g., `"Archived cycle 99: 0 work items, 0 findings moved."`).

**Expected**: The response string should include artifact counts. For an empty cycle: `"Archived cycle 99: 0 work items, 0 findings moved."`

**Fix**: Update the archiveCycle resolver to count the affected artifacts and include the counts in the response string, matching the format: `"Archived cycle {N}: {X} work items, {Y} findings moved."`

---

### 7. Journal entry ID format mismatch (3 tests)

**Tests**:
- `appendJournalEntry > returns a J-NNN-NNN format ID`
- `appendJournalEntry > sequential entries within a cycle get incrementing sequence numbers`
- `appendJournalEntry > created journal entry can be retrieved via getNode`

**What happens**: Server generates IDs as `J-025`, `J-026` (global sequence, no cycle scoping, no zero-padding). Contract expects `J-{cycle}-{sequence}` format: `J-001-001`, `J-001-002`.

**Expected**: Journal entry IDs use the format `/^J-\d{3}-\d{3}$/` where:
- First group = cycle number (zero-padded to 3 digits)
- Second group = sequence within that cycle (zero-padded to 3 digits)

**Fix**: Update the ID generator for journal entries:
```typescript
const maxSeq = await session.run(
  `MATCH (n:JournalEntry {org_id: $orgId})
   WHERE n.cycle = $cycle
   RETURN max(toInteger(split(n.id, '-')[2])) AS maxSeq`,
  { orgId, cycle }
);
const seq = (maxSeq.records[0]?.get('maxSeq') ?? 0) + 1;
const id = `J-${String(cycle).padStart(3, '0')}-${String(seq).padStart(3, '0')}`;
```

The third test (`created journal entry can be retrieved via getNode`) fails because `getNode("J-025")` returns null — likely the node is stored with a different ID or the lookup doesn't match. This will be fixed when the ID format is corrected, as long as `getNode` can retrieve nodes by the returned ID.

---

## Summary

| # | Issue | Failing Tests | Priority |
|---|---|---|---|
| 1 | putNode CREATED vs UPDATED | 2 | Medium |
| 2 | Query multi-tenant scoping | 4 | **Critical** |
| 3 | PPR returns tenant nodes | 2 | High |
| 4 | batchMutate errors on valid input | 3 | High |
| 5 | nextId doesn't increment | 1 | Medium |
| 6 | archiveCycle response format | 1 | Low |
| 7 | Journal entry ID format | 3 | High |

**Recommended fix order**:
1. **Issue 2** (multi-tenant scoping) — foundational security/correctness issue, affects all queries
2. **Issue 3** (PPR tenant node filter) — blocks traversal/context assembly
3. **Issue 7** (journal ID format) — 3 tests, format mismatch
4. **Issue 4** (batchMutate) — 3 tests, may cascade from other fixes
5. **Issue 1** (putNode status) — 2 tests
6. **Issue 5** (nextId increment) — 1 test
7. **Issue 6** (archiveCycle format) — 1 test, cosmetic

**Validation**: After fixes, run from the plugin repo:
```bash
cd /path/to/ideate/mcp/artifact-server
npx vitest run src/__tests__/remote-contract.test.ts --reporter=verbose
```
Target: **104/104 tests pass** (52 LocalAdapter + 52 RemoteAdapter).
