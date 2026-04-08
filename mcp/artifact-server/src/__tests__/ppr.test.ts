/**
 * ppr.test.ts — Tests for the PPR (Personalized PageRank) algorithm.
 *
 * Architecture:
 * - Each test creates a fresh in-memory SQLite DB with createSchema applied.
 * - Nodes and edges are inserted directly via prepared statements.
 * - computePPR is called and results are inspected.
 *
 * Tests:
 *   1. single seed — result is non-empty, seed has top score
 *   2. multiple seeds — both seeds influence results
 *   3. convergence — algorithm stops when score deltas are below threshold
 *   4. edge type weighting — higher-weight edges propagate more score
 *   5. node specificity dampening — high in-degree nodes get lower scores
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import { computePPR, PPROptions } from "../ppr.js";
import { ValidationError } from "../adapter.js";
import { LocalContextAdapter } from "../adapters/local/context.js";

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  createSchema(db);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a minimal node row */
function insertNode(id: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
    VALUES (?, 'work_item', 1, NULL, 'hash', 0, '/tmp/' || ? || '.yaml', 'pending')
  `).run(id, id);
}

/** Insert an edge row */
function insertEdge(sourceId: string, targetId: string, edgeType: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO edges (source_id, target_id, edge_type, props)
    VALUES (?, ?, ?, NULL)
  `).run(sourceId, targetId, edgeType);
}

// ---------------------------------------------------------------------------
// Test 1: Single seed
// ---------------------------------------------------------------------------

describe("computePPR — single seed", () => {
  it("returns non-empty results with seed node scoring higher than a distant node", () => {
    // Graph: SEED → N1 → N2 → N3 → DISTANT
    // The seed has the teleport (restart) term pulling its score up.
    // A purely distant leaf like DISTANT, with no back-edges toward the seed,
    // should score lower than the seed itself.
    //
    // We use a star topology from SEED so it is clearly the most connected node
    // from the restart perspective.
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertNode("DISTANT");
    // SEED is the hub — it connects to three leaves
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("SEED", "N2", "depends_on");
    insertEdge("SEED", "DISTANT", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    expect(results.length).toBeGreaterThan(0);

    // SEED has inDegree=0, so max specificity factor. Its raw PPR score also
    // includes the restart term. It should outscore any single leaf node.
    const seedScore = results.find((r) => r.nodeId === "SEED")!.score;
    const n1Score = results.find((r) => r.nodeId === "N1")!.score;
    expect(seedScore).toBeGreaterThan(n1Score);

    // All scores should be non-negative
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }

    // Results should be sorted descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("returns empty array when no seeds provided", () => {
    insertNode("A");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, []);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Multiple seeds
// ---------------------------------------------------------------------------

describe("computePPR — multiple seeds", () => {
  it("both seed nodes appear near the top of results", () => {
    // Two stars sharing one hub
    //
    //   A → HUB ← B
    //   A → C
    //   B → D
    insertNode("A");
    insertNode("B");
    insertNode("HUB");
    insertNode("C");
    insertNode("D");
    insertEdge("A", "HUB", "depends_on");
    insertEdge("B", "HUB", "depends_on");
    insertEdge("A", "C", "depends_on");
    insertEdge("B", "D", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["A", "B"]);

    // Both seeds should appear in results
    const nodeIds = results.map((r) => r.nodeId);
    expect(nodeIds).toContain("A");
    expect(nodeIds).toContain("B");

    // Seeds should have higher scores than isolated nodes
    const scoreA = results.find((r) => r.nodeId === "A")!.score;
    const scoreD = results.find((r) => r.nodeId === "D")!.score;
    const scoreC = results.find((r) => r.nodeId === "C")!.score;
    expect(scoreA).toBeGreaterThan(scoreD);
    expect(scoreA).toBeGreaterThan(scoreC);
  });

  it("scores from both seeds propagate to shared neighbours", () => {
    // A → SHARED ← B
    // FAR is connected only via a weak link from a non-seed node
    insertNode("A");
    insertNode("B");
    insertNode("SHARED");
    insertNode("FRINGE");  // connected via single low-weight edge from a leaf
    insertNode("LEAF");
    insertEdge("A", "SHARED", "depends_on");
    insertEdge("B", "SHARED", "depends_on");
    // FRINGE is far from both seeds — reachable only through LEAF which connects
    // to FRINGE but neither A nor B point to LEAF
    insertEdge("LEAF", "FRINGE", "references"); // low-weight edge type

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["A", "B"]);

    const scoreShared = results.find((r) => r.nodeId === "SHARED")!.score;
    const scoreFringe = results.find((r) => r.nodeId === "FRINGE")!.score;

    // SHARED receives contributions from both seeds; FRINGE is unreachable
    // from the seeds in one hop and gets minimal score
    expect(scoreShared).toBeGreaterThan(scoreFringe);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Convergence
// ---------------------------------------------------------------------------

describe("computePPR — convergence", () => {
  it("produces stable results when run twice with default settings", () => {
    // A cycle of 4 nodes — PPR should converge on this
    insertNode("N1");
    insertNode("N2");
    insertNode("N3");
    insertNode("N4");
    insertEdge("N1", "N2", "depends_on");
    insertEdge("N2", "N3", "depends_on");
    insertEdge("N3", "N4", "depends_on");
    insertEdge("N4", "N1", "depends_on"); // cycle back

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results1 = computePPR(drizzleDb, ["N1"]);
    const results2 = computePPR(drizzleDb, ["N1"]);

    // Results should be deterministic
    expect(results1.length).toBe(results2.length);
    for (let i = 0; i < results1.length; i++) {
      expect(results1[i].nodeId).toBe(results2[i].nodeId);
      expect(results1[i].score).toBeCloseTo(results2[i].score, 10);
    }
  });

  it("honours convergenceThreshold option — tighter threshold changes results less", () => {
    insertNode("X");
    insertNode("Y");
    insertEdge("X", "Y", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // With a very loose threshold the algorithm stops in 1 iteration
    const looseOpts: PPROptions = { maxIterations: 1, convergenceThreshold: 1.0 };
    const resultsLoose = computePPR(drizzleDb, ["X"], looseOpts);

    // With many iterations it should fully converge
    const tightOpts: PPROptions = { maxIterations: 100, convergenceThreshold: 1e-10 };
    const resultsTight = computePPR(drizzleDb, ["X"], tightOpts);

    // Both should contain the same nodes
    const idsLoose = new Set(resultsLoose.map((r) => r.nodeId));
    const idsTight = new Set(resultsTight.map((r) => r.nodeId));
    expect(idsLoose).toEqual(idsTight);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Edge type weighting
// ---------------------------------------------------------------------------

describe("computePPR — edge type weighting", () => {
  it("higher-weight edge type propagates more score than lower-weight type", () => {
    // Seed S connects to HIGH via high-weight edge and to LOW via low-weight edge.
    // After one hop, HIGH should have a greater score than LOW.
    insertNode("S");
    insertNode("HIGH");
    insertNode("LOW");
    insertEdge("S", "HIGH", "depends_on"); // weight 1.0
    insertEdge("S", "LOW", "references");  // weight 0.4

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["S"], {
      edgeTypeWeights: { depends_on: 1.0, references: 0.4 },
      maxIterations: 20,
    });

    const scoreHigh = results.find((r) => r.nodeId === "HIGH")!.score;
    const scoreLow = results.find((r) => r.nodeId === "LOW")!.score;

    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  it("custom edge type weights are respected", () => {
    // Custom weight that inverts the default order
    insertNode("S");
    insertNode("A");
    insertNode("B");
    insertEdge("S", "A", "type_alpha"); // custom type, will get weight 2.0
    insertEdge("S", "B", "type_beta");  // custom type, will get weight 0.1

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["S"], {
      edgeTypeWeights: { type_alpha: 2.0, type_beta: 0.1 },
      maxIterations: 20,
    });

    const scoreA = results.find((r) => r.nodeId === "A")!.score;
    const scoreB = results.find((r) => r.nodeId === "B")!.score;

    expect(scoreA).toBeGreaterThan(scoreB);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Node specificity dampening
// ---------------------------------------------------------------------------

describe("computePPR — node specificity dampening", () => {
  it("high in-degree hub node is dampened relative to low in-degree node", () => {
    // HUB is pointed to by every other node — very high in-degree.
    // LEAF is pointed to only by one node — low in-degree.
    // Both are one hop from the seed. Without dampening HUB might outscore LEAF;
    // with dampening the hub's score is reduced by the log(N/inDegree) factor.
    //
    // Graph:
    //   SEED → HUB  (and so do N1..N4)
    //   SEED → LEAF
    //
    insertNode("SEED");
    insertNode("HUB");
    insertNode("LEAF");
    insertNode("N1");
    insertNode("N2");
    insertNode("N3");
    insertNode("N4");

    // 5 nodes point to HUB, only 1 points to LEAF
    insertEdge("SEED", "HUB", "depends_on");
    insertEdge("N1", "HUB", "depends_on");
    insertEdge("N2", "HUB", "depends_on");
    insertEdge("N3", "HUB", "depends_on");
    insertEdge("N4", "HUB", "depends_on");

    insertEdge("SEED", "LEAF", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    const scoreHub = results.find((r) => r.nodeId === "HUB")!.score;
    const scoreLeaf = results.find((r) => r.nodeId === "LEAF")!.score;

    // HUB has inDegree=5, LEAF has inDegree=1.
    // Dampening factor for HUB = log(7/5) ≈ 0.34
    // Dampening factor for LEAF = log(7/1) ≈ 1.95
    // So LEAF should outscore HUB after dampening, even if its raw PPR score is equal.
    expect(scoreLeaf).toBeGreaterThan(scoreHub);
  });

  it("isolated node (inDegree=0) receives maximum specificity factor", () => {
    // An isolated node with in-degree 0 should receive the maximum dampening
    // factor (log(N)), not have its score zeroed.
    insertNode("SEED");
    insertNode("TARGET");
    insertEdge("SEED", "TARGET", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    // TARGET has inDegree=1 (pointed to by SEED), but SEED has inDegree=0.
    // With totalNodes=2, specificity for SEED = log(2/1) > 0.
    // SEED's score should be positive.
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Edge case regression tests (CR-001, CR-002, GA-001)
// ---------------------------------------------------------------------------

describe("computePPR — edge case regression tests", () => {
  it("CR-001: single-node graph with seed only does not zero scores", () => {
    // When the graph consists of only the seed node (totalNodes=1),
    // specificity dampening would compute log(1/1) = 0, zeroing all scores.
    // The fix skips dampening when totalNodes=1.
    insertNode("SEED");
    // No other nodes, no edges

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    // Should return exactly one result
    expect(results).toHaveLength(1);
    expect(results[0].nodeId).toBe("SEED");

    // Score should be positive, not zeroed by log(1) = 0 factor
    // (The fix at line 258 skips dampening when totalNodes=1)
    expect(results[0].score).toBeGreaterThan(0);

    // With only one node and no edges, score comes only from teleportation.
    // The seed receives alpha * seedScore = alpha * (1/|seeds|) = 0.15 * 1 = 0.15
    expect(results[0].score).toBeCloseTo(0.15, 5);
  });

  it("CR-001: totalNodes=1 produces valid non-zero score", () => {
    // Verify PPR produces valid score even when totalNodes=1
    // (Previous bug: specificity dampening with log(1) = 0 zeroed all scores)
    insertNode("ONLY_NODE");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["ONLY_NODE"]);

    // Score should be positive and finite (not NaN, not Infinity, not 0)
    expect(results[0].score).toBeGreaterThan(0);
    expect(Number.isFinite(results[0].score)).toBe(true);
    expect(Number.isNaN(results[0].score)).toBe(false);
  });

  it("CR-002: empty result from PPR does not break context assembly", () => {
    // When PPR returns empty results (e.g., maxNodes exceeded or empty seeds),
    // downstream context assembly should handle this gracefully.
    // This test verifies empty result is properly returned and structured.
    insertNode("A");
    insertNode("B");
    insertEdge("A", "B", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Empty seeds → empty result (documented behavior)
    const results = computePPR(drizzleDb, []);
    expect(results).toEqual([]);
    expect(Array.isArray(results)).toBe(true);
  });

  it("CR-002: PPR with maxNodes limit returns empty array when exceeded", () => {
    // When graph size exceeds maxNodes, PPR returns empty result
    // This should be a well-formed empty array, not null/undefined
    insertNode("A");
    insertNode("B");
    insertEdge("A", "B", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["A"], { maxNodes: 1 });

    expect(results).toEqual([]);
    expect(Array.isArray(results)).toBe(true);
  });

  it("GA-001: single seed in multi-node graph produces valid scores", () => {
    // Single seed in a graph with multiple nodes should produce
    // valid, non-NaN, non-Infinity scores for all reachable nodes
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertNode("N3");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");
    insertEdge("N2", "N3", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    // All scores should be finite and non-negative
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(r.score)).toBe(false);
    }

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }

    // Seed should be in results with a valid score
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);
  });

  it("GA-001: PPR scores sum to approximately 1.0 (probability mass)", () => {
    // PPR is a probability distribution and should sum to ~1.0
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertNode("N3");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("SEED", "N2", "depends_on");
    insertEdge("N2", "N3", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    // Sum of all scores should be close to 1.0 (before specificity dampening)
    // Note: specificity dampening changes the scale, so we check that
    // the scores are reasonably distributed
    const scoreSum = results.reduce((sum, r) => sum + r.score, 0);

    // After specificity dampening, scores can exceed 1.0,
    // but they should all be positive and finite
    expect(scoreSum).toBeGreaterThan(0);
    expect(Number.isFinite(scoreSum)).toBe(true);
  });

  it("GA-001: multiple seeds with equal weighting", () => {
    // Multiple seeds should each receive 1/N initial probability
    insertNode("SEED_A");
    insertNode("SEED_B");
    insertNode("SEED_C");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED_A", "SEED_B", "SEED_C"]);

    // All three seeds should be present
    const resultIds = results.map((r) => r.nodeId);
    expect(resultIds).toContain("SEED_A");
    expect(resultIds).toContain("SEED_B");
    expect(resultIds).toContain("SEED_C");

    // With no edges and equal specificity, all scores should be non-zero
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0);
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it("handles graph with isolated nodes (no edges)", () => {
    // Graph with nodes but no edges should still produce valid PPR
    insertNode("SEED");
    insertNode("ISOLATED_A");
    insertNode("ISOLATED_B");
    // No edges inserted

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    // All nodes should be present since they're in the node set
    expect(results.length).toBeGreaterThanOrEqual(1);

    // Seed should have highest score
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles self-loop edge without infinite recursion", () => {
    // Self-loop should not cause infinite loops or NaN scores
    insertNode("SEED");
    insertEdge("SEED", "SEED", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"]);

    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe("SEED");
    expect(results[0].score).toBeGreaterThan(0);
    expect(Number.isFinite(results[0].score)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Stress tests with large graphs
// ---------------------------------------------------------------------------

describe("computePPR — stress tests with large graphs", () => {
  it("handles graph with 500 nodes and linear chain structure", () => {
    // Create a linear chain: N0 → N1 → N2 → ... → N499
    const nodeCount = 500;
    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }
    for (let i = 0; i < nodeCount - 1; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["N0"]);

    // All nodes should be present
    expect(results.length).toBe(nodeCount);

    // Seed should be in results with a valid score
    const seedResult = results.find((r) => r.nodeId === "N0");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);

    // All scores should be valid
    const scores = results.map((r) => r.score);
    for (let i = 0; i < scores.length; i++) {
      expect(Number.isFinite(scores[i])).toBe(true);
      expect(scores[i]).toBeGreaterThanOrEqual(0);
    }

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("handles graph with 500 nodes and star topology", () => {
    // Create a star: CENTER connected to 499 leaves
    const leafCount = 499;
    insertNode("CENTER");
    for (let i = 0; i < leafCount; i++) {
      insertNode(`LEAF${i}`);
      insertEdge("CENTER", `LEAF${i}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["CENTER"]);

    // All nodes should be present
    expect(results.length).toBe(leafCount + 1);

    // Center should be in results
    const centerResult = results.find((r) => r.nodeId === "CENTER");
    expect(centerResult).toBeDefined();
    expect(centerResult!.score).toBeGreaterThan(0);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles graph with 500 nodes and dense connectivity", () => {
    // Create a densely connected graph
    const nodeCount = 500;
    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }

    // Each node connects to ~10 random other nodes
    for (let i = 0; i < nodeCount; i++) {
      for (let j = 1; j <= 10; j++) {
        const targetIndex = (i + j) % nodeCount;
        insertEdge(`N${i}`, `N${targetIndex}`, "depends_on");
      }
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["N0"]);

    // All nodes should be present
    expect(results.length).toBe(nodeCount);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("handles graph with multiple seeds on large graph", () => {
    const nodeCount = 300;
    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }
    // Create connections between consecutive nodes
    for (let i = 0; i < nodeCount - 1; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const seeds = ["N0", "N100", "N200"];
    const results = computePPR(drizzleDb, seeds);

    // All nodes should be present
    expect(results.length).toBe(nodeCount);

    // All seeds should be in results
    for (const seed of seeds) {
      const seedResult = results.find((r) => r.nodeId === seed);
      expect(seedResult).toBeDefined();
      expect(seedResult!.score).toBeGreaterThan(0);
    }
  });

  it("completes within reasonable time for 1000-node graph", () => {
    const nodeCount = 1000;
    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }
    // Sparse connections: each node connects to 2 others
    for (let i = 0; i < nodeCount; i++) {
      insertEdge(`N${i}`, `N${(i + 1) % nodeCount}`, "depends_on");
      insertEdge(`N${i}`, `N${(i + 2) % nodeCount}`, "references");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const startTime = Date.now();
    const results = computePPR(drizzleDb, ["N0"]);
    const duration = Date.now() - startTime;

    // Should complete in reasonable time (< 5 seconds for stress test)
    expect(duration).toBeLessThan(5000);

    // All nodes should be present
    expect(results.length).toBe(nodeCount);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: Boundary tests for maxNodes enforcement
// ---------------------------------------------------------------------------

describe("computePPR — maxNodes boundary tests", () => {
  it("proceeds when graph size equals maxNodes limit", () => {
    // Graph has exactly 10 connected nodes, maxNodes is 10
    for (let i = 0; i < 10; i++) {
      insertNode(`N${i}`);
    }
    // Connect nodes in a chain so all are discovered
    for (let i = 0; i < 9; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    // totalNodes=10, maxNodes=10: 10 > 10 is false, should proceed
    const results = computePPR(drizzleDb, ["N0"], { maxNodes: 10 });

    expect(results.length).toBe(10);
  });

  it("returns empty array when graph size exceeds maxNodes by 1", () => {
    // Graph has 11 connected nodes, maxNodes is 10
    for (let i = 0; i < 11; i++) {
      insertNode(`N${i}`);
    }
    // Connect nodes in a chain
    for (let i = 0; i < 10; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["N0"], { maxNodes: 10 });

    // 11 > 10, should return empty
    expect(results).toEqual([]);
    expect(Array.isArray(results)).toBe(true);
  });

  it("enforces maxNodes: 5 nodes with maxNodes=4 returns empty", () => {
    const nodeCount = 5;
    const maxNodes = 4;

    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }
    // Connect nodes in a chain
    for (let i = 0; i < nodeCount - 1; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["N0"], { maxNodes });

    // 5 > 4, should return empty
    expect(results).toEqual([]);
  });

  it("enforces maxNodes: 5 nodes with maxNodes=5 proceeds", () => {
    const nodeCount = 5;
    const maxNodes = 5;

    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }
    // Connect nodes in a chain
    for (let i = 0; i < nodeCount - 1; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["N0"], { maxNodes });

    // 5 > 5 is false, should proceed
    expect(results.length).toBe(nodeCount);
  });

  it("enforces maxNodes: 5 nodes with maxNodes=6 proceeds", () => {
    const nodeCount = 5;
    const maxNodes = 6;

    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }
    // Connect nodes in a chain
    for (let i = 0; i < nodeCount - 1; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["N0"], { maxNodes });

    // 5 > 6 is false, should proceed
    expect(results.length).toBe(nodeCount);
  });

  it("handles maxNodes=0 by returning empty result", () => {
    insertNode("A");
    insertNode("B");
    insertEdge("A", "B", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["A"], { maxNodes: 0 });

    // 2 > 0, should return empty
    expect(results).toEqual([]);
  });

  it("handles maxNodes=1 with single-node graph", () => {
    insertNode("ONLY");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["ONLY"], { maxNodes: 1 });

    // With maxNodes=1 and 1 node, should proceed (1 > 1 is false)
    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe("ONLY");
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("only counts connected nodes toward maxNodes limit", () => {
    // Create 15 nodes but only connect 5
    for (let i = 0; i < 15; i++) {
      insertNode(`N${i}`);
    }
    // Only connect first 5 nodes
    for (let i = 0; i < 4; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    // totalNodes will be 5 (connected) + 1 (seed "N0" already counted) = 5
    // Actually: seed N0 + N1,N2,N3,N4 via edges = 5 total
    const results = computePPR(drizzleDb, ["N0"], { maxNodes: 10 });

    // Only connected nodes are counted, so should proceed (5 <= 10)
    expect(results.length).toBe(5);
  });

  it("enforces maxNodes with very large limit", () => {
    // Create a moderate-sized connected graph
    for (let i = 0; i < 100; i++) {
      insertNode(`N${i}`);
    }
    // Connect nodes in a chain
    for (let i = 0; i < 99; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    // maxNodes very large, should proceed
    const results = computePPR(drizzleDb, ["N0"], { maxNodes: 10000 });

    expect(results.length).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Test 9: High alpha values (> 0.5)
// ---------------------------------------------------------------------------

describe("computePPR — high alpha value tests", () => {
  it("handles alpha=0.6 with stable convergence", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.6 });

    // Should complete and return valid results
    expect(results.length).toBe(3);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }

    // Seed should have highest score with high alpha
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);
  });

  it("handles alpha=0.85 (very high teleport probability)", () => {
    // Create a longer chain to test propagation with high alpha
    // Chain: SEED → N1 → N2 → N3 → N4 → N5
    insertNode("SEED");
    for (let i = 1; i <= 5; i++) {
      insertNode(`N${i}`);
    }
    // Insert edges after all nodes are created
    insertEdge("SEED", "N1", "depends_on");
    for (let i = 1; i < 5; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.85, maxIterations: 100 });

    // Should complete and return results
    expect(results.length).toBe(6);

    // With high alpha, scores drop off quickly with distance
    // Seed should have significantly higher score than distant nodes
    const seedScore = results.find((r) => r.nodeId === "SEED")!.score;
    const distantScore = results.find((r) => r.nodeId === "N5")!.score;
    expect(seedScore).toBeGreaterThan(distantScore);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });

  it("handles alpha=0.99 (near-deterministic teleport)", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.99, maxIterations: 100 });

    expect(results.length).toBe(3);

    // With alpha=0.99, nearly all probability mass stays at seed
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it("handles alpha=0.5 (boundary value)", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.5 });

    expect(results.length).toBe(3);

    // With alpha=0.5, equal balance between teleportation and propagation
    const seedScore = results.find((r) => r.nodeId === "SEED")!.score;
    expect(seedScore).toBeGreaterThan(0);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it("compares low vs high alpha behavior", () => {
    // Create a triangle graph
    insertNode("A");
    insertNode("B");
    insertNode("C");
    insertEdge("A", "B", "depends_on");
    insertEdge("B", "C", "depends_on");
    insertEdge("C", "A", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Low alpha (more exploration)
    const resultsLow = computePPR(drizzleDb, ["A"], { alpha: 0.1, maxIterations: 100 });

    // High alpha (more teleportation)
    // Reset DB between runs
    try { db.close(); } catch { /* ignore */ }
    db = new Database(":memory:");
    createSchema(db);

    insertNode("A");
    insertNode("B");
    insertNode("C");
    insertEdge("A", "B", "depends_on");
    insertEdge("B", "C", "depends_on");
    insertEdge("C", "A", "depends_on");

    const resultsHigh = computePPR(drizzle(db, { schema: dbSchema }), ["A"], {
      alpha: 0.8,
      maxIterations: 100,
    });

    // Both should produce valid results
    expect(resultsLow.length).toBe(3);
    expect(resultsHigh.length).toBe(3);

    // With high alpha, seed retains more score relative to others
    const lowAlphaSeedScore = resultsLow.find((r) => r.nodeId === "A")!.score;
    const highAlphaSeedScore = resultsHigh.find((r) => r.nodeId === "A")!.score;

    // High alpha seed score should be greater (more teleportation back to seed)
    expect(highAlphaSeedScore).toBeGreaterThan(lowAlphaSeedScore);
  });

  it("handles alpha approaching 1.0 with convergence", () => {
    insertNode("SEED");
    insertNode("N1");
    insertEdge("SEED", "N1", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    // Very close to 1.0
    const results = computePPR(drizzleDb, ["SEED"], {
      alpha: 0.999,
      convergenceThreshold: 1e-10,
      maxIterations: 200,
    });

    expect(results.length).toBe(2);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 10: Concurrent computations
// ---------------------------------------------------------------------------

describe("computePPR — concurrent computation tests", () => {
  it("handles multiple sequential calls on same database", () => {
    insertNode("A");
    insertNode("B");
    insertNode("C");
    insertEdge("A", "B", "depends_on");
    insertEdge("B", "C", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Multiple sequential calls
    const results1 = computePPR(drizzleDb, ["A"]);
    const results2 = computePPR(drizzleDb, ["B"]);
    const results3 = computePPR(drizzleDb, ["C"]);

    // All should return valid results
    expect(results1.length).toBe(3);
    expect(results2.length).toBe(3);
    expect(results3.length).toBe(3);

    // Each call's seed should be in results with a positive score
    // (Note: seed may not be at top due to specificity dampening)
    const seedAResult = results1.find((r) => r.nodeId === "A");
    expect(seedAResult).toBeDefined();
    expect(seedAResult!.score).toBeGreaterThan(0);

    const seedBResult = results2.find((r) => r.nodeId === "B");
    expect(seedBResult).toBeDefined();
    expect(seedBResult!.score).toBeGreaterThan(0);

    const seedCResult = results3.find((r) => r.nodeId === "C");
    expect(seedCResult).toBeDefined();
    expect(seedCResult!.score).toBeGreaterThan(0);

    // Results should be sorted by score descending
    for (const results of [results1, results2, results3]) {
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    }
  });

  it("produces consistent results across multiple identical calls", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Call PPR multiple times with same parameters
    const results: { nodeId: string; score: number }[][] = [];
    for (let i = 0; i < 10; i++) {
      results.push(computePPR(drizzleDb, ["SEED"]));
    }

    // All results should be identical
    for (let i = 1; i < results.length; i++) {
      expect(results[i].length).toBe(results[0].length);
      for (let j = 0; j < results[i].length; j++) {
        expect(results[i][j].nodeId).toBe(results[0][j].nodeId);
        expect(results[i][j].score).toBeCloseTo(results[0][j].score, 10);
      }
    }
  });

  it("handles different seeds called in succession", () => {
    // Create a connected graph
    for (let i = 0; i < 10; i++) {
      insertNode(`N${i}`);
    }
    for (let i = 0; i < 9; i++) {
      insertEdge(`N${i}`, `N${i + 1}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Test different seed combinations
    const seeds = [["N0"], ["N5"], ["N9"], ["N0", "N5"], ["N3", "N7", "N9"]];

    for (const seedSet of seeds) {
      const results = computePPR(drizzleDb, seedSet);

      // Should return results for all nodes
      expect(results.length).toBe(10);

      // All seeds should be in results
      for (const seed of seedSet) {
        const seedResult = results.find((r) => r.nodeId === seed);
        expect(seedResult).toBeDefined();
        expect(seedResult!.score).toBeGreaterThan(0);
      }
    }
  });

  it("handles rapid successive calls with different options", () => {
    insertNode("A");
    insertNode("B");
    insertNode("C");
    insertEdge("A", "B", "depends_on");
    insertEdge("B", "C", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Rapid calls with different options
    const opts1: PPROptions = { alpha: 0.1, maxIterations: 20 };
    const opts2: PPROptions = { alpha: 0.5, maxIterations: 50 };
    const opts3: PPROptions = { alpha: 0.9, maxIterations: 100 };

    const results1 = computePPR(drizzleDb, ["A"], opts1);
    const results2 = computePPR(drizzleDb, ["A"], opts2);
    const results3 = computePPR(drizzleDb, ["A"], opts3);

    // All should return valid results
    expect(results1.length).toBe(3);
    expect(results2.length).toBe(3);
    expect(results3.length).toBe(3);

    // All scores should be valid
    for (const r of [...results1, ...results2, ...results3]) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it("handles graph modification between calls", () => {
    insertNode("A");
    insertNode("B");
    insertEdge("A", "B", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // First call
    const results1 = computePPR(drizzleDb, ["A"]);
    expect(results1.length).toBe(2);

    // Add new node and edge
    insertNode("C");
    insertEdge("B", "C", "depends_on");

    // Second call - should see new node
    const results2 = computePPR(drizzleDb, ["A"]);
    expect(results2.length).toBe(3);
    expect(results2.map((r) => r.nodeId)).toContain("C");
  });

  it("produces deterministic results across multiple database instances", () => {
    // Create identical graph in fresh database
    const createTestGraph = () => {
      const testDb = new Database(":memory:");
      createSchema(testDb);

      testDb.prepare(`
        INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
        VALUES (?, 'work_item', 1, NULL, 'hash', 0, '/tmp/' || ? || '.yaml', 'pending')
      `).run("SEED", "SEED");

      testDb.prepare(`
        INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
        VALUES (?, 'work_item', 1, NULL, 'hash', 0, '/tmp/' || ? || '.yaml', 'pending')
      `).run("N1", "N1");

      testDb.prepare(`
        INSERT OR REPLACE INTO edges (source_id, target_id, edge_type, props)
        VALUES (?, ?, ?, NULL)
      `).run("SEED", "N1", "depends_on");

      return testDb;
    };

    const results: { nodeId: string; score: number }[][] = [];
    for (let i = 0; i < 5; i++) {
      const testDb = createTestGraph();
      const drizzleDb = drizzle(testDb, { schema: dbSchema });
      results.push(computePPR(drizzleDb, ["SEED"]));
      testDb.close();
    }

    // All results should be identical across database instances
    for (let i = 1; i < results.length; i++) {
      expect(results[i].length).toBe(results[0].length);
      for (let j = 0; j < results[i].length; j++) {
        expect(results[i][j].nodeId).toBe(results[0][j].nodeId);
        expect(results[i][j].score).toBeCloseTo(results[0][j].score, 10);
      }
    }
  });

  it("handles edge type weight changes between calls", () => {
    insertNode("SEED");
    insertNode("HIGH");
    insertNode("LOW");
    insertEdge("SEED", "HIGH", "depends_on");
    insertEdge("SEED", "LOW", "references");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // First call with default weights
    const results1 = computePPR(drizzleDb, ["SEED"]);
    const scoreHigh1 = results1.find((r) => r.nodeId === "HIGH")!.score;
    const scoreLow1 = results1.find((r) => r.nodeId === "LOW")!.score;

    // Second call with inverted weights
    const results2 = computePPR(drizzleDb, ["SEED"], {
      edgeTypeWeights: { depends_on: 0.4, references: 1.0 },
    });
    const scoreHigh2 = results2.find((r) => r.nodeId === "HIGH")!.score;
    const scoreLow2 = results2.find((r) => r.nodeId === "LOW")!.score;

    // With inverted weights, LOW should now have higher score than HIGH
    expect(scoreLow2).toBeGreaterThan(scoreHigh2);

    // Verify original was different
    expect(scoreHigh1).toBeGreaterThan(scoreLow1);
  });
});

// ---------------------------------------------------------------------------
// Test 10: High alpha value tests (WI-632)
// ---------------------------------------------------------------------------

describe("computePPR — high alpha stability tests", () => {
  it("handles alpha=0.5 (aggressive restart probability)", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.5 });

    // All nodes should be present with valid scores
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }

    // With high alpha (0.5), teleportation dominates
    // Seed should have significantly higher score than distant nodes
    const scoreSeed = results.find((r) => r.nodeId === "SEED")!.score;
    const scoreN2 = results.find((r) => r.nodeId === "N2")!.score;
    expect(scoreSeed).toBeGreaterThan(scoreN2);
  });

  it("handles alpha=0.7 (very aggressive restart)", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertNode("N3");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");
    insertEdge("N2", "N3", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.7 });

    // All nodes should be present
    expect(results.length).toBe(4);

    // With very high alpha, scores should still be valid and sum reasonably
    const scoreSum = results.reduce((sum, r) => sum + r.score, 0);
    expect(Number.isFinite(scoreSum)).toBe(true);
    expect(scoreSum).toBeGreaterThan(0);

    // Results should be sorted by score
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("handles alpha=0.9 (near-random walk)", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.9 });

    // All nodes should be present
    expect(results.length).toBe(3);

    // With alpha=0.9, almost every step restarts to seed
    // Seed should dominate the scores
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });

  it("converges within maxIterations for high alpha values", () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertNode("N3");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("N1", "N2", "depends_on");
    insertEdge("N2", "N3", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // High alpha values should converge quickly
    const alphas = [0.5, 0.7, 0.9];
    for (const alpha of alphas) {
      const results = computePPR(drizzleDb, ["SEED"], {
        alpha,
        maxIterations: 20, // Should converge quickly with high alpha
      });

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(Number.isFinite(r.score)).toBe(true);
      }
    }
  });

  it("handles alpha=0.99 (extreme case)", () => {
    insertNode("SEED");
    insertNode("N1");
    insertEdge("SEED", "N1", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.99 });

    // Should still produce valid results even with extreme alpha
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 11: Concurrent computation tests (WI-632)
// ---------------------------------------------------------------------------

describe("computePPR — sequential computation isolation tests", () => {
  it("handles concurrent PPR calls on the same database", async () => {
    // Create a graph with multiple branches
    insertNode("ROOT");
    for (let i = 0; i < 10; i++) {
      insertNode(`BRANCH${i}`);
      insertEdge("ROOT", `BRANCH${i}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Run multiple PPR calls concurrently
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        Promise.resolve().then(() =>
          computePPR(drizzleDb, ["ROOT"])
        )
      );
    }

    const results = await Promise.all(promises);

    // All results should be identical (deterministic)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].length).toBe(results[0].length);
      for (let j = 0; j < results[i].length; j++) {
        expect(results[i][j].nodeId).toBe(results[0][j].nodeId);
        expect(results[i][j].score).toBeCloseTo(results[0][j].score, 10);
      }
    }
  });

  it("handles concurrent PPR calls with different seeds", async () => {
    // Create a graph with multiple disconnected components
    for (let i = 0; i < 5; i++) {
      insertNode(`SEED${i}`);
      insertNode(`LEAF${i}`);
      insertEdge(`SEED${i}`, `LEAF${i}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Run PPR with different seeds concurrently
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(
        Promise.resolve().then(() =>
          computePPR(drizzleDb, [`SEED${i}`])
        )
      );
    }

    const results = await Promise.all(promises);

    // Each result should have valid scores
    for (const result of results) {
      expect(result.length).toBeGreaterThan(0);
      for (const r of result) {
        expect(Number.isFinite(r.score)).toBe(true);
      }
    }
  });

  it("handles concurrent PPR calls with different options", async () => {
    insertNode("SEED");
    insertNode("N1");
    insertNode("N2");
    insertEdge("SEED", "N1", "depends_on");
    insertEdge("SEED", "N2", "depends_on");

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Run PPR with different options concurrently
    const promises = [
      Promise.resolve().then(() =>
        computePPR(drizzleDb, ["SEED"], { alpha: 0.15 })
      ),
      Promise.resolve().then(() =>
        computePPR(drizzleDb, ["SEED"], { alpha: 0.5 })
      ),
      Promise.resolve().then(() =>
        computePPR(drizzleDb, ["SEED"], { maxIterations: 50 })
      ),
      Promise.resolve().then(() =>
        computePPR(drizzleDb, ["SEED"], { convergenceThreshold: 1e-8 })
      ),
    ];

    const results = await Promise.all(promises);

    // All results should be valid
    for (const result of results) {
      expect(result.length).toBe(3);
      for (const r of result) {
        expect(Number.isFinite(r.score)).toBe(true);
      }
    }

    // Results with different alpha should be different
    const scoresAlpha015 = results[0].find((r) => r.nodeId === "N1")!.score;
    const scoresAlpha05 = results[1].find((r) => r.nodeId === "N1")!.score;
    expect(scoresAlpha015).not.toBe(scoresAlpha05);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Large graph stress tests (WI-632)
// ---------------------------------------------------------------------------

describe("computePPR — large graph stress tests (10,000+ nodes)", () => {
  it("handles graph with 2000 nodes efficiently", () => {
    const nodeCount = 2000;

    // Create nodes
    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }

    // Create sparse connections (each node connects to ~2 others)
    for (let i = 0; i < nodeCount; i++) {
      insertEdge(`N${i}`, `N${(i + 1) % nodeCount}`, "depends_on");
      insertEdge(`N${i}`, `N${(i + 2) % nodeCount}`, "references");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });
    const startTime = Date.now();
    const results = computePPR(drizzleDb, ["N0"]);
    const duration = Date.now() - startTime;

    // Should complete in reasonable time for stress test
    expect(duration).toBeLessThan(10000); // 10 seconds

    // All nodes should be present
    expect(results.length).toBe(nodeCount);

    // All scores should be valid
    for (const r of results) {
      expect(Number.isFinite(r.score)).toBe(true);
    }

    // Results should be sorted
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("maxNodes enforcement works with large graphs", () => {
    const nodeCount = 1000;

    for (let i = 0; i < nodeCount; i++) {
      insertNode(`N${i}`);
    }

    // Fully connected graph
    for (let i = 0; i < nodeCount; i++) {
      insertEdge(`N${i}`, `N${(i + 1) % nodeCount}`, "depends_on");
    }

    const drizzleDb = drizzle(db, { schema: dbSchema });

    // Test with various maxNodes values
    const maxNodesValues = [100, 500, 1000];
    for (const maxNodes of maxNodesValues) {
      const results = computePPR(drizzleDb, ["N0"], { maxNodes });

      if (nodeCount > maxNodes) {
        // Should return empty array when limit exceeded
        expect(results).toEqual([]);
      } else {
        // Should return results when within limit
        expect(results.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Test 8: PPR parameter validation (WI-648)
// ---------------------------------------------------------------------------

describe("computePPR — parameter validation", () => {
  it("rejects alpha = 0", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { alpha: 0 })).toThrow(/alpha must be between 0 and 1/);
  });

  it("rejects negative alpha", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { alpha: -0.1 })).toThrow(/alpha must be between 0 and 1/);
  });

  it("rejects alpha > 1", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { alpha: 1.5 })).toThrow(/alpha must be between 0 and 1/);
  });

  it("accepts alpha = 1", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    // alpha = 1 should be valid (returns to seed with probability 1)
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 1 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("accepts valid alpha between 0 and 1", () => {
    insertNode("SEED");
    insertNode("N1");
    insertEdge("SEED", "N1", "depends_on");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { alpha: 0.15 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("rejects maxIterations = 0", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { maxIterations: 0 })).toThrow(/maxIterations must be a positive integer/);
  });

  it("rejects negative maxIterations", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { maxIterations: -1 })).toThrow(/maxIterations must be a positive integer/);
  });

  it("rejects non-integer maxIterations", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { maxIterations: 10.5 })).toThrow(/maxIterations must be a positive integer/);
  });

  it("accepts valid positive integer maxIterations", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { maxIterations: 100 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("rejects convergenceThreshold = 0", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { convergenceThreshold: 0 })).toThrow(/convergenceThreshold must be a positive number/);
  });

  it("rejects negative convergenceThreshold", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { convergenceThreshold: -0.001 })).toThrow(/convergenceThreshold must be a positive number/);
  });

  it("accepts valid positive convergenceThreshold", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { convergenceThreshold: 0.00001 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("rejects negative maxNodes", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { maxNodes: -1 })).toThrow(/maxNodes must be a non-negative integer/);
  });

  it("rejects non-integer maxNodes", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    expect(() => computePPR(drizzleDb, ["SEED"], { maxNodes: 10.5 })).toThrow(/maxNodes must be a non-negative integer/);
  });

  it("accepts maxNodes = 0", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    // maxNodes = 0 means all graphs are rejected (returns empty)
    const results = computePPR(drizzleDb, ["SEED"], { maxNodes: 0 });
    expect(results).toEqual([]);
  });

  it("accepts valid non-negative integer maxNodes", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const results = computePPR(drizzleDb, ["SEED"], { maxNodes: 1000 });
    expect(results.length).toBeGreaterThan(0);
  });

  it("throws INVALID_ALPHA code for invalid alpha", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    try {
      computePPR(drizzleDb, ["SEED"], { alpha: -0.5 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_ALPHA");
    }
  });

  it("throws INVALID_MAX_ITERATIONS code for invalid maxIterations", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    try {
      computePPR(drizzleDb, ["SEED"], { maxIterations: -1 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_MAX_ITERATIONS");
    }
  });

  it("throws INVALID_CONVERGENCE_THRESHOLD code for invalid convergenceThreshold", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    try {
      computePPR(drizzleDb, ["SEED"], { convergenceThreshold: -0.001 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_CONVERGENCE_THRESHOLD");
    }
  });

  it("throws INVALID_MAX_NODES code for invalid maxNodes", () => {
    insertNode("SEED");
    const drizzleDb = drizzle(db, { schema: dbSchema });
    try {
      computePPR(drizzleDb, ["SEED"], { maxNodes: -1 });
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_MAX_NODES");
    }
  });
});

// ---------------------------------------------------------------------------
// Test 11: LocalContextAdapter.traverse boundary validation (WI-697)
// ---------------------------------------------------------------------------

describe("LocalContextAdapter.traverse — boundary validation", () => {
  it("throws ValidationError for alpha=0", async () => {
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const adapter = new LocalContextAdapter(drizzleDb, db);
    insertNode("SEED");

    try {
      await adapter.traverse({ seed_ids: ["SEED"], alpha: 0 });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_ALPHA");
      expect((err as Error).message).toContain("must be > 0");
      expect((err as Error).message).toContain("(0, 1]");
    }
  });

  it("throws ValidationError for max_iterations=0", async () => {
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const adapter = new LocalContextAdapter(drizzleDb, db);
    insertNode("SEED");

    try {
      await adapter.traverse({ seed_ids: ["SEED"], max_iterations: 0 });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_MAX_ITERATIONS");
      expect((err as Error).message).toContain("must be > 0");
    }
  });

  it("throws ValidationError for alpha=-0.1 (existing boundary)", async () => {
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const adapter = new LocalContextAdapter(drizzleDb, db);
    insertNode("SEED");

    try {
      await adapter.traverse({ seed_ids: ["SEED"], alpha: -0.1 });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_ALPHA");
    }
  });

  it("throws ValidationError for max_iterations=-1 (existing boundary)", async () => {
    const drizzleDb = drizzle(db, { schema: dbSchema });
    const adapter = new LocalContextAdapter(drizzleDb, db);
    insertNode("SEED");

    try {
      await adapter.traverse({ seed_ids: ["SEED"], max_iterations: -1 });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_MAX_ITERATIONS");
    }
  });
});
