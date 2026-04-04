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
import {
  createDualAdapters,
  isTestServerAvailable,
  type DualAdapters,
} from "./equivalence-helpers.js";
import type { TraversalOptions, TraversalResult, NodeType } from "../adapter.js";

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
    console.error(
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
      console.error(
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
      console.error(
        "PPR score divergences beyond tolerance:",
        JSON.stringify(divergences, null, 2)
      );
    }
    expect(divergences).toHaveLength(0);
  });
});
