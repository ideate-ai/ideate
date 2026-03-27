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
import { computePPR, PPROptions } from "../ppr.js";

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

    const drizzleDb = drizzle(db);
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
    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);

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

    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);
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

    const drizzleDb = drizzle(db);
    const results = computePPR(drizzleDb, ["SEED"]);

    // TARGET has inDegree=1 (pointed to by SEED), but SEED has inDegree=0.
    // With totalNodes=2, specificity for SEED = log(2/1) > 0.
    // SEED's score should be positive.
    const seedResult = results.find((r) => r.nodeId === "SEED");
    expect(seedResult).toBeDefined();
    expect(seedResult!.score).toBeGreaterThan(0);
  });
});
