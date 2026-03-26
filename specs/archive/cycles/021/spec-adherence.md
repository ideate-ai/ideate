# Spec Adherence Review — Cycle 021

## Verdict

Pass. All acceptance criteria for WI-178, WI-179, and WI-180 are met. The dual-maintenance constraint (migrate-to-v3.js mirrors migrate-to-v3.ts) is satisfied. Guiding principles are upheld. No architecture deviations, unmet acceptance criteria, or principle violations were found. Three minor issues from incremental reviews carry forward but are not escalated here.

## Architecture Deviations

None.

## Unmet Acceptance Criteria

None.

## Principle Violations

None.

## Principle Adherence Evidence

- **GP-8 (Durable Knowledge Capture / dual-maintenance)**: `scripts/migrate-to-v3.js` lines 146–169 and `scripts/migrate-to-v3.ts` lines 110–133 contain structurally identical array-item quoting guards. Both files agree on every condition, including the `item.startsWith('"')` form.
- **GP-1 (Spec Sufficiency)**: All three work items have acceptance criteria that are entirely machine-verifiable (exit codes, `existsSync` assertions, `toContain`/`toMatch` assertions). P-8 is upheld.
- **GP-4 (Parallel-First)**: Work items 178, 179, and 180 have non-overlapping file scopes and no declared dependencies — consistent with parallel execution. C-6 is upheld.
- **GP-5 (Continuous Review)**: Incremental reviews were completed for all three work items before capstone review.
- **C-8 (dual-maintenance)**: `scripts/migrate-to-v3.js` mirrors `scripts/migrate-to-v3.ts` at all modified lines.

## Critical Findings

None.

## Significant Findings

None.

## Minor Findings

### M1 (carry-forward from WI-179 incremental): `item.startsWith('"')` deviates from notes spec

- **File**: `scripts/migrate-to-v3.ts:112`, `scripts/migrate-to-v3.js:148`
- **Detail**: The WI-179 notes spec shows the target condition retaining `item.includes('"')`. The implementation replaced this with `item.startsWith('"')`. The acceptance criteria in work-items.yaml#179 enumerate only the new conditions to add and do not specify which form to use for the double-quote check — so no criterion is violated. Both `.ts` and `.js` agree on `startsWith`, preserving dual-maintenance. No correctness hole exists.
- **Action**: No rework needed. The notes spec is advisory; the criterion text governs.

### M2 (carry-forward from WI-178 incremental): Outer `catch(e) {}` in pretest silently swallows non-ENOENT `.ts` errors

- **File**: `mcp/artifact-server/package.json` — `pretest` script
- **Detail**: The notes spec (line 56) explicitly authorizes this: "don't want infra issues to break test runs." But the notes also say "emit the error message" while the implementation swallows it entirely. Minor divergence from notes but does not violate any acceptance criterion.
- **Action**: No rework needed for this cycle.

### M3 (carry-forward from WI-180 incremental): Version-mismatch test leaves `db` handle dependent on internal side-effect

- **File**: `mcp/artifact-server/src/__tests__/schema.test.ts:305–306`
- **Detail**: Test opens `db` and passes it to `checkSchemaVersion` without an explicit `db.close()`. The function closes the handle internally. The notes spec also omits explicit close. No acceptance criterion requires explicit handle management.
- **Action**: No rework needed. Latent fragility, not a current failure.

## WI-178 Acceptance Criteria Detail

| Criterion | Verdict | Evidence |
|---|---|---|
| `package.json` has `prebuild:migration` deleting three stale artifact files | Pass | `package.json:14` — all three paths in forEach array |
| `npm run prebuild:migration` exits 0 whether or not stale files exist | Pass | Each `rmSync` wrapped in `try/catch(e){}` — idempotent |
| `pretest` exits non-zero when `.js` is older than `.ts` | Pass | `package.json:11` — `process.exit(1)` called after staleness warning |
| `pretest` emits warning to stderr when `.js` does not exist | Pass | Inner catch checks `e.code==='ENOENT'`, writes to `process.stderr`, calls `process.exit(1)` |
| `pretest` exits 0 when both files exist and `.js` is at least as new as `.ts` | Pass | No `process.exit` call in the `js>=ts` path |
| All existing tests pass | Pass | 162 tests, 5 files |

## WI-179 Acceptance Criteria Detail

| Criterion | Verdict | Evidence |
|---|---|---|
| Array-item condition includes all scalar guard conditions | Pass | `migrate-to-v3.ts:110–133` — all listed conditions present |
| `migrate-to-v3.js` mirrors identical change | Pass | `migrate-to-v3.js:146–169` — structurally identical condition list |
| Test: `"true"` as array item is emitted quoted | Pass | `migrate.test.ts:72–75` |
| Test: item starting with `{` is emitted quoted | Pass | `migrate.test.ts:77–80` |
| Test: item starting with a digit is emitted quoted | Pass | `migrate.test.ts:82–85` |
| Test: item containing a tab is emitted quoted | Pass | `migrate.test.ts:87–90` |
| All existing tests pass | Pass | 162 tests |

## WI-180 Acceptance Criteria Detail

| Criterion | Verdict | Evidence |
|---|---|---|
| Test: returns `false` for `user_version = 5` | Pass | `schema.test.ts:306–308` |
| Version-mismatch test asserts database file is deleted | Pass | `schema.test.ts:309` — `expect(existsSync(dbPath)).toBe(false)` |
| Test: returns `true` for `user_version = 6` | Pass | `schema.test.ts:315–320` |
| `checkSchemaVersion` describe block has 3 tests | Pass | `schema.test.ts:285–322` — version-0, version-mismatch, version-current |
| All existing tests pass | Pass | 162 tests |

## Cross-Cutting Policy Checks

| Policy | Applicable | Status |
|---|---|---|
| P-8 (artifact-structure): acceptance criteria machine-verifiable | Yes | Pass |
| P-30 (artifact-structure): filter columns must have DB indexes | No | Not touched |
| P-18 (workflow): review-skill features must include brrr in scope | No | No review-skill features changed |
| P-21 (workflow): consumer notes must cite producer schema | No | No producer/consumer pairs in this cycle |
| P-30 (workflow): child work item notes must cross-check parent | No | No parent feature decomposition |
| C-6: non-overlapping work item scope | Yes | Pass — disjoint file scopes |
| C-8 (dual-maintenance) | Yes | Pass — both files identical at modified lines |
