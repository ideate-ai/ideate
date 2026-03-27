import Database from "better-sqlite3";
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { notInArray, eq } from "drizzle-orm";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml } from "yaml";
import { EDGE_TYPE_REGISTRY } from "./schema.js";
import * as dbSchema from "./db.js";
import { TYPE_TO_EXTENSION_TABLE, nodes } from "./db.js";

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

/** Safely parse YAML; returns null on error */
function safeParseYaml(content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    return null;
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
function buildNodeRow(doc: Row, content: string, filePath: string, hash: string): Row {
  return {
    id: toStrOrNull(doc.id) ?? filePath, // fall back to file path if no id
    type: toStrOrNull(doc.type),
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

    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// UPSERT helpers
// ---------------------------------------------------------------------------

function upsertNode(drizzleDb: BetterSQLite3Database<typeof dbSchema>, nodeRow: Row): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drizzleDb.insert(nodes as any).values(nodeRow as any).onConflictDoUpdate({
    target: (nodes as any).id,
    set: nodeRow as any,
  }).run();
}

function upsertExtension(drizzleDb: BetterSQLite3Database<typeof dbSchema>, tableRef: dbSchema.AnyTable, id: string, extRow: Row): void {
  const rowWithId = { id, ...extRow };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drizzleDb.insert(tableRef as any).values(rowWithId as any).onConflictDoUpdate({
    target: (tableRef as any).id,
    set: extRow as any,
  }).run();
}

function upsertEdge(
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
  sourceId: string,
  targetId: string,
  edgeType: string
): void {
  drizzleDb.insert(dbSchema.edges).values({
    source_id: sourceId,
    target_id: targetId,
    edge_type: edgeType,
    props: null,
  }).onConflictDoNothing().run();
}

function upsertFileRef(
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
  nodeId: string,
  filePath: string
): void {
  drizzleDb.insert(dbSchema.nodeFileRefs).values({
    node_id: nodeId,
    file_path: filePath,
  }).onConflictDoNothing().run();
}

// ---------------------------------------------------------------------------
// Edge extraction
// ---------------------------------------------------------------------------

function extractEdges(
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
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
          upsertEdge(drizzleDb, nodeId, item.trim(), edgeType);
          edgesCreated++;
        }
      }
    } else if (typeof fieldValue === "string" && fieldValue.trim()) {
      // Single-value field (e.g. supersedes, work_item, module, domain)
      upsertEdge(drizzleDb, nodeId, fieldValue.trim(), edgeType);
      edgesCreated++;
    }
  }

  return edgesCreated;
}

// ---------------------------------------------------------------------------
// File ref extraction
// ---------------------------------------------------------------------------

function extractFileRefs(
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
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
        upsertFileRef(drizzleDb, nodeId, refPath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Delete stale rows
// ---------------------------------------------------------------------------

function deleteStaleRows(drizzleDb: BetterSQLite3Database<typeof dbSchema>, keepIds: string[]): number {
  const sentinel = keepIds.length > 0 ? keepIds : [''];

  // Single delete on nodes — CASCADE handles extension tables, edges, and node_file_refs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const staleRows = drizzleDb.select({ id: (nodes as any).id }).from(nodes as any).where(notInArray((nodes as any).id, sentinel)).all() as Array<{ id: string }>;

  if (staleRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    drizzleDb.delete(nodes as any).where(notInArray((nodes as any).id, sentinel)).run();
  }

  return staleRows.length;
}

// ---------------------------------------------------------------------------
// Cycle detection — Kahn's algorithm on depends_on edges
// ---------------------------------------------------------------------------

export const MAX_DEPENDENCY_NODES = 10_000;
export const MAX_DEPENDENCY_EDGES = 50_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function detectCycles(drizzleDb: BetterSQLite3Database<any>): string[][] {
  // SELECT all depends_on edges via Drizzle ORM
  const edges = drizzleDb
    .select({ source_id: dbSchema.edges.source_id, target_id: dbSchema.edges.target_id })
    .from(dbSchema.edges)
    .where(eq(dbSchema.edges.edge_type, 'depends_on'))
    .all() as Array<{ source_id: string; target_id: string }>;

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
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
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

  const parsed = safeParseYaml(content);
  if (!parsed || typeof parsed !== "object") {
    return { nodeId: null, updated: false, failed: true, error: `${filePath}: YAML parse error`, edgesCreated: 0 };
  }

  const doc = parsed as Row;
  const typeField = toStrOrNull(doc.type);
  if (!typeField) {
    return { nodeId: null, updated: false, failed: true, error: `${filePath}: missing type field`, edgesCreated: 0 };
  }

  const extensionTable = TYPE_TO_EXTENSION_TABLE[typeField];
  if (!extensionTable) {
    return { nodeId: null, updated: false, failed: true, error: `${filePath}: unknown type '${typeField}'`, edgesCreated: 0 };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tableName: string = (extensionTable as any)[Symbol.for("drizzle:Name")] ?? (extensionTable as any)._.name;

  const nodeRow = buildNodeRow(doc, content, filePath, hash);
  const nodeId = nodeRow.id as string;
  const extRow = buildExtensionRow(tableName, doc);

  upsertNode(drizzleDb, nodeRow);
  upsertExtension(drizzleDb, extensionTable, nodeId, extRow);

  // Delete old edges and file refs before re-inserting
  drizzleDb.delete(dbSchema.edges).where(eq(dbSchema.edges.source_id, nodeId)).run();
  drizzleDb.delete(dbSchema.nodeFileRefs).where(eq(dbSchema.nodeFileRefs.node_id, nodeId)).run();

  let edgesCreated = extractEdges(drizzleDb, doc, nodeId, typeField);
  extractFileRefs(drizzleDb, doc, nodeId, typeField);

  // Special handling for interview files with an entries array
  if (typeField === "interview" && Array.isArray(doc.entries)) {
    const interviewQuestionsTable = TYPE_TO_EXTENSION_TABLE["interview_question"];
    for (const entry of doc.entries) {
      if (!entry || typeof entry !== "object") continue;
      const entryDoc = entry as Row;
      const entryId = toStrOrNull(entryDoc.id);
      if (!entryId) continue;

      const entryNodeRow: Row = {
        id: entryId,
        type: "interview_question",
        cycle_created: toNumOrNull(doc.cycle_created),
        cycle_modified: null,
        content_hash: hash,
        token_count: null,
        file_path: filePath,
        status: null,
      };
      const entryExtRow: Row = {
        interview_id: nodeId,
        question: toStrOrNull(entryDoc.question) ?? "",
        answer: toStrOrNull(entryDoc.answer) ?? "",
        domain: toStrOrNull(entryDoc.domain),
        seq: toNumOrNull(entryDoc.seq) ?? 0,
      };

      upsertNode(drizzleDb, entryNodeRow);
      upsertExtension(drizzleDb, interviewQuestionsTable, entryId, entryExtRow);
      upsertEdge(drizzleDb, entryId, nodeId, "references");
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
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
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
  drizzleDb: BetterSQLite3Database<typeof dbSchema>,
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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          drizzleDb.delete(nodes as any).where(eq((nodes as any).id, row.id)).run();
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

export function rebuildIndex(db: Database.Database, drizzleDb: BetterSQLite3Database<typeof dbSchema>, ideateDir: string): RebuildStats {
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
