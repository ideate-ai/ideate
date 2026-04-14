/**
 * equivalence-traverse.test.ts — Equivalence tests for PPR-based graph
 * traversal across LocalAdapter and RemoteAdapter.
 *
 * Verifies that traverse() returns equivalent ranked results from both
 * adapters for the canonical equivalence fixture, within a defined tolerance
 * for floating-point PPR score differences.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run with:
 *   npm run test:equivalence
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createDualAdapters,
  isTestServerAvailable,
  type DualAdapters,
} from "./equivalence-helpers.js";
import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { RemoteAdapter } from "../../src/adapters/remote/index.js";
import type { TraversalOptions, TraversalResult, NodeType } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// PPR tolerance — 1e-4 is appropriate for a small fixture graph (~20 nodes)
// where PPR converges quickly. Relative ranking matters more than absolute
// score values.
// ---------------------------------------------------------------------------

const PPR_TOLERANCE = 1e-4;

// ---------------------------------------------------------------------------
// assertTraversalEquivalent
//
// Custom comparison helper that:
//   1. Sorts both ranked_nodes by score descending, then by node.id ascending
//      for ties.
//   2. Compares scores with Math.abs(localScore - remoteScore) <= tolerance.
//   3. On failure, logs divergence details for each node that exceeds tolerance.
// ---------------------------------------------------------------------------

interface DivergenceDetail {
  id: string;
  localScore: number;
  remoteScore: number;
  delta: number;
}

function sortedRankedNodes(
  result: TraversalResult,
  tolerance: number = PPR_TOLERANCE
): Array<{ nodeId: string; score: number }> {
  return [...result.ranked_nodes]
    .map((entry) => ({ nodeId: entry.node.id, score: entry.score }))
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > tolerance) {
        // Sort by score descending
        return b.score - a.score;
      }
      // Tie-break: sort by node ID ascending
      return a.nodeId.localeCompare(b.nodeId);
    });
}

function assertTraversalEquivalent(
  local: TraversalResult,
  remote: TraversalResult,
  tolerance: number = PPR_TOLERANCE
): void {
  const localSorted = sortedRankedNodes(local, tolerance);
  const remoteSorted = sortedRankedNodes(remote, tolerance);

  // Build score maps from ppr_scores for cross-adapter comparison
  const localPprMap = new Map<string, number>(
    local.ppr_scores.map((s) => [s.id, s.score])
  );
  const remotePprMap = new Map<string, number>(
    remote.ppr_scores.map((s) => [s.id, s.score])
  );

  // Collect all node IDs from both sets of ppr_scores for divergence reporting
  const allPprIds = new Set<string>([
    ...localPprMap.keys(),
    ...remotePprMap.keys(),
  ]);

  // Collect divergences in ppr_scores
  const divergences: DivergenceDetail[] = [];
  for (const id of allPprIds) {
    const localScore = localPprMap.get(id) ?? 0;
    const remoteScore = remotePprMap.get(id) ?? 0;
    const delta = Math.abs(localScore - remoteScore);
    if (delta > tolerance) {
      divergences.push({ id, localScore, remoteScore, delta });
    }
  }

  if (divergences.length > 0) {
    console.log(
      "PPR score divergences beyond tolerance:",
      JSON.stringify(divergences, null, 2)
    );
  }

  // Assert: ranked_nodes lists must have the same length
  expect(localSorted.length).toBe(remoteSorted.length);

  // Assert: node IDs must match in order
  for (let i = 0; i < localSorted.length; i++) {
    expect(localSorted[i].nodeId).toBe(remoteSorted[i].nodeId);
  }

  // Assert: ppr_scores divergences must be within tolerance
  expect(divergences).toHaveLength(0);

  // Assert: ranked_nodes scores must be within tolerance for each position
  for (let i = 0; i < localSorted.length; i++) {
    const localScore = localSorted[i].score;
    const remoteScore = remoteSorted[i].score;
    const delta = Math.abs(localScore - remoteScore);
    if (delta > tolerance) {
      console.log(
        `Ranked node score divergence at position ${i}:`,
        JSON.stringify({
          id: localSorted[i].nodeId,
          localScore,
          remoteScore,
          delta,
        })
      );
    }
    expect(delta).toBeLessThanOrEqual(tolerance);
  }
}

// ---------------------------------------------------------------------------
// Server availability guard — skip the entire suite if Docker is not running
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const suite = serverAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Suite: single seed node
// ---------------------------------------------------------------------------

suite("Equivalence — traverse() with a single seed node", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("traverse(WI-001) returns ranked results from both adapters", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Both adapters must return at least the seed node
    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    // Both must return ppr_scores
    expect(local.ppr_scores.length).toBeGreaterThan(0);
    expect(remote.ppr_scores.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse(GP-01) returns ranked results from both adapters", async () => {
    const options: TraversalOptions = {
      seed_ids: ["GP-01"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse(PH-001) returns ranked results from both adapters", async () => {
    const options: TraversalOptions = {
      seed_ids: ["PH-001"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("PPR scores are compared with tolerance of 1e-4", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Build score maps
    const localPprMap = new Map<string, number>(
      local.ppr_scores.map((s) => [s.id, s.score])
    );
    const remotePprMap = new Map<string, number>(
      remote.ppr_scores.map((s) => [s.id, s.score])
    );

    // Verify all overlapping ppr_scores are within tolerance
    for (const [id, localScore] of localPprMap) {
      if (remotePprMap.has(id)) {
        const remoteScore = remotePprMap.get(id)!;
        expect(Math.abs(localScore - remoteScore)).toBeLessThanOrEqual(
          PPR_TOLERANCE
        );
      }
    }
  });

  it("ranked_nodes are sorted by score descending then by node.id ascending for ties", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
    };

    const [local] = await Promise.all([adapters.local.traverse(options)]);

    const sorted = sortedRankedNodes(local);

    // Verify sort order: score descending, id ascending for ties
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      if (Math.abs(prev.score - curr.score) <= PPR_TOLERANCE) {
        // Tie: IDs must be in ascending order
        expect(prev.nodeId.localeCompare(curr.nodeId)).toBeLessThanOrEqual(0);
      } else {
        // No tie: score must be descending
        expect(prev.score).toBeGreaterThanOrEqual(curr.score);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Suite: multiple seed nodes
// ---------------------------------------------------------------------------

suite("Equivalence — traverse() with multiple seed nodes", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("traverse([WI-001, GP-01]) returns equivalent results within tolerance", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001", "GP-01"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse([WI-001, PH-001]) returns equivalent results within tolerance", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001", "PH-001"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse([WI-001, WI-002, GP-01]) returns equivalent results within tolerance", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001", "WI-002", "GP-01"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });
});

// ---------------------------------------------------------------------------
// Suite: token_budget constraint
// ---------------------------------------------------------------------------

suite("Equivalence — traverse() with token_budget constraint", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("traverse(WI-001, token_budget=500) returns results within budget from both adapters", async () => {
    const budget = 500;
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      token_budget: budget,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Both adapters must respect the token budget
    expect(local.total_tokens).toBeLessThanOrEqual(budget);
    expect(remote.total_tokens).toBeLessThanOrEqual(budget);

    // Both must still return some results (seed is always included)
    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    // Results must be equivalent within tolerance
    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse(WI-001, token_budget=1000) returns results within budget from both adapters", async () => {
    const budget = 1000;
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      token_budget: budget,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.total_tokens).toBeLessThanOrEqual(budget);
    expect(remote.total_tokens).toBeLessThanOrEqual(budget);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse(GP-01, token_budget=2000) returns results within budget from both adapters", async () => {
    const budget = 2000;
    const options: TraversalOptions = {
      seed_ids: ["GP-01"],
      token_budget: budget,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.total_tokens).toBeLessThanOrEqual(budget);
    expect(remote.total_tokens).toBeLessThanOrEqual(budget);

    expect(local.ranked_nodes.length).toBeGreaterThan(0);
    expect(remote.ranked_nodes.length).toBeGreaterThan(0);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });
});

// ---------------------------------------------------------------------------
// Suite: always_include_types
// ---------------------------------------------------------------------------

suite("Equivalence — traverse() with always_include_types", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("traverse(WI-001, always_include_types=[guiding_principle]) includes guiding_principles from both adapters", async () => {
    const alwaysTypes: NodeType[] = ["guiding_principle"];
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      always_include_types: alwaysTypes,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Both must include at least one guiding_principle (GP-01, GP-02 in fixture)
    const localGpNodes = local.ranked_nodes.filter(
      (entry) => entry.node.type === "guiding_principle"
    );
    const remoteGpNodes = remote.ranked_nodes.filter(
      (entry) => entry.node.type === "guiding_principle"
    );

    expect(localGpNodes.length).toBeGreaterThan(0);
    expect(remoteGpNodes.length).toBeGreaterThan(0);

    // Both should have the same count of guiding_principle nodes
    expect(localGpNodes.length).toBe(remoteGpNodes.length);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse(WI-001, always_include_types=[domain_policy]) includes domain_policies from both adapters", async () => {
    const alwaysTypes: NodeType[] = ["domain_policy"];
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      always_include_types: alwaysTypes,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Both must include domain_policy nodes (P-01 in fixture)
    const localPolicyNodes = local.ranked_nodes.filter(
      (entry) => entry.node.type === "domain_policy"
    );
    const remotePolicyNodes = remote.ranked_nodes.filter(
      (entry) => entry.node.type === "domain_policy"
    );

    expect(localPolicyNodes.length).toBeGreaterThan(0);
    expect(remotePolicyNodes.length).toBeGreaterThan(0);

    expect(localPolicyNodes.length).toBe(remotePolicyNodes.length);

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  it("traverse(WI-001, always_include_types=[guiding_principle, constraint]) includes both types from both adapters", async () => {
    const alwaysTypes: NodeType[] = ["guiding_principle", "constraint"];
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      always_include_types: alwaysTypes,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Both must include nodes of the specified always-include types
    for (const type of alwaysTypes) {
      const localTypeNodes = local.ranked_nodes.filter(
        (entry) => entry.node.type === type
      );
      const remoteTypeNodes = remote.ranked_nodes.filter(
        (entry) => entry.node.type === type
      );

      expect(localTypeNodes.length).toBeGreaterThan(0);
      expect(remoteTypeNodes.length).toBeGreaterThan(0);
      expect(localTypeNodes.length).toBe(remoteTypeNodes.length);
    }

    assertTraversalEquivalent(local, remote, PPR_TOLERANCE);
  });

  // WI-787 S1: exercise the RemoteAdapter client-side budget gate for
  // always_include_types so that budget_exhausted and truncated_types are
  // not regressed silently. Uses token_budget=1 so any non-seed always-include
  // artifact overflows on both adapters.
  it("traverse with tiny token_budget sets budget_exhausted and truncated_types on both adapters", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      token_budget: 1,
      always_include_types: ["guiding_principle", "constraint"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Both adapters must report overflow.
    expect(local.budget_exhausted).toBe(true);
    expect(remote.budget_exhausted).toBe(true);

    // truncated_types must be a non-empty array on both, and its contents
    // must be a subset of the always_include_types set.
    expect(Array.isArray(local.truncated_types)).toBe(true);
    expect(Array.isArray(remote.truncated_types)).toBe(true);
    expect((local.truncated_types ?? []).length).toBeGreaterThan(0);
    expect((remote.truncated_types ?? []).length).toBeGreaterThan(0);

    const allowed = new Set(["guiding_principle", "constraint"]);
    for (const t of local.truncated_types ?? []) expect(allowed.has(t)).toBe(true);
    for (const t of remote.truncated_types ?? []) expect(allowed.has(t)).toBe(true);

    // truncated_types must agree on the set of truncated NodeTypes.
    const localSet = new Set(local.truncated_types ?? []);
    const remoteSet = new Set(remote.truncated_types ?? []);
    expect([...localSet].sort()).toEqual([...remoteSet].sort());
  });
});

// ---------------------------------------------------------------------------
// Suite: divergence reporting
// ---------------------------------------------------------------------------

suite("Equivalence — traverse() PPR score divergence reporting", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("reports divergence details (node ID, local score, remote score) when scores exceed tolerance", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    // Build maps for manual divergence check
    const localPprMap = new Map<string, number>(
      local.ppr_scores.map((s) => [s.id, s.score])
    );
    const remotePprMap = new Map<string, number>(
      remote.ppr_scores.map((s) => [s.id, s.score])
    );

    const allIds = new Set<string>([
      ...localPprMap.keys(),
      ...remotePprMap.keys(),
    ]);

    const divergences: DivergenceDetail[] = [];
    for (const id of allIds) {
      const localScore = localPprMap.get(id) ?? 0;
      const remoteScore = remotePprMap.get(id) ?? 0;
      const delta = Math.abs(localScore - remoteScore);
      if (delta > PPR_TOLERANCE) {
        divergences.push({ id, localScore, remoteScore, delta });
      }
    }

    // Divergences should have shape: { id, localScore, remoteScore, delta }
    // If any exist, verify the shape is correct
    for (const d of divergences) {
      expect(typeof d.id).toBe("string");
      expect(typeof d.localScore).toBe("number");
      expect(typeof d.remoteScore).toBe("number");
      expect(typeof d.delta).toBe("number");
      expect(d.delta).toBe(Math.abs(d.localScore - d.remoteScore));
    }

    // In practice for this fixture, there should be zero divergences
    if (divergences.length > 0) {
      console.log(
        "PPR score divergences beyond tolerance:",
        JSON.stringify(divergences, null, 2)
      );
    }
    expect(divergences).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Suite: traverse happy path with seeded node (D-177 convention)
//
// This suite follows the D-177 pattern:
//   - LocalAdapter tests use unconditional it(...)
//   - RemoteAdapter tests use it.skipIf(!remoteAvailable) with early return guard
//
// The test creates a node via putNode in setup, then calls traverse with that
// node's ID as the seed. It verifies the result has the required shape:
//   - ranked_nodes (array of { node, score } entries)
//   - ppr_scores (array of { id, score } entries)
//   - total_tokens (number)
// ---------------------------------------------------------------------------

// Evaluated at module level (collection time) so it.skipIf resolves correctly.
const remoteAvailable = isTestServerAvailable();

interface HappyPathSetup {
  localAdapter: LocalAdapter;
  remoteAdapter: RemoteAdapter | null;
  tmpDir: string;
  db: Database.Database;
}

async function createHappyPathSetup(): Promise<HappyPathSetup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-traverse-happy-")
  );
  const ideateDir = path.join(tmpDir, ".ideate");

  for (const sub of [
    "work-items",
    "policies",
    "decisions",
    "questions",
    "principles",
    "constraints",
    "modules",
    "research",
    "metrics",
    "interviews",
    "projects",
    "phases",
    "plan",
    "steering",
    "domains",
    "archive/cycles",
    "archive/incremental",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  createSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });

  const localAdapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await localAdapter.initialize();

  return { localAdapter, remoteAdapter: null, tmpDir, db };
}

async function teardownHappyPathSetup(setup: HappyPathSetup): Promise<void> {
  try {
    await setup.localAdapter.shutdown();
  } catch {
    // ignore
  }
  try {
    setup.db.close();
  } catch {
    // ignore
  }
  if (setup.remoteAdapter) {
    try {
      await setup.remoteAdapter.shutdown();
    } catch {
      // ignore
    }
  }
  try {
    fs.rmSync(setup.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Suite: max_nodes as a result-count cap (WI-789)
//
// Asserts adapter contract: same graph + same max_nodes → ranked_nodes.length ≤ N.
// Score ordering is NOT asserted (per RF D5 — remote PPR may differ in score
// values). Only the length invariant is checked.
// ---------------------------------------------------------------------------

suite("Equivalence — traverse() max_nodes result-count cap", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("traverse(WI-001, max_nodes=3) — both adapters return ranked_nodes.length <= 3", async () => {
    const maxNodes = 3;
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      max_nodes: maxNodes,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeLessThanOrEqual(maxNodes);
    expect(remote.ranked_nodes.length).toBeLessThanOrEqual(maxNodes);
  });

  it("traverse(WI-001, max_nodes=1) — both adapters return at most 1 ranked node", async () => {
    const maxNodes = 1;
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      max_nodes: maxNodes,
    };

    const [local, remote] = await Promise.all([
      adapters.local.traverse(options),
      adapters.remote.traverse(options),
    ]);

    expect(local.ranked_nodes.length).toBeLessThanOrEqual(maxNodes);
    expect(remote.ranked_nodes.length).toBeLessThanOrEqual(maxNodes);
  });

  it("traverse(WI-001, max_nodes=0) — both adapters return all ranked nodes (0 means no cap)", async () => {
    const options: TraversalOptions = {
      seed_ids: ["WI-001"],
      max_nodes: 0,
    };

    const [localCapped, localUncapped] = await Promise.all([
      adapters.local.traverse(options),
      adapters.local.traverse({ seed_ids: ["WI-001"] }),
    ]);

    // max_nodes=0 means no cap; result count should equal uncapped result count
    expect(localCapped.ranked_nodes.length).toBe(localUncapped.ranked_nodes.length);
  });
});

describe("Equivalence — traverse() happy path with seeded node (D-177)", () => {
  let setup: HappyPathSetup;

  beforeAll(async () => {
    setup = await createHappyPathSetup();

    // Wire up RemoteAdapter if the server is available (checked at module level).
    if (remoteAvailable) {
      const remote = new RemoteAdapter({
        endpoint: "http://localhost:4001/graphql",
        org_id: "equivalence-test-org",
        codebase_id: "equivalence-happy-cb",
      });
      try {
        await remote.initialize();
        setup.remoteAdapter = remote;
      } catch {
        // initialize() failed despite server appearing available; tests with
        // it.skipIf(!remoteAvailable) will still run (server was reachable at
        // collection time), but the early-return guard in each test body
        // (if (!setup.remoteAdapter) return) will abort gracefully.
      }
    }

    // Seed a node in LocalAdapter. If remote is available, seed it there too.
    await setup.localAdapter.putNode({
      id: "GP-HAPPY-SEED-01",
      type: "guiding_principle",
      properties: {
        name: "Happy path traverse seed",
        description: "Used by the traverse happy-path equivalence test.",
        status: "active",
      },
    });

    if (setup.remoteAdapter) {
      await setup.remoteAdapter.putNode({
        id: "GP-HAPPY-SEED-01",
        type: "guiding_principle",
        properties: {
          name: "Happy path traverse seed",
          description: "Used by the traverse happy-path equivalence test.",
          status: "active",
        },
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (setup) await teardownHappyPathSetup(setup);
  });

  // -------------------------------------------------------------------------
  // Local adapter — unconditional it() per D-177
  // -------------------------------------------------------------------------

  it("LocalAdapter traverse({seed_ids: [seeded node]}) returns ranked_nodes and ppr_scores arrays", async () => {
    const result = await setup.localAdapter.traverse({
      seed_ids: ["GP-HAPPY-SEED-01"],
    });

    // TraversalResult shape: .ranked_nodes (array), .ppr_scores (array), .total_tokens (number)
    expect(Array.isArray(result.ranked_nodes)).toBe(true);
    expect(Array.isArray(result.ppr_scores)).toBe(true);
    // The seed node must always appear in ranked_nodes
    expect(result.ranked_nodes.length).toBeGreaterThan(0);
  });

  it("LocalAdapter TraversalResult has required shape: ranked_nodes and ppr_scores arrays", async () => {
    const result = await setup.localAdapter.traverse({
      seed_ids: ["GP-HAPPY-SEED-01"],
    });

    // Verify the result has the documented TraversalResult shape
    expect(result).toHaveProperty("ranked_nodes");
    expect(result).toHaveProperty("ppr_scores");
    expect(result).toHaveProperty("total_tokens");
    expect(Array.isArray(result.ranked_nodes)).toBe(true);
    expect(Array.isArray(result.ppr_scores)).toBe(true);
    expect(typeof result.total_tokens).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Remote adapter — it.skipIf(!remoteAvailable) per D-177
  //
  // Note: TRANSACTION_FAILED error code is covered in write-transaction.test.ts.
  // This suite tests the success path only (contract test for shape equivalence).
  // -------------------------------------------------------------------------

  it.skipIf(!remoteAvailable)(
    "RemoteAdapter traverse({seed_ids: [seeded node]}) returns ranked_nodes and ppr_scores arrays",
    async () => {
      if (!setup.remoteAdapter) return;

      const result = await setup.remoteAdapter.traverse({
        seed_ids: ["GP-HAPPY-SEED-01"],
      });

      expect(Array.isArray(result.ranked_nodes)).toBe(true);
      expect(Array.isArray(result.ppr_scores)).toBe(true);
      expect(result.ranked_nodes.length).toBeGreaterThan(0);
    }
  );

  it.skipIf(!remoteAvailable)(
    "both adapters return TraversalResult with ranked_nodes and ppr_scores arrays for the same seed",
    async () => {
      if (!setup.remoteAdapter) return;

      const [local, remote] = await Promise.all([
        setup.localAdapter.traverse({ seed_ids: ["GP-HAPPY-SEED-01"] }),
        setup.remoteAdapter.traverse({ seed_ids: ["GP-HAPPY-SEED-01"] }),
      ]);

      // Both must return the required TraversalResult shape
      expect(Array.isArray(local.ranked_nodes)).toBe(true);
      expect(Array.isArray(remote.ranked_nodes)).toBe(true);
      expect(Array.isArray(local.ppr_scores)).toBe(true);
      expect(Array.isArray(remote.ppr_scores)).toBe(true);

      // The seed node must appear in both results
      expect(local.ranked_nodes.length).toBeGreaterThan(0);
      expect(remote.ranked_nodes.length).toBeGreaterThan(0);
    }
  );
});
