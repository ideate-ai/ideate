# Gap Analysis — Cycle 022

## Verdict: Pass

All 11 planned tools are implemented and wired. The schema refactor is complete. Tests pass. Skill files updated. Several minor gaps identified — primarily documentation and test coverage.

## Critical Gaps

None.

## Significant Gaps

### SG1: Architecture Section 9 source code index is stale
- **File**: `specs/plan/architecture.md:573-584`
- **Gap**: The source code index table still lists `tools.ts` as a single file. The actual implementation has `tools/index.ts` plus 5 tool group files (context.ts, query.ts, execution.ts, analysis.ts, write.ts). Six new source files are missing from the index.
- **Impact**: Any agent reading the architecture for orientation will see outdated file information. Context assembly tools that use this table will report stale data.
- **Recommendation**: Update Section 9 to list all current source files with their exports. This is a documentation fix, not a code change.

### SG2: WI-190 AC "verifies defer_foreign_keys allows edges before targets during rebuild" — not testable
- **File**: `specs/plan/work-items.yaml` (WI-190 criteria), `mcp/artifact-server/src/indexer.ts`
- **Gap**: WI-190 acceptance criterion states the indexer tests should verify `defer_foreign_keys` behavior. However, the indexer implementation uses `foreign_keys = OFF` (not `defer_foreign_keys`). The test for "edges before targets during rebuild" exists but tests the FK-OFF mechanism, not deferred FK. The AC text is satisfied in spirit (edges before targets works) but not in letter (the specific pragma name doesn't match).
- **Impact**: Future maintainers reading the AC may be confused about which mechanism is used.
- **Recommendation**: Update the WI-190 AC text in work-items.yaml to say "verifies that edges can be inserted before targets during rebuild" (mechanism-neutral). Low priority — the YAML is archived after review.

## Minor Gaps

### MG1: ideate_artifact_query graph traversal mode has no test for depth > 1
- **File**: `mcp/artifact-server/src/__tests__/tools.test.ts`
- **Gap**: The tools test suite has tests for filter mode and error cases, but no test exercises the recursive CTE path (depth > 1 with `related_to`). The code-reviewer identified two bugs in this path (S1: cycle protection, S2: ambiguous column). Both would have been caught by a depth > 1 test.
- **Recommendation**: Add a test that creates a 3-node chain (A→B→C via depends_on edges) and queries `related_to: "A", depth: 3`. This would exercise the recursive CTE and catch the ambiguous column issue.

### MG2: No test for write tool synchronous SQLite update
- **File**: `mcp/artifact-server/src/__tests__/tools.test.ts`
- **Gap**: The tools test suite has an integration test for `append_journal → artifact_query`, but it relies on the watcher firing rather than testing the synchronous SQLite upsert that write tools should perform. The plan specified write tools "synchronously upsert affected rows into SQLite" but this behavior is not directly tested.
- **Recommendation**: Add a test that calls `handleAppendJournal`, then immediately queries the `journal_entries` table (without waiting for watcher) to verify the row exists.

### MG3: 7 tools excluded from research inventory not documented in overview.md
- **File**: `specs/plan/overview.md`
- **Assessment**: Actually present — overview.md includes a "Tools excluded from 18-tool research inventory" section with all 7 tools and rationale. No gap. (Retracted.)

### MG4: ideate_artifact_query `related_to` does not validate edge existence
- **File**: `mcp/artifact-server/src/tools/query.ts`
- **Gap**: The query tool validates that `related_to` node exists in the `nodes` table, but if the node has no edges, it returns an empty result without indication. This is acceptable behavior but the spec says "Error: Node '{id}' not found" for non-existent nodes — an isolated node (no edges) could be confusing since it exists but returns empty traversal results.
- **Recommendation**: No code change needed. The behavior is correct — an existing node with no edges legitimately has no connections. Could add a note in the response like "Node exists but has no edges" if the result is empty.

## Suggestions

### S1: Consider adding `UNION` deduplication in recursive CTE
The code-reviewer's S1 finding (cycle protection) is the highest-priority fix from this review. Changing `UNION ALL` to `UNION` in the recursive CTE body would prevent exponential blowup on cyclic non-depends_on edges with minimal performance cost at this scale.

### S2: Consider running `npm run build` in CI
The current test suite runs `vitest` but does not verify that the TypeScript compilation (`tsc`) succeeds. Adding `npm run build` or `tsc --noEmit` to the test pipeline would catch type errors that vitest (via esbuild) may miss.
