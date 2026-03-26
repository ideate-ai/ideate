## Gap Analysis — Cycle 019

## Missing Requirements

None.

The four work items (WI-170 through WI-173) directly addressed the questions and findings cited in the cycle 019 change plan. Cycle 019 had no new interview — it was driven entirely by carry-forward findings from cycle 018. Q-41 (migration script is a one-time tool) is documented in the script header comment in both `.ts` and `.js`.

## Unhandled Edge Cases

### E1: `checkSchemaVersion` accepts `user_version = 0` as compatible even when tables exist — Minor
- **Component**: `mcp/artifact-server/src/schema.ts:601`
- **Scenario**: A SQLite database created before the `user_version` mechanism was introduced has `user_version = 0` but may contain real tables. `checkSchemaVersion` treats 0 as "fresh DB — compatible" and returns `true` without deleting the file. `CREATE TABLE IF NOT EXISTS` then silently no-ops.
- **Severity**: Minor
- **Recommendation**: Defer — only affects databases created before cycle 016 (when `user_version` was introduced). Any active deployment will have been rebuilt by now. Document as known limitation and revisit before Phase 2 DDL changes.

### E2: `walkDir` directory-read errors cause stale DB rows to be silently deleted — Minor
- **Component**: `mcp/artifact-server/src/indexer.ts`
- **Scenario**: When `fs.readdirSync` throws mid-walk (permissions change, etc.), `walkDir` logs the error and skips the directory. The files under that directory are omitted from `yamlFiles`. On the `deleteStaleRows` pass, their DB rows are deleted because their IDs do not appear in `keepIds`. The operator sees `files_deleted: N` with no indication the deletions were caused by a filesystem error.
- **Current behavior**: Directory errors are logged to stderr but not counted in `files_failed` or reported in `parse_errors`.
- **Severity**: Minor
- **Recommendation**: Defer — filesystem permission errors mid-walk are rare in normal use. The existing `console.error` log provides enough signal for manual investigation. Track for Phase 2.

## Incomplete Integrations

### I1: Test call sites pass a spurious third argument to three exported migration functions — Minor
- **Interface**: `migratePlanArtifacts(ctx, sourceDir)` / `migrateSteeringArtifacts(ctx, sourceDir)` / `migrateInterviews(ctx, sourceDir)`
- **Gap**: Every test call passes three arguments (e.g. `migratePlanArtifacts(ctx, tmpSrc, ideateDir)`). The third argument is silently discarded by JavaScript. Tests pass. TypeScript does not flag this because the test imports from the `.js` file. If a future refactor adds a third parameter with different semantics, these call sites will silently pass the wrong value.
- **Severity**: Minor
- **Recommendation**: Defer — correct behaviour is exercised despite the misleading call sites. Fix is mechanical (remove third arg from ~10 call sites) and can be bundled with the next migration-script work item.

### I2: `migrate-to-v3.js` header documents `npm run build:migration` but the script does not exist — Significant
- **Interface**: `mcp/artifact-server/package.json` → `scripts["build:migration"]`
- **Producer**: `scripts/migrate-to-v3.js` line 3 documents: `Regenerate by running: cd mcp/artifact-server && npm run build:migration`
- **Gap**: The `pretest` staleness warning (added by WI-172) tells contributors that `migrate-to-v3.js` may be stale and instructs them to "regenerate with tsc." The header comment in `migrate-to-v3.js` points them to `npm run build:migration`. That script does not exist in `package.json`. Running it produces `npm error Missing script: "build:migration"`. The staleness warning fires correctly but the documented remedy fails immediately. Q-58's root cause (dual-maintenance confusion) is only half-addressed: the detection mechanism was added but the recovery mechanism was not.
- **Severity**: Significant
- **Recommendation**: Address in next cycle — add `"build:migration"` to `package.json` scripts. Without this, every contributor who follows the documented recovery path hits an immediate failure, and the dual-maintenance risk flagged three consecutive cycles remains unresolved.

## Missing Infrastructure

None beyond I2 above.

## Implicit Requirements

### R1: Q-54, Q-55, Q-57 are closed by cycle 019 — domain curator should mark them resolved — Minor
- Q-54 (watcher debounce): resolved by WI-170. Debounce via `clearTimeout`/`setTimeout` in ArtifactWatcher, verified by coalescing test.
- Q-55 (file_path indexes): resolved by WI-171. `idx_{table}_file_path` indexes in `createSchema`, pre-created `hashCheckStmts` before file loop.
- Q-57 (O(n²) BFS): resolved by WI-171. `let head = 0; const node = queue[head++]` pattern in both BFS loops.
- **Recommendation**: Defer to domain curator.

### R2: Q-59, Q-62, Q-41 are closed by cycle 019 — domain curator should mark them resolved — Minor
- Q-59: `interview_responses` fully removed from DDL, Drizzle, dispatch maps; negative test asserts table does not exist.
- Q-62: `file_path: outRelPath` set in both capstone and incremental finding builders.
- Q-41: One-time-tool header present in both `.ts` and `.js`.
- **Recommendation**: Defer to domain curator.

### R3: Q-58 remains open — partial closure only — Minor
- The staleness warning and header comment were added in cycle 019, but the `build:migration` script referenced in the header is absent. Q-58 should remain open pending I2 being addressed.
- **Recommendation**: Defer to domain curator — update Q-58 to note partial progress but keep it open.

### R4: `domains/index.md` `current_cycle` must be updated to 19 — Minor
- **Recommendation**: Defer to domain curator — standard review completion step.
