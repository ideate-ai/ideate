/**
 * db-helpers.ts — Typed helper functions for Drizzle ORM operations
 *
 * This module provides type-safe wrappers for common Drizzle ORM operations,
 * eliminating the need for `as any` casts throughout the codebase.
 */

import Database from "better-sqlite3";
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, notInArray, getTableName as drizzleGetTableName } from "drizzle-orm";
import * as dbSchema from "./db.js";

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
// Typed upsert helpers for extension tables
// ---------------------------------------------------------------------------

/**
 * Upsert a row into the work_items table.
 */
export function upsertWorkItem(db: DrizzleDb, row: WorkItemRow): void {
  db.insert(dbSchema.workItems)
    .values({
      id: row.id,
      title: row.title,
      complexity: row.complexity,
      scope: row.scope,
      depends: row.depends,
      blocks: row.blocks,
      criteria: row.criteria,
      module: row.module,
      domain: row.domain,
      phase: row.phase,
      notes: row.notes,
    })
    .onConflictDoUpdate({
      target: dbSchema.workItems.id,
      set: {
        title: row.title,
        complexity: row.complexity,
        scope: row.scope,
        depends: row.depends,
        blocks: row.blocks,
        criteria: row.criteria,
        module: row.module,
        domain: row.domain,
        phase: row.phase,
        notes: row.notes,
      },
    })
    .run();
}

/**
 * Upsert a row into the findings table.
 */
export function upsertFinding(db: DrizzleDb, row: FindingRow): void {
  db.insert(dbSchema.findings)
    .values({
      id: row.id,
      severity: row.severity,
      work_item: row.work_item,
      file_refs: row.file_refs,
      verdict: row.verdict,
      cycle: row.cycle,
      reviewer: row.reviewer,
      description: row.description,
      suggestion: row.suggestion,
      addressed_by: row.addressed_by,
    })
    .onConflictDoUpdate({
      target: dbSchema.findings.id,
      set: {
        severity: row.severity,
        work_item: row.work_item,
        file_refs: row.file_refs,
        verdict: row.verdict,
        cycle: row.cycle,
        reviewer: row.reviewer,
        description: row.description,
        suggestion: row.suggestion,
        addressed_by: row.addressed_by,
      },
    })
    .run();
}

/**
 * Upsert a row into the domain_policies table.
 */
export function upsertDomainPolicy(db: DrizzleDb, row: DomainPolicyRow): void {
  db.insert(dbSchema.domainPolicies)
    .values({
      id: row.id,
      domain: row.domain,
      derived_from: row.derived_from,
      established: row.established,
      amended: row.amended,
      amended_by: row.amended_by,
      description: row.description,
    })
    .onConflictDoUpdate({
      target: dbSchema.domainPolicies.id,
      set: {
        domain: row.domain,
        derived_from: row.derived_from,
        established: row.established,
        amended: row.amended,
        amended_by: row.amended_by,
        description: row.description,
      },
    })
    .run();
}

/**
 * Upsert a row into the domain_decisions table.
 */
export function upsertDomainDecision(db: DrizzleDb, row: DomainDecisionRow): void {
  db.insert(dbSchema.domainDecisions)
    .values({
      id: row.id,
      domain: row.domain,
      cycle: row.cycle,
      supersedes: row.supersedes,
      description: row.description,
      rationale: row.rationale,
    })
    .onConflictDoUpdate({
      target: dbSchema.domainDecisions.id,
      set: {
        domain: row.domain,
        cycle: row.cycle,
        supersedes: row.supersedes,
        description: row.description,
        rationale: row.rationale,
      },
    })
    .run();
}

/**
 * Upsert a row into the domain_questions table.
 */
export function upsertDomainQuestion(db: DrizzleDb, row: DomainQuestionRow): void {
  db.insert(dbSchema.domainQuestions)
    .values({
      id: row.id,
      domain: row.domain,
      impact: row.impact,
      source: row.source,
      resolution: row.resolution,
      resolved_in: row.resolved_in,
      description: row.description,
      addressed_by: row.addressed_by,
    })
    .onConflictDoUpdate({
      target: dbSchema.domainQuestions.id,
      set: {
        domain: row.domain,
        impact: row.impact,
        source: row.source,
        resolution: row.resolution,
        resolved_in: row.resolved_in,
        description: row.description,
        addressed_by: row.addressed_by,
      },
    })
    .run();
}

/**
 * Upsert a row into the guiding_principles table.
 */
export function upsertGuidingPrinciple(db: DrizzleDb, row: GuidingPrincipleRow): void {
  db.insert(dbSchema.guidingPrinciples)
    .values({
      id: row.id,
      name: row.name,
      description: row.description,
      amendment_history: row.amendment_history,
    })
    .onConflictDoUpdate({
      target: dbSchema.guidingPrinciples.id,
      set: {
        name: row.name,
        description: row.description,
        amendment_history: row.amendment_history,
      },
    })
    .run();
}

/**
 * Upsert a row into the constraints table.
 */
export function upsertConstraint(db: DrizzleDb, row: ConstraintRow): void {
  db.insert(dbSchema.constraints)
    .values({
      id: row.id,
      category: row.category,
      description: row.description,
    })
    .onConflictDoUpdate({
      target: dbSchema.constraints.id,
      set: {
        category: row.category,
        description: row.description,
      },
    })
    .run();
}

/**
 * Upsert a row into the module_specs table.
 */
export function upsertModuleSpec(db: DrizzleDb, row: ModuleSpecRow): void {
  db.insert(dbSchema.moduleSpecs)
    .values({
      id: row.id,
      name: row.name,
      scope: row.scope,
      provides: row.provides,
      requires: row.requires,
      boundary_rules: row.boundary_rules,
    })
    .onConflictDoUpdate({
      target: dbSchema.moduleSpecs.id,
      set: {
        name: row.name,
        scope: row.scope,
        provides: row.provides,
        requires: row.requires,
        boundary_rules: row.boundary_rules,
      },
    })
    .run();
}

/**
 * Upsert a row into the research_findings table.
 */
export function upsertResearchFinding(db: DrizzleDb, row: ResearchFindingRow): void {
  db.insert(dbSchema.researchFindings)
    .values({
      id: row.id,
      topic: row.topic,
      date: row.date,
      content: row.content,
      sources: row.sources,
    })
    .onConflictDoUpdate({
      target: dbSchema.researchFindings.id,
      set: {
        topic: row.topic,
        date: row.date,
        content: row.content,
        sources: row.sources,
      },
    })
    .run();
}

/**
 * Upsert a row into the journal_entries table.
 */
export function upsertJournalEntry(db: DrizzleDb, row: JournalEntryRow): void {
  db.insert(dbSchema.journalEntries)
    .values({
      id: row.id,
      phase: row.phase,
      date: row.date,
      title: row.title,
      work_item: row.work_item,
      content: row.content,
    })
    .onConflictDoUpdate({
      target: dbSchema.journalEntries.id,
      set: {
        phase: row.phase,
        date: row.date,
        title: row.title,
        work_item: row.work_item,
        content: row.content,
      },
    })
    .run();
}

/**
 * Upsert a row into the metrics_events table.
 */
export function upsertMetricsEvent(db: DrizzleDb, row: MetricsEventRow): void {
  db.insert(dbSchema.metricsEvents)
    .values({
      id: row.id,
      event_name: row.event_name,
      timestamp: row.timestamp,
      payload: row.payload,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_write_tokens: row.cache_write_tokens,
      outcome: row.outcome,
      finding_count: row.finding_count,
      finding_severities: row.finding_severities,
      first_pass_accepted: row.first_pass_accepted,
      rework_count: row.rework_count,
      work_item_total_tokens: row.work_item_total_tokens,
      cycle_total_tokens: row.cycle_total_tokens,
      cycle_total_cost_estimate: row.cycle_total_cost_estimate,
      convergence_cycles: row.convergence_cycles,
      context_artifact_ids: row.context_artifact_ids,
    })
    .onConflictDoUpdate({
      target: dbSchema.metricsEvents.id,
      set: {
        event_name: row.event_name,
        timestamp: row.timestamp,
        payload: row.payload,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
        outcome: row.outcome,
        finding_count: row.finding_count,
        finding_severities: row.finding_severities,
        first_pass_accepted: row.first_pass_accepted,
        rework_count: row.rework_count,
        work_item_total_tokens: row.work_item_total_tokens,
        cycle_total_tokens: row.cycle_total_tokens,
        cycle_total_cost_estimate: row.cycle_total_cost_estimate,
        convergence_cycles: row.convergence_cycles,
        context_artifact_ids: row.context_artifact_ids,
      },
    })
    .run();
}

/**
 * Upsert a row into the document_artifacts table.
 */
export function upsertDocumentArtifact(db: DrizzleDb, row: DocumentArtifactRow): void {
  db.insert(dbSchema.documentArtifacts)
    .values({
      id: row.id,
      title: row.title,
      cycle: row.cycle,
      content: row.content,
    })
    .onConflictDoUpdate({
      target: dbSchema.documentArtifacts.id,
      set: {
        title: row.title,
        cycle: row.cycle,
        content: row.content,
      },
    })
    .run();
}

/**
 * Upsert a row into the interview_questions table.
 */
export function upsertInterviewQuestion(db: DrizzleDb, row: InterviewQuestionRow): void {
  db.insert(dbSchema.interviewQuestions)
    .values({
      id: row.id,
      interview_id: row.interview_id,
      question: row.question,
      answer: row.answer,
      domain: row.domain,
      seq: row.seq,
    })
    .onConflictDoUpdate({
      target: dbSchema.interviewQuestions.id,
      set: {
        interview_id: row.interview_id,
        question: row.question,
        answer: row.answer,
        domain: row.domain,
        seq: row.seq,
      },
    })
    .run();
}

/**
 * Upsert a row into the proxy_human_decisions table.
 */
export function upsertProxyHumanDecision(db: DrizzleDb, row: ProxyHumanDecisionRow): void {
  db.insert(dbSchema.proxyHumanDecisions)
    .values({
      id: row.id,
      cycle: row.cycle,
      trigger: row.trigger,
      triggered_by: row.triggered_by,
      decision: row.decision,
      rationale: row.rationale,
      timestamp: row.timestamp,
      status: row.status,
    })
    .onConflictDoUpdate({
      target: dbSchema.proxyHumanDecisions.id,
      set: {
        cycle: row.cycle,
        trigger: row.trigger,
        triggered_by: row.triggered_by,
        decision: row.decision,
        rationale: row.rationale,
        timestamp: row.timestamp,
        status: row.status,
      },
    })
    .run();
}

/**
 * Upsert a row into the projects table.
 */
export function upsertProject(db: DrizzleDb, row: ProjectRow): void {
  db.insert(dbSchema.projects)
    .values({
      id: row.id,
      intent: row.intent,
      scope_boundary: row.scope_boundary,
      success_criteria: row.success_criteria,
      appetite: row.appetite,
      steering: row.steering,
      horizon: row.horizon,
      status: row.status,
    })
    .onConflictDoUpdate({
      target: dbSchema.projects.id,
      set: {
        intent: row.intent,
        scope_boundary: row.scope_boundary,
        success_criteria: row.success_criteria,
        appetite: row.appetite,
        steering: row.steering,
        horizon: row.horizon,
        status: row.status,
      },
    })
    .run();
}

/**
 * Upsert a row into the phases table.
 */
export function upsertPhase(db: DrizzleDb, row: PhaseRow): void {
  db.insert(dbSchema.phases)
    .values({
      id: row.id,
      project: row.project,
      phase_type: row.phase_type,
      intent: row.intent,
      steering: row.steering,
      status: row.status,
      work_items: row.work_items,
    })
    .onConflictDoUpdate({
      target: dbSchema.phases.id,
      set: {
        project: row.project,
        phase_type: row.phase_type,
        intent: row.intent,
        steering: row.steering,
        status: row.status,
        work_items: row.work_items,
      },
    })
    .run();
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
    if (row[field] === undefined) {
      throw new Error(`upsertExtensionRow(${tableName}): required field '${field}' is missing`);
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
      upsertDomainPolicy(db, { id, ...row } as DomainPolicyRow);
      break;
    case "domain_decisions":
      upsertDomainDecision(db, { id, ...row } as DomainDecisionRow);
      break;
    case "domain_questions":
      upsertDomainQuestion(db, { id, ...row } as DomainQuestionRow);
      break;
    case "guiding_principles":
      upsertGuidingPrinciple(db, { id, ...row } as GuidingPrincipleRow);
      break;
    case "constraints":
      upsertConstraint(db, { id, ...row } as ConstraintRow);
      break;
    case "module_specs":
      upsertModuleSpec(db, { id, ...row } as ModuleSpecRow);
      break;
    case "research_findings":
      upsertResearchFinding(db, { id, ...row } as ResearchFindingRow);
      break;
    case "journal_entries":
      upsertJournalEntry(db, { id, ...row } as JournalEntryRow);
      break;
    case "metrics_events":
      upsertMetricsEvent(db, { id, ...row } as MetricsEventRow);
      break;
    case "document_artifacts":
      upsertDocumentArtifact(db, { id, ...row } as DocumentArtifactRow);
      break;
    case "interview_questions":
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