## Verdict: Fail

The file watcher silently never fires due to a misapplied `ignored` regex, and module-level mutable state in the migration script makes parallel test runs unsafe.

---

## Critical Findings

### C1: Watcher `ignored` pattern silences all events inside `.ideate/`
- **File**: `mcp/artifact-server/src/watcher.ts:24`
- **Issue**: The chokidar `ignored` option is set to `/(^|[/\\])\../`, which matches any path containing a segment that begins with a dot. Because the watched root is the `.ideate/` directory, every absolute file path inside it contains `/.ideate/`, which satisfies the pattern. Chokidar passes every candidate path through anymatch with this regex before emitting; all paths match, so no `add`, `change`, or `unlink` event is ever emitted. The `rebuildIndex` callback registered in `index.ts:35-41` never executes at runtime.
- **Impact**: The SQLite index is built once at startup and never updated again. Any YAML file written, modified, or deleted after startup is invisible to the index until the server is restarted. The watcher is entirely non-functional.
- **Suggested fix**: Restrict the ignore pattern to hidden files *within* the directory, not to paths that contain a hidden parent-directory name. One correct approach:
  ```ts
  ignored: (p: string) =>
    path.basename(p).startsWith('.') && p \!== artifactDir,
  ```
  This ignores hidden files (`.DS_Store`, `.swp`, etc.) but does not reject files whose ancestor directory starts with a dot.

---

## Significant Findings

### S1: Module-level mutable state in `migrate-to-v3.ts` is not concurrency-safe
- **File**: `scripts/migrate-to-v3.ts:25-30`
- **Issue**: Six module-level `let` variables (`errors`, `created`, `ideateDir`, `sourceDir`, `dryRun`, `force`) are mutated by `runMigration` and read by every private helper. `runMigration` resets them at the top of each call, but because they are module-globals any overlapping calls (parallel test workers, or any future async use) share and corrupt each other's state.
- **Impact**: Current tests pass because they run sequentially. If vitest is configured with `--pool=threads` or the function is called concurrently, state leaks between calls producing wrong output paths and wrong dry-run behaviour with no error raised.
- **Suggested fix**: Move all six variables inside `runMigration` and pass them as explicit parameters (or a context object) to each private helper function.

### S2: Startup throws an uncaught exception when `.ideate/` is not found
- **File**: `mcp/artifact-server/src/index.ts:19`
- **Issue**: `resolveArtifactDir({})` is called at module top level with no try/catch. When no `.ideate/config.json` exists in the working-directory tree, the function throws. As a top-level ESM statement this becomes an unhandled rejection and the process terminates with a stack trace rather than a user-readable message.
- **Impact**: Every misconfigured invocation produces a crash dump. The MCP host receives no usable diagnostic.
- **Suggested fix**:
  ```ts
  let ideateDir: string;
  try {
    ideateDir = resolveArtifactDir({});
  } catch (err) {
    console.error(`[ideate-artifact-server] ${(err as Error).message}`);
    process.exit(1);
  }
  ```

### S3: `upsertRow` interpolates column names directly into SQL
- **File**: `mcp/artifact-server/src/indexer.ts:261-270`
- **Issue**: `upsertRow` builds the INSERT statement by joining `Object.keys(row)` into the SQL string without validation. The table name and row keys are safe today because both come from hardcoded constants in `buildRow` and `TYPE_TO_TABLE`. However the function signature accepts any `Row` (`Record<string, unknown>`), and there is no enforcement preventing a future caller from passing attacker-influenced keys. SQLite does not support parameterised identifiers.
- **Impact**: Low exploitability in the current call path. The risk is latent: any call site that constructs a row from external data without going through `buildRow` could inject SQL via a column name.
- **Suggested fix**: Add a guard at the top of `upsertRow` that validates every key against `/^[a-z_]+$/` and throws on violation, or restrict the function to accept a typed column list rather than a free-form record.

---

## Minor Findings

### M1: `deleteStaleRows` issues three DELETE statements per stale row
- **File**: `mcp/artifact-server/src/indexer.ts:394-411`
- **Issue**: For each stale row the code runs three separate prepared statements (delete from typed table, delete from edges, delete from node_file_refs). With many deleted files this is N times 3 statements inside the already-open transaction.
- **Suggested fix**: Collect all stale IDs and issue a single `DELETE ... WHERE id IN (...)` per table.

### M2: `walkDir` swallows `readdirSync` errors silently
- **File**: `mcp/artifact-server/src/indexer.ts:57-62`
- **Issue**: The bare `catch` block returns without logging when `readdirSync` fails (permission error, broken symlink, etc.). The caller receives `files_scanned: 0` with no explanation.
- **Suggested fix**: Add `console.warn('[walkDir] readdirSync failed:', current, err)` before returning from the catch block.

### M3: `persistent: false` in watcher config
- **File**: `mcp/artifact-server/src/watcher.ts:25`
- **Issue**: `persistent: false` tells chokidar not to keep the Node.js event loop alive. For the MCP server the event loop is held open by the stdio transport, so this does not cause an immediate exit in production. However, in any isolated test or standalone context without other event-loop refs, the process exits before watch events fire.
- **Suggested fix**: Change to `persistent: true` for a long-running server watcher. If `false` was intentional, add a comment explaining the rationale.

### M4: `migrateJournal` duplicates `buildArtifact` hash logic inline
- **File**: `scripts/migrate-to-v3.ts:901-906`
- **Issue**: Journal entry hashes are computed with an inline copy of the `buildArtifact` algorithm rather than calling `buildArtifact`. The inline version does not delete `content_hash` and `token_count` from the hash input. In the current call path both fields are absent at hash-time so the result is correct, but if either field is ever present before hashing the inline and `buildArtifact` results diverge silently.
- **Suggested fix**: Replace lines 901-906 with a call to `buildArtifact(entryObj)` and assign the returned enriched object back.

### M5: No test covers the watcher triggering a reindex
- **File**: `mcp/artifact-server/src/__tests__/` (all test files)
- **Issue**: There is no integration test that writes a YAML file to a temp `.ideate/` directory, waits for the watcher event, and asserts `rebuildIndex` was called. Such a test would have caught C1 before merge.
- **Suggested fix**: Add a watcher integration test using `vi.waitFor` against a real temp directory, asserting that a file write causes the database to reflect the new content.

---

## Unmet Acceptance Criteria

None. The cycle 016 scope did not include a formal acceptance-criteria checklist. All functional behaviour items are accounted for in the findings above.
