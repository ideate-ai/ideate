# Decision Log — Cycle 021

## Decisions Made This Cycle

### D-102: Q-68 and Q-71 combined into a single work item
**Date**: 2026-03-24
**Context**: Q-68 (stale `.d.ts`/`.js.map` artifacts not cleaned by build:migration) and Q-71 (pretest exits 0 on staleness or absence) both required changes to `mcp/artifact-server/package.json` and had no logical dependency between them.
**Decision**: Combined both questions into a single work item (WI-178) targeting `package.json` exclusively, rather than two separate work items.
**Rationale**: Single file scope; both changes are build-tooling hygiene with no interaction. One work item avoids unnecessary parallelism overhead for two-line changes in the same file.
**Source**: Cycle 021 refine interview (2026-03-24); WI-178

### D-103: toYaml array-item guard brought to full parity with scalar guard (Q-69)
**Date**: 2026-03-24
**Context**: Q-69 identified that the array-item quoting branch checked only 5 conditions while the scalar guard checked 14. Items starting with `>`, `'`, `{`, `[`, `*`, `&`, `!`, `|`, items with tabs, digit-starting items, and YAML keyword items were not being quoted in array context.
**Decision**: Expanded the array-item quoting condition to match all 14 scalar guard conditions (WI-179). User chose "full please" over partial parity.
**Rationale**: Inconsistent quoting between scalars and array items creates latent YAML correctness holes. Full parity eliminates the class of bug permanently.
**Source**: Refine interview user response ("1- full please"); WI-179; specs/plan/notes/179.md

### D-104: checkSchemaVersion version-mismatch test asserts both return value and file deletion (Q-70)
**Date**: 2026-03-24
**Context**: Q-70 identified two uncovered branches in `checkSchemaVersion`: the version-mismatch branch (closes DB, deletes files, returns false) and the version-current branch (returns true). The question was whether to test only the return value or also the side-effect (file deletion).
**Decision**: Test both the return value AND the file deletion side-effect for the version-mismatch branch. User delegated scope judgment ("use your best judgement"); deleting the wrong database is a data-loss risk, so the deletion must be tested.
**Rationale**: The deletion side-effect is the most consequential behavior in the function. Testing only the return value would leave the destructive operation unverified.
**Source**: Refine interview user response ("2- use your best judgement"); WI-180; specs/plan/notes/180.md

### D-105: Array-item guard uses `startsWith('"')` instead of `includes('"')` for structural parity
**Date**: 2026-03-25
**Context**: WI-179 incremental review M1 identified that the array-item guard used `item.includes('"')` while the scalar guard used `value.startsWith('"')`. The notes spec showed `includes('"')`, but structural parity with the scalar guard requires `startsWith('"')`. Items containing an embedded `"` not at position 0 are still handled correctly by the escape pass.
**Decision**: Replaced `item.includes('"')` with `item.startsWith('"')` in the array-item guard; mirrored in `migrate-to-v3.js`.
**Rationale**: Structural parity makes the two guards easier to audit as equivalent. No functional regression — mid-string double quotes are handled by the escape at emit time.
**Source**: WI-179 incremental review M1; execute phase rework

### D-106: Regex normalized to `/^\d/` in both scalar and array-item guards
**Date**: 2026-03-25
**Context**: WI-179 incremental review M2 identified that the scalar guard used `/^[\d]/` (character class) while the array-item guard used `/^\d/` (bare). Both are semantically identical but divergent in form.
**Decision**: Normalized both guards to `/^\d/` in `migrate-to-v3.ts` and `migrate-to-v3.js`.
**Rationale**: Consistent form eliminates reader confusion about whether the divergence is intentional.
**Source**: WI-179 incremental review M2; execute phase rework

### D-107: Version-mismatch test wrapped in try/finally for temp-directory cleanup
**Date**: 2026-03-25
**Context**: WI-180 incremental review M2 identified that `rmSync(dir)` was called unconditionally at the end of the test body. If any assertion before it threw, the temp directory would leak.
**Decision**: Wrapped the test body in `try/finally` with `rmSync(dir, { recursive: true, force: true })` in the finally clause.
**Rationale**: Temp directory cleanup must be guaranteed even when assertions fail. try/finally is the standard pattern for cleanup in vitest.
**Source**: WI-180 incremental review M2; execute phase rework

## Questions Resolved This Cycle

### Q-68: Stale `.d.ts` and `.js.map` files accumulate from build:migration runs
**Status**: Resolved
**Resolution**: WI-178 added `prebuild:migration` npm lifecycle script that deletes `scripts/migrate-to-v3.d.ts`, `scripts/migrate-to-v3.d.ts.map`, and `scripts/migrate-to-v3.js.map` before each `build:migration` run. Idempotent — uses `try/catch` around each `rmSync`.
**Source**: WI-178; package.json `prebuild:migration` entry

### Q-69: toYaml array-item guard narrower than scalar guard for reserved scalars and indicator characters
**Status**: Resolved
**Resolution**: WI-179 expanded the array-item quoting condition from 5 conditions to 15 conditions, matching all scalar guard conditions. The expansion covers starts-with YAML indicator characters (`>`, `'`, `{`, `[`, `*`, `&`, `!`, `|`), contains tab, starts with digit, and equals YAML keywords (`true`, `false`, `null`, `yes`, `no`, `on`, `off`).
**Source**: WI-179; scripts/migrate-to-v3.ts:110–133

### Q-70: checkSchemaVersion version-mismatch and version-current branches untested
**Status**: Resolved
**Resolution**: WI-180 added two tests to `schema.test.ts`: (1) version-mismatch test — creates a real on-disk DB with `user_version = 5`, calls `checkSchemaVersion`, asserts `false` return value AND that the file was deleted; (2) version-current test — in-memory DB with `user_version = 6`, asserts `true` return value. The `checkSchemaVersion` describe block now has 3 tests covering all 3 branches.
**Source**: WI-180; schema.test.ts:285–322

### Q-71: pretest exits 0 on stale or absent migrate-to-v3.js
**Status**: Resolved
**Resolution**: WI-178 hardened `pretest` to: (a) exit 1 with a warning when `migrate-to-v3.js` is absent (ENOENT on `.js` stat), (b) exit 1 with a staleness warning when `.js` mtime is less than `.ts` mtime, (c) exit 0 when both files exist and `.js` is current.
**Source**: WI-178; package.json `pretest` entry

## New Open Questions

### Q-72: pretest outer catch silently swallows all errors on migrate-to-v3.ts stat
**Domain**: workflow
**Context**: The outer `try/catch(e) {}` in `pretest` wraps the `statSync` call on `migrate-to-v3.ts`. Any error — wrong working directory, permissions, `.ts` absent — is swallowed silently and `pretest` exits 0. The design is intentional (specs/plan/notes/178.md line 56: "don't want infra issues to break test runs"), but no inline comment documents this. The one-liner format prevents adding a comment directly.
**Impact if unresolved**: Future readers may silently inherit a broken pretest guard and not realize the outer catch is intentionally permissive.

### Q-73: Version-mismatch test does not call db.close() explicitly
**Domain**: artifact-structure
**Context**: `schema.test.ts:305` opens a `Database` handle and passes it to `checkSchemaVersion`. The function closes the handle internally on the stale-version path. The test relies on this internal side effect for cleanup. If `checkSchemaVersion` is changed to not close the handle before deletion, the test leaks a file descriptor and leaves the DB file locked, which would cause the `finally` cleanup to fail.
**Impact if unresolved**: Latent fragility. Current behavior is correct; the risk materializes only if `checkSchemaVersion` implementation changes.

### Q-74: 11 of 15 newly-added array-item quoting conditions have no tests
**Domain**: artifact-structure
**Context**: WI-179 added 10 new conditions to the array-item guard (plus 5 existing = 15 total). WI-179 AC-3 required 4 representative tests. The other 11 conditions (`"false"`, `"null"`, `"yes"`, `"no"`, `"on"`, `"off"`, `startsWith("'")`, `startsWith(">")`, `startsWith("*")`, `startsWith("&")`, `startsWith("!")`, `startsWith("|")`) have no test. A regression in any one would not be caught.
**Impact if unresolved**: Low — the 4 representative tests cover the pattern. A silent regression in a specific keyword or indicator is unlikely but possible.

## Cross-References

- **Q-73 ↔ WI-180 M1/M2**: The incremental reviewer M2 (temp dir leak) was fixed in execute-phase rework. M1 (db handle explicit close) was not fixed. Both findings are related to cleanup robustness in the same test. The capstone code-reviewer (M2) and gap-analyst (MG2) independently identified the unfixed M1 as a carry-forward issue.

- **Q-72 ↔ WI-178 M1**: Code-reviewer M1 and spec-adherence M2 both carry forward the same pretest outer-catch concern. Both agree it is intentional per spec and no rework is required. The domain-curator should update Q-71 resolution to note that the outer-catch behavior is documented in specs/plan/notes/178.md.

- **Q-68, Q-69, Q-70, Q-71 all resolved this cycle**: The cycle 020 "minor residual cluster" (four open questions, all characterized as low-effort with no architectural impact) was fully addressed by three parallel work items in cycle 021. Confirms the characterization — no Andon events, 0 critical findings, 0 significant findings across both incremental and capstone reviews.

## Pattern Notes

**Carry-forward minor pattern**: This is the second consecutive cycle where minor findings from incremental reviews carry forward to the capstone. In cycle 020, M1–M2 from WI-173 and M1 from WI-175 appeared in the capstone. In cycle 021, M1 from WI-178, M1 from WI-179, and M1 from WI-180 appear in the capstone. The execute skill Phase 8 says to fix minor findings silently, but some minor findings were explicitly designated as requiring a design decision ("document or restrict") or were intentionally deferred by the spec. This pattern suggests minor findings that require out-of-scope decisions should be surfaced as new questions (Q-72, Q-73) rather than left as informal carry-forwards.

**Q-69/Q-70 deferred-then-resolved**: Both Q-69 and Q-70 were flagged as "deferred" in cycle 020 and resolved in cycle 021. The deferred status was accurate — both required out-of-cycle decisions about scope (full parity vs partial, return-value-only vs side-effect assertion). Cycle 021 collected those decisions and resolved the items cleanly. This is the intended deferral-and-resolution flow.
