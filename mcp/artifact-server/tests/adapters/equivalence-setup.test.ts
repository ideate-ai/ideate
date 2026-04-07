/**
 * equivalence-setup.test.ts — Validates that both adapters initialise
 * correctly and that the equivalence fixture data is loaded before other
 * per-concern equivalence test files run.
 *
 * This file is a standalone validation test and exports nothing.
 *
 * To run the equivalence suite in full:
 *   npm run test:equivalence
 *
 * The Docker Compose stack (docker-compose.test.yml) must be running:
 *   docker compose -f docker-compose.test.yml up -d
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createDualAdapters,
  isTestServerAvailable,
  type DualAdapters,
} from "./equivalence-helpers.js";

// ---------------------------------------------------------------------------
// Server availability check (synchronous at module load — same pattern as
// remote-contract.test.ts so the file never blocks the test runner when the
// Docker stack is absent).
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const suite = serverAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Equivalence setup validation suite
// ---------------------------------------------------------------------------

suite("Equivalence — dual-adapter setup validation", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000 /* allow up to 2 min for migration CLI */);

  afterAll(async () => {
    if (adapters) {
      await adapters.cleanup();
    }
  });

  // ------------------------------------------------------------------
  // Sanity checks: both adapters are initialised and fixture is loaded
  // ------------------------------------------------------------------

  it("LocalAdapter returns a known fixture node (WI-001)", async () => {
    const node = await adapters.local.getNode("WI-001");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("WI-001");
    expect(node?.type).toBe("work_item");
  });

  it("RemoteAdapter returns a known fixture node (WI-001)", async () => {
    const node = await adapters.remote.getNode("WI-001");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("WI-001");
    expect(node?.type).toBe("work_item");
  });

  it("LocalAdapter returns a second known fixture node (GP-01)", async () => {
    const node = await adapters.local.getNode("GP-01");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("GP-01");
    expect(node?.type).toBe("guiding_principle");
  });

  it("RemoteAdapter returns a second known fixture node (GP-01)", async () => {
    const node = await adapters.remote.getNode("GP-01");
    expect(node).not.toBeNull();
    expect(node?.id).toBe("GP-01");
    expect(node?.type).toBe("guiding_principle");
  });

  it("LocalAdapter getNode returns null for a non-existent ID", async () => {
    const node = await adapters.local.getNode("WI-NONEXISTENT");
    expect(node).toBeNull();
  });

  it("RemoteAdapter getNode returns null for a non-existent ID", async () => {
    const node = await adapters.remote.getNode("WI-NONEXISTENT");
    expect(node).toBeNull();
  });

  it("both adapters agree on the type of WI-001", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-001"),
      adapters.remote.getNode("WI-001"),
    ]);
    expect(localNode?.type).toBe(remoteNode?.type);
  });

  it("both adapters agree on the status of WI-001", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-001"),
      adapters.remote.getNode("WI-001"),
    ]);
    expect(localNode?.status).toBe(remoteNode?.status);
  });
});
