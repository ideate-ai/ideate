// ppr.ts — Personalized PageRank (PPR) algorithm for ideate artifact graph
//
// Computes PPR scores for nodes in the artifact graph, starting from one or
// more seed nodes. Scores represent contextual relevance: higher-scoring nodes
// are more relevant to the seeds given the graph structure.
//
// Algorithm overview:
//   1. Load all edges from SQLite.
//   2. Build undirected adjacency (each directed edge is traversable both ways).
//   3. Initialise seed nodes to 1/|seeds|, all others to 0.
//   4. Iterate until convergence:
//        new_score[v] = alpha * seed_score[v]
//                     + (1 - alpha) * Σ(weighted_score[u] / out_degree[u])
//      where u iterates over neighbours of v and weighted_score = score * edge_weight.
//   5. Apply node specificity dampening: multiply by log(totalNodes / max(1, inDegree)).
//   6. Return nodes sorted by score descending.

import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as dbSchema from "./db.js";
import { edges } from "./db.js";
import { ValidationError } from "./adapter.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PPROptions {
  /** Restart probability — probability of teleporting back to a seed node. Default: 0.15 */
  alpha?: number;
  /** Maximum number of iterations before stopping. Default: 50 */
  maxIterations?: number;
  /** Stop when max score delta between iterations is below this threshold. Default: 1e-6 */
  convergenceThreshold?: number;
  /**
   * Per-edge-type multipliers applied to score propagation.
   * Edges with unlisted types get weight 1.0.
   */
  edgeTypeWeights?: Record<string, number>;
  /**
   * Maximum number of nodes to process. Kept for backward compatibility but
   * ignored inside computePPR — the caller (LocalAdapter.traverse) applies
   * max_nodes as a result-count slice after PPR scoring.
   */
  maxNodes?: number;
}

export interface PPRResult {
  nodeId: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

const DEFAULT_ALPHA = 0.15;
const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_CONVERGENCE_THRESHOLD = 1e-6;

const DEFAULT_EDGE_TYPE_WEIGHTS: Record<string, number> = {
  DEPENDS_ON: 1.0,
  GOVERNED_BY: 0.8,
  INFORMED_BY: 0.6,
  REFERENCES: 0.4,
  BLOCKS: 0.3,
};

/** Containment edge types excluded from PPR traversal. */
const CONTAINMENT_EDGE_TYPES = new Set([
  "owns_codebase", "owns_project", "has_phase", "has_work_item",
  "owns_knowledge", "references_codebase",
]);

/**
 * Normalize an edge type to UPPER_SNAKE_CASE for weight lookup.
 * Handles snake_case (SQLite), UPPER_SNAKE_CASE (Neo4j), and mixed case.
 */
function normalizeEdgeType(edgeType: string): string {
  return edgeType.toUpperCase();
}

// ---------------------------------------------------------------------------
// computePPR
// ---------------------------------------------------------------------------

/**
 * Compute Personalized PageRank scores for all nodes reachable from seedNodeIds.
 *
 * @param drizzleDb  Drizzle ORM database instance backed by better-sqlite3.
 * @param seedNodeIds  IDs of the nodes to use as the restart set.
 * @param options  Optional algorithm parameters.
 * @returns Array of {nodeId, score} sorted by score descending.
 */
export function computePPR(
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
  seedNodeIds: string[],
  options?: PPROptions
): PPRResult[] {
  const alpha = options?.alpha ?? DEFAULT_ALPHA;
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const convergenceThreshold = options?.convergenceThreshold ?? DEFAULT_CONVERGENCE_THRESHOLD;

  // Normalize edge type weight keys to UPPER_SNAKE_CASE for consistent lookup
  const rawEdgeTypeWeights = options?.edgeTypeWeights ?? DEFAULT_EDGE_TYPE_WEIGHTS;
  const edgeTypeWeights: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawEdgeTypeWeights)) {
    edgeTypeWeights[normalizeEdgeType(key)] = value;
  }

  // Validate alpha: must be 0 < alpha <= 1
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new ValidationError(
      `alpha must be between 0 and 1 (exclusive of 0, inclusive of 1), received ${alpha}`,
      "INVALID_ALPHA",
      { value: alpha }
    );
  }

  // Validate maxIterations: must be positive integer
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw new ValidationError(
      `maxIterations must be a positive integer, received ${maxIterations}`,
      "INVALID_MAX_ITERATIONS",
      { value: maxIterations }
    );
  }

  // Validate convergenceThreshold: must be positive number
  if (!Number.isFinite(convergenceThreshold) || convergenceThreshold <= 0) {
    throw new ValidationError(
      `convergenceThreshold must be a positive number, received ${convergenceThreshold}`,
      "INVALID_CONVERGENCE_THRESHOLD",
      { value: convergenceThreshold }
    );
  }

  // Short-circuit: empty seeds → empty result
  if (seedNodeIds.length === 0) {
    return [];
  }

  // -------------------------------------------------------------------------
  // Step 1: Load all edges from SQLite via Drizzle ORM
  // -------------------------------------------------------------------------
  const allEdges = drizzleDb
    .select({
      source_id: edges.source_id,
      target_id: edges.target_id,
      edge_type: edges.edge_type,
    })
    .from(edges)
    .all();


  // -------------------------------------------------------------------------
  // Step 2: Collect all node IDs and build adjacency structures
  //
  // We treat the graph as undirected for PPR traversal, so each directed edge
  // (source → target) becomes two entries in the adjacency list. This lets
  // relevance flow in both directions, which is appropriate when we want to
  // surface nodes that depend on, or are depended upon by, the seeds.
  //
  // adj[nodeId] = Array of {neighbour, weight} representing edges to walk.
  // inDegree[nodeId] = number of directed edges pointing AT this node
  //                    (used for specificity dampening only — not adjacency).
  // -------------------------------------------------------------------------

  const nodeSet = new Set<string>(seedNodeIds);
  for (const e of allEdges) {
    nodeSet.add(e.source_id);
    nodeSet.add(e.target_id);
  }
  const allNodeIds = Array.from(nodeSet);
  const totalNodes = allNodeIds.length;

  // adj: undirected adjacency — for each node, the list of weighted neighbours
  const adj = new Map<string, Array<{ neighbour: string; weight: number }>>();
  for (const id of allNodeIds) {
    adj.set(id, []);
  }

  // inDegree: directed in-degree (used for specificity dampening)
  const inDegree = new Map<string, number>();
  for (const id of allNodeIds) {
    inDegree.set(id, 0);
  }

  for (const e of allEdges) {
    // Skip containment edges (organizational hierarchy)
    if (CONTAINMENT_EDGE_TYPES.has(e.edge_type)) continue;

    // Normalize edge type to UPPER_SNAKE_CASE for weight lookup
    const normalizedEdgeType = normalizeEdgeType(e.edge_type);
    const w = edgeTypeWeights[normalizedEdgeType] ?? 1.0;

    // Skip edges with zero weight — they contribute nothing to score propagation
    if (w === 0) continue;

    // source → target (forward direction)
    adj.get(e.source_id)!.push({ neighbour: e.target_id, weight: w });
    // target → source (reverse direction — undirected traversal)
    adj.get(e.target_id)!.push({ neighbour: e.source_id, weight: w });

    // Update directed in-degree for target only
    inDegree.set(e.target_id, (inDegree.get(e.target_id) ?? 0) + 1);
  }

  // Initialize inDegree for isolated seeds to prevent specificity dampening from zeroing them out.
  // This matches the server-side PPR behavior in ideate-server/src/services/ppr.ts
  for (const seed of seedNodeIds) {
    if (!inDegree.has(seed)) {
      inDegree.set(seed, 1);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Initialise scores
  //
  // Seed nodes each receive 1/|seeds|; all others start at 0.
  // -------------------------------------------------------------------------

  const seedSet = new Set<string>(seedNodeIds);
  const seedScore = 1.0 / seedNodeIds.length;

  const scores = new Map<string, number>();
  for (const id of allNodeIds) {
    scores.set(id, seedSet.has(id) ? seedScore : 0.0);
  }

  // -------------------------------------------------------------------------
  // Step 4: Iterate PPR until convergence
  // -------------------------------------------------------------------------

  for (let iter = 0; iter < maxIterations; iter++) {
    const newScores = new Map<string, number>();

    // Initialize with 0 for all nodes.
    for (const id of allNodeIds) {
      newScores.set(id, 0.0);
    }

    // Propagate scores along edges
    // For each node u, distribute its score to neighbours proportionally
    // to their edge weights divided by u's total weighted out-degree.
    for (const u of allNodeIds) {
      const uScore = scores.get(u)!;
      if (uScore === 0.0) continue;

      const neighbours = adj.get(u)!;
      if (neighbours.length === 0) continue;

      // Compute the total weighted out-degree (sum of weights on all edges from u)
      let totalWeight = 0.0;
      for (const { weight } of neighbours) {
        totalWeight += weight;
      }
      if (totalWeight === 0.0) continue;

      for (const { neighbour, weight } of neighbours) {
        const contribution = (1.0 - alpha) * uScore * (weight / totalWeight);
        newScores.set(neighbour, newScores.get(neighbour)! + contribution);
      }
    }

    // Add teleportation mass back to seed nodes.
    if (seedNodeIds.length > 0) {
      for (const seed of seedNodeIds) {
        newScores.set(seed, (newScores.get(seed) ?? 0.0) + alpha * seedScore);
      }
    }

    // Check convergence: max absolute delta across all nodes
    let maxDelta = 0.0;
    for (const id of allNodeIds) {
      const delta = Math.abs((newScores.get(id) ?? 0.0) - (scores.get(id) ?? 0.0));
      if (delta > maxDelta) maxDelta = delta;
    }

    // Update scores
    for (const id of allNodeIds) {
      scores.set(id, newScores.get(id)!);
    }

    if (maxDelta < convergenceThreshold) {
      break;
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Apply node specificity dampening (IDF-like)
  //
  // Nodes with very high in-degree are "hub" nodes — they appear in many
  // relationships and are therefore less specific/informative. We dampen their
  // scores proportionally:
  //
  //   score *= log(totalNodes / max(1, inDegree))
  //
  // log here is natural log. Nodes with inDegree=0 receive the maximum factor
  // (log(totalNodes)), while a hub node with inDegree ≈ totalNodes gets ~0.
  //
  // When totalNodes=1 the factor is log(1)=0. To avoid zeroing out all scores
  // in degenerate single-node graphs, we skip dampening in that case.
  // -------------------------------------------------------------------------

  if (totalNodes > 1) {
    for (const id of allNodeIds) {
      const deg = inDegree.get(id) ?? 0;
      const specificityFactor = Math.log(totalNodes / Math.max(1, deg));
      scores.set(id, scores.get(id)! * specificityFactor);
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Build and sort results
  // -------------------------------------------------------------------------

  const results: PPRResult[] = [];
  for (const id of allNodeIds) {
    results.push({ nodeId: id, score: scores.get(id)! });
  }

  results.sort((a, b) => b.score - a.score);

  return results;
}
