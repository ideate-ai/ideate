// adapters/local/context.ts — LocalAdapter context assembly and PPR traversal
//
// This module provides the LocalAdapter implementation for:
//   - traverse(): PPR-based graph traversal for context assembly (wraps ppr.ts)
//   - Context assembly helpers: node metadata queries, content reads, and
//     artifact assembly used by the MCP context tool handlers.
//
// ppr.ts is an adapter-internal dependency — it is NOT imported directly by
// any MCP tool handler. All PPR logic flows through traverse() in this module.

import * as fs from "fs";
import { parse as parseYaml } from "yaml";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import type * as dbSchema from "../../db.js";
import { computePPR } from "../../ppr.js";
import type {
  TraversalOptions,
  TraversalResult,
  Node,
  NodeType,
} from "../../adapter.js";
import { ValidationError, ALL_NODE_TYPES } from "../../adapter.js";

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string;
  type: string;
  file_path: string;
  token_count: number | null;
  status: string | null;
}

interface DocumentArtifactRow {
  id: string;
  title: string | null;
  cycle: number | null;
  content: string | null;
}

interface GuidingPrincipleRow {
  id: string;
  name: string;
  description: string | null;
}

interface ConstraintRow {
  id: string;
  category: string;
  description: string | null;
}

interface ProjectRow {
  id: string;
  intent: string;
  success_criteria: string | null;
  appetite: number | null;
  horizon: string | null;
  status: string | null;
}

interface PhaseRow {
  id: string;
  project: string;
  phase_type: string;
  intent: string;
  steering: string | null;
  status: string | null;
  work_items: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a string using ~4 chars/token heuristic.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Read a file and return its raw text content. Returns empty string on error.
 */
function readFileContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Build a Node object from a NodeRow and its YAML content.
 */
function nodeRowToNode(row: NodeRow, content: string): Node {
  let properties: Record<string, unknown> = {};
  if (content) {
    try {
      const parsed = parseYaml(content) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") {
        properties = parsed;
      }
    } catch {
      // If YAML parse fails, leave properties empty
    }
  }

  return {
    id: row.id,
    type: row.type as NodeType,
    status: row.status,
    cycle_created: null,
    cycle_modified: null,
    content_hash: "",
    token_count: row.token_count,
    properties,
  };
}

// ---------------------------------------------------------------------------
// LocalContextAdapter
// ---------------------------------------------------------------------------

/**
 * LocalContextAdapter provides traverse() and context assembly operations
 * for the local (SQLite + YAML) backend.
 *
 * This class is instantiated by tool handlers in tools/context.ts. It wraps
 * ppr.ts internally so that tool handlers never import computePPR directly.
 */
export class LocalContextAdapter {
  private drizzleDb: BetterSQLite3Database<typeof dbSchema>;
  private db: Database.Database;

  constructor(
    drizzleDb: BetterSQLite3Database<typeof dbSchema>,
    db: Database.Database
  ) {
    this.drizzleDb = drizzleDb;
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // traverse() — PPR-based graph traversal
  // -------------------------------------------------------------------------

  /**
   * Execute a PPR-based graph traversal for context assembly.
   *
   * Internally:
   *   1. Runs computePPR(drizzleDb, seedIds, options)
   *   2. Queries node metadata for all PPR results + always-include types
   *   3. Partitions into always-include (seeds + include types) and ranked
   *   4. Greedily assembles nodes within token budget
   *   5. Reads YAML content for each included node
   *
   * Returns a TraversalResult with ranked nodes including content.
   */
  async traverse(options: TraversalOptions): Promise<TraversalResult> {
    const {
      seed_ids: seedNodeIds,
      alpha,
      max_iterations: maxIterations,
      convergence_threshold: convergenceThreshold,
      edge_type_weights: edgeTypeWeights,
      token_budget: tokenBudget,
      always_include_types: alwaysIncludeTypes = [],
      max_nodes: maxNodes,
    } = options;

    // Validate seed_ids (WI-653)
    if (!Array.isArray(seedNodeIds)) {
      throw new ValidationError(
        "seed_ids must be an array",
        "INVALID_SEED_IDS",
        { value: seedNodeIds }
      );
    }
    if (seedNodeIds.length === 0) {
      throw new ValidationError(
        "seed_ids cannot be empty",
        "EMPTY_SEED_IDS",
        {}
      );
    }
    for (const id of seedNodeIds) {
      if (typeof id !== "string") {
        throw new ValidationError(
          `Each seed_id must be a string, received ${typeof id}`,
          "INVALID_SEED_ID",
          { value: id }
        );
      }
    }

    // Validate always_include_types BEFORE other validations (AC-3: WI-649)
    // This ensures type validation errors are reported before PPR computation
    if (!Array.isArray(alwaysIncludeTypes)) {
      throw new ValidationError(
        "always_include_types must be an array",
        "INVALID_ALWAYS_INCLUDE_TYPE",
        { value: alwaysIncludeTypes }
      );
    }
    const validNodeTypes = new Set<string>(ALL_NODE_TYPES);
    for (const type of alwaysIncludeTypes) {
      if (!validNodeTypes.has(type)) {
        throw new ValidationError(
          `Invalid NodeType in always_include_types: ${type}`,
          "INVALID_ALWAYS_INCLUDE_TYPE",
          { value: type }
        );
      }
    }

    // Validate PPR parameters before calling computePPR (WI-663)
    // token_budget: must be non-negative
    if (tokenBudget !== undefined && tokenBudget < 0) {
      throw new ValidationError(
        `token_budget must be non-negative (valid range: 0 to Infinity), received ${tokenBudget}`,
        "INVALID_TOKEN_BUDGET",
        { value: tokenBudget }
      );
    }

    // alpha: must be > 0 and <= 1
    if (alpha !== undefined && (alpha <= 0 || alpha > 1)) {
      throw new ValidationError(
        `alpha must be > 0 (valid range: (0, 1]), received ${alpha}`,
        "INVALID_ALPHA",
        { value: alpha }
      );
    }

    // max_iterations: must be a positive integer (> 0)
    if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0)) {
      throw new ValidationError(
        `max_iterations must be > 0 (valid range: 1 to Infinity), received ${maxIterations}`,
        "INVALID_MAX_ITERATIONS",
        { value: maxIterations }
      );
    }

    // convergence_threshold: must be positive number
    if (convergenceThreshold !== undefined && convergenceThreshold <= 0) {
      throw new ValidationError(
        `convergence_threshold must be a positive number (valid range: > 0), received ${convergenceThreshold}`,
        "INVALID_CONVERGENCE_THRESHOLD",
        { value: convergenceThreshold }
      );
    }

    // max_nodes: must be non-negative integer
    if (maxNodes !== undefined && (!Number.isInteger(maxNodes) || maxNodes < 0)) {
      throw new ValidationError(
        `max_nodes must be a non-negative integer (valid range: 0 to Infinity), received ${maxNodes}`,
        "INVALID_MAX_NODES",
        { value: maxNodes }
      );
    }

    // Run PPR algorithm (ppr.ts is an adapter-internal dependency)
    const pprResults = computePPR(this.drizzleDb, seedNodeIds, {
      alpha,
      maxIterations,
      convergenceThreshold,
      edgeTypeWeights,
      maxNodes,
    });

    // Build a map of nodeId → PPR score
    const scoreMap = new Map<string, number>();
    for (const r of pprResults) {
      scoreMap.set(r.nodeId, r.score);
    }

    // -----------------------------------------------------------------------
    // Query node metadata for all PPR results + always-include types
    // -----------------------------------------------------------------------

    // Get all node IDs from PPR + seed IDs (seeds may not appear in PPR if
    // graph is empty)
    const pprNodeIds = new Set<string>([
      ...pprResults.map((r) => r.nodeId),
      ...seedNodeIds,
    ]);

    const pprNodeRows: NodeRow[] = [];
    for (const id of pprNodeIds) {
      const row = this.db
        .prepare(
          `SELECT id, type, file_path, token_count, status FROM nodes WHERE id = ?`
        )
        .get(id) as NodeRow | undefined;
      if (row) {
        pprNodeRows.push(row);
      }
    }

    // -----------------------------------------------------------------------
    // Partition into always-include and ranked
    // -----------------------------------------------------------------------

    const includeTypeSet = new Set(alwaysIncludeTypes as string[]);
    const seenIds = new Set<string>();

    const alwaysInclude: NodeRow[] = [];
    const ranked: NodeRow[] = [];

    // First, fetch ALL nodes of always-include types from the DB
    // (they may not appear in PPR results if they have no edges to seeds)
    if (includeTypeSet.size > 0) {
      const typePlaceholders = Array.from(includeTypeSet)
        .map(() => "?")
        .join(", ");
      const alwaysTypeRows = this.db
        .prepare(
          `SELECT id, type, file_path, token_count, status FROM nodes WHERE type IN (${typePlaceholders})`
        )
        .all(...Array.from(includeTypeSet)) as NodeRow[];
      for (const row of alwaysTypeRows) {
        if (!seenIds.has(row.id)) {
          alwaysInclude.push(row);
          seenIds.add(row.id);
        }
      }
    }

    // Then process PPR nodes: seeds go to alwaysInclude, others go to ranked
    for (const row of pprNodeRows) {
      if (seenIds.has(row.id)) continue; // already in always-include
      if (seedNodeIds.includes(row.id)) {
        alwaysInclude.push(row);
        seenIds.add(row.id);
      } else {
        ranked.push(row);
        seenIds.add(row.id);
      }
    }

    // Sort ranked by PPR score descending
    ranked.sort(
      (a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0)
    );

    // -----------------------------------------------------------------------
    // Greedily assemble artifacts within token budget
    // -----------------------------------------------------------------------

    const contentCache = new Map<string, string>(); // file_path -> content
    let usedTokens = 0;

    const includedWithContent: Array<{
      row: NodeRow;
      content: string;
      tokenCount: number;
    }> = [];

    // Always-include first (seeds + include_types)
    for (const row of alwaysInclude) {
      const content = readFileContent(row.file_path);
      contentCache.set(row.file_path, content);
      const tokenCount = row.token_count ?? estimateTokens(content);
      usedTokens += tokenCount;
      includedWithContent.push({ row, content, tokenCount });
    }

    // Then add ranked artifacts by score until budget exhausted
    const effectiveTokenBudget = tokenBudget ?? 50000;
    for (const row of ranked) {
      if (usedTokens >= effectiveTokenBudget) break;
      const content = readFileContent(row.file_path);
      contentCache.set(row.file_path, content);
      const tokenCount = row.token_count ?? estimateTokens(content);
      if (usedTokens + tokenCount > effectiveTokenBudget) continue; // skip if would bust budget
      usedTokens += tokenCount;
      includedWithContent.push({ row, content, tokenCount });
    }

    // -----------------------------------------------------------------------
    // Build TraversalResult
    // -----------------------------------------------------------------------

    const rankedNodes = includedWithContent.map(({ row, content }) => ({
      node: nodeRowToNode(row, content),
      score: scoreMap.get(row.id) ?? 0,
      content,
    }));

    const top20PprScores = pprResults
      .slice(0, 20)
      .map((r) => ({ id: r.nodeId, score: r.score }));

    return {
      ranked_nodes: rankedNodes,
      total_tokens: usedTokens,
      ppr_scores: top20PprScores,
    };
  }

  // -------------------------------------------------------------------------
  // Context assembly: architecture document
  // -------------------------------------------------------------------------

  /**
   * Query the architecture document for the context package.
   * Returns the document row if found, null otherwise.
   */
  queryArchitectureDocument(): DocumentArtifactRow | null {
    const row = this.db
      .prepare(
        `SELECT da.id, da.title, da.cycle, da.content
         FROM document_artifacts da
         JOIN nodes n ON n.id = da.id
         WHERE n.type = 'architecture'
         ORDER BY n.id
         LIMIT 1`
      )
      .get() as DocumentArtifactRow | undefined;
    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // Context assembly: guiding principles
  // -------------------------------------------------------------------------

  /**
   * Query all guiding principles ordered by ID.
   */
  queryGuidingPrinciples(): GuidingPrincipleRow[] {
    return this.db
      .prepare(
        `SELECT gp.id, gp.name, gp.description
         FROM guiding_principles gp
         JOIN nodes n ON n.id = gp.id
         ORDER BY n.id`
      )
      .all() as GuidingPrincipleRow[];
  }

  // -------------------------------------------------------------------------
  // Context assembly: constraints
  // -------------------------------------------------------------------------

  /**
   * Query all constraints ordered by category, then ID.
   */
  queryConstraints(): ConstraintRow[] {
    return this.db
      .prepare(
        `SELECT c.id, c.category, c.description
         FROM constraints c
         JOIN nodes n ON n.id = c.id
         ORDER BY c.category, n.id`
      )
      .all() as ConstraintRow[];
  }

  // -------------------------------------------------------------------------
  // Context assembly: active project
  // -------------------------------------------------------------------------

  /**
   * Query the active project node.
   */
  queryActiveProject(): ProjectRow | null {
    const row = this.db
      .prepare(
        `SELECT p.id, p.intent, p.success_criteria, p.appetite, p.horizon, n.status
         FROM projects p
         JOIN nodes n ON n.id = p.id
         WHERE n.status = 'active'
         LIMIT 1`
      )
      .get() as ProjectRow | undefined;
    return row ?? null;
  }

  // -------------------------------------------------------------------------
  // Context assembly: active phase
  // -------------------------------------------------------------------------

  /**
   * Query the active phase node.
   */
  queryActivePhase(): PhaseRow | null {
    const row = this.db
      .prepare(
        `SELECT p.id, p.project, p.phase_type, p.intent, p.steering, p.work_items, n.status
         FROM phases p
         JOIN nodes n ON n.id = p.id
         WHERE n.status = 'active'
         LIMIT 1`
      )
      .get() as PhaseRow | undefined;
    return row ?? null;
  }
}

// ---------------------------------------------------------------------------
// Re-export row types for use by tool handlers
// ---------------------------------------------------------------------------

export type {
  DocumentArtifactRow,
  GuidingPrincipleRow,
  ConstraintRow,
  ProjectRow,
  PhaseRow,
};
