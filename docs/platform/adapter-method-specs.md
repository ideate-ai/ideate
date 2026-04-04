# Unified StorageAdapter Method Specifications

## Overview

This document provides canonical behavior specs for all 21 StorageAdapter methods. For each method it documents what the LocalAdapter does, what the RemoteAdapter + server does, identifies divergences, and prescribes a concrete fix. A developer can implement each fix from this document alone.

**Repositories**:
- Plugin (LocalAdapter + RemoteAdapter): `/Users/dan/code/ideate/mcp/artifact-server/src/`
- Server (resolvers + services): `/Users/dan/code/ideate-server/src/`

**Key structural difference**: LocalAdapter stores data in SQLite with extension tables (one per type) and YAML files on disk. RemoteAdapter delegates to ideate-server which stores flat-property nodes in Neo4j and serializes the input properties as a JSON `content` blob.

---

## Method Specifications

### 1. getNode

**Signature**: `getNode(id: string): Promise<Node | null>`

**Canonical behavior**:
Return a full Node (metadata + properties) for the given ID, or null if not found. The `properties` record MUST contain exactly the columns defined in the extension table for that node type (the EXTENSION_COLUMNS allowlist). Absent fields MUST be null, not omitted. The `status` field MUST be lowercase (e.g. `"active"`, not `"ACTIVE"`). `cycle_created` and `cycle_modified` MUST be JS numbers or null, never Neo4j Integer objects.

**Current LocalAdapter behavior**:
- Queries `nodes` table for metadata, then calls `fetchExtensionProperties()` which does `SELECT * FROM {extension_table} WHERE id = ?` and returns all columns except `id`.
- Properties are the raw SQLite column values. Arrays/objects stored as JSON strings remain as strings (e.g. `scope: "[{\"path\":\"foo\"}]"`).
- `cycle_created` and `cycle_modified` come from the `nodes` table as numbers.

**Current RemoteAdapter behavior**:
- Calls `artifact(id, codebaseId)` GraphQL query requesting `ARTIFACT_NODE_FIELDS_WITH_CONTENT`.
- `mapGqlNodeToNode()` parses the `content` JSON blob and filters it through `EXTENSION_COLUMNS[type]` to build properties. Applies `FIELD_FALLBACKS` for alternate field names.
- Status is lowercased via `fromGraphQLEnum()`.
- `cycle_created` and `cycle_modified` come from the GraphQL response as numbers (server's `mapNodeToGraphQL` calls `toNativeInt`).

**Divergences**:

1. **Properties source**: LocalAdapter reads from extension table columns (the indexed, structured representation). RemoteAdapter reconstructs from the `content` JSON blob (the raw input serialization). On `putNode`, the server stores `content = JSON.stringify(input.properties)` which only contains the fields the caller provided. If a field was computed by the indexer or writer (e.g. `module: null` default in work_items), it will be absent from `content` but present in the SQLite extension table. **Round-trip divergence**: putNode with `{title: "Test"}` for a work_item, then getNode: Local returns `{title: "Test", complexity: null, scope: null, depends: null, blocks: null, criteria: null, module: null, domain: null, phase: null, notes: null, work_item_type: "feature", resolution: null}`. Remote returns `{title: "Test", complexity: null, scope: null, ...}` but only if those fields are listed in EXTENSION_COLUMNS and present in content blob. Fields not in the original `input.properties` get `null` from the `else` branch in mapGqlNodeToNode (line 186: "Absent fields default to null").

2. **Status case**: Server's `mapNodeToGraphQL` uppercases status via `enumProp()`. RemoteAdapter lowercases it back via `fromGraphQLEnum()`. Local never uppercases. These cancel out, so both return lowercase. **No divergence**.

3. **content field in properties**: Server stores all input properties inside a `content` JSON blob. It also stores them as top-level Neo4j node properties. The `content` field itself is a valid property for document artifact types (architecture, cycle_summary, etc.). When a document artifact has a `content` property, the server stores `content = JSON.stringify({title: "...", content: "the actual doc content"})`. On read, the RemoteAdapter parses this blob and extracts the `content` key, which works correctly. **No divergence for document types**. However, for non-document types, the Neo4j node has a `content` property that is the JSON blob of all properties -- this is metadata, not a user-visible property. The RemoteAdapter correctly excludes `content` from the destructured metadata keys (line 135) and uses it only as the source for property reconstruction.

4. **Neo4j-specific fields leaking**: Server's `mapNodeToGraphQL` returns many type-specific fields (title, complexity, domain, etc.) as top-level GraphQL fields. RemoteAdapter's `mapGqlNodeToNode` destructures known metadata fields and puts `...rest` into properties. With `ARTIFACT_NODE_FIELDS_WITH_CONTENT`, the `rest` spread captures nothing because the query only requests the fragment fields. **No divergence**.

**Recommended fix**:
The current behavior is aligned as long as the server's `content` blob includes all fields that the extension table would have. The server's putNode mutation MUST store content as the full merged property set, not just the caller's input. See putNode (method 4) for the fix.

---

### 2. getNodes

**Signature**: `getNodes(ids: string[]): Promise<Map<string, Node>>`

**Canonical behavior**:
Batch version of getNode. Return a Map of id to Node for all found nodes. Missing IDs are silently omitted. Empty input returns empty Map. Property reconstruction follows the same rules as getNode.

**Current LocalAdapter behavior**:
- Uses `WHERE id IN (...)` query on `nodes` table, then fetches extension properties for each result individually.

**Current RemoteAdapter behavior**:
- Calls `artifacts(ids, codebaseId)` GraphQL query. Maps results via `mapGqlNodeToNode()`.

**Divergences**:
Same property reconstruction divergence as getNode (method 1). No additional divergences.

**Recommended fix**:
Same as getNode -- fix the server's content storage (see putNode, method 4).

---

### 3. readNodeContent

**Signature**: `readNodeContent(id: string): Promise<string>`

**Canonical behavior**:
Return the full serialized content of a node as a string. Returns empty string if the node does not exist or content is unavailable. The format is an adapter implementation detail (YAML for local, JSON for remote).

**Current LocalAdapter behavior**:
- Looks up `file_path` from `nodes` table, reads the YAML file from disk via `fs.readFileSync`.
- Returns raw YAML text.

**Current RemoteAdapter behavior**:
- Calls `artifact(id, codebaseId) { content }` GraphQL query.
- Returns the `content` field (a JSON string) or empty string.

**Divergences**:
1. **Format**: Local returns YAML, Remote returns JSON. This is explicitly documented as an adapter implementation detail in the interface contract ("The format is an adapter implementation detail -- callers treat it as opaque text."). **Acceptable divergence**.

**Recommended fix**:
No fix needed. The interface contract explicitly allows format differences.

---

### 4. putNode

**Signature**: `putNode(input: MutateNodeInput): Promise<MutateNodeResult>`

**Canonical behavior**:
Create or replace a node. Compute `content_hash` and `token_count` automatically. Return `{id, status: "created"|"updated"}`. The stored content MUST be the full merged set of properties (all extension table columns populated), not just the caller's input subset. On update, existing properties not provided in the input MUST be preserved.

**Current LocalAdapter behavior**:
- Resolves file path via `resolveArtifactPath()`.
- Builds YAML object: `{id, type, ...content}`, computes hash and tokens.
- Writes YAML file to disk.
- Upserts into `nodes` table and the type-specific extension table via `upsertExtensionTableRow()`.
- Extension table upsert uses `?? null` defaults for absent fields, so all columns are populated.
- Detects create vs update by checking if the node exists before writing.
- Returns `{id, status: "created" | "updated"}`.

**Current RemoteAdapter behavior**:
- Sends `putNode(input: MutateNodeInput!)` GraphQL mutation with `{id, type, properties, cycle, codebaseId}`.
- Returns `{id, status}` with status lowercased from server response.

**Server behavior** (`resolvers/mutations/node.ts`):
- Strips immutable fields from input properties.
- Stores `content = JSON.stringify(safeInputProps)` -- this is the **RAW caller input**, not the full merged set.
- On MERGE (update path), uses `ON MATCH SET n += $props`. The `+=` operator merges at the top level, so existing Neo4j properties not in the new `$props` are preserved. **BUT** the `content` field is replaced wholesale with `JSON.stringify(safeInputProps)`, which contains only the update fields.
- This means: after putNode({id: "WI-001", type: "work_item", properties: {status: "done"}}), the content blob becomes `{"status": "done"}` -- losing all other properties (title, scope, criteria, etc.).

**Divergences**:
1. **Content blob on update loses properties**: Server's putNode stores `content = JSON.stringify(input.properties)` which only has the fields the caller sent. On subsequent getNode, RemoteAdapter reconstructs properties from this truncated content blob. Fields like `title`, `scope`, `criteria` that were set in the original putNode are lost. LocalAdapter does not have this problem because it reads from the extension table, which was fully populated.

2. **Content hash computation**: Local computes hash from the full YAML object (after merging all fields). Server computes hash from `rawProps` which includes the truncated `content` field. Hashes will differ between adapters for the same logical content.

3. **Token count estimation**: Local uses `Math.floor(yamlString.length / 4)`. Server uses `Math.ceil(JSON.stringify(rawProps).length / 4)`. The input to the estimation differs (YAML vs JSON+metadata).

4. **Status string**: Server returns `"CREATED"` or `"UPDATED"` (uppercase). RemoteAdapter lowercases. Local returns lowercase directly. **No functional divergence** (RemoteAdapter handles the conversion).

**Recommended fix**:
**Server** (`ideate-server/src/resolvers/mutations/node.ts`, `putNode` function, lines ~175-180):
On the `ON MATCH` path, fetch existing content, merge, then store:
```typescript
// BEFORE (current — truncates):
rawProps["content"] = JSON.stringify(safeInputProps);

// AFTER (fixed — merges):
// For ON CREATE, store safeInputProps as-is
// For ON MATCH, merge with existing content inside the executeWrite transaction
```
The fix requires restructuring the putNode mutation to:
1. Inside `executeWrite`, fetch the existing node's `content` property.
2. If the node exists (ON MATCH path), parse existing content, merge safeInputProps over it, then store the merged result.
3. If the node is new (ON CREATE path), store safeInputProps directly.

Specifically, replace the single MERGE with a fetch-then-MERGE:
```typescript
const existCheck = await tx.run(
  `MATCH (existing {artifact_uid: $uid}) RETURN existing.content AS content, labels(existing)[0] AS label`,
  { uid },
);
const existingContent = existCheck.records[0]?.get("content");
let mergedContent = safeInputProps;
if (existingContent != null) {
  try {
    const parsed = JSON.parse(existingContent as string);
    mergedContent = { ...parsed, ...safeInputProps };
  } catch { /* use safeInputProps alone */ }
}
rawProps["content"] = JSON.stringify(mergedContent);
```

This change goes in: `ideate-server/src/resolvers/mutations/node.ts`, inside the `executeWrite` callback, before the MERGE cypher.

---

### 5. patchNode

**Signature**: `patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult>`

**Canonical behavior**:
Partially update an existing node. Only provided fields are changed. Immutable fields (`id`, `type`, `cycle_created`) MUST be rejected with an error. Return `{id, status: "updated"|"not_found"}`. After patch, getNode MUST return the merged state (original + patch).

**Current LocalAdapter behavior**:
- Rejects immutable fields.
- Reads existing YAML from file_path, parses it, merges new properties over it.
- Updates `cycle_modified` to current cycle.
- Rewrites the full YAML file.
- Re-upserts the full merged content into both `nodes` and the extension table.
- Returns `{id, status: "updated"}` or `{id, status: "not_found"}`.

**Current RemoteAdapter behavior**:
- Sends `patchNode(input: UpdateNodeInput!)` mutation.

**Server behavior** (`resolvers/mutations/node.ts`, `patchNode`):
- Rejects immutable fields (plus additional server fields: `artifact_id`, `artifact_uid`, etc.).
- Fetches existing node properties in a single transaction.
- Merges patch properties onto existing: `{...existingProps, ...input.properties, updated_at: now}`.
- **Rebuilds `content` from merged properties**: Iterates over `mergedProps`, excludes internal fields, and stores `content = JSON.stringify(contentProps)`. This correctly preserves all properties. **This is correct**.
- Recomputes content_hash and token_count from merged props.
- Writes back with `SET n += $props`.

**Divergences**:
1. **cycle_modified**: LocalAdapter updates cycle_modified from the domain index file's current_cycle. Server does not set cycle_modified during patchNode -- it preserves whatever was there before (unless the caller explicitly provides it in `input.properties`). The `mergedProps` will contain the old `cycle_modified`.

2. **Immutable field list**: Local checks `["id", "type", "cycle_created"]`. Server checks `["id", "type", "cycle_created", "artifact_id", "artifact_uid", "org_id", "codebase_id", "created_at"]`. Server is stricter. **Acceptable** -- server rejects more, which is safer.

3. **Content reconstruction on server**: Server's patchNode correctly merges existing content with patch. **No divergence in property round-trip** for patchNode specifically (unlike putNode's ON MATCH path).

**Recommended fix**:
**Server** (`ideate-server/src/resolvers/mutations/node.ts`, `patchNode`): Add `cycle_modified` update logic. After merging props:
```typescript
// If cycle_modified is not explicitly provided in the patch, auto-increment
// by querying the max cycle_created across all nodes:
if (!Object.prototype.hasOwnProperty.call(input.properties, 'cycle_modified')) {
  // Server could either: (a) leave cycle_modified unchanged (current), or
  // (b) compute from max cycle_created. Option (a) is simpler and correct
  // for server use-cases where cycle tracking is managed by the orchestrator.
}
```
**Decision**: Keep server behavior as-is (no auto-update of cycle_modified). The orchestrator layer should pass cycle_modified explicitly when needed. This is a minor behavioral difference that does not affect test equivalence.

---

### 6. deleteNode

**Signature**: `deleteNode(id: string): Promise<DeleteNodeResult>`

**Canonical behavior**:
Delete a node and all its associated edges. Return `{id, status: "deleted"|"not_found"}`.

**Current LocalAdapter behavior**:
- Looks up file_path from `nodes` table. Returns `not_found` if absent.
- In a transaction: deletes all edges referencing this node, deletes the node row.
- Best-effort removes the YAML file from disk.

**Current RemoteAdapter behavior**:
- Sends `deleteNode(id: ID!)` mutation.

**Server behavior**:
- Checks if node exists. If not, returns `NOT_FOUND`.
- Uses `DETACH DELETE` to remove node and all relationships.

**Divergences**:
1. **Extension table cleanup**: LocalAdapter deletes from the nodes table but does NOT explicitly delete from extension tables. Relies on SQLite CASCADE or orphaned rows. Server uses `DETACH DELETE` which removes the single Neo4j node (no extension tables exist). **No functional divergence** -- extension table rows become orphans but are never queried without a nodes table join.

2. **Status case**: Server returns `"DELETED"` / `"NOT_FOUND"`. RemoteAdapter lowercases. **No functional divergence**.

**Recommended fix**:
No fix needed. Both adapters produce equivalent behavior.

---

### 7. putEdge

**Signature**: `putEdge(edge: Edge): Promise<void>`

**Canonical behavior**:
Create an edge between two nodes. Idempotent: if the exact (source, target, type) triple exists, this is a no-op. Returns void (no return value to compare).

**Current LocalAdapter behavior**:
- Calls `insertEdge()` which uses `INSERT OR IGNORE` on the (source_id, target_id, edge_type) unique constraint.
- Serializes edge.properties to JSON if non-empty, null otherwise.

**Current RemoteAdapter behavior**:
- Sends `putEdge(input: EdgeInput!)` mutation with sourceId, targetId, edgeType (uppercased), properties.

**Server behavior**:
- Uses `MERGE (source)-[r:TYPE]->(target)` which is idempotent.
- Sets properties on CREATE only.

**Divergences**:
No divergences. Both are idempotent and produce equivalent graph state.

**Recommended fix**:
No fix needed.

---

### 8. removeEdges

**Signature**: `removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void>`

**Canonical behavior**:
Remove all edges from a given source node with the specified types. No-op if edge_types is empty.

**Current LocalAdapter behavior**:
- Returns early if edge_types is empty.
- Runs `DELETE FROM edges WHERE source_id = ? AND edge_type IN (...)`.

**Current RemoteAdapter behavior**:
- Sends `removeEdges(sourceId, edgeTypes)` mutation with edgeTypes uppercased.

**Server behavior**:
- Returns true if edge_types is empty.
- For each edge type: `MATCH (source)-[r:TYPE]->() DELETE r`.

**Divergences**:
No divergences. Both remove the same edges.

**Recommended fix**:
No fix needed.

---

### 9. getEdges

**Signature**: `getEdges(id: string, direction: "outgoing"|"incoming"|"both"): Promise<Edge[]>`

**Canonical behavior**:
Return all edges for a node in the specified direction. Each edge has source_id, target_id, edge_type, and properties.

**Current LocalAdapter behavior**:
- Queries the `edges` table filtering by source_id and/or target_id depending on direction.
- Parses `props` column from JSON.

**Current RemoteAdapter behavior**:
- Queries `artifact(id) { edges(direction) { sourceId targetId edgeType properties } }`.
- Maps via `mapGqlEdge()` which lowercases edgeType.

**Divergences**:
No significant divergences. Edge data flows through correctly.

**Recommended fix**:
No fix needed.

---

### 10. traverse (PPR)

**Signature**: `traverse(options: TraversalOptions): Promise<TraversalResult>`

**Canonical behavior**:
Execute PPR-based graph traversal for context assembly. Both adapters MUST use:
- Undirected adjacency (each directed edge traversable both ways)
- Same default edge type weights: `{depends_on: 1.0, governed_by: 0.8, informed_by: 0.6, references: 0.4, blocks: 0.3}`
- Same specificity dampening: `score *= log(totalNodes / max(1, inDegree))`
- Same default alpha (0.15), max_iterations (50), convergence_threshold (1e-6)
- `always_include_types`: ALL nodes of the specified types MUST be included regardless of PPR score AND regardless of token budget. They are force-included.
- Seed nodes: always included (force-included, ignoring budget).
- Remaining nodes: included greedily by descending PPR score until `token_budget` is exhausted. Skip individual nodes that would bust the budget (continue to next).

**Current LocalAdapter behavior** (`context.ts`):
- Calls `computePPR()` from `ppr.ts` which loads all edges via Drizzle ORM.
- `always_include_types`: Fetches ALL nodes of those types from DB regardless of PPR results (`SELECT ... FROM nodes WHERE type IN (...)`). Force-includes them all (no budget check).
- Seeds: force-included (no budget check).
- Ranked nodes: greedily added with budget check. If a single node busts remaining budget, it is **skipped** (continues to next node).
- Builds Node objects from YAML file content.

**Current Server behavior** (`services/ppr.ts`):
- `fetchEdges()` loads all edges, excludes CONTAINMENT_EDGE_TYPES.
- Same PPR algorithm (undirected, dampening, weights).
- `always_include_types`: Iterates `nodePropsMap` (only nodes from PPR edges + seeds), checks if any Neo4j label matches the always_include set. Uses `forceInclude()` which ignores budget.
- Seeds: force-included via `forceInclude()`.
- Ranked nodes: added via `tryInclude()` which checks budget. If a single node busts budget, **breaks the loop** (stops adding more nodes).

**Divergences**:

1. **always_include_types scope**: LocalAdapter fetches ALL nodes of the specified types from the entire DB. Server only checks nodes that appeared in the PPR edge graph (the `nodePropsMap` which is built from PPR edges + seeds). If a node of an always_include type has no edges at all, LocalAdapter includes it but Server does not. **Fix needed**: Server should query Neo4j for all nodes of always_include types, not just those in the PPR edge graph.

2. **Budget enforcement on ranked nodes**: LocalAdapter skips nodes that bust budget and continues. Server breaks out of the loop entirely when a node busts budget. This means Local may include a smaller node later in the ranking that fits, while Server stops. **Fix needed**: Server should skip-and-continue instead of break.

3. **Content format**: LocalAdapter returns raw YAML file content. Server returns `JSON.stringify(filteredNodeProps)`. This is inherent to the adapter abstraction (Local=YAML, Remote=JSON). **Acceptable divergence** per the interface contract.

4. **Node object in TraversalResult**: LocalAdapter builds Node from YAML parse (context.ts `nodeRowToNode`). Properties are the full YAML parsed object. Server returns node metadata but the RemoteAdapter's traverse constructs Node from `mapGqlNodeToNode(rn.node)` which does NOT have the `content` field (the query fragment is `ARTIFACT_NODE_FIELDS` without content). Properties will be empty. **Fix needed**: The assembleContext query should include content in the node fragment, or the server resolver should populate it.

5. **Excluded edge types**: Server's `fetchEdges()` excludes `CONTAINMENT_EDGE_TYPES` (OWNS_CODEBASE, OWNS_PROJECT, etc.). Local does not have these edge types in SQLite, so no divergence in practice.

**Recommended fixes**:

**Fix 1 — Server** (`ideate-server/src/services/ppr.ts`, `runPPR` function, around line 483):
After building `nodePropsMap` from PPR edges, add a Neo4j query to fetch all nodes of `alwaysIncludeTypes`:
```typescript
if (alwaysIncludeTypes.length > 0) {
  // Fetch ALL nodes of always_include types, not just those in PPR edges
  const alwaysNodes = await fetchNodesByType(driver, orgId, alwaysIncludeTypes);
  for (const [id, props] of alwaysNodes.entries()) {
    if (!nodePropsMap.has(id)) {
      nodePropsMap.set(id, props);
    }
  }
}
```
Add a new helper function `fetchNodesByType()`:
```typescript
async function fetchNodesByType(driver: Driver, orgId: string, types: string[]): Promise<Map<string, NodeProperties>> {
  const session = getSession(driver);
  try {
    const result = await session.run(
      `MATCH (n {org_id: $orgId}) WHERE any(label IN labels(n) WHERE label IN $types) RETURN n`,
      { orgId, types },
    );
    const map = new Map<string, NodeProperties>();
    for (const rec of result.records) {
      const node = rec.get("n") as { properties: Record<string, unknown>; labels: string[] };
      const props = node.properties as NodeProperties;
      props["labels"] = node.labels;
      const artifactId = props["artifact_id"];
      if (typeof artifactId === "string") map.set(artifactId, props);
    }
    return map;
  } finally {
    await session.close();
  }
}
```

**Fix 2 — Server** (`ideate-server/src/services/ppr.ts`, `runPPR` function, around line 504):
Change the break to a continue:
```typescript
// BEFORE:
if (!added) {
  const props = nodePropsMap.get(id);
  if (props && tokensUsed + getTokenCount(props) > tokenBudget) {
    break; // <-- stops too early
  }
}

// AFTER:
if (!added) {
  // Budget exceeded for this node, but smaller nodes later might fit.
  // Continue to try the next node.
  continue;
}
```

**Fix 3 — Plugin** (`ideate/mcp/artifact-server/src/adapters/remote/index.ts`, `traverse` method, around line 585):
Add `content` to the node fragment in the assembleContext query so that the Node object has populated properties:
```typescript
// BEFORE:
rankedNodes {
  node {
    ${ARTIFACT_NODE_FIELDS}
  }
  score
  content
}

// AFTER:
rankedNodes {
  node {
    ${ARTIFACT_NODE_FIELDS_WITH_CONTENT}
  }
  score
  content
}
```

---

### 11. queryGraph

**Signature**: `queryGraph(query: GraphQuery, limit: number, offset: number): Promise<QueryResult>`

**Canonical behavior**:
BFS from an origin node up to `depth` hops. Return nodes found with their edge_type, direction, depth, and a summary string. Throw NotFoundError if origin does not exist. Paginate results by limit/offset. Return total_count of all matching nodes (before pagination). The BFS MUST be effectively undirected when `direction="both"` -- traverse edges in both directions.

**Current LocalAdapter behavior**:
- Verifies origin exists, throws NotFoundError if not.
- For depth=1: direct SQL joins on edges table. For direction "both", uses UNION of outgoing and incoming queries.
- For depth>1: recursive CTE.
- The edges table stores directed edges but the SQL queries explicitly traverse both directions via separate clauses or UNION.
- Builds summary strings from extension tables via `_buildSummaryMap`.
- NodeMeta in results includes `cycle_created: null, cycle_modified: null, content_hash: ""` for graph query results (not fetched for performance).
- Returns total_count as a COUNT(*) over the full filtered result set.

**Current RemoteAdapter behavior**:
- Sends `graphQuery(query, first, after)` with cursor-based pagination.
- Pagination: encodes offset as base64 cursor for the `after` parameter.

**Server behavior** (`resolvers/queries/graph.ts`):
- Uses DataLoader-based BFS.
- Loads edges per frontier node via edge DataLoader (direction-specific: OUTGOING and/or INCOMING keys).
- Excludes CONTAINMENT_EDGE_TYPES from traversal.
- Excludes EXCLUDED_NODE_TYPES (ORGANIZATION, CODEBASE, DOMAIN).
- Summary: generates `"Depth N via EDGE_TYPE"` instead of type-specific summaries from extension tables.
- `cycle_created` and `cycle_modified` ARE populated from Neo4j node properties (via `mapNodeToGraphQL`).
- Returns `totalCount` as the count of all BFS results (no separate count query).

**Divergences**:

1. **cycle_created/cycle_modified**: LocalAdapter returns null for these in queryGraph results (line 626-631 builds a minimal NodeMeta). Server returns actual values. **Fix needed**: LocalAdapter should populate these from the nodes table.

2. **content_hash**: LocalAdapter returns empty string. Server returns actual hash. **Fix needed**: LocalAdapter should populate from the nodes table.

3. **Summary format**: LocalAdapter returns type-specific summaries (e.g. work_item title, finding severity). Server returns generic `"Depth N via EDGE_TYPE"`. **Fix needed**: Server should return type-specific summaries matching LocalAdapter.

4. **Node count at multi-hop depth**: LocalAdapter's recursive CTE treats edges as undirected (separate UNION branches for outgoing and incoming at each hop). Server's BFS loads edges by direction key and traverses OUTGOING + INCOMING separately. Both should produce the same node set. However, server excludes CONTAINMENT_EDGE_TYPES which local does not have. **No functional divergence** (containment edges don't exist in local SQLite).

5. **Pagination model**: LocalAdapter uses limit/offset. Server uses cursor-based pagination (first/after). RemoteAdapter converts offset to a cursor by encoding `offset-1` as base64. Server decodes cursor to `afterArtifactId` and filters `n.artifact_id > $afterArtifactId`. This is a different pagination model: offset-based vs cursor-based. For equivalence tests, offset=0 and small result sets should align.

6. **Filtered node still in frontier**: Server adds filtered-out nodes (type mismatch, filter mismatch) to the next frontier for deeper BFS. LocalAdapter's SQL filters them out of results but the recursive CTE may or may not traverse through them depending on SQL query structure. The recursive CTE traverses ALL edges regardless of type_filter; filtering is applied after traversal. **Aligned behavior**.

**Recommended fixes**:

**Fix 1 — Plugin** (`ideate/mcp/artifact-server/src/adapters/local/reader.ts`, `queryGraph` method, around line 623):
Populate NodeMeta fully instead of using nulls:
```typescript
// BEFORE:
const nodeMeta: NodeMeta = {
  id: r.node_id,
  type: r.type as NodeType,
  status: r.status,
  cycle_created: null,
  cycle_modified: null,
  content_hash: "",
  token_count: null,
};

// AFTER: Fetch full metadata from nodes table for result rows
```
Specifically, add `n.cycle_created, n.cycle_modified, n.content_hash, n.token_count` to the SQL select. The depth>1 recursive CTE case needs to join on nodes at the final select.

For the depth=1 case, change the SQL to include these fields from the `nodes n` join:
```sql
SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status,
       n.cycle_created, n.cycle_modified, n.content_hash, n.token_count
FROM edges e JOIN nodes n ON n.id = e.target_id
WHERE e.source_id = ? ...
```
Then populate NodeMeta from these columns.

For the depth>1 recursive CTE, the final SELECT already joins on `nodes n`. Add the same columns.

**Fix 2 — Server** (`ideate-server/src/resolvers/queries/graph.ts`, around line 291):
Generate type-specific summaries instead of depth-based strings:
```typescript
// BEFORE:
summary: `Depth ${item.depth}${item.edgeType !== null ? ` via ${item.edgeType}` : ""}`,

// AFTER: Generate type-aware summary from node properties
// Use a helper that maps type -> summary expression (title for work_items,
// severity + verdict for findings, etc.)
```
This requires implementing a `buildSummary(node: MappedNode): string` function that mirrors the LocalAdapter's TYPE_EXTENSION_INFO summaryExpr logic.

---

### 12. queryNodes

**Signature**: `queryNodes(filter: NodeFilter, limit: number, offset: number): Promise<QueryResult>`

**Canonical behavior**:
Query nodes by type and filters with pagination. Return NodeMeta + summary for each matching node, plus total_count. When type is `work_item` and no status filter is provided, exclude `done` and `obsolete` items by default.

**Current LocalAdapter behavior**:
- Builds SQL query joining nodes with extension tables.
- Generates summary from extension table summary expressions.
- Counts total before pagination.
- Returns full NodeMeta from the nodes table.

**Current RemoteAdapter behavior**:
- Sends `artifactQuery(filter, first, offset)` query.
- Maps results via `mapGqlNodeToMeta()`.
- Summary is always empty string (`""`) -- server's artifactQuery does not return summaries.

**Server behavior** (`resolvers/queries/artifact.ts`):
- Builds Cypher WHERE clause from filter fields.
- Default exclusion for WORK_ITEM without status: excludes done/obsolete. **Aligned with LocalAdapter**.
- Returns full node objects. RemoteAdapter maps to NodeMeta.
- Pagination: supports offset-based.

**Divergences**:

1. **Summary**: LocalAdapter returns type-specific summaries. RemoteAdapter returns empty string. This is a presentation issue -- the data is available on the server but the query/resolver doesn't compute it. **Fix needed for parity**.

2. **Filter field mapping**: RemoteAdapter's `buildFilterInput` maps `work_item` to `workItem` and `work_item_type` to `workItemType` (camelCase). Server matches on `n.work_item` and `n.work_item_type` (snake_case Neo4j properties). **Aligned** -- the GraphQL filter uses camelCase keys, server maps to snake_case property accessors.

**Recommended fix**:

**Server** or **RemoteAdapter**: To achieve summary parity, either:
(a) Add a summary field to the `artifactQuery` response. The server resolver would need to compute summaries from node properties (matching LocalAdapter's TYPE_EXTENSION_INFO). This is the cleanest fix.
(b) Have the RemoteAdapter compute summaries client-side from node properties by requesting `ARTIFACT_NODE_FIELDS_WITH_CONTENT` and extracting summary from parsed content. This avoids a server change.

Recommended: Option (b) is simpler. In `ideate/mcp/artifact-server/src/adapters/remote/index.ts`, `queryNodes` method:
```typescript
// Request content so we can compute summaries
const data = await this.client.query<{...}>(
  `query QueryNodes($filter: NodeFilterInput, $first: Int, $offset: Int) {
    artifactQuery(filter: $filter, first: $first, offset: $offset) {
      edges { node { ${ARTIFACT_NODE_FIELDS_WITH_CONTENT} } }
      pageInfo { totalCount }
    }
  }`, ...
);

// Compute summary from content for each node
```
Then implement a `computeSummary(type: string, content: string): string` function.

---

### 13. nextId

**Signature**: `nextId(type: NodeType, cycle?: number): Promise<string>`

**Canonical behavior**:
Generate the next available ID for a given node type. IDs follow type-specific prefix conventions. The strategy MUST be MAX+1 (find the highest existing numeric suffix and increment), not COUNT (count existing nodes), to handle gaps from deleted nodes.

**Current LocalAdapter behavior** (split between writer.ts and reader.ts):

Writer handles `journal_entry` and `finding`:
- **journal_entry**: `J-{cycle}-{seq}` where seq = `COUNT(*) FROM nodes WHERE type='journal_entry' AND cycle_created=?`. Uses COUNT, not MAX. **Zero-indexed** (first entry is J-001-000).
- **finding**: `F-{cycle}-{seq}` where seq = `COUNT(*) + 1`. **One-indexed**.
- **work_item**: `WI-{next}` where next = `MAX(numeric suffix) + 1`. Uses MAX.

Reader handles all other types:
- Uses MAX+1 strategy: `SELECT MAX(CAST(SUBSTR(id, LENGTH(prefix)+1) AS INTEGER))`.
- For cycle-scoped types (proxy_human_decision): `prefix-cycle-seq` with MAX+1.
- Prefixes: WI-/GP-/C-/P-/D-/Q-/PHD-/PR-/PH- with varying pad widths.

**Current RemoteAdapter behavior**:
- Sends `nextId(type, cycle)` query.

**Server behavior** (`services/id-generator.ts`):
- Uses MAX+1 strategy: queries Neo4j for highest existing ID matching `prefix + \d{3}` regex, parses numeric suffix, increments.
- Prefixes differ from LocalAdapter:
  - `DOMAIN_POLICY` -> `DP-` (server) vs `P-` (local)
  - `DOMAIN_DECISION` -> `DD-` (server) vs `D-` (local)
  - `DOMAIN_QUESTION` -> `DQ-` (server) vs `Q-` (local)
  - `CONSTRAINT` -> `CON-` (server) vs `C-` (local)
  - `PROJECT` -> `PRJ-` (server) vs `PR-` (local)
  - `MODULE_SPEC` -> `MS-` (server) vs same (local has no explicit mapping, falls through to reader)
  - `WORK_ITEM` -> `WI-` (both)
  - `GUIDING_PRINCIPLE` -> `GP-` (both)
  - `FINDING` -> `F-` (both)
  - `JOURNAL_ENTRY` -> `J-` (both)
  - `PHASE` -> `PH-` (both)
  - `PROXY_HUMAN_DECISION` -> `PHD-` (both)

**Divergences**:

1. **ID prefixes for domain types**: Local uses `P-`, `D-`, `Q-`, `C-`, `PR-`. Server uses `DP-`, `DD-`, `DQ-`, `CON-`, `PRJ-`. This means the same node type gets different ID prefixes depending on which adapter is used. **Major divergence**.

2. **journal_entry sequence strategy**: Local uses COUNT (zero-indexed). Server uses MAX+1. If journal entries are deleted, COUNT gives a lower number and may collide. MAX+1 never collides.

3. **finding sequence strategy**: Local uses COUNT+1. Server uses MAX+1. Same gap/collision risk as journal_entry.

4. **Pad width**: Server always uses 3 digits. Local uses 2 digits for GP, C, P, D, Q, PHD, and 3 for WI, PR, PH. Difference: `GP-01` (local) vs `GP-001` (server).

**Recommended fixes**:

**Fix 1 — Server** (`ideate-server/src/services/id-generator.ts`): Align prefixes with LocalAdapter:
```typescript
// Change these entries in TYPE_TO_LABEL_MAP:
DOMAIN_POLICY:  { prefix: "P",   ... }  // was "DP"
DOMAIN_DECISION: { prefix: "D",  ... }  // was "DD"
DOMAIN_QUESTION: { prefix: "Q",  ... }  // was "DQ"
CONSTRAINT:     { prefix: "C",   ... }  // was "CON"
PROJECT:        { prefix: "PR",  ... }  // was "PRJ"
```

**Fix 2 — Plugin** (`ideate/mcp/artifact-server/src/adapters/local/writer.ts`): Change journal_entry and finding from COUNT to MAX+1:
```typescript
// journal_entry: change from COUNT to MAX+1
// BEFORE:
const seqRow = this.db.prepare(
  `SELECT COUNT(*) as cnt FROM nodes WHERE type = 'journal_entry' AND cycle_created = ?`
).get(cycleNum) as { cnt: number };
const seq = seqRow?.cnt ?? 0;

// AFTER:
const maxRow = this.db.prepare(
  `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
).get(prefix.length + 1, `J-${cycleStr}-%`) as { max_num: number | null };
const seq = (maxRow?.max_num ?? -1) + 1;
```
Similarly for finding.

**Fix 3 — Server** (`ideate-server/src/services/id-generator.ts`): Align pad widths. For types where Local uses 2-digit padding, use 2 digits:
- GP: 2 digits
- C: 2 digits
- P: 2 digits
- D: 2 digits
- Q: 2 digits
- PHD: 2 digits
Currently the server uses `String(nextNum).padStart(3, "0")` universally. Add a `padWidth` field to `TYPE_TO_LABEL_MAP` entries.

---

### 14. batchMutate

**Signature**: `batchMutate(input: BatchMutateInput): Promise<BatchMutateResult>`

**Canonical behavior**:
Atomically create/update multiple nodes and edges. Validate DAG cycles and scope collisions before persisting. On validation failure, return errors and persist nothing. Return `{results: [{id, status: "created"|"updated"}], errors: [{id, error}]}`.

**Current LocalAdapter behavior**:
- Assigns IDs for nodes without one (work_items get MAX+1 WI- IDs).
- DAG cycle detection via temp edge insertion + `detectCycles()`.
- Scope collision detection between work items.
- Two-phase write: YAML files first, then SQLite in exclusive transaction.
- Returns `status: "created"` for ALL nodes (does not check if existing). This is a bug -- should check.
- `errors` array items have shape `{id: string, error: string}`.

**Current RemoteAdapter behavior**:
- Sends `batchMutate(input: BatchMutateInput!)` mutation.
- Maps results: lowercases status.
- Maps errors: `{id: e.id ?? "", error: e.error}` -- drops the `code` field from server response.

**Server behavior** (`resolvers/mutations/batch.ts`):
- Validates via `validateBatch()` service.
- All nodes and edges in a single Neo4j transaction.
- Uses MERGE (idempotent create/update) and checks `wasCreated` to determine status.
- Returns `{results: [{id, status: "CREATED"|"UPDATED"}], errors: [{id, error, code}]}`.
- The content blob issue applies here too: `rawProps["content"] = JSON.stringify(input.properties)` stores only caller input.

**Divergences**:

1. **Status always "created"**: LocalAdapter returns `"created"` for all nodes regardless of whether they existed. Server correctly returns `"created"` or `"updated"`. **Fix needed**: LocalAdapter should check existence.

2. **Content blob truncation**: Same issue as putNode -- server stores only caller input in content blob. **Fix needed** (same fix as putNode).

3. **Error shape**: Server returns `{id, error, code}`. RemoteAdapter drops `code`. LocalAdapter returns `{id, error}`. Interface defines `errors: Array<{ id: string; error: string }>` without `code`. **Aligned with interface** -- `code` is extra server metadata that can be dropped.

**Recommended fixes**:

**Fix 1 — Plugin** (`ideate/mcp/artifact-server/src/adapters/local/writer.ts`, `batchMutate` method, around line 1044):
```typescript
// BEFORE (line 1044-1046):
for (const node of resolvedNodes) {
  results.push({ id: node.resolvedId, status: "created" });
}

// AFTER:
for (const node of resolvedNodes) {
  const existing = this.db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(node.resolvedId);
  results.push({ id: node.resolvedId, status: existing ? "updated" : "created" });
}
```
Note: this check must happen BEFORE the upsert transaction, or stored as state during it.

**Fix 2 — Server**: Same content blob fix as putNode (method 4).

---

### 15. countNodes

**Signature**: `countNodes(filter: NodeFilter, group_by: "status"|"type"|"domain"|"severity"): Promise<Array<{key: string, count: number}>>`

**Canonical behavior**:
Count nodes grouped by a dimension. Filter by type, status, etc. Return array of `{key, count}`. Keys MUST be lowercase for type grouping. When grouping by domain, only nodes with a domain property contribute. Null domain maps to key `"unknown"`.

**Current LocalAdapter behavior**:
- Builds SQL with GROUP BY on the appropriate field.
- For `domain` grouping: joins extension tables that have a `domain` column (work_items, domain_policies, domain_decisions, domain_questions). Uses INNER JOIN so only nodes with domains are counted.
- For `severity` grouping: joins `findings` table, respects cycle filter.
- Null keys become `"unknown"`.

**Current RemoteAdapter behavior**:
- Sends `nodeCounts(filter, groupBy)` query.

**Server behavior** (`resolvers/queries/status.ts`):
- Builds Cypher with GROUP BY on the mapped property field.
- For DOMAIN grouping: adds `AND n.domain IS NOT NULL` to exclude nodes without domain. **Aligned with LocalAdapter**.
- For TYPE grouping: lowercases the key. **Aligned**.
- Excludes Organization, Codebase, Domain nodes. **Aligned** (LocalAdapter doesn't have these).

**Divergences**:
Domain grouping is now aligned. No remaining divergences after the recent fix to add `IS NOT NULL` on server.

**Recommended fix**:
No fix needed. Both are aligned.

---

### 16. getDomainState

**Signature**: `getDomainState(domains?: string[]): Promise<Map<string, {...}>>`

**Canonical behavior**:
Return domain state: active policies, decisions, and open questions grouped by domain. Policies exclude deprecated/superseded. Questions include only `open` status. Decisions include all. If specific domains are requested, filter to those domains.

**Current LocalAdapter behavior**:
- Queries `domain_policies` joined with `nodes` where status is not deprecated/superseded.
- Queries `domain_decisions` joined with `nodes` (no status filter).
- Queries `domain_questions` joined with `nodes` where `status = 'open'`.
- Groups by domain, filters to requested domains if specified.

**Current RemoteAdapter behavior**:
- Sends `domainState(domains)` query.
- Converts returned array into a Map.

**Server behavior** (`resolvers/queries/domain.ts`):
- Queries DomainPolicy nodes (no status filter on policies -- server does NOT exclude deprecated/superseded).
- Queries DomainDecision nodes (no status filter).
- Queries DomainQuestion nodes with `status = 'open' OR status = 'OPEN'`. **Aligned for open-only**.
- Groups by domain.
- If specific domains requested, ensures empty domains are included.

**Divergences**:

1. **Policy status filter**: LocalAdapter excludes deprecated/superseded policies. Server includes all policies regardless of status. **Fix needed**: Server should exclude deprecated/superseded.

2. **Empty domain handling**: Server creates empty entries for requested domains even if no nodes exist in them. LocalAdapter only includes domains that have at least one node across all three categories. **Minor divergence** -- server behavior is more helpful.

**Recommended fix**:

**Server** (`ideate-server/src/resolvers/queries/domain.ts`, policies query, around line 58):
Add a status filter to the policies Cypher:
```cypher
-- BEFORE:
MATCH (n:DomainPolicy {org_id: $orgId})

-- AFTER:
MATCH (n:DomainPolicy {org_id: $orgId})
WHERE NOT n.status IN ['deprecated', 'superseded', 'DEPRECATED', 'SUPERSEDED']
  OR n.status IS NULL
```

---

### 17. getConvergenceData

**Signature**: `getConvergenceData(cycle: number): Promise<{findings_by_severity: Record<string, number>, cycle_summary_content: string | null}>`

**Canonical behavior**:
Return finding counts by severity for a cycle, and the cycle summary document content if available.

**Current LocalAdapter behavior**:
- Queries `findings` table by cycle for severity counts.
- Searches for cycle_summary node by cycle number. Looks in `document_artifacts` table for content. Falls back to reading YAML file from file_path.
- Returns raw YAML/document content if from file, or parsed JSON content if from DB.

**Current RemoteAdapter behavior**:
- Sends `convergenceStatus(cycleNumber)` query.
- Maps `findingsBySeverity` array to a Record.

**Server behavior** (`resolvers/queries/status.ts`):
- Queries Finding nodes with matching cycle and org.
- Queries for CYCLE_SUMMARY node where `cycle = $cycleNumber OR cycle_created = $cycleNumber`.
- Returns `content` property (the JSON blob) directly.

**Divergences**:

1. **cycle_summary_content format**: LocalAdapter may return raw YAML (from file) or the content field from document_artifacts. Server returns the JSON `content` property which is `JSON.stringify(input.properties)`. If the cycle summary was created via putNode with `{title: "Summary", content: "...markdown..."}`, server returns `'{"title":"Summary","content":"...markdown..."}'` while LocalAdapter returns either raw YAML or the `content` field from document_artifacts table (which for document types is `typeof content.content === "string" ? content.content : JSON.stringify(content)`).

2. **Cycle matching**: LocalAdapter matches by `da.cycle = ?` OR file_path pattern `%/cycles/NNN/%`. Server matches by `n.cycle = $cycleNumber OR n.cycle_created = $cycleNumber`. These are different matching strategies.

**Recommended fix**:

**Server** (`ideate-server/src/resolvers/queries/status.ts`, `convergenceStatus`, around line 327):
Parse the `content` JSON blob and extract the inner `content` field if it exists:
```typescript
// BEFORE:
const cycleSummaryContent = summaryRecord?.get("content") ?? null;

// AFTER:
let cycleSummaryContent: string | null = null;
const rawContent = summaryRecord?.get("content") as string | null;
if (rawContent != null) {
  try {
    const parsed = JSON.parse(rawContent);
    cycleSummaryContent = typeof parsed.content === 'string' ? parsed.content : rawContent;
  } catch {
    cycleSummaryContent = rawContent;
  }
}
```

---

### 18. archiveCycle

**Signature**: `archiveCycle(cycle: number): Promise<string>`

**Canonical behavior**:
Archive completed work items and findings for a given cycle. Return a human-readable summary string. Format: `"Archived cycle N: X work items, Y {findings|incremental reviews} moved."`. No-op on already-archived cycle (returns zero counts). On error, return error string (do not throw).

**Current LocalAdapter behavior**:
- Physically moves YAML files: copies findings to `archive/cycles/NNN/incremental/`, copies referenced work items to `archive/cycles/NNN/work-items/`.
- Three-phase: copy, verify hashes, delete originals.
- Updates SQLite: deletes finding node rows, updates work item file_paths.
- Returns: `"Archived cycle N: X work items, Y incremental reviews moved."`
- Uses term "incremental reviews" for findings.

**Current RemoteAdapter behavior**:
- Sends `archiveCycle(cycleNumber)` mutation.
- Returns the server's string directly.

**Server behavior** (`resolvers/mutations/lifecycle.ts`):
- Transitions work item and finding nodes from `status='active'` to `status='archived'`.
- No file operations (no YAML/archive directory concepts).
- Returns: `"Archived cycle N: X work items, Y findings moved."`
- Uses term "findings" instead of "incremental reviews".

**Divergences**:

1. **Return message wording**: Local says "incremental reviews". Server says "findings". **Fix needed for string equivalence**.

2. **Archive mechanism**: Local moves files + deletes SQLite rows. Server changes status to 'archived'. These are functionally equivalent from the caller's perspective (nodes are no longer "active").

3. **Matching criteria**: Local finds findings in `cycles/NNN/findings/` directory. Server matches `cycle_created = $cycle AND status = 'active'`. If findings were created with a different cycle_created, they won't match on server but might exist in the directory for local.

**Recommended fix**:

**Server** (`ideate-server/src/resolvers/mutations/lifecycle.ts`, around line 232):
```typescript
// BEFORE:
const summary = `Archived cycle ${cycleNumber}: ${workItemsMoved} work items, ${findingsMoved} findings moved.`;

// AFTER:
const summary = `Archived cycle ${cycleNumber}: ${workItemsMoved} work items, ${findingsMoved} incremental reviews moved.`;
```

---

### 19. appendJournalEntry

**Signature**: `appendJournalEntry(args: {skill, date, entryType, body, cycle}): Promise<string>`

**Canonical behavior**:
Create a new journal entry node for a cycle. Generate ID in format `J-{cycle}-{seq}` where cycle is zero-padded to 3 digits and seq is the next available sequence number (MAX+1 strategy). Return the generated ID string.

**Current LocalAdapter behavior**:
- Inside an exclusive transaction:
  - Counts existing journal entries for the cycle: `SELECT COUNT(*) FROM nodes WHERE type='journal_entry' AND cycle_created=?`
  - Sequence = count (zero-indexed, so first entry is J-001-000).
  - Builds YAML object, writes to disk at `cycles/NNN/journal/J-NNN-NNN.yaml`.
  - Upserts into nodes and journal_entries tables.

**Current RemoteAdapter behavior**:
- Sends `appendJournal(input: JournalEntryInput!)` mutation.
- Returns the `id` from the response.

**Server behavior** (`resolvers/mutations/lifecycle.ts`):
- Calls `generateNextId(session, {type: "JOURNAL_ENTRY", ...})`.
- id-generator uses MAX+1 strategy with prefix `J-` and optional cycle scoping.
- `buildIdPrefix("JOURNAL_ENTRY", cycle)` returns `J-{paddedCycle}-` for cycle-scoped.
- Queries highest existing ID matching `J-NNN-\d{3}` and increments.
- Creates JournalEntry node with CREATE (not MERGE), so it's always a new node.
- Stores properties: skill, date, entry_type, body on the Neo4j node directly.
- Returns `{id, status: "CREATED"}`.

**Divergences**:

1. **Sequence numbering**: LocalAdapter uses COUNT (zero-indexed). Server uses MAX+1 (one-indexed). First entry: Local = `J-001-000`, Server = `J-001-001`. After deleting J-001-000, Local creates J-001-000 again (collision risk), Server creates J-001-001 (gap-safe). **Fix needed**.

2. **Property mapping**: LocalAdapter stores `phase: skill`, `title: entryType`, `content: body`. Server stores `skill`, `entry_type`, `body` as direct node properties. These are different field names for the same data.

**Recommended fix**:

**Fix 1 — Plugin** (`ideate/mcp/artifact-server/src/adapters/local/writer.ts`, `putNodeForJournal` method, around line 1242):
```typescript
// BEFORE (COUNT-based, zero-indexed):
const seqRow = this.db.prepare(
  `SELECT COUNT(*) as cnt FROM nodes WHERE type = 'journal_entry' AND cycle_created = ?`
).get(cycleNumber) as { cnt: number };
const seq = seqRow?.cnt ?? 0;

// AFTER (MAX+1, one-indexed):
const maxRow = this.db.prepare(
  `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
).get(`J-${cycleStr}-`.length + 1, `J-${cycleStr}-%`) as { max_num: number | null };
const seq = (maxRow?.max_num ?? 0) + 1;
```

Also fix the `nextId` method for journal_entry in writer.ts (line 462-472) to use the same MAX+1 strategy.

**Fix 2 — Server** (`ideate-server/src/resolvers/mutations/lifecycle.ts`, `appendJournal`):
Map the field names to match LocalAdapter conventions when storing:
```typescript
// Current: stores as skill, entry_type, body
// Should also store as: phase (= skill), title (= entryType), content (= body)
// This is needed for getDomainState and queryNodes which look for 'phase' and 'title' fields.
props["phase"] = input.skill;
props["title"] = input.entryType;
props["content"] = input.body;
```

---

### 20. initialize

**Signature**: `initialize(): Promise<void>`

**Canonical behavior**:
Initialize the adapter. Called once at server startup.

**Current LocalAdapter behavior**:
No-op. Initialization is done externally in server.ts.

**Current RemoteAdapter behavior**:
Validates connection by issuing a lightweight `nextId` query. Throws `ConnectionError` on failure.

**Divergences**:
None relevant to equivalence tests. Lifecycle methods are not tested for behavioral equivalence.

**Recommended fix**:
No fix needed.

---

### 21. shutdown

**Signature**: `shutdown(): Promise<void>`

**Canonical behavior**:
Gracefully shut down the adapter.

**Current LocalAdapter behavior**:
No-op.

**Current RemoteAdapter behavior**:
No-op (fetch-based client has no persistent connection).

**Divergences**:
None.

**Recommended fix**:
No fix needed.

---

## Summary of All Fixes Required

### Server fixes (ideate-server)

| # | File | Method | Fix |
|---|------|--------|-----|
| S1 | `src/resolvers/mutations/node.ts` | putNode | Merge existing content blob with new input on ON MATCH path instead of replacing |
| S2 | `src/resolvers/mutations/batch.ts` | batchMutate | Same content blob merge fix as S1 (in `prepareNodeProps` or the MERGE cypher) |
| S3 | `src/services/id-generator.ts` | nextId | Align prefixes: DP->P, DD->D, DQ->Q, CON->C, PRJ->PR. Add per-type pad widths. |
| S4 | `src/services/ppr.ts` | runPPR | Fetch ALL nodes of always_include types from Neo4j, not just PPR-reachable ones |
| S5 | `src/services/ppr.ts` | runPPR | Change budget-exceeded `break` to `continue` for ranked node inclusion |
| S6 | `src/resolvers/queries/graph.ts` | graphQuery | Generate type-specific summaries matching LocalAdapter |
| S7 | `src/resolvers/queries/domain.ts` | domainState | Exclude deprecated/superseded policies |
| S8 | `src/resolvers/queries/status.ts` | convergenceStatus | Parse content JSON to extract inner content field |
| S9 | `src/resolvers/mutations/lifecycle.ts` | archiveCycle | Change "findings" to "incremental reviews" in return message |
| S10 | `src/resolvers/mutations/lifecycle.ts` | appendJournal | Add phase/title/content property aliases for field mapping |

### Plugin fixes (ideate)

| # | File | Method | Fix |
|---|------|--------|-----|
| P1 | `mcp/artifact-server/src/adapters/local/reader.ts` | queryGraph | Populate cycle_created, cycle_modified, content_hash, token_count in NodeMeta |
| P2 | `mcp/artifact-server/src/adapters/local/writer.ts` | nextId (journal) | Change from COUNT to MAX+1 for journal_entry and finding ID generation |
| P3 | `mcp/artifact-server/src/adapters/local/writer.ts` | putNodeForJournal | Change from COUNT to MAX+1 for sequence numbering |
| P4 | `mcp/artifact-server/src/adapters/local/writer.ts` | batchMutate | Check existence to return correct "created"/"updated" status |
| P5 | `mcp/artifact-server/src/adapters/remote/index.ts` | traverse | Use ARTIFACT_NODE_FIELDS_WITH_CONTENT in assembleContext query |

---

## Mapping to Test Failures

| Focus Area | Root Cause | Fixes |
|------------|-----------|-------|
| 1. getNode properties | Server content blob stores only input, not full property set | S1 |
| 2. queryGraph | Missing metadata in Local; different summaries | P1, S6 |
| 3. traverse (PPR) | always_include scope; budget break vs skip; empty node properties | S4, S5, P5 |
| 4. putNode/patchNode | Content blob truncation on update | S1 |
| 5. batchMutate | Always "created" status; content blob truncation | P4, S2 |
| 6. nextId | Different prefixes; COUNT vs MAX+1 | S3, P2 |
| 7. archiveCycle | "findings" vs "incremental reviews" | S9 |
| 8. appendJournalEntry | COUNT vs MAX+1; field name mapping | P3, S10 |
| 9. getConvergenceData | content JSON blob vs inner content field | S8 |
| 10. countNodes | Aligned (no remaining failures) | -- |
| 11. getDomainState | Policy status filter missing on server | S7 |
