# Review Summary — Cycle 019

## Overview

Cycle 019 addressed five significant findings from the cycle 018 capstone review, with all four work items achieving Pass verdicts on incremental review. The implementation is correct and all incremental criteria are satisfied. One significant gap remains: the `build:migration` npm script referenced in the `migrate-to-v3.js` header does not exist, leaving the dual-maintenance recovery path broken. Five minor issues were identified, four of which are new open questions for the next cycle.

## Critical Findings

None.

## Significant Findings

- [gap-analyst] `build:migration` npm script absent from `package.json` — `migrate-to-v3.js` header and `pretest` staleness warning both reference `npm run build:migration`; that script does not exist. Contributors following the documented recovery path get `npm error Missing script: "build:migration"` immediately. Q-58 detection was added (WI-172) but the recovery mechanism was not. — relates to: WI-172, Q-58

## Minor Findings

- [code-reviewer] Array-item branch in `toYaml` missing leading-whitespace guard — `migrate-to-v3.ts:110` (and `.js`) checks `\n`, `"`, `:`, `#` for array items but not `/^\s/`. A string array item with leading whitespace produces unquoted output and invalid YAML. — relates to: WI-172

- [code-reviewer] `toYaml` whitespace-prefix scalar guard has no test — the `/^\s/.test(value)` guard added at line 76 is not covered by any test in `migrate.test.ts`, while every other quoting trigger has explicit coverage. — relates to: WI-172

- [code-reviewer] `checkSchemaVersion` version-0 bypass is untested — `schema.ts:601` accepts `user_version = 0` as "fresh DB" without a test; a pre-cycle-016 database with real stale tables would also pass. — relates to: WI-171

- [code-reviewer] `close()` does not defensively clear `debounceTimers` after loop — both maps are kept in sync by current code, but a future refactor could orphan timers if an entry is added to `debounceTimers` without a corresponding `watchers` entry. — relates to: WI-170

- [spec-reviewer] `db.ts` source code index row omits `TYPE_TO_DRIZZLE_TABLE` and `metricsEvents` — architecture.md source code index updated by WI-173 but the `db.ts` row still lacks two key exports present in the source file. — relates to: WI-173

- [spec-reviewer] / [gap-analyst] Stale 3-argument call sites in migrate tests — `migratePlanArtifacts`, `migrateSteeringArtifacts`, and `migrateInterviews` signatures reduced to 2 params by WI-172; ~10 test call sites still pass a third argument silently discarded by JavaScript. — relates to: WI-172

## Suggestions

- [code-reviewer] Add `this.debounceTimers.clear()` after the `close()` loop as a defensive measure against future refactors orphaning timers.

## Findings Requiring User Input

None — all findings can be resolved from existing context.

## Proposed Refinement Plan

The review identified 0 critical and 1 significant finding. A targeted refinement cycle is recommended to address them.

**Scope for `/ideate:refine`:**

1. **`build:migration` script** (addresses I2/Q-63): Add `"build:migration"` to `mcp/artifact-server/package.json` scripts. The command should compile `scripts/migrate-to-v3.ts` to `scripts/migrate-to-v3.js` with consistent ESM settings.

2. **Array-item `toYaml` whitespace guard** (addresses Q-66): Add `/^\s/.test(item)` to the array-item quoting condition at `migrate-to-v3.ts:110` and `migrate-to-v3.js` equivalent. Add a test case.

3. **Stale test call sites** (addresses Q-65): Remove the spurious third argument from ~10 call sites in `migrate.test.ts` for `migratePlanArtifacts`, `migrateSteeringArtifacts`, and `migrateInterviews`.

4. **`db.ts` source code index** (addresses Q-64): Add `metricsEvents` and `TYPE_TO_DRIZZLE_TABLE` to the `db.ts` row in `architecture.md`.

5. **Minor test additions** (addresses Q-67): Add `checkSchemaVersion` version-0 path test to `schema.test.ts`.

Items 1–3 are the highest priority. Items 4–5 are single-line documentation and test additions that can be bundled into the same work item.

**Questions to close via domain curator**: Q-41, Q-54, Q-55, Q-56, Q-57, Q-59, Q-60, Q-62 (all resolved this cycle).
