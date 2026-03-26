## Verdict: Fail

All four acceptance criteria are met by the implementation, but no tests cover the new limit-exceeded code paths, leaving the guard logic unverified by the test suite.

## Critical Findings

None.

## Significant Findings

### S1: No tests for either traversal-limit guard

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/__tests__/indexer.test.ts:620`
- **Issue**: The test file's `detectCycles` section ends at line 620 with three test groups covering the happy path (empty DB, DAG, 2-node cycle, 3-node cycle). There are no tests that exercise the `MAX_DEPENDENCY_EDGES` throw path (lines 435–437 of `indexer.ts`) or the `MAX_DEPENDENCY_NODES` throw path (lines 448–450). Both branches are dead from the test suite's perspective.
- **Impact**: A regression that silently removes or misinverts either guard would pass all 111 tests. The acceptance criterion "all existing tests pass" is satisfied, but the new behaviour introduced by this work item has zero test coverage.
- **Suggested fix**: Add two tests to the `detectCycles` section:

```typescript
describe("detectCycles — traversal limits", () => {
  it("throws when edge count exceeds MAX_DEPENDENCY_EDGES", () => {
    const db = freshDb();
    const insert = db.prepare(`
      INSERT INTO edges (source_id, source_type, target_id, target_type, edge_type)
      VALUES (?, 'work_item', ?, 'work_item', 'depends_on')
    `);
    // Insert MAX_DEPENDENCY_EDGES + 1 edges using distinct node pairs
    for (let i = 0; i <= MAX_DEPENDENCY_EDGES; i++) {
      insert.run(`src-${i}`, `tgt-${i}`);
    }
    expect(() => detectCycles(db)).toThrow(/edge count .* exceeds limit/);
  });

  it("throws when node count exceeds MAX_DEPENDENCY_NODES", () => {
    const db = freshDb();
    const insert = db.prepare(`
      INSERT INTO edges (source_id, source_type, target_id, target_type, edge_type)
      VALUES (?, 'work_item', ?, 'work_item', 'depends_on')
    `);
    // One edge per pair: MAX_DEPENDENCY_NODES/2 + 1 edges yields
    // MAX_DEPENDENCY_NODES + 2 distinct nodes, within the edge limit.
    const nodeLimit = MAX_DEPENDENCY_NODES; // 10_000
    for (let i = 0; i <= nodeLimit / 2; i++) {
      insert.run(`a-${i}`, `b-${i}`);
    }
    expect(() => detectCycles(db)).toThrow(/node count .* exceeds limit/);
  });
});
```

Note: inserting 50 001 rows to test the edge path will be slow in a unit test. An alternative is to mock the DB query or restructure the guard to accept the limits as parameters, enabling injection of small values for testing. Either approach is acceptable; what matters is that both throw paths are exercised.

## Minor Findings

### M1: Node limit check fires after an O(E) allocation, not before

- **File**: `/Users/dan/code/ideate/mcp/artifact-server/src/indexer.ts:441`
- **Issue**: The code builds the full `allNodes` Set (iterating all E edges) before checking whether the node count exceeds the limit (line 448). For a payload that is within the edge limit but over the node limit, the function allocates memory for the entire edge list and node set before rejecting. The edge-count check correctly fires before any allocation-heavy work, but the node-count check does not benefit from the same early-exit property.
- **Suggested fix**: This is a minor efficiency concern only — correctness is not affected. To make the pattern consistent with the edge check, convert the node-collection loop to an early-exit:

```typescript
const allNodes = new Set<string>();
for (const e of edges) {
  allNodes.add(e.source_id);
  allNodes.add(e.target_id);
  if (allNodes.size > MAX_DEPENDENCY_NODES) {
    throw new Error(
      `detectCycles: node count exceeds limit ${MAX_DEPENDENCY_NODES}`
    );
  }
}
```

This also avoids reporting a stale `.size` value after the Set is fully populated.

## Unmet Acceptance Criteria

- [ ] Criterion 4 (all existing tests pass) is met, but the work item's own new behaviour is untested. The criterion as written does not require new tests, so this is logged as a Significant finding rather than an unmet criterion.

None.
