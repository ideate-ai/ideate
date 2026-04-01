/**
 * db-helpers.ts — Typed helper functions for Drizzle ORM operations
 *
 * This module provides type-safe wrappers for common Drizzle ORM operations,
 * eliminating the need for `as any` casts throughout the codebase.
 */

import * as crypto from "crypto";
import { stringify as stringifyYaml } from "yaml";
import Database from "better-sqlite3";
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, notInArray, getTableName as drizzleGetTableName } from "drizzle-orm";
import * as dbSchema from "./db.js";

// ---------------------------------------------------------------------------
// Shared artifact hash computation
// ---------------------------------------------------------------------------

/**
 * Compute a stable content hash for a YAML artifact object.
 *
 * Excludes metadata fields that are computed at write/index time:
 *   - content_hash  (would be self-referential)
 *   - token_count   (derived from serialized length)
 *   - file_path     (storage detail, not content)
 *
 * This matches the exclusion pattern used by write handlers (write.ts ~line 780)
 * so that a file written by a write handler and later re-indexed by rebuildIndex
 * produces the same content_hash value.
 */
export function computeArtifactHash(yamlObj: Record<string, unknown>): string {
  const forHash: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(yamlObj)) {
    if (k !== "content_hash" && k !== "token_count" && k !== "file_path") {
      forHash[k] = v;
    }
  }
  const serialized = stringifyYaml(forHash, { lineWidth: 0 });
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

// Re-export all table references for convenience
export {
  nodes,
  workItems,
  findings,
  domainPolicies,
  domainDecisions,
  domainQuestions,
  guidingPrinciples,
  constraints,
  moduleSpecs,
  researchFindings,
  journalEntries,
  metricsEvents,
  documentArtifacts,
  interviewQuestions,
  proxyHumanDecisions,
  projects,
  phases,
  edges,
  nodeFileRefs,
} from "./db.js";

// ---------------------------------------------------------------------------
// Type definitions for Drizzle database
// ---------------------------------------------------------------------------

/** The properly-typed Drizzle database type */
export type DrizzleDb = BetterSQLite3Database<typeof dbSchema>;

// ---------------------------------------------------------------------------
// Node row types (matching Drizzle table schema)
// ---------------------------------------------------------------------------

/** Row type for nodes table insert/upsert */
export interface NodeRow {
  id: string;
  type: string;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
  file_path: string;
  status: string | null;
}

// ---------------------------------------------------------------------------
// Extension table row types
// ---------------------------------------------------------------------------

/** Row type for work_items table */
export interface WorkItemRow {
  id: string;
  title: string;
  complexity: string | null;
  scope: string | null;
  depends: string | null;
  blocks: string | null;
  criteria: string | null;
  module: string | null;
  domain: string | null;
  phase: string | null;
  notes: string | null;
  work_item_type: string | null;
}

/** Row type for findings table */
export interface FindingRow {
  id: string;
  severity: string;
  work_item: string;
  file_refs: string | null;
  verdict: string;
  cycle: number;
  reviewer: string;
  description: string | null;
  suggestion: string | null;
  addressed_by: string | null;
}

/** Row type for domain_policies table */
export interface DomainPolicyRow {
  id: string;
  domain: string;
  derived_from: string | null;
  established: string | null;
  amended: string | null;
  amended_by: string | null;
  description: string | null;
}

/** Row type for domain_decisions table */
export interface DomainDecisionRow {
  id: string;
  domain: string;
  cycle: number | null;
  supersedes: string | null;
  description: string | null;
  rationale: string | null;
}

/** Row type for domain_questions table */
export interface DomainQuestionRow {
  id: string;
  domain: string;
  impact: string | null;
  source: string | null;
  resolution: string | null;
  resolved_in: number | null;
  description: string | null;
  addressed_by: string | null;
}

/** Row type for guiding_principles table */
export interface GuidingPrincipleRow {
  id: string;
  name: string;
  description: string | null;
  amendment_history: string | null;
}

/** Row type for constraints table */
export interface ConstraintRow {
  id: string;
  category: string;
  description: string | null;
}

/** Row type for module_specs table */
export interface ModuleSpecRow {
  id: string;
  name: string;
  scope: string | null;
  provides: string | null;
  requires: string | null;
  boundary_rules: string | null;
}

/** Row type for research_findings table */
export interface ResearchFindingRow {
  id: string;
  topic: string;
  date: string | null;
  content: string | null;
  sources: string | null;
}

/** Row type for journal_entries table */
export interface JournalEntryRow {
  id: string;
  phase: string | null;
  date: string | null;
  title: string | null;
  work_item: string | null;
  content: string | null;
}

/** Row type for metrics_events table */
export interface MetricsEventRow {
  id: string;
  event_name: string;
  timestamp: string | null;
  payload: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  outcome: string | null;
  finding_count: number | null;
  finding_severities: string | null;
  first_pass_accepted: number | null;
  rework_count: number | null;
  work_item_total_tokens: number | null;
  cycle_total_tokens: number | null;
  cycle_total_cost_estimate: string | null;
  convergence_cycles: number | null;
  context_artifact_ids: string | null;
}

/** Row type for document_artifacts table */
export interface DocumentArtifactRow {
  id: string;
  title: string | null;
  cycle: number | null;
  content: string | null;
}

/** Row type for interview_questions table */
export interface InterviewQuestionRow {
  id: string;
  interview_id: string;
  question: string;
  answer: string;
  domain: string | null;
  seq: number;
}

/** Row type for proxy_human_decisions table */
export interface ProxyHumanDecisionRow {
  id: string;
  cycle: number;
  trigger: string;
  triggered_by: string | null;
  decision: string;
  rationale: string | null;
  timestamp: string;
  status: string;
}

/** Row type for projects table */
export interface ProjectRow {
  id: string;
  name: string | null;
  description: string | null;
  intent: string;
  scope_boundary: string | null;
  success_criteria: string | null;
  appetite: number | null;
  steering: string | null;
  horizon: string | null;
  status: string;
}

/** Row type for phases table */
export interface PhaseRow {
  id: string;
  name: string | null;
  description: string | null;
  project: string;
  phase_type: string;
  intent: string;
  steering: string | null;
  status: string;
  work_items: string | null;
}

/** Row type for edges table */
export interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  props: string | null;
}

/** Row type for node_file_refs table */
export interface NodeFileRefRow {
  node_id: string;
  file_path: string;
}

// ---------------------------------------------------------------------------
// Typed upsert helper for nodes table
// ---------------------------------------------------------------------------

/**
 * Upsert a row into the nodes table.
 * Uses onConflictDoUpdate for upsert semantics.
 */
export function upsertNode(db: DrizzleDb, row: NodeRow): void {
  db.insert(dbSchema.nodes)
    .values({
      id: row.id,
      type: row.type,
      cycle_created: row.cycle_created,
      cycle_modified: row.cycle_modified,
      content_hash: row.content_hash,
      token_count: row.token_count,
      file_path: row.file_path,
      status: row.status,
    })
    .onConflictDoUpdate({
      target: dbSchema.nodes.id,
      set: {
        type: row.type,
        cycle_created: row.cycle_created,
        cycle_modified: row.cycle_modified,
        content_hash: row.content_hash,
        token_count: row.token_count,
        file_path: row.file_path,
        status: row.status,
      },
    })
    .run();
}

// ---------------------------------------------------------------------------
// Generic upsert for extension tables
// ---------------------------------------------------------------------------

/**
 * Generic upsert for any extension table. Takes a Drizzle table reference and
 * a row object. Inserts all fields from the row, and on conflict updates all
 * fields except `id`.
 *
 * This replaces 16 individual per-table upsert functions that all followed the
 * identical pattern: insert(table).values(row).onConflictDoUpdate({target: table.id, set: row minus id}).
 *
 * The `as any` casts are safe here because:
 * 1. The table reference determines which SQLite table is written to
 * 2. The row object's fields are validated by the caller (assertRequiredFields or typed interfaces)
 * 3. SQLite will reject columns that don't exist on the target table
 */
function genericUpsert(db: DrizzleDb, table: any, row: Record<string, unknown>): void {
  const { id, ...rest } = row;
  db.insert(table)
    .values(row as any)
    .onConflictDoUpdate({
      target: table.id,
      set: rest as any,
    })
    .run();
}

/** Upsert a work item row. Delegates to genericUpsert. */
export function upsertWorkItem(db: DrizzleDb, row: WorkItemRow): void {
  genericUpsert(db, dbSchema.workItems, row as unknown as Record<string, unknown>);
}

/** Upsert a finding row. */
export function upsertFinding(db: DrizzleDb, row: FindingRow): void {
  genericUpsert(db, dbSchema.findings, row as unknown as Record<string, unknown>);
}

/** Upsert a domain policy row. */
export function upsertDomainPolicy(db: DrizzleDb, row: DomainPolicyRow): void {
  genericUpsert(db, dbSchema.domainPolicies, row as unknown as Record<string, unknown>);
}

/** Upsert a domain decision row. */
export function upsertDomainDecision(db: DrizzleDb, row: DomainDecisionRow): void {
  genericUpsert(db, dbSchema.domainDecisions, row as unknown as Record<string, unknown>);
}

/** Upsert a domain question row. */
export function upsertDomainQuestion(db: DrizzleDb, row: DomainQuestionRow): void {
  genericUpsert(db, dbSchema.domainQuestions, row as unknown as Record<string, unknown>);
}

/** Upsert a guiding principle row. */
export function upsertGuidingPrinciple(db: DrizzleDb, row: GuidingPrincipleRow): void {
  genericUpsert(db, dbSchema.guidingPrinciples, row as unknown as Record<string, unknown>);
}

/** Upsert a constraint row. */
export function upsertConstraint(db: DrizzleDb, row: ConstraintRow): void {
  genericUpsert(db, dbSchema.constraints, row as unknown as Record<string, unknown>);
}

/** Upsert a module spec row. */
export function upsertModuleSpec(db: DrizzleDb, row: ModuleSpecRow): void {
  genericUpsert(db, dbSchema.moduleSpecs, row as unknown as Record<string, unknown>);
}

/** Upsert a research finding row. */
export function upsertResearchFinding(db: DrizzleDb, row: ResearchFindingRow): void {
  genericUpsert(db, dbSchema.researchFindings, row as unknown as Record<string, unknown>);
}

/** Upsert a journal entry row. */
export function upsertJournalEntry(db: DrizzleDb, row: JournalEntryRow): void {
  genericUpsert(db, dbSchema.journalEntries, row as unknown as Record<string, unknown>);
}

/** Upsert a metrics event row. */
export function upsertMetricsEvent(db: DrizzleDb, row: MetricsEventRow): void {
  genericUpsert(db, dbSchema.metricsEvents, row as unknown as Record<string, unknown>);
}

/** Upsert a document artifact row. */
export function upsertDocumentArtifact(db: DrizzleDb, row: DocumentArtifactRow): void {
  genericUpsert(db, dbSchema.documentArtifacts, row as unknown as Record<string, unknown>);
}

/** Upsert an interview question row. */
export function upsertInterviewQuestion(db: DrizzleDb, row: InterviewQuestionRow): void {
  genericUpsert(db, dbSchema.interviewQuestions, row as unknown as Record<string, unknown>);
}

/** Upsert a proxy human decision row. */
export function upsertProxyHumanDecision(db: DrizzleDb, row: ProxyHumanDecisionRow): void {
  genericUpsert(db, dbSchema.proxyHumanDecisions, row as unknown as Record<string, unknown>);
}

/** Upsert a project row. */
export function upsertProject(db: DrizzleDb, row: ProjectRow): void {
  genericUpsert(db, dbSchema.projects, row as unknown as Record<string, unknown>);
}

/** Upsert a phase row. */
export function upsertPhase(db: DrizzleDb, row: PhaseRow): void {
  genericUpsert(db, dbSchema.phases, row as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Typed insert helpers for edges and file refs (no conflict handling)
// ---------------------------------------------------------------------------

/**
 * Insert an edge with onConflictDoNothing semantics.
 */
export function insertEdge(db: DrizzleDb, row: EdgeRow): void {
  db.insert(dbSchema.edges)
    .values({
      source_id: row.source_id,
      target_id: row.target_id,
      edge_type: row.edge_type,
      props: row.props,
    })
    .onConflictDoNothing()
    .run();
}

/**
 * Insert a file reference with onConflictDoNothing semantics.
 */
export function insertFileRef(db: DrizzleDb, row: NodeFileRefRow): void {
  db.insert(dbSchema.nodeFileRefs)
    .values({
      node_id: row.node_id,
      file_path: row.file_path,
    })
    .onConflictDoNothing()
    .run();
}

// ---------------------------------------------------------------------------
// Typed delete helpers
// ---------------------------------------------------------------------------

/**
 * Delete nodes by ID (not in the provided list).
 * Returns the count of deleted rows.
 */
export function deleteNodesNotIn(db: DrizzleDb, keepIds: string[]): number {
  if (keepIds.length === 0) {
    // If no IDs to keep, delete all nodes
    const result = db.delete(dbSchema.nodes).run();
    return result.changes;
  }
  const result = db.delete(dbSchema.nodes)
    .where(notInArray(dbSchema.nodes.id, keepIds))
    .run();
  return result.changes;
}

/**
 * Delete nodes by a single ID.
 */
export function deleteNodeById(db: DrizzleDb, id: string): void {
  db.delete(dbSchema.nodes).where(eq(dbSchema.nodes.id, id)).run();
}

/**
 * Delete edges by source node ID.
 */
export function deleteEdgesBySourceId(db: DrizzleDb, sourceId: string): void {
  db.delete(dbSchema.edges).where(eq(dbSchema.edges.source_id, sourceId)).run();
}

/**
 * Delete file refs by node ID.
 */
export function deleteFileRefsByNodeId(db: DrizzleDb, nodeId: string): void {
  db.delete(dbSchema.nodeFileRefs).where(eq(dbSchema.nodeFileRefs.node_id, nodeId)).run();
}

// ---------------------------------------------------------------------------
// Typed select helpers
// ---------------------------------------------------------------------------

/**
 * Select node IDs not in the provided list.
 */
export function selectNodeIdsNotIn(db: DrizzleDb, keepIds: string[]): string[] {
  if (keepIds.length === 0) {
    return db.select({ id: dbSchema.nodes.id }).from(dbSchema.nodes).all().map(r => r.id);
  }
  return db.select({ id: dbSchema.nodes.id })
    .from(dbSchema.nodes)
    .where(notInArray(dbSchema.nodes.id, keepIds))
    .all()
    .map(r => r.id);
}

/**
 * Select all edges from the database.
 */
export function selectAllEdges(db: DrizzleDb): Array<{ source_id: string; target_id: string; edge_type: string }> {
  return db.select({
    source_id: dbSchema.edges.source_id,
    target_id: dbSchema.edges.target_id,
    edge_type: dbSchema.edges.edge_type,
  }).from(dbSchema.edges).all();
}

// ---------------------------------------------------------------------------
// Table name resolution helper
// ---------------------------------------------------------------------------

/**
 * Get the Drizzle table name from a table reference.
 * Delegates to Drizzle's public getTableName API.
 */
export function getTableName(table: dbSchema.AnyTable): string {
  return drizzleGetTableName(table);
}

// ---------------------------------------------------------------------------
// Generic extension table upsert (for dynamic table dispatch)
// ---------------------------------------------------------------------------

/**
 * Runtime guard: throws if any required field is undefined in the row.
 * This is the boundary between the untyped YAML world and the typed ORM layer.
 * The cast to a typed row interface is safe only if buildExtensionRow produced
 * the correct fields — this check enforces that contract at runtime.
 */
function assertRequiredFields(tableName: string, row: Record<string, unknown>, ...fields: string[]): void {
  for (const field of fields) {
    if (row[field] === undefined || row[field] === null) {
      const reason = row[field] === undefined ? 'missing' : 'null';
      throw new Error(`upsertExtensionRow(${tableName}): required field '${field}' is ${reason}`);
    }
  }
}

/**
 * Upsert a row into an extension table based on the table name.
 * This is a generic dispatcher for cases where the table is determined at runtime.
 *
 * Note: The row must be properly typed for the target table.
 * Use the specific typed upsert functions when possible for better type safety.
 */
export function upsertExtensionRow(
  db: DrizzleDb,
  tableName: string,
  id: string,
  row: Record<string, unknown>
): void {
  switch (tableName) {
    case "work_items":
      assertRequiredFields(tableName, row, "title");
      upsertWorkItem(db, { id, ...row } as WorkItemRow);
      break;
    case "findings":
      assertRequiredFields(tableName, row, "severity", "work_item", "verdict", "cycle", "reviewer");
      upsertFinding(db, { id, ...row } as FindingRow);
      break;
    case "domain_policies":
      assertRequiredFields(tableName, row, "domain");
      upsertDomainPolicy(db, { id, ...row } as DomainPolicyRow);
      break;
    case "domain_decisions":
      assertRequiredFields(tableName, row, "domain");
      upsertDomainDecision(db, { id, ...row } as DomainDecisionRow);
      break;
    case "domain_questions":
      assertRequiredFields(tableName, row, "domain");
      upsertDomainQuestion(db, { id, ...row } as DomainQuestionRow);
      break;
    case "guiding_principles":
      assertRequiredFields(tableName, row, "name");
      upsertGuidingPrinciple(db, { id, ...row } as GuidingPrincipleRow);
      break;
    case "constraints":
      assertRequiredFields(tableName, row, "category");
      upsertConstraint(db, { id, ...row } as ConstraintRow);
      break;
    case "module_specs":
      assertRequiredFields(tableName, row, "name");
      upsertModuleSpec(db, { id, ...row } as ModuleSpecRow);
      break;
    case "research_findings":
      assertRequiredFields(tableName, row, "topic");
      upsertResearchFinding(db, { id, ...row } as ResearchFindingRow);
      break;
    case "journal_entries":
      upsertJournalEntry(db, { id, ...row } as JournalEntryRow);
      break;
    case "metrics_events":
      assertRequiredFields(tableName, row, "event_name");
      upsertMetricsEvent(db, { id, ...row } as MetricsEventRow);
      break;
    case "document_artifacts":
      upsertDocumentArtifact(db, { id, ...row } as DocumentArtifactRow);
      break;
    case "interview_questions":
      assertRequiredFields(tableName, row, "interview_id", "question", "answer", "seq");
      upsertInterviewQuestion(db, { id, ...row } as InterviewQuestionRow);
      break;
    case "proxy_human_decisions":
      assertRequiredFields(tableName, row, "cycle", "trigger", "decision", "timestamp", "status");
      upsertProxyHumanDecision(db, { id, ...row } as ProxyHumanDecisionRow);
      break;
    case "projects":
      assertRequiredFields(tableName, row, "intent", "status");
      upsertProject(db, { id, ...row } as ProjectRow);
      break;
    case "phases":
      assertRequiredFields(tableName, row, "project", "phase_type", "intent", "status");
      upsertPhase(db, { id, ...row } as PhaseRow);
      break;
    default:
      throw new Error(`Unknown extension table: ${tableName}`);
  }
}