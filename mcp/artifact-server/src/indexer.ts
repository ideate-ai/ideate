import Database from "better-sqlite3";
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml } from "yaml";
import { EDGE_TYPE_REGISTRY } from "./schema.js";
import * as dbSchema from "./db.js";
import { TYPE_TO_EXTENSION_TABLE } from "./db.js";
import {
  type DrizzleDb,
  type NodeRow,
  type EdgeRow,
  type NodeFileRefRow,
  upsertNode,
  upsertExtensionRow,
  insertEdge,
  insertFileRef,
  deleteNodesNotIn,
  deleteNodeById,
  deleteEdgesBySourceId,
  deleteFileRefsByNodeId,
  selectAllEdges,
  getTableName,
} from "./db-helpers.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RebuildStats {
  files_scanned: number;
  files_updated: number;
  files_deleted: number;
  edges_created: number;
  cycles_detected: string[][];
  files_failed: number;
  parse_errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function tokenCount(content: string): number {
  // Rough approximation: characters / 4. No tokenizer dependency; expect ±50% accuracy.
  return Math.floor(content.length / 4);
}

/** Recursively collect all files under dir */
function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      console.error('[ideate] walkDir: failed to read directory', current, err);
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(full);
      }
    }
  }

  walk(dir);
  return results;
}


/** Result of parsing YAML content */
interface SafeParseYamlResult {
  parsed: unknown;
  errorMessage: string | null;
}

/** Extract caller function name from the call stack */
function getCallerContext(): string {
  const stack = new Error().stack;
  if (!stack) return "unknown";
  const lines = stack.split("\n");
  // Stack format varies by Node.js version; look for function names after this function
  // Typical format: "    at functionName (file:line:col)" or "    at Object.functionName (file:line:col)"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines until we find our own function name
    if (line.includes("getCallerContext")) continue;
    if (line.includes("safeParseYaml")) continue;
    // The next meaningful line should be the caller
    const match = line.match(/at\s+(?:(\w+)\.)?(\w+)\s*\(/);
    if (match && match[2]) {
      return match[2];
    }
    // Alternative format: "    at functionName (file)"
    const altMatch = line.match(/at\s+(\w+)\s*\(/);
    if (altMatch && altMatch[1]) {
      return altMatch[1];
    }
  }
  return "unknown";
}

/** Safely parse YAML; logs warning with timestamp, context, file path and error details on failure */
function safeParseYaml(content: string, filePath: string): SafeParseYamlResult {
  try {
    return { parsed: parseYaml(content), errorMessage: null };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const timestamp = new Date().toISOString();
    const caller = getCallerContext();
    console.warn(`[${timestamp}] [indexer:${caller}] YAML parse error in ${filePath}: ${errMsg}`);
    return { parsed: null, errorMessage: errMsg };
  }
}

/** Coerce a value to a JSON string, or null */
function toJsonOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return JSON.stringify(val);
}

/** Coerce a value to a string, or null */
function toStrOrNull(val: unknown): string | null {
  if (val === undefined || val === null) return null;
  return String(val);
}

/** Coerce a value to a number, or null */
function toNumOrNull(val: unknown): number | null {
  if (val === undefined || val === null) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Row builders — map parsed YAML document to table columns
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Build the nodes base-table row (8 common columns) */
function buildNodeRow(doc: Row, content: string, filePath: string, hash: string): NodeRow {
  return {
    id: toStrOrNull(doc.id) ?? filePath, // fall back to file path if no id
    type: toStrOrNull(doc.type) ?? "",
    cycle_created: toNumOrNull(doc.cycle_created),
    cycle_modified: toNumOrNull(doc.cycle_modified),
    content_hash: hash,
    token_count: tokenCount(content),
    file_path: filePath,
    status: toStrOrNull(doc.status),
  };
}

/** Build the extension-table row (type-specific columns only — no id, no common columns) */
function buildExtensionRow(table: string, doc: Row): Row {
  switch (table) {
    case "work_items":
      return {
        title: toStrOrNull(doc.title) ?? "",
        complexity: toStrOrNull(doc.complexity),
        scope: toJsonOrNull(doc.scope),
        depends: toJsonOrNull(doc.depends),
        blocks: toJsonOrNull(doc.blocks),
        criteria: toJsonOrNull(doc.criteria),
        module: toStrOrNull(doc.module),
        domain: toStrOrNull(doc.domain),
        phase: toStrOrNull(doc.phase),
        notes: toStrOrNull(doc.notes),
      };

    case "findings":
      return {
        severity: toStrOrNull(doc.severity) ?? "",
        work_item: toStrOrNull(doc.work_item) ?? "",
        file_refs: toJsonOrNull(doc.file_refs),
        verdict: toStrOrNull(doc.verdict) ?? "",
        cycle: toNumOrNull(doc.cycle) ?? 0,
        reviewer: toStrOrNull(doc.reviewer) ?? "",
        description: toStrOrNull(doc.description),
        suggestion: toStrOrNull(doc.suggestion),
        addressed_by: toStrOrNull(doc.addressed_by),
      };

    case "domain_policies":
      return {
        domain: toStrOrNull(doc.domain) ?? "",
        derived_from: toJsonOrNull(doc.derived_from),
        established: toStrOrNull(doc.established),
        amended: toStrOrNull(doc.amended),
        amended_by: toStrOrNull(doc.amended_by),
        description: toStrOrNull(doc.description),
      };

    case "domain_decisions":
      return {
        domain: toStrOrNull(doc.domain) ?? "",
        cycle: toNumOrNull(doc.cycle),
        supersedes: toStrOrNull(doc.supersedes),
        description: toStrOrNull(doc.description),
        rationale: toStrOrNull(doc.rationale),
      };

    case "domain_questions":
      return {
        domain: toStrOrNull(doc.domain) ?? "",
        impact: toStrOrNull(doc.impact),
        source: toStrOrNull(doc.source),
        resolution: toStrOrNull(doc.resolution),
        resolved_in: toNumOrNull(doc.resolved_in),
        description: toStrOrNull(doc.description),
        addressed_by: toStrOrNull(doc.addressed_by),
      };

    case "guiding_principles":
      return {
        name: toStrOrNull(doc.name) ?? "",
        description: toStrOrNull(doc.description),
        amendment_history: toJsonOrNull(doc.amendment_history),
      };

    case "constraints":
      return {
        category: toStrOrNull(doc.category) ?? "",
        description: toStrOrNull(doc.description),
      };

    case "module_specs":
      return {
        name: toStrOrNull(doc.name) ?? "",
        scope: toStrOrNull(doc.scope),
        provides: toJsonOrNull(doc.provides),
        requires: toJsonOrNull(doc.requires),
        boundary_rules: toJsonOrNull(doc.boundary_rules),
      };

    case "research_findings":
      return {
        topic: toStrOrNull(doc.topic) ?? "",
        date: toStrOrNull(doc.date),
        content: toStrOrNull(doc.content),
        sources: toJsonOrNull(doc.sources),
      };

    case "journal_entries":
      return {
        phase: toStrOrNull(doc.phase),
        date: toStrOrNull(doc.date),
        title: toStrOrNull(doc.title),
        work_item: toStrOrNull(doc.work_item),
        content: toStrOrNull(doc.content),
      };

    case "metrics_events":
      return {
        event_name: toStrOrNull(doc.event_name) ?? "",
        timestamp: toStrOrNull(doc.timestamp),
        payload: toJsonOrNull(doc.payload),
        // Token accounting
        input_tokens: toNumOrNull(doc.input_tokens),
        output_tokens: toNumOrNull(doc.output_tokens),
        cache_read_tokens: toNumOrNull(doc.cache_read_tokens),
        cache_write_tokens: toNumOrNull(doc.cache_write_tokens),
        // Output quality signals
        outcome: toStrOrNull(doc.outcome),
        finding_count: toNumOrNull(doc.finding_count),
        finding_severities: toStrOrNull(doc.finding_severities),
        first_pass_accepted: toNumOrNull(doc.first_pass_accepted),
        rework_count: toNumOrNull(doc.rework_count),
        // Cycle-level aggregates
        work_item_total_tokens: toNumOrNull(doc.work_item_total_tokens),
        cycle_total_tokens: toNumOrNull(doc.cycle_total_tokens),
        cycle_total_cost_estimate: toStrOrNull(doc.cycle_total_cost_estimate),
        convergence_cycles: toNumOrNull(doc.convergence_cycles),
        // Context composition
        context_artifact_ids: toStrOrNull(doc.context_artifact_ids),
      };

    case "document_artifacts":
      return {
        title:   toStrOrNull(doc.title),
        cycle:   toNumOrNull(doc.cycle),
        content: toStrOrNull(doc.content),
      };

    case "interview_questions":
      return {
        interview_id: toStrOrNull(doc.interview_id) ?? "",
        question: toStrOrNull(doc.question) ?? "",
        answer: toStrOrNull(doc.answer) ?? "",
        domain: toStrOrNull(doc.domain),
        seq: toNumOrNull(doc.seq) ?? 0,
      };

    case "proxy_human_decisions":
      return {
        cycle:        toNumOrNull(doc.cycle) ?? 0,
        trigger:      toStrOrNull(doc.trigger) ?? "",
        triggered_by: toJsonOrNull(doc.triggered_by),
        decision:     toStrOrNull(doc.decision) ?? "",
        rationale:    toStrOrNull(doc.rationale),
        timestamp:    toStrOrNull(doc.timestamp) ?? new Date().toISOString(),
        status:       toStrOrNull(doc.status) ?? "resolved",
      };

    case "projects":
      return {
        intent:           toStrOrNull(doc.intent) ?? "",
        scope_boundary:   toJsonOrNull(doc.scope_boundary),
        success_criteria: toJsonOrNull(doc.success_criteria),
        appetite:         toNumOrNull(doc.appetite),
        steering:         toStrOrNull(doc.steering),
        horizon:          toJsonOrNull(doc.horizon),
        status:           toStrOrNull(doc.status) ?? "",
      };

    case "phases":
      return {
        project:    toStrOrNull(doc.project) ?? "",
        phase_type: toStrOrNull(doc.phase_type) ?? "",
        intent:     toStrOrNull(doc.intent) ?? "",
        steering:   toStrOrNull(doc.steering),
        status:     toStrOrNull(doc.status) ?? "",
        work_items: toJsonOrNull(doc.work_items),
      };

    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------

function extractEdges(
  drizzleDb: DrizzleDb,
  doc: Row,
  nodeId: string,
  nodeType: string
): number {
  let edgesCreated = 0;

  // Drive extraction from the registry — only process edge types with a yaml_field
  // and where the source artifact type matches.
  for (const [edgeType, spec] of Object.entries(EDGE_TYPE_REGISTRY)) {
    if (spec.yaml_field === null) continue;
    if (!spec.source_types.includes(nodeType)) continue;

    const fieldValue = doc[spec.yaml_field];

    if (Array.isArray(fieldValue)) {
      // Multi-value field (e.g. depends, blocks, derived_from)
      for (const item of fieldValue) {
        if (typeof item === "string" && item.trim()) {
          insertEdge(drizzleDb, { source_id: nodeId, target_id: item.trim(), edge_type: edgeType, props: null });
          edgesCreated++;
        }
      }
    } else if (typeof fieldValue === "string" && fieldValue.trim()) {
      // Single-value field (e.g. supersedes, work_item, module, domain)
      insertEdge(drizzleDb, { source_id: nodeId, target_id: fieldValue.trim(), edge_type: edgeType, props: null });
      edgesCreated++;
    }
  }

  return edgesCreated;
}

// ---------------------------------------------------------------------------
// File ref extraction
// ---------------------------------------------------------------------------

function extractFileRefs(
  drizzleDb: DrizzleDb,
  doc: Row,
  nodeId: string,
  nodeType: string
): void {
  if (nodeType !== "work_item") return;

  const scope = doc.scope;
  if (!Array.isArray(scope)) return;

  for (const entry of scope) {
    if (entry && typeof entry === "object" && typeof (entry as Row).path === "string") {
      const refPath = ((entry as Row).path as string).trim();
      if (refPath) {
        insertFileRef(drizzleDb, { node_id: nodeId, file_path: refPath });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Delete stale rows
// ---------------------------------------------------------------------------

function deleteStaleRows(drizzleDb: DrizzleDb, keepIds: string[]): number {
  return deleteNodesNotIn(drizzleDb, keepIds);
}

// ---------------------------------------------------------------------------
// Cycle detection — Kahn's algorithm on depends_on edges
// ---------------------------------------------------------------------------

export const MAX_DEPENDENCY_NODES = 10_000;
export const MAX_DEPENDENCY_EDGES = 50_000;

export function detectCycles(drizzleDb: DrizzleDb): string[][] {
  // SELECT all depends_on edges via Drizzle ORM
  const edges = selectAllEdges(drizzleDb).filter(e => e.edge_type === 'depends_on');

  if (edges.length > MAX_DEPENDENCY_EDGES) {
    throw new Error(`detectCycles: edge count ${edges.length} exceeds limit ${MAX_DEPENDENCY_EDGES}`);
  }

  if (edges.length === 0) return [];

  // Collect all nodes (exit early if limit exceeded)
  const allNodes = new Set<string>();
  for (const e of edges) {
    allNodes.add(e.source_id);
    allNodes.add(e.target_id);
    if (allNodes.size > MAX_DEPENDENCY_NODES) {
      throw new Error(`detectCycles: node count ${allNodes.size} exceeds limit ${MAX_DEPENDENCY_NODES}`);
    }
  }

  // Build adjacency list (source → targets) and in-degree map
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of allNodes) {
    adj.set(node, []);
    inDegree.set(node, 0);
  }

  for (const e of edges) {
    adj.get(e.source_id)!.push(e.target_id);
    inDegree.set(e.target_id, (inDegree.get(e.target_id) ?? 0) + 1);
  }

  // Kahn's: initialize queue with zero-in-degree nodes
  const queue: string[] = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }

  const visited = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    visited.add(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Nodes with remaining non-zero in-degree are in cycles
  const cycleNodes = [...allNodes].filter((n) => !visited.has(n));

  if (cycleNodes.length === 0) return [];

  // Group cycle nodes into connected components using the edge graph
  const cycleSet = new Set(cycleNodes);
  const components: string[][] = [];
  const seen = new Set<string>();

  for (const start of cycleNodes) {
    if (seen.has(start)) continue;
    // BFS within cycle nodes
    const component: string[] = [];
    const bfsQueue = [start];
    let bfsHead = 0;
    while (bfsHead < bfsQueue.length) {
      const node = bfsQueue[bfsHead++];
      if (seen.has(node)) continue;
      seen.add(node);
      component.push(node);
      for (const neighbor of adj.get(node) ?? []) {
        if (cycleSet.has(neighbor) && !seen.has(neighbor)) {
          bfsQueue.push(neighbor);
        }
      }
    }
    if (component.length > 0) {
      components.push(component);
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Single-file index helper (shared by rebuildIndex and indexFiles)
// ---------------------------------------------------------------------------

interface IndexSingleFileResult {
  nodeId: string | null;
  updated: boolean;
  failed: boolean;
  error: string | null;
  edgesCreated: number;
}

function indexSingleFile(
  db: Database.Database,
  drizzleDb: DrizzleDb,
  filePath: string,
  hashCheckStmt: Database.Statement
): IndexSingleFileResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { nodeId: null, updated: false, failed: false, error: null, edgesCreated: 0 };
  }

  const hash = sha256(content);

  const existingRow = hashCheckStmt.get(filePath) as { id: string; content_hash: string } | undefined;
  const storedHash = existingRow?.content_hash ?? null;
  const storedId = existingRow?.id ?? null;

  // Skip if unchanged
  if (storedHash === hash) {
    return { nodeId: storedId, updated: false, failed: false, error: null, edgesCreated: 0 };
  }


  const parseResult = safeParseYaml(content, filePath);
  if (!parseResult.parsed || typeof parseResult.parsed !== "object") {
    const errorMsg = parseResult.errorMessage ?? "unknown parse error";
    return { nodeId: null, updated: false, failed: true, error: `${filePath}: YAML parse error - ${errorMsg}`, edgesCreated: 0 };
  }

  const doc = parseResult.parsed as Row;
  const typeField = toStrOrNull(doc.type);
  if (!typeField) {
    return { nodeId: null, updated: false, failed: true, error: `${filePath}: missing type field`, edgesCreated: 0 };
  }

  const extensionTable = TYPE_TO_EXTENSION_TABLE[typeField];
  if (!extensionTable) {
    return { nodeId: null, updated: false, failed: true, error: `${filePath}: unknown type '${typeField}'`, edgesCreated: 0 };
  }

  const tableName = getTableName(extensionTable);

  const nodeRow = buildNodeRow(doc, content, filePath, hash);
  const nodeId = nodeRow.id as string;
  const extRow = buildExtensionRow(tableName, doc);

  upsertNode(drizzleDb, nodeRow);
  upsertExtensionRow(drizzleDb, tableName, nodeId, extRow);

  // Delete old edges and file refs before re-inserting
  deleteEdgesBySourceId(drizzleDb, nodeId);
  deleteFileRefsByNodeId(drizzleDb, nodeId);

  let edgesCreated = extractEdges(drizzleDb, doc, nodeId, typeField);
  extractFileRefs(drizzleDb, doc, nodeId, typeField);

  // Special handling for interview files with an entries array
  if (typeField === "interview" && Array.isArray(doc.entries)) {
    for (const entry of doc.entries) {
      if (!entry || typeof entry !== "object") continue;
      const entryDoc = entry as Row;
      const entryId = toStrOrNull(entryDoc.id);
      if (!entryId) continue;

      const entryNodeRow: NodeRow = {
        id: entryId,
        type: "interview_question",
        cycle_created: toNumOrNull(doc.cycle_created),
        cycle_modified: null,
        content_hash: hash,
        token_count: null,
        file_path: filePath,
        status: null,
      };
      const entryExtRow: Record<string, unknown> = {
        interview_id: nodeId,
        question: toStrOrNull(entryDoc.question) ?? "",
        answer: toStrOrNull(entryDoc.answer) ?? "",
        domain: toStrOrNull(entryDoc.domain),
        seq: toNumOrNull(entryDoc.seq) ?? 0,
      };

      upsertNode(drizzleDb, entryNodeRow);
      upsertExtensionRow(drizzleDb, "interview_questions", entryId, entryExtRow);
      insertEdge(drizzleDb, { source_id: entryId, target_id: nodeId, edge_type: "references", props: null });
      edgesCreated++;
    }
  }

  return { nodeId, updated: true, failed: false, error: null, edgesCreated };
}

// ---------------------------------------------------------------------------
// Incremental index functions (used by watcher)
// ---------------------------------------------------------------------------

export interface IndexFilesResult {
  updated: number;
  failed: number;
  errors: string[];
}

/**
 * Incrementally index specific files. Used by the watcher for add/change events.
 * Only processes the given file paths, not the entire directory.
 */
export function indexFiles(
  db: Database.Database,
  drizzleDb: DrizzleDb,
  filePaths: string[]
): IndexFilesResult {
  const result: IndexFilesResult = { updated: 0, failed: 0, errors: [] };
  const yamlPaths = filePaths.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  if (yamlPaths.length === 0) return result;

  const hashCheckStmt = db.prepare(`SELECT id, content_hash FROM nodes WHERE file_path = ?`);

  const fkWasOn = db.pragma('foreign_keys', { simple: true }) as number;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  try {
    const upsertPhase = db.transaction(() => {
      for (const filePath of yamlPaths) {
        const r = indexSingleFile(db, drizzleDb, filePath, hashCheckStmt);
        if (r.failed) {
          result.failed++;
          if (r.error) result.errors.push(r.error);
        } else if (r.updated) {
          result.updated++;
        }
      }
    });
    upsertPhase();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }

  return result;
}

/**
 * Remove files from the index. Used by the watcher for unlink events.
 * Deletes nodes by file_path; CASCADE handles extension tables, edges, and file refs.
 */
export function removeFiles(
  db: Database.Database,
  drizzleDb: DrizzleDb,
  filePaths: string[]
): { removed: number } {
  if (filePaths.length === 0) return { removed: 0 };

  let removed = 0;
  // FK must be ON for CASCADE to work
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) as number;
  if (!fkWasOn) db.pragma('foreign_keys = ON');

  try {
    const deletePhase = db.transaction(() => {
      for (const filePath of filePaths) {
        // Find node ID(s) for this file path
        const rows = db.prepare(`SELECT id FROM nodes WHERE file_path = ?`).all(filePath) as Array<{ id: string }>;
        for (const row of rows) {
          deleteNodeById(drizzleDb, row.id);
          removed++;
        }
      }
    });
    deletePhase();
  } finally {
    if (!fkWasOn) db.pragma('foreign_keys = OFF');
  }

  return { removed };
}

// ---------------------------------------------------------------------------
// Main rebuild function
// ---------------------------------------------------------------------------

export function rebuildIndex(db: Database.Database, drizzleDb: DrizzleDb, ideateDir: string): RebuildStats {
  const stats: RebuildStats = {
    files_scanned: 0,
    files_updated: 0,
    files_deleted: 0,
    edges_created: 0,
    cycles_detected: [],
    files_failed: 0,
    parse_errors: [],
  };

  // Collect all YAML files under .ideate/ subdirectories
  const yamlFiles = walkDir(ideateDir).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml")
  );

  stats.files_scanned = yamlFiles.length;

  // Collect IDs of all rows that should be kept (their source file still exists)
  const keepIds: string[] = [];

  // Single hash-check statement on nodes table
  const hashCheckStmt = db.prepare(`SELECT id, content_hash FROM nodes WHERE file_path = ?`);

  // Phase 1: upsert all nodes, extension tables, edges, and file refs.
  // FK enforcement is turned OFF for this phase so that edges may reference
  // logical identifiers (domain names, module IDs) that are not themselves
  // indexed artifacts. Turning FK off must happen outside the transaction
  // because SQLite does not allow changing the foreign_keys pragma inside one.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) as number;
  if (fkWasOn) db.pragma('foreign_keys = OFF');

  const upsertPhase = db.transaction(() => {
    for (const filePath of yamlFiles) {
      const r = indexSingleFile(db, drizzleDb, filePath, hashCheckStmt);
      if (r.nodeId !== null) {
        keepIds.push(r.nodeId);
        // For interview entries, also collect their IDs
        // (indexSingleFile handles entry upsert but we need their IDs for keepIds)
        // Re-query for any interview_question nodes with this file_path
        const entryRows = db.prepare(`SELECT id FROM nodes WHERE file_path = ? AND type = 'interview_question'`).all(filePath) as Array<{ id: string }>;
        for (const er of entryRows) {
          keepIds.push(er.id);
        }
      }
      if (r.failed) {
        stats.files_failed++;
        if (r.error) stats.parse_errors.push(r.error);
      } else if (r.updated) {
        stats.files_updated++;
        stats.edges_created += r.edgesCreated;
      }
    }
  });

  try {
    upsertPhase();
  } finally {
    // Re-enable FK so that stale deletion CASCADE fires correctly.
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }

  // Phase 2: delete stale rows with FK ON so that ON DELETE CASCADE removes
  // extension table rows, edges, and node_file_refs automatically.
  const deletePhase = db.transaction(() => {
    stats.files_deleted = deleteStaleRows(drizzleDb, keepIds);
  });

  deletePhase();

  if (stats.files_failed > 0) {
    console.warn(`[indexer] ${stats.files_failed} file(s) failed to parse`);
  }

  // Note: cycle detection runs after the transaction commits. A concurrent write during detection could produce a false positive. This window is accepted as low-risk for single-writer workloads.
  // Detect cycles (outside transaction — read-only)
  const cycles = detectCycles(drizzleDb);
  stats.cycles_detected = cycles;

  if (cycles.length > 0) {
    for (const cycle of cycles) {
      console.warn(`[indexer] Cycle detected among nodes: ${cycle.join(" -> ")}`);
    }
  }

  return stats;
}
