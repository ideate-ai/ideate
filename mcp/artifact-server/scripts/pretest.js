// pretest.js — run before `npm test` to warn if the migration script is stale.
//
// The outer try/catch intentionally swallows all errors (wrong working directory,
// missing permissions, .ts file absent, etc.). The guard is advisory-only: infra
// problems with the migration script should never block the test suite from running.
// See: specs/plan/notes/178.md line 56 — "don't want infra issues to break test runs".

import { statSync } from "fs";

try {
  const tsMs = statSync("../../scripts/migrate-to-v3.ts").mtimeMs;
  let jsMs;
  try {
    jsMs = statSync("../../scripts/migrate-to-v3.js").mtimeMs;
  } catch (e) {
    if (e.code === "ENOENT") {
      process.stderr.write(
        "WARNING: migrate-to-v3.js not found — run: cd mcp/artifact-server && npm run build:migration\n"
      );
      process.exit(1);
    }
    throw e;
  }
  if (jsMs < tsMs) {
    process.stderr.write(
      "WARNING: migrate-to-v3.js may be stale — run: cd mcp/artifact-server && npm run build:migration\n"
    );
    process.exit(1);
  }
} catch {
  // Intentional: swallow errors so infra issues never block the test suite.
}
