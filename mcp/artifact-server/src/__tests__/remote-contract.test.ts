/**
 * remote-contract.test.ts — StorageAdapter contract tests for RemoteAdapter.
 *
 * Runs the full contract test suite (from adapter-contract.test.ts) against a
 * live RemoteAdapter pointing at localhost:4000. All tests in this suite are
 * skipped automatically when the server is not reachable.
 *
 * To exercise these tests, start ideate-server locally:
 *   cd ideate-server && npm run dev
 *
 * Test isolation: a distinct org_id / codebase_id pair is used so test data
 * does not collide with real data. The adapter's shutdown() call in teardown
 * handles cleanup of the HTTP connection; node cleanup in Neo4j relies on each
 * test's deleteNode calls (exercised by the contract suite itself).
 */

import { describe, beforeAll } from "vitest";
import { runAdapterContractTests } from "./adapter-contract.test.js";
import { RemoteAdapter } from "../adapters/remote/index.js";

// ---------------------------------------------------------------------------
// Server availability check (synchronous at module load)
// ---------------------------------------------------------------------------

import { execSync } from "child_process";

let serverAvailable = false;
try {
  const result = execSync(
    'curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:4000/graphql -H "Content-Type: application/json" -d \'{"query":"{ __typename }"}\'',
    { timeout: 3000, encoding: "utf8" }
  );
  serverAvailable = result.trim() === "200";
} catch {
  serverAvailable = false;
}

// ---------------------------------------------------------------------------
// Contract test suite — skipped when server is unreachable
// ---------------------------------------------------------------------------

const suite = serverAvailable ? describe : describe.skip;

suite("RemoteAdapter Contract Tests", () => {
  // Purge all contract-test-org data before the suite runs so tests start
  // from a known-empty state. Without this, data from previous runs causes
  // putNode to return "updated" instead of "created".
  beforeAll(async () => {
    try {
      await fetch("http://localhost:4000/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Org-Id": "contract-test-org",
          "X-Codebase-Id": "contract-test-cb",
        },
        body: JSON.stringify({
          query: `mutation { _purgeOrgData(codebaseId: "contract-test-cb") }`,
        }),
      });
    } catch {
      // Server not reachable — suite will be skipped anyway
    }
  });

  runAdapterContractTests(
    async () =>
      new RemoteAdapter({
        endpoint: "http://localhost:4000/graphql",
        org_id: "contract-test-org",
        codebase_id: "contract-test-cb",
      }),
    async (adapter) => {
      await adapter.shutdown();
    }
  );
});
