# Gap Analysis — Cycle 021

## Verdict

Pass. All acceptance criteria for WI-178, WI-179, and WI-180 are met. Three minor open items carry forward from the incremental reviews: two were not fixed (WI-178 M1, WI-180 M1), and one is a test coverage gap introduced by WI-179's deliberate choice to add only 4 representative tests for 15 conditions. No critical or significant gaps exist.

## Pre-Analysis: Deferred Gaps Resolved

- **Q-68** (`artifact-structure`): Stale `.d.ts`/`.js.map` files — addressed by WI-178 (`prebuild:migration`). Resolved.
- **Q-69** (`artifact-structure`): `toYaml` array-item guard parity — addressed by WI-179. Resolved.
- **Q-70** (`artifact-structure`): `checkSchemaVersion` branches untested — addressed by WI-180. Resolved.
- **Q-71** (`workflow`): `pretest` fail-fast — addressed by WI-178. Resolved.

## Critical Gaps

None.

## Significant Gaps

None.

## Minor Gaps

### MG1: No inline comment documents the intentional outer-catch swallow in `pretest`

- **Source**: WI-178 incremental review M1
- **File**: `mcp/artifact-server/package.json` — `pretest` script
- **Gap**: The outer `try/catch(e) {}` in `pretest` silently swallows all errors that occur when statting `migrate-to-v3.ts`. WI-178 notes (line 56) explicitly state this is intentional: "we don't want infra issues to break test runs." The incremental reviewer recommended adding a comment to signal this is deliberate. No comment was added. The silence is correct per spec, but the rationale is undocumented in the artifact itself.
- **Recommendation**: Defer — the behavior is correct and the rationale is documented in `specs/plan/notes/178.md`. The script lives in a minified one-liner format that makes commenting impractical. Capture the design rationale in the Q-71 resolution entry in `workflow/questions.md` instead.

### MG2: `db.close()` not explicitly called in version-mismatch test

- **Source**: WI-180 incremental review M1
- **File**: `mcp/artifact-server/src/__tests__/schema.test.ts:305`
- **Gap**: The version-mismatch test opens a `Database` handle at line 305, passes it to `checkSchemaVersion`, and never calls `db.close()`. The function closes the handle internally on the stale-version path, so there is no current leak. But the test relies on that internal side effect for cleanup. M2 from the same review (temp dir cleanup on test failure) was fixed — a `try/finally` wrapping the test body was added. M1 was not fixed.
- **Recommendation**: Defer — the current implementation is correct. Add to the next cleanup work item for `schema.test.ts`.

### MG3: WI-179 added 15 quoting conditions; only 4 have tests

- **File**: `mcp/artifact-server/src/__tests__/migrate.test.ts`
- **Gap**: The array-item guard in `toYaml` now contains 15 quoting conditions (up from 5 before WI-179). WI-179 AC-3 required 4 representative test cases. All 4 are present and passing. The other 11 newly-activated conditions have no test:
  - Keywords: `"false"`, `"null"`, `"yes"`, `"no"`, `"on"`, `"off"`
  - Indicator characters: `startsWith("'")`, `startsWith(">")`, `startsWith("*")`, `startsWith("&")`, `startsWith("!")`, `startsWith("|")`
  - Inline newline: `includes("\n")` (was present before WI-179, but now co-exists with 14 other conditions)

  WI-179 AC specified only 4 tests, so no AC is violated. But a regression in any of these 11 conditions would not be caught by the existing tests.
- **Recommendation**: Defer — the conditions are structurally identical and the 4 existing representative tests provide coverage for the pattern. Bundle additional test cases with any future `migrate.test.ts` touch.

## Suggestions

### S1: M2 from WI-179 (regex asymmetry) not present in current code

The WI-179 incremental review M2 described an asymmetry where the scalar guard used `/^[\d]/` while the array-item guard used `/^\d/`. The current code at `scripts/migrate-to-v3.ts:89` and `:125` both use `/^\d/`. The character-class form does not appear anywhere in the current `.ts` or `.js`. The M2 finding described an intermediate state that was corrected during execution of the work item. No action required.

### S2: `artifact-structure/questions.md` Q-68, Q-69, Q-70 status fields are stale

Q-68 is marked `open`, Q-69 and Q-70 are marked `deferred`. All three were addressed in cycle 021. The domain-curator pass for this cycle should update these to `resolved` with cycle 021 resolution notes.
