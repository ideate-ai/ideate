/**
 * remote-contract-ci.test.ts — StorageAdapter contract tests for RemoteAdapter
 * running against an in-process mock GraphQL server.
 *
 * Unlike remote-contract.test.ts (which gates on a live localhost:4000 server
 * and uses describe.skip when unreachable), this suite always runs in CI.
 * The mock server is started in-process before all tests and stopped after all
 * tests complete.
 *
 * Architecture:
 *   RemoteAdapter -> HTTP -> InMemoryGraph (mock-remote-server.ts)
 *
 * The RemoteAdapter is wrapped in ValidatingAdapter so that client-side
 * input validation (INVALID_NODE_ID, INVALID_NODE_TYPE, etc.) is enforced
 * identically to production usage.
 */

import { describe, beforeAll, afterAll } from "vitest";
import { runAdapterContractTests } from "./adapter-contract.test.js";
import { RemoteAdapter } from "../adapters/remote/index.js";
import { ValidatingAdapter } from "../validating.js";
import { startMockServer, type MockServerHandle } from "./fixtures/mock-remote-server.js";
import type { StorageAdapter } from "../adapter.js";

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let serverHandle: MockServerHandle;

beforeAll(async () => {
  serverHandle = await startMockServer();
});

afterAll(async () => {
  await serverHandle.close();
});

// ---------------------------------------------------------------------------
// Contract suite — always runs (no describe.skip gate)
// ---------------------------------------------------------------------------

describe("RemoteAdapter Contract (CI — in-process mock server)", () => {
  runAdapterContractTests(
    async (): Promise<StorageAdapter> => {
      // Reset the mock server's in-memory graph so each test starts from an
      // empty state. The server is shared across tests (started once in
      // beforeAll), so state would otherwise accumulate.
      await fetch(serverHandle.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "mutation ResetGraph { resetGraph }" }),
      });

      const raw = new RemoteAdapter({
        endpoint: serverHandle.url,
        org_id: "ci-test-org",
        codebase_id: "ci-test-cb",
        tokenProvider: async () => "mock-token",
      });
      return new ValidatingAdapter(raw);
    },
    async (adapter: StorageAdapter): Promise<void> => {
      // RemoteAdapter.shutdown() is idempotent and closes HTTP state.
      // Cast to access shutdown(); ValidatingAdapter delegates transparently.
      await (adapter as ValidatingAdapter & { shutdown: () => Promise<void> }).shutdown();
    },
    {
      // traverse() requires a full PPR implementation on the server.
      // The mock server returns seed-only results; the traverse budget tests
      // involve 60+ large nodes and would not produce meaningful budget enforcement.
      skipTraverse: true,
      // getToolUsage is a no-op stub on RemoteAdapter — no seedToolUsage hook.
      seedToolUsage: undefined,
    }
  );
});
