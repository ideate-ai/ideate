# Review Summary — Cycle 022

## Overview
Cycle 022 consolidated MCP artifact server Phases 2-5 into a single cycle: schema refactor (v6→v7 class table inheritance), 11 MCP tools, test suite rewrite, skill file updates. All 11 work items (WI-181–WI-191) complete. 207 tests pass. Two significant findings in the graph query tool's recursive CTE implementation. No critical findings.

## Significant Findings
- [code-reviewer] Recursive CTE in `ideate_artifact_query` uses `UNION ALL` without cycle protection; depth > 1 traversal on cyclic non-depends_on edges produces exponential duplicate rows — relates to: WI-186
- [code-reviewer] Ambiguous column name `id` in graph traversal ORDER BY (`query.ts:485`); filtered depth > 1 traversals may produce wrong ordering or SQLite error — relates to: WI-186

## Minor Findings
- [code-reviewer] `handleWriteWorkItems` uses string concatenation for YAML output; criteria with colons/quotes could produce malformed YAML — relates to: WI-189
- [code-reviewer] `context.ts` walkDir follows symbolic links; monorepo symlinks could inflate source index — relates to: WI-185
- [spec-reviewer] WI-183 AC-2 specifies `defer_foreign_keys` but implementation uses `foreign_keys = OFF`; functionally equivalent mechanism substitution — relates to: WI-183
- [spec-reviewer] Architecture Section 9 source code index lists deleted `tools.ts`, missing 5 new tool group files — relates to: cross-cutting
- [gap-analyst] Architecture Section 9 stale (same as spec-reviewer M2, independently identified) — relates to: cross-cutting
- [gap-analyst] WI-190 AC text references `defer_foreign_keys` but implementation uses `foreign_keys = OFF` — relates to: WI-190
- [gap-analyst] No test for depth > 1 graph traversal; both recursive CTE bugs would have been caught — relates to: WI-190
- [gap-analyst] No test for synchronous SQLite upsert in write tools — relates to: WI-190

## Suggestions
- [gap-analyst] Add `tsc --noEmit` to CI test pipeline to catch type errors esbuild may miss
- [gap-analyst] Add `entry.isSymbolicLink()` check in walkDir to prevent symlink traversal

## Findings Requiring User Input
None — all findings can be resolved from existing context.

## Proposed Refinement Plan
The review identified 0 critical and 2 significant findings. A refinement cycle is recommended to address:

1. **Q-75/Q-76**: Fix the recursive CTE in `query.ts` — change `UNION ALL` to `UNION` for cycle protection, alias `n.id` as `node_id` for unambiguous ORDER BY. Both are surgical fixes in one file.
2. **Q-78**: Add a depth > 1 graph traversal test to catch these bugs and prevent regression.
3. **Q-77**: Update architecture Section 9 source code index to reflect current file structure.

Estimated scope: 2-3 small work items. No architecture changes needed.
