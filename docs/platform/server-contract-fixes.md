# ideate-server Contract Test Fixes

> Generated from running the StorageAdapter contract test suite against ideate-server at localhost:4000.
> Latest run: 86 pass, 18 fail (after MutationStatus enum fix and plugin-side status lowercasing fix).
> This document details each failure category, root cause, and fix.
>
> **How to use this document**: Fix each issue, then re-run the contract tests from the ideate plugin repo:
> ```bash
> cd /path/to/ideate/mcp/artifact-server
> npx vitest run src/__tests__/remote-contract.test.ts --reporter=verbose
> ```
> Target: 104/104 pass (52 LocalAdapter + 52 RemoteAdapter).

---

## Issue 1: putNode returns "updated" instead of "created" for new nodes

**Tests affected** (2):
- `CRUD > putNode creates a new node (status: created)`
- `Idempotency > putNode twice with same ID updates the node (status: updated on second call)`

**Root cause**: The putNode resolver uses `MERGE` in Cypher, which always reports the node as existing (updated) rather than distinguishing between create and update. The MutateNodeResult.status should be `CREATED` for new nodes and `UPDATED` for existing ones.

**Expected behavior**: First putNode call returns `{ status: "CREATED" }`. Second call with same ID returns `{ status: "UPDATED" }`.

**Fix (TDD)**:
1. Write integration test: `putNode with new ID returns CREATED; putNode with existing ID returns UPDATED`
2. In the putNode resolver, use a two-step Cypher:
   ```cypher
   OPTIONAL MATCH (existing {artifact_uid: $uid})
   WITH existing IS NOT NULL AS existed
   MERGE (n {artifact_uid: $uid})
   SET n += $properties
   RETURN existed
   ```
3. Return `CREATED` when `existed` is false, `UPDATED` when true.

---

## Issue 2: getNode returns node without title property

**Tests affected** (1):
- `CRUD > getNode retrieves the node after putNode`

**Root cause**: The artifact query resolver returns node properties but `title` is not being mapped from Neo4j properties to the GraphQL response. The test asserts `node.title === "Retrievable"` but gets `undefined`.

**Expected behavior**: `getNode` returns all properties set during `putNode`, including `title`.

**Fix (TDD)**:
1. Write integration test: `putNode with title "Test", then artifact(id) returns title "Test"`
2. Verify the resolver maps the `title` property from the Neo4j node to the GraphQL response field.

---

## Issue 3: readNodeContent returns empty string for existing nodes

**Tests affected** (1):
- `CRUD > readNodeContent returns non-empty string for an existing node`

**Root cause**: The `content` field on the artifact query likely returns null or empty for nodes created via putNode (which stores properties but may not populate a `content` field in Neo4j).

**Expected behavior**: `readNodeContent(id)` returns the serialized content of the node as a non-empty string.

**Fix (TDD)**:
1. Write integration test: `putNode creates a node; artifact(id) { content } returns non-empty string`
2. Ensure putNode stores a `content` property on the Neo4j node (e.g., JSON.stringify of the properties object).
3. Ensure the artifact resolver returns the `content` property.

---

## Issue 4: patchNode does not throw ImmutableFieldError for immutable fields

**Tests affected** (3):
- `CRUD > patchNode rejects immutable field 'id'`
- `CRUD > patchNode rejects immutable field 'type'`
- `CRUD > patchNode rejects immutable field 'cycle_created'`

**Root cause**: The patchNode resolver does not validate that immutable fields (`id`, `type`, `cycle_created`) are not included in the update payload. It either silently ignores them or applies them, but does not throw an error with `extensions.code: "IMMUTABLE_FIELD"`.

**Expected behavior**: patchNode throws a GraphQL error with `extensions.code: "IMMUTABLE_FIELD"` when the patch contains `id`, `type`, or `cycle_created`.

**Fix (TDD)**:
1. Write integration test: `patchNode with {id: "new-id"} throws error with code IMMUTABLE_FIELD`
2. Add validation at the top of the patchNode resolver:
   ```typescript
   const IMMUTABLE_FIELDS = ["id", "type", "cycle_created"];
   for (const field of IMMUTABLE_FIELDS) {
     if (field in input.properties) {
       throw new GraphQLError(`Cannot modify immutable field '${field}'`, {
         extensions: { code: "IMMUTABLE_FIELD" },
       });
     }
   }
   ```

---

## Issue 5: Enum case mismatch — lowercase stored in Neo4j, UPPER_CASE expected by GraphQL

**Tests affected** (multiple — cascading from putNode/queryNodes):
- `Query > queryNodes returns nodes matching the type filter`
- `Query > queryNodes filters by status`
- `Query > countNodes groups nodes by type`

**Root cause**: When data is imported via migration or written via putNode, enum values are stored as lowercase strings in Neo4j (e.g., `"guiding_principle"`, `"pending"`, `"small"`). The GraphQL schema defines these as UPPER_CASE enums (`GUIDING_PRINCIPLE`, `PENDING`, `SMALL`). The resolver does not convert case when reading from Neo4j.

**Expected behavior**: Resolvers uppercase enum values before returning them to GraphQL.

**Fix (TDD)**:
1. Write integration test: `putNode with type "work_item", then artifactQuery returns type WORK_ITEM`
2. Add a helper function:
   ```typescript
   function toGraphQLEnum(value: string): string {
     return value.toUpperCase().replace(/-/g, "_");
   }
   ```
3. Apply in all resolvers that return enum fields: `type`, `status`, `complexity`, `work_item_type`, `edge_type`.

---

## Issue 6: assembleContext resolver missing resolveType for ArtifactNode

**Tests affected** (2):
- `Traversal > traverse with a valid seed ID returns a TraversalResult`
- `Traversal > traverse with empty seed_ids returns an empty result`

**Root cause**: The `assembleContext` query returns `RankedNode` objects containing `ArtifactNode` (an interface). Apollo requires either a `resolveType` function on the interface or `isTypeOf` on each implementing type. Neither is provided.

**Expected behavior**: `assembleContext` returns ranked nodes with properly resolved concrete types.

**Fix (TDD)**:
1. Write integration test: `assembleContext with seed IDs returns a TraversalResult with resolved node types`
2. Add `resolveType` to the ArtifactNode interface resolver:
   ```typescript
   ArtifactNode: {
     __resolveType(obj: any) {
       // Map Neo4j labels or type property to GraphQL type names
       const typeMap: Record<string, string> = {
         work_item: "WorkItem",
         guiding_principle: "GuidingPrinciple",
         domain_policy: "DomainPolicy",
         // ... all types
       };
       return typeMap[obj.type] || "Document";
     }
   }
   ```

---

## Issue 7: batchMutate returns errors for valid input

**Tests affected** (3):
- `Batch > batchMutate creates multiple nodes atomically`
- `Batch > batchMutate creates edges provided alongside nodes`
- `Batch > batchMutate handles empty node list without error`

**Root cause**: The batchMutate resolver returns `{ errors: [{ id: "", message: "..." }] }` for inputs that should succeed. The empty `id` in the error suggests the resolver is failing before processing individual nodes.

**Expected behavior**: batchMutate with valid nodes returns `{ created: [...], errors: [] }`. Empty input returns `{ created: [], errors: [] }`.

**Fix (TDD)**:
1. Write integration test: `batchMutate with 2 valid nodes returns created: 2, errors: []`
2. Debug the resolver — check if it's failing on input validation, Cypher execution, or response mapping.
3. Verify empty input case: `batchMutate with nodes: [] returns created: [], errors: []`

---

## Issue 8: nextId does not increment after node creation

**Tests affected** (1):
- `ID generation > nextId for work_item increments after a node is created`

**Root cause**: `nextId` returns the same ID (`WI-001`) before and after creating a node. The ID generator is not scanning existing nodes to find the next available ID.

**Expected behavior**: After creating `WI-001`, `nextId("work_item")` returns `WI-002`.

**Fix (TDD)**:
1. Write integration test: `nextId returns WI-001; create WI-001; nextId returns WI-002`
2. In the nextId resolver, query Neo4j for the max existing ID of the given type:
   ```cypher
   MATCH (n:WorkItem)
   WHERE n.org_id = $orgId
   RETURN max(toInteger(replace(n.id, 'WI-', ''))) AS maxNum
   ```
3. Return `WI-{maxNum + 1}` zero-padded to 3 digits.

---

## Issue 9: Journal entry ID format mismatch (JE-NNN vs J-NNN-NNN)

**Tests affected** (3):
- `appendJournalEntry > returns a J-NNN-NNN format ID`
- `appendJournalEntry > sequential entries within a cycle get incrementing sequence numbers`
- `appendJournalEntry > created journal entry can be retrieved via getNode`

**Root cause**: The server generates journal entry IDs in `JE-NNN` format. The StorageAdapter contract specifies `J-{cycle}-{sequence}` format (e.g., `J-001-001`).

**Expected behavior**: `appendJournal` returns IDs matching `/^J-\d{3}-\d{3}$/` where the first group is the cycle number and the second is the sequence within that cycle.

**Fix (TDD)**:
1. Write integration test: `appendJournal with cycle=1 returns J-001-001; second call returns J-001-002`
2. Update the ID generator for journal entries:
   ```typescript
   // Find max sequence for this cycle
   const maxSeq = await session.run(
     `MATCH (n:JournalEntry {org_id: $orgId, cycle: $cycle})
      RETURN max(toInteger(split(n.id, '-')[2])) AS maxSeq`,
     { orgId, cycle }
   );
   const seq = (maxSeq.records[0]?.get('maxSeq') ?? 0) + 1;
   const id = `J-${String(cycle).padStart(3, '0')}-${String(seq).padStart(3, '0')}`;
   ```

---

## Issue 10: Finding ID format mismatch (F-N-NNN vs F-NNN-NNN)

**Tests affected** (1):
- `ID generation > nextId for finding requires a cycle parameter`

**Root cause**: Server generates finding IDs as `F-{cycle}-{seq}` without zero-padding the cycle (e.g., `F-1-001` instead of `F-001-001`).

**Expected behavior**: Finding IDs match `/^F-\d{3}-\d{3}$/`.

**Fix**: Same as Issue 9 — zero-pad the cycle number to 3 digits in the ID generator.

---

## Issue 11: getDomainState Cypher syntax error with domain filter

**Tests affected** (1):
- `Aggregation > getDomainState returns entries for domains that have policies`

**Root cause**: The resolver generates invalid Cypher:
```cypher
MATCH (n:DomainPolicy {org_id: $orgId}) AND n.domain IN $domains
```
`AND` is not valid after a `MATCH` pattern — it should be `WHERE`.

**Expected behavior**: Domain filtering uses valid Cypher syntax.

**Fix (TDD)**:
1. Write integration test: `getDomainState(["workflow"]) returns only workflow policies`
2. Fix the Cypher:
   ```cypher
   MATCH (n:DomainPolicy {org_id: $orgId})
   WHERE n.domain IN $domains
   RETURN n
   ```

---

## Issue 12: archiveCycle throws NotFoundError instead of returning no-op string

**Tests affected** (1):
- `archiveCycle > archiveCycle is a no-op (returns a summary string) when cycle has no artifacts`

**Root cause**: The resolver throws `NotFoundError: No nodes found for cycle 99` when archiving a cycle with no artifacts. The contract specifies a no-op return (summary string like `"Archived cycle 99: 0 items"`).

**Expected behavior**: `archiveCycle(99)` returns a summary string, not an error, when the cycle has no artifacts.

**Fix (TDD)**:
1. Write integration test: `archiveCycle(99) returns string containing "0" (no throw)`
2. In the resolver, change the empty-cycle path from `throw new NotFoundError(...)` to `return "Archived cycle 99: 0 work items, 0 findings moved."`

---

## Issue 13: ORGANIZATION not in NodeType enum — traversal fails

**Tests affected** (2):
- `Traversal > traverse with a valid seed ID returns a TraversalResult`
- `Traversal > traverse with empty seed_ids returns an empty result`

**Root cause**: The `assembleContext` query returns `RankedNode` objects. When the PPR traversal includes Organization or Codebase nodes (tenant-level nodes), the `type` field value `"ORGANIZATION"` is not a valid member of the `NodeType` GraphQL enum. This causes: `Enum "NodeType" cannot represent value: "ORGANIZATION"`.

**Expected behavior**: Either:
- (a) Add `ORGANIZATION` and `CODEBASE` to the `NodeType` enum in the schema, or
- (b) Filter tenant nodes (Organization, Codebase) out of PPR results before returning them — they are structural nodes, not artifacts.

**Fix (TDD)**:
1. Write integration test: `assembleContext with a seed node returns results without NodeType errors`
2. Option (a): Add `ORGANIZATION` and `CODEBASE` to the `NodeType` enum in `schema.graphql`
3. Option (b) — preferred: In the `assembleContext` resolver, filter out nodes with labels `Organization` or `Codebase` from the ranked results before returning. These are tenant containers, not content nodes.

---

## Issue 14: queryNodes does not scope to test org/codebase — returns migrated data

**Tests affected** (3):
- `Query > queryNodes returns nodes matching the type filter`
- `Query > queryNodes respects pagination (limit + offset)`
- `Query > queryNodes filters by status`

**Root cause**: The contract tests create nodes under `org_id: "contract-test-org"` / `codebase_id: "contract-test-cb"`, but `queryNodes` returns nodes from all orgs (including migrated data under `dev-org`). The resolver does not filter by the authenticated user's org/codebase context.

**Expected behavior**: All queries are automatically scoped to the authenticated org_id. Nodes from other orgs are invisible.

**Fix (TDD)**:
1. Write integration test: `create node in org-A; queryNodes in org-B returns empty`
2. In every query resolver, add `WHERE n.org_id = $orgId` (from the auth context) to the Cypher query. This is a multi-tenancy requirement — queries must be tenant-isolated.

---

## Resolved Issues

### Issue 5 (Enum case mismatch) — FIXED
Server now uppercases data enums correctly. MutationStatus enum fixed to remain UPPER_CASE.

### Plugin-side fix: status lowercasing in RemoteAdapter
The RemoteAdapter's `mapGqlNodeToNode` and `mapGqlNodeToMeta` now lowercase the `status` field from server responses using `fromGraphQLEnum()`. This handles the server returning `IN_PROGRESS` while the adapter contract expects `in_progress`.

---

## Summary

| # | Issue | Tests | Severity | Status |
|---|---|---|---|---|
| 1 | putNode status CREATED vs UPDATED | 2 | Medium | Open |
| 2 | getNode missing title | 1 | Medium | Open |
| 3 | readNodeContent empty | 1 | Medium | Open |
| 4 | patchNode immutable field validation | 3 | High | Open |
| 5 | Enum case mismatch | 3+ | High | **Fixed** |
| 6 | resolveType missing on ArtifactNode | 2 | High | Open → see Issue 13 |
| 7 | batchMutate errors on valid input | 3 | High | Open |
| 8 | nextId doesn't increment | 1 | Medium | Open |
| 9 | Journal entry ID format | 3 | High | Open |
| 10 | Finding ID format | 1 | Medium | Open |
| 11 | Cypher syntax error in getDomainState | 1 | High | Open |
| 12 | archiveCycle throws instead of no-op | 1 | Medium | Open |
| 13 | ORGANIZATION not in NodeType enum | 2 | High | **New** |
| 14 | queryNodes not scoped to org/codebase | 3 | High | **New** |

**Recommended fix order** (updated):
1. Issue 14 (Multi-tenant scoping — foundational, affects all queries)
2. Issue 11 (Cypher syntax — trivial)
3. Issue 13 (NodeType enum or filter tenant nodes from PPR)
4. Issue 4 (Immutable field validation)
5. Issue 9 + 10 (ID format — journal + finding)
6. Issue 1 (putNode status)
7. Issue 12 (archiveCycle no-op)
8. Issue 7 (batchMutate)
9. Issues 2, 3, 8 (property mapping, content, nextId increment)

After all fixes, re-run: `npx vitest run src/__tests__/remote-contract.test.ts --reporter=verbose`
Target: **104/104 tests pass**.
