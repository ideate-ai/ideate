/**
 * writer.ts — LocalAdapter write operations.
 *
 * Extracted storage logic from tools/write.ts. Implements the write-side of
 * the StorageAdapter interface: putNode, patchNode, deleteNode, putEdge,
 * removeEdges, batchMutate, archiveCycle, nextId, appendJournalEntry.
 *
 *   appendJournalEntry — three-phase journal write (reserve → YAML → finalize) preserving P-44 compliance
 *
 * P-44 two-phase write pattern (YAML first, SQLite second) is preserved for all
 * write operations and is invisible to tool handlers. Tool handlers call adapter
 * methods; storage details (YAML I/O, SQLite upserts, rollback) are encapsulated
 * in this module. appendJournalEntry uses a three-phase pattern (exclusive tx to
 * reserve a sequence-number slot, YAML write outside any transaction, exclusive tx
 * to finalize) to satisfy P-44 while preventing sequence-number collisions.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type Database from "better-sqlite3";
import { eq, inArray, and } from "drizzle-orm";
import { detectCycles } from "../../indexer.js";
import { TYPE_TO_EXTENSION_TABLE } from "../../db.js";
import * as dbSchema from "../../db.js";
import {
  type DrizzleDb,
  type NodeRow,
  type WorkItemRow,
  type JournalEntryRow,
  type DomainPolicyRow,
  type DomainDecisionRow,
  type DomainQuestionRow,
  type ProxyHumanDecisionRow,
  type GuidingPrincipleRow,
  type ConstraintRow,
  type DocumentArtifactRow,
  type ResearchFindingRow,
  type ModuleSpecRow,
  type FindingRow,
  type MetricsEventRow,
  type InterviewQuestionRow,
  type ProjectRow,
  type PhaseRow,
  upsertNode,
  upsertWorkItem,
  upsertJournalEntry,
  upsertDomainPolicy,
  upsertDomainDecision,
  upsertDomainQuestion,
  upsertProxyHumanDecision,
  upsertGuidingPrinciple,
  upsertConstraint,
  upsertDocumentArtifact,
  upsertResearchFinding,
  upsertModuleSpec,
  upsertFinding,
  upsertMetricsEvent,
  upsertInterviewQuestion,
  upsertProject,
  upsertPhase as upsertPhaseRow,
  insertEdge,
  computeArtifactHash,
} from "../../db-helpers.js";
import type {
  MutateNodeInput,
  MutateNodeResult,
  UpdateNodeInput,
  UpdateNodeResult,
  DeleteNodeResult,
  Edge,
  EdgeType,
  BatchMutateInput,
  BatchMutateResult,
  NodeType,
} from "../../adapter.js";
import { ImmutableFieldError, ValidationError, ALL_NODE_TYPES } from "../../adapter.js";
import { EDGE_TYPES } from "../../schema.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function tokenCount(content: string): number {
  return Math.floor(content.length / 4);
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Cycle-scoped type detection
// ---------------------------------------------------------------------------

const CYCLE_SCOPED_TYPES = new Set([
  "finding", "cycle_summary", "review_output", "review_manifest", "decision_log",
  "proxy_human_decision",
]);

// ---------------------------------------------------------------------------
// resolveArtifactPath — determine output path for an artifact
// ---------------------------------------------------------------------------

export function resolveArtifactPath(ideateDir: string, type: string, id: string, cycle?: number): string {
  if (CYCLE_SCOPED_TYPES.has(type)) {
    if (cycle === undefined || cycle === null) {
      throw new Error(`Type '${type}' requires a cycle parameter`);
    }
    const paddedCycle = String(cycle).padStart(3, "0");
    if (type === "finding") {
      return path.join(ideateDir, "cycles", paddedCycle, "findings", `${id}.yaml`);
    }
    if (type === "proxy_human_decision") {
      return path.join(ideateDir, "cycles", paddedCycle, "proxy-human", `${id}.yaml`);
    }
    return path.join(ideateDir, "cycles", paddedCycle, `${id}.yaml`);
  }

  switch (type) {
    case "overview":
    case "execution_strategy":
    case "architecture":
      return path.join(ideateDir, "plan", `${id}.yaml`);
    case "guiding_principles":
    case "constraints":
      return path.join(ideateDir, "steering", `${id}.yaml`);
    case "guiding_principle":
      return path.join(ideateDir, "principles", `${id}.yaml`);
    case "constraint":
      return path.join(ideateDir, "constraints", `${id}.yaml`);
    case "domain_policy":
      return path.join(ideateDir, "policies", `${id}.yaml`);
    case "domain_decision":
      return path.join(ideateDir, "decisions", `${id}.yaml`);
    case "domain_question":
      return path.join(ideateDir, "questions", `${id}.yaml`);
    case "domain_index":
      return path.join(ideateDir, "domains", "index.yaml");
    case "module_spec":
      return path.join(ideateDir, "modules", `${id}.yaml`);
    case "research_finding":
      return path.join(ideateDir, "research", `${id}.yaml`);
    case "metrics_event":
      return path.join(ideateDir, "metrics", `${id}.yaml`);
    case "interview_question":
      return path.join(ideateDir, "interviews", `${id}.yaml`);
    case "interview":
      return path.join(ideateDir, "interviews", `${id}.yaml`);
    case "research":
      return path.join(ideateDir, "steering", "research", `${id}.yaml`);
    case "project":
      return path.join(ideateDir, "projects", `${id}.yaml`);
    case "phase":
      return path.join(ideateDir, "phases", `${id}.yaml`);
    case "work_item":
      return path.join(ideateDir, "work-items", `${id}.yaml`);
    default:
      return path.join(ideateDir, type, `${id}.yaml`);
  }
}

// ---------------------------------------------------------------------------
// Type-specific SQLite upsert dispatch (extracted from handleWriteArtifact)
// ---------------------------------------------------------------------------

function upsertExtensionTableRow(
  drizzleDb: DrizzleDb,
  type: string,
  id: string,
  content: Record<string, unknown>,
  cycleForNode: number | null
): void {
  if (type === "domain_policy") {
    const policyRow: DomainPolicyRow = {
      id,
      domain: (content.domain as string) ?? "",
      derived_from: content.derived_from ? JSON.stringify(content.derived_from) : null,
      established: (content.established as string | null) ?? null,
      amended: (content.amended as string | null) ?? null,
      amended_by: (content.amended_by as string | null) ?? null,
      description: (content.description as string | null) ?? null,
    };
    upsertDomainPolicy(drizzleDb, policyRow);
  } else if (type === "domain_decision") {
    const decisionRow: DomainDecisionRow = {
      id,
      domain: (content.domain as string) ?? "",
      cycle: (content.cycle as number | null) ?? null,
      supersedes: (content.supersedes as string | null) ?? null,
      description: (content.description as string | null) ?? null,
      rationale: (content.rationale as string | null) ?? null,
      title: (content.title as string | null) ?? null,
      source: (content.source as string | null) ?? null,
    };
    upsertDomainDecision(drizzleDb, decisionRow);
  } else if (type === "domain_question") {
    const questionRow: DomainQuestionRow = {
      id,
      domain: (content.domain as string) ?? "",
      impact: (content.impact as string | null) ?? null,
      source: (content.source as string | null) ?? null,
      resolution: (content.resolution as string | null) ?? null,
      resolved_in: (content.resolved_in as number | null) ?? null,
      description: (content.description as string | null) ?? null,
      addressed_by: (content.addressed_by as string | null) ?? null,
    };
    upsertDomainQuestion(drizzleDb, questionRow);
  } else if (type === "proxy_human_decision") {
    const phDecisionRow: ProxyHumanDecisionRow = {
      id,
      cycle: (content.cycle as number) ?? 0,
      trigger: (content.trigger as string) ?? "",
      triggered_by: content.triggered_by ? JSON.stringify(content.triggered_by) : null,
      decision: (content.decision as string) ?? "",
      rationale: (content.rationale as string | null) ?? null,
      timestamp: (content.timestamp as string) ?? new Date().toISOString(),
      status: (content.status as string) ?? "resolved",
    };
    upsertProxyHumanDecision(drizzleDb, phDecisionRow);

    // Insert triggered_by edges
    if (content.triggered_by && Array.isArray(content.triggered_by)) {
      for (const ref of content.triggered_by as Array<{ type: string; id: string }>) {
        if (ref && ref.id) {
          insertEdge(drizzleDb, {
            source_id: id,
            target_id: ref.id,
            edge_type: "triggered_by",
            props: null,
          });
        }
      }
    }
  } else if (type === "guiding_principle") {
    const principleRow: GuidingPrincipleRow = {
      id,
      name: (content.name as string) ?? "",
      description: (content.description as string | null) ?? null,
      amendment_history: content.amendment_history ? JSON.stringify(content.amendment_history) : null,
    };
    upsertGuidingPrinciple(drizzleDb, principleRow);
  } else if (type === "constraint") {
    const constraintRow: ConstraintRow = {
      id,
      category: (content.category as string) ?? "",
      description: (content.description as string | null) ?? null,
    };
    upsertConstraint(drizzleDb, constraintRow);
  } else if (
    type === "overview" ||
    type === "execution_strategy" ||
    type === "architecture" ||
    type === "cycle_summary" ||
    type === "review_output" ||
    type === "decision_log" ||
    type === "review_manifest" ||
    type === "guiding_principles" ||
    type === "constraints" ||
    type === "research" ||
    type === "interview" ||
    type === "domain_index"
  ) {
    const docRow: DocumentArtifactRow = {
      id,
      title: (content.title as string | null) ?? null,
      cycle: (content.cycle as number | null) ?? cycleForNode,
      content: typeof content.content === "string" ? content.content : JSON.stringify(content),
    };
    upsertDocumentArtifact(drizzleDb, docRow);
  } else if (type === "research_finding") {
    const rfRow: ResearchFindingRow = {
      id,
      topic: (content.topic as string) ?? "",
      date: (content.date as string | null) ?? null,
      content: (content.content as string | null) ?? null,
      sources: content.sources ? JSON.stringify(content.sources) : null,
    };
    upsertResearchFinding(drizzleDb, rfRow);
  } else if (type === "module_spec") {
    const msRow: ModuleSpecRow = {
      id,
      name: (content.name as string) ?? "",
      scope: (content.scope as string | null) ?? null,
      provides: content.provides ? JSON.stringify(content.provides) : null,
      requires: content.requires ? JSON.stringify(content.requires) : null,
      boundary_rules: content.boundary_rules ? JSON.stringify(content.boundary_rules) : null,
    };
    upsertModuleSpec(drizzleDb, msRow);
  } else if (type === "finding") {
    const findingRow: FindingRow = {
      id,
      severity: (content.severity as string) ?? "",
      work_item: (content.work_item as string) ?? "",
      file_refs: (content.file_refs as string | null) ?? null,
      verdict: (content.verdict as string) ?? "",
      cycle: (content.cycle as number) ?? cycleForNode ?? 0,
      reviewer: (content.reviewer as string) ?? "",
      description: (content.description as string | null) ?? null,
      suggestion: (content.suggestion as string | null) ?? null,
      addressed_by: (content.addressed_by as string | null) ?? null,
      title: (content.title as string | null) ?? null,
    };
    upsertFinding(drizzleDb, findingRow);
  } else if (type === "metrics_event") {
    const writePayloadFields = ["agent_type", "skill", "phase", "work_item", "model", "wall_clock_ms", "turns_used", "cycle"] as const;
    const writeComputedPayload: Record<string, unknown> = {};
    for (const field of writePayloadFields) {
      const v = content[field];
      if (v !== undefined && v !== null) writeComputedPayload[field] = v;
    }
    const writeStoredPayload = Object.keys(writeComputedPayload).length > 0
      ? JSON.stringify(writeComputedPayload)
      : null;
    const meRow: MetricsEventRow = {
      id,
      event_name: typeof content.agent_type === "string"
        ? (content.agent_type as string)
        : (content.event_name as string) ?? "",
      timestamp: (content.timestamp as string | null) ?? null,
      payload: writeStoredPayload,
      input_tokens: (content.input_tokens as number | null) ?? null,
      output_tokens: (content.output_tokens as number | null) ?? null,
      cache_read_tokens: (content.cache_read_tokens as number | null) ?? null,
      cache_write_tokens: (content.cache_write_tokens as number | null) ?? null,
      outcome: (content.outcome as string | null) ?? null,
      finding_count: (content.finding_count as number | null) ?? null,
      finding_severities: content.finding_severities
        ? (typeof content.finding_severities === "string"
            ? content.finding_severities
            : JSON.stringify(content.finding_severities))
        : null,
      first_pass_accepted: (content.first_pass_accepted as number | null) ?? null,
      rework_count: (content.rework_count as number | null) ?? null,
      work_item_total_tokens: (content.work_item_total_tokens as number | null) ?? null,
      cycle_total_tokens: (content.cycle_total_tokens as number | null) ?? null,
      cycle_total_cost_estimate: (content.cycle_total_cost_estimate as string | null) ?? null,
      convergence_cycles: (content.convergence_cycles as number | null) ?? null,
      context_artifact_ids: content.context_artifact_ids ? JSON.stringify(content.context_artifact_ids) : null,
    };
    upsertMetricsEvent(drizzleDb, meRow);
  } else if (type === "interview_question") {
    const iqRow: InterviewQuestionRow = {
      id,
      interview_id: (content.interview_id as string) ?? "",
      question: (content.question as string) ?? "",
      answer: (content.answer as string) ?? "",
      domain: (content.domain as string | null) ?? null,
      seq: (content.seq as number) ?? 0,
    };
    upsertInterviewQuestion(drizzleDb, iqRow);
  } else if (type === "project") {
    const projRow: ProjectRow = {
      id,
      name: (content.name as string | null) ?? null,
      description: (content.description as string | null) ?? null,
      intent: (content.intent as string) ?? "",
      scope_boundary: content.scope_boundary ? JSON.stringify(content.scope_boundary) : null,
      success_criteria: content.success_criteria ? JSON.stringify(content.success_criteria) : null,
      appetite: (content.appetite as number | null) ?? null,
      steering: (content.steering as string | null) ?? null,
      horizon: content.horizon ? JSON.stringify(content.horizon) : null,
      status: (content.status as string) ?? "active",
      current_phase_id: (content.current_phase_id as string | null) ?? null,
    };
    upsertProject(drizzleDb, projRow);
  } else if (type === "phase") {
    const phaseRow: PhaseRow = {
      id,
      name: (content.name as string | null) ?? null,
      description: (content.description as string | null) ?? null,
      project: (content.project as string) ?? "",
      phase_type: (content.phase_type as string) ?? "implementation",
      intent: (content.intent as string) ?? "",
      steering: (content.steering as string | null) ?? null,
      status: (content.status as string) ?? "pending",
      work_items: content.work_items ? JSON.stringify(content.work_items) : null,
      completed_date: (content.completed_date as string | null) ?? null,
    };
    upsertPhaseRow(drizzleDb, phaseRow);
  }
  // journal_entry and work_item are handled separately (handleAppendJournal /
  // handleWriteWorkItems routes), but they can also come through putNode.
  else if (type === "journal_entry") {
    const journalRow: JournalEntryRow = {
      id,
      phase: (content.phase as string | null) ?? null,
      date: (content.date as string | null) ?? null,
      title: (content.title as string | null) ?? null,
      work_item: (content.work_item as string | null) ?? null,
      content: (content.content as string | null) ?? null,
    };
    upsertJournalEntry(drizzleDb, journalRow);
  } else if (type === "work_item") {
    const wiRow: WorkItemRow = {
      id,
      title: (content.title as string) ?? "",
      complexity: (content.complexity as string | null) ?? null,
      scope: content.scope ? JSON.stringify(content.scope) : null,
      depends: content.depends ? JSON.stringify(content.depends) : null,
      blocks: content.blocks ? JSON.stringify(content.blocks) : null,
      criteria: content.criteria ? JSON.stringify(content.criteria) : null,
      module: null,
      domain: (content.domain as string | null) ?? null,
      phase: (content.phase as string | null) ?? null,
      notes: (content.notes as string | null) ?? null,
      work_item_type: (content.work_item_type as string | null) ?? "feature",
      resolution: (content.resolution as string | null) ?? null,
    };
    upsertWorkItem(drizzleDb, wiRow);

    // Insert dependency edges
    if (content.depends && Array.isArray(content.depends)) {
      for (const dep of content.depends as string[]) {
        insertEdge(drizzleDb, {
          source_id: id,
          target_id: dep,
          edge_type: "depends_on",
          props: null,
        });
      }
    }
    // Insert blocks edges
    if (content.blocks && Array.isArray(content.blocks)) {
      for (const blocked of content.blocks as string[]) {
        insertEdge(drizzleDb, {
          source_id: id,
          target_id: blocked,
          edge_type: "blocks",
          props: null,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LocalWriterAdapter — implements write-side StorageAdapter methods
// ---------------------------------------------------------------------------

export interface LocalWriterConfig {
  db: Database.Database;
  drizzleDb: DrizzleDb;
  ideateDir: string;
}

export class LocalWriterAdapter {
  protected db: Database.Database;
  protected drizzleDb: DrizzleDb;
  protected ideateDir: string;

  /** Cached current cycle number from domains/index.yaml */
  private _cachedCycleNumber: number | null = null;
  /** mtime (ms) of domains/index.yaml at last cache fill */
  private _cycleCacheMtime: number = 0;

  constructor(config: LocalWriterConfig) {
    this.db = config.db;
    this.drizzleDb = config.drizzleDb;
    this.ideateDir = config.ideateDir;
  }

  // -------------------------------------------------------------------------
  // nextId — generate the next available ID for a given node type
  // -------------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    // Validate cycle parameter: must be non-negative integer if provided
    if (cycle !== undefined) {
      if (!Number.isInteger(cycle)) {
        throw new ValidationError(
          `Cycle must be an integer, received ${typeof cycle}`,
          "INVALID_CYCLE",
          { value: cycle }
        );
      }
      if (cycle < 0) {
        throw new ValidationError(
          `Cycle must be a non-negative integer, received ${cycle}`,
          "INVALID_CYCLE",
          { value: cycle }
        );
      }
    }

    if (type === "journal_entry") {
      // Journal entries: J-{cycleStr}-{seqStr}
      const cycleNum = cycle ?? 0;
      const cycleStr = String(cycleNum).padStart(3, "0");
      // Use MAX+1 strategy (not COUNT) to handle gaps from deleted entries
      const maxRow = this.db.prepare(
        `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
      ).get(`J-${cycleStr}-`.length + 1, `J-${cycleStr}-%`) as { max_num: number | null };
      const seq = (maxRow?.max_num ?? 0) + 1;
      return `J-${cycleStr}-${String(seq).padStart(3, "0")}`;
    }

    if (type === "work_item") {
      const maxIdRow = this.db.prepare(
        `SELECT MAX(CAST(REPLACE(n.id, 'WI-', '') AS INTEGER)) as max_id FROM nodes n WHERE n.type = 'work_item'`
      ).get() as { max_id: number | null };
      const next = (maxIdRow?.max_id ?? 0) + 1;
      return `WI-${String(next).padStart(3, "0")}`;
    }

    if (type === "finding") {
      const cycleNum = cycle ?? 0;
      const cycleStr = String(cycleNum).padStart(3, "0");
      // Use MAX+1 strategy (not COUNT) to handle gaps from deleted entries
      const maxRow = this.db.prepare(
        `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
      ).get(`F-${cycleStr}-`.length + 1, `F-${cycleStr}-%`) as { max_num: number | null };
      const seq = (maxRow?.max_num ?? 0) + 1;
      return `F-${cycleStr}-${String(seq).padStart(3, "0")}`;
    }

    // For all other types, raise an error — ID generation is type-specific
    throw new ValidationError(
      `nextId: no ID format defined for type '${type}'`,
      "INVALID_NODE_TYPE",
      { value: type }
    );
  }

  // -------------------------------------------------------------------------
  // putNode — create or replace a node (two-phase write)
  // -------------------------------------------------------------------------

  async putNode(input: MutateNodeInput): Promise<MutateNodeResult> {
    // Input validation
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      throw new ValidationError('Node id must be a non-empty string', 'INVALID_NODE_ID', { value: input.id });
    }
    if (!ALL_NODE_TYPES.includes(input.type as NodeType)) {
      throw new ValidationError(`Invalid NodeType: ${input.type}`, 'INVALID_NODE_TYPE', { value: input.type });
    }
    if (input.properties == null) {
      throw new ValidationError('Node properties must be provided', 'MISSING_NODE_PROPERTIES', {});
    }

    const { id, type, properties: content, cycle } = input;

    // Determine output path
    const absoluteFilePath = resolveArtifactPath(this.ideateDir, type, id, cycle);
    ensureDir(path.dirname(absoluteFilePath));

    // Build YAML object: merge content with id and type
    const yamlObj: Record<string, unknown> = {
      id,
      type,
      ...content,
    };
    if (cycle !== undefined && !("cycle" in yamlObj)) {
      yamlObj.cycle = cycle;
    }

    // Apply defaults for work_item type (match server behavior)
    if (type === "work_item") {
      if (!yamlObj.work_item_type) {
        yamlObj.work_item_type = "feature";
      }
    }

    // Determine current cycle for cycle_modified (same logic as patchNode)
    let cycleNumber: number | null = null;
    try {
      const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
      const indexMdPath = path.join(this.ideateDir, "domains", "index.md");
      let indexPath: string | null = null;
      if (fs.existsSync(indexYamlPath)) {
        indexPath = indexYamlPath;
      } else if (fs.existsSync(indexMdPath)) {
        indexPath = indexMdPath;
      }
      if (indexPath) {
        const indexContent = fs.readFileSync(indexPath, "utf8");
        const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
        cycleNumber = match ? parseInt(match[1], 10) : null;
      }
    } catch {
      // cycle_modified remains null if index cannot be read
    }
    yamlObj.cycle_modified = cycleNumber;

    // Compute hash over content fields only
    const contentHash = computeArtifactHash(yamlObj);
    const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
    const tokens = tokenCount(yamlForTokens);

    // Add computed fields (no file_path in YAML)
    yamlObj.content_hash = contentHash;
    yamlObj.token_count = tokens;

    // Determine if this is a create or update
    const existingRow = this.db.prepare(
      `SELECT id, file_path FROM nodes WHERE id = ?`
    ).get(id) as { id: string; file_path: string } | undefined;
    const isUpdate = existingRow !== undefined;

    // For updates: read existing YAML and merge with new properties
    let finalYamlObj = yamlObj;
    let originalContent: string | null = null;
    if (isUpdate && fs.existsSync(existingRow.file_path)) {
      try {
        const existingContent = fs.readFileSync(existingRow.file_path, "utf8");
        originalContent = existingContent;
        const existingObj = parseYaml(existingContent) as Record<string, unknown>;
        // Merge: existing values + new values (new wins for provided fields)
        finalYamlObj = { ...existingObj, ...yamlObj };
        // Recompute hash and tokens for merged content
        const mergedContentHash = computeArtifactHash(finalYamlObj);
        const mergedYamlForTokens = stringifyYaml(finalYamlObj, { lineWidth: 0 });
        const mergedTokens = tokenCount(mergedYamlForTokens);
        finalYamlObj.content_hash = mergedContentHash;
        finalYamlObj.token_count = mergedTokens;
      } catch {
        // If read/parse fails, use the new yamlObj as-is
      }
    }

    const finalYaml = stringifyYaml(finalYamlObj, { lineWidth: 0 });

    // Phase 1 — Write the YAML file (source of truth)
    fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");

    // Phase 2 — SQLite upserts in a single exclusive transaction
    const cycleForNode = CYCLE_SCOPED_TYPES.has(type) && cycle !== undefined
      ? cycle
      : (finalYamlObj.cycle_created as number | null) ?? null;
    const finalCycleModified = finalYamlObj.cycle_modified as number | null;
    const finalContentHash = finalYamlObj.content_hash as string;
    const finalTokenCount = finalYamlObj.token_count as number;

    // Build extension content from finalYamlObj (for work_item extension table)
    const extensionContent: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(finalYamlObj)) {
      // Skip metadata fields, keep user-visible properties
      if (!["id", "type", "content_hash", "token_count", "file_path"].includes(k)) {
        extensionContent[k] = v;
      }
    }

    try {
      const upsertPhase = this.db.transaction(() => {
        const nodeRow: NodeRow = {
          id,
          type,
          cycle_created: cycleForNode,
          cycle_modified: finalCycleModified,
          content_hash: finalContentHash,
          token_count: finalTokenCount,
          file_path: absoluteFilePath,
          status: (finalYamlObj.status as string | null) ?? null,
        };

        upsertNode(this.drizzleDb, nodeRow);
        upsertExtensionTableRow(this.drizzleDb, type, id, extensionContent, cycleForNode);
      });
      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — roll back the YAML file
      try {
        if (isUpdate && originalContent !== null) {
          // Restore the original content for updates
          fs.writeFileSync(absoluteFilePath, originalContent, "utf8");
        } else {
          // New insert, or update where original read failed — remove newly written file
          if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
        }
      } catch (cleanupErr) {
        throw new ValidationError(
          `operation failed: ${(dbErr as Error).message}; cleanup also failed: ${(cleanupErr as Error).message}`,
          "TRANSACTION_FAILED",
          { operation: "putNode", id, filePath: absoluteFilePath }
        );
      }
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "putNode", id, filePath: absoluteFilePath }
      );
    }

    return { id, status: isUpdate ? "updated" : "created" };
  }

  // -------------------------------------------------------------------------
  // patchNode — partially update an existing node's properties
  // -------------------------------------------------------------------------

  async patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult> {
    // Input validation
    if (typeof input.id !== 'string' || input.id.trim() === '') {
      throw new ValidationError('Node id must be a non-empty string', 'INVALID_NODE_ID', { value: input.id });
    }

    const { id, properties } = input;

    // Reject immutable fields
    const IMMUTABLE = ["id", "type", "cycle_created"];
    for (const field of IMMUTABLE) {
      if (field in properties) {
        throw new ImmutableFieldError(field);
      }
    }

    // Determine file path for work items (only work_item type supports patchNode for now)
    // Find the node's file_path from the index
    const nodeRow = this.db.prepare(
      `SELECT file_path, type, cycle_created, status FROM nodes WHERE id = ?`
    ).get(id) as { file_path: string; type: string; cycle_created: number | null; status: string | null } | undefined;

    if (!nodeRow) {
      return { id, status: "not_found" };
    }

    const filePath = nodeRow.file_path;

    // Read and parse existing YAML.
    // Filesystem errors (ENOENT, EACCES, etc.) during the read phase are treated
    // as "not_found" — they are a pre-condition failure, not a DB/transaction
    // failure.  This ensures callers (handleUpdateWorkItems) can add the item to
    // the per-item failures list without re-throwing, preserving the original
    // behavior where filesystem errors are surfaced as item-level failures.
    if (!fs.existsSync(filePath)) {
      return { id, status: "not_found" };
    }

    let existingContent: string;
    try {
      existingContent = fs.readFileSync(filePath, "utf8");
    } catch {
      return { id, status: "not_found" };
    }
    const existingObj = parseYaml(existingContent) as Record<string, unknown>;

    // Determine current cycle for cycle_modified (cached to avoid re-reading on every call)
    let cycleNumber: number | null = null;
    try {
      const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
      const indexMdPath = path.join(this.ideateDir, "domains", "index.md");
      // Check mtime of the preferred index file to decide whether the cache is stale
      let indexPath: string | null = null;
      if (fs.existsSync(indexYamlPath)) {
        indexPath = indexYamlPath;
      } else if (fs.existsSync(indexMdPath)) {
        indexPath = indexMdPath;
      }
      if (indexPath) {
        const mtime = fs.statSync(indexPath).mtimeMs;
        if (mtime !== this._cycleCacheMtime || this._cachedCycleNumber === null) {
          // Cache is stale or empty — re-read
          const indexContent = fs.readFileSync(indexPath, "utf8");
          const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
          this._cachedCycleNumber = match ? parseInt(match[1], 10) : null;
          this._cycleCacheMtime = mtime;
        }
        cycleNumber = this._cachedCycleNumber;
      }
    } catch {
      // cycle_modified remains null if index cannot be read
    }

    // Merge provided fields (skip immutable fields)
    const merged: Record<string, unknown> = { ...existingObj };
    const IMMUTABLE_SET = new Set(["id", "type", "cycle_created", "file_path"]);
    for (const [field, value] of Object.entries(properties)) {
      if (!IMMUTABLE_SET.has(field)) {
        merged[field] = value;
      }
    }

    // Update cycle_modified
    merged.cycle_modified = cycleNumber;

    // Apply work_item_type default for work_item type (match server behavior)
    if (nodeRow.type === "work_item" && !merged.work_item_type) {
      merged.work_item_type = "feature";
    }

    // Recompute hash and token count
    const contentHash = computeArtifactHash(merged);
    const yamlForTokens = stringifyYaml(merged, { lineWidth: 0 });
    const tokens = tokenCount(yamlForTokens);

    merged.content_hash = contentHash;
    merged.token_count = tokens;
    delete merged.file_path;

    // Write updated YAML back to same path (save original for rollback)
    const finalYaml = stringifyYaml(merged, { lineWidth: 0 });

    fs.writeFileSync(filePath, finalYaml, "utf8");

    // Phase 2 — SQLite upserts in exclusive transaction
    const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) this.db.pragma("foreign_keys = OFF");

    try {
      const upsertPhase = this.db.transaction(() => {
        const type = nodeRow.type;
        const writtenContent = fs.readFileSync(filePath, "utf8");
        const parsedObj = parseYaml(writtenContent) as Record<string, unknown>;
        const hash = computeArtifactHash(parsedObj);

        const updatedNodeRow: NodeRow = {
          id,
          type,
          cycle_created: nodeRow.cycle_created,
          cycle_modified: (parsedObj.cycle_modified as number | null) ?? null,
          content_hash: hash,
          token_count: tokenCount(writtenContent),
          file_path: filePath,
          status: (parsedObj.status as string | null) ?? null,
        };

        upsertNode(this.drizzleDb, updatedNodeRow);

        // For work_item type, also upsert extension table and replace edges
        if (type === "work_item") {
          // Apply defaults to parsedObj to match server behavior
          const workItemType = (parsedObj.work_item_type as string | null) ?? "feature";
          parsedObj.work_item_type = workItemType;

          const wiRow: WorkItemRow = {
            id,
            title: (parsedObj.title as string) ?? "",
            complexity: (parsedObj.complexity as string | null) ?? null,
            scope: parsedObj.scope ? JSON.stringify(parsedObj.scope) : null,
            depends: parsedObj.depends ? JSON.stringify(parsedObj.depends) : null,
            blocks: parsedObj.blocks ? JSON.stringify(parsedObj.blocks) : null,
            criteria: parsedObj.criteria ? JSON.stringify(parsedObj.criteria) : null,
            module: null,
            domain: (parsedObj.domain as string | null) ?? null,
            phase: (parsedObj.phase as string | null) ?? null,
            notes: (parsedObj.notes as string | null) ?? null,
            work_item_type: workItemType,
            resolution: (parsedObj.resolution as string | null) ?? null,
          };
          upsertWorkItem(this.drizzleDb, wiRow);

          // Delete old dependency edges for this item
          this.db.prepare(`DELETE FROM edges WHERE source_id = ? AND edge_type IN ('depends_on', 'blocks')`).run(id);

          // Insert new depends_on edges
          for (const dep of (parsedObj.depends as string[] | undefined) || []) {
            this.db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`).run(id, dep);
          }

          // Insert new blocks edges
          for (const blk of (parsedObj.blocks as string[] | undefined) || []) {
            this.db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'blocks')`).run(id, blk);
          }
        }
      });

      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — restore original YAML content
      try {
        fs.writeFileSync(filePath, existingContent, "utf8");
      } catch (cleanupErr) {
        throw new ValidationError(
          `operation failed: ${(dbErr as Error).message}; cleanup also failed: ${(cleanupErr as Error).message}`,
          "TRANSACTION_FAILED",
          { operation: "patchNode", id, filePath }
        );
      }
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "patchNode", id, filePath }
      );
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    return { id, status: "updated" };
  }

  // -------------------------------------------------------------------------
  // deleteNode — delete a node and its associated edges
  // -------------------------------------------------------------------------

  async deleteNode(id: string): Promise<DeleteNodeResult> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError('Node id must be a non-empty string', 'INVALID_NODE_ID', { value: id });
    }
    const nodeRow = this.db.prepare(
      `SELECT file_path FROM nodes WHERE id = ?`
    ).get(id) as { file_path: string } | undefined;

    if (!nodeRow) {
      return { id, status: "not_found" };
    }

    const absoluteFilePath = nodeRow.file_path;

    // Phase 0 — Save file content so we can restore on rollback
    let originalContent: string | null = null;
    try {
      originalContent = fs.readFileSync(absoluteFilePath, 'utf-8');
    } catch {
      // File may already be missing; proceed, but rollback won't be able to restore
    }

    // Phase 1 — Remove YAML file first (YAML-first per P-44)
    try {
      fs.unlinkSync(absoluteFilePath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // File already absent — nothing to unlink, proceed
      } else {
        throw new ValidationError(
          `deleteNode failed: artifact removal failed: ${(e as Error).message}`,
          "FILESYSTEM_ERROR",
          { operation: "deleteNode", id }
        );
      }
    }

    // Phase 2 — Delete from SQLite (edges cascade or are deleted separately)
    try {
      const deleteTransaction = this.db.transaction(() => {
        this.db.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).run(id, id);
        this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
      });
      deleteTransaction.exclusive();
    } catch (err: unknown) {
      // Restore the YAML file that was already unlinked
      if (originalContent !== null) {
        try {
          fs.writeFileSync(absoluteFilePath, originalContent, 'utf-8');
        } catch (restoreErr: unknown) {
          throw new ValidationError(
            `operation failed: ${(err as Error).message}; cleanup also failed: ${(restoreErr as Error).message}`,
            "TRANSACTION_FAILED",
            { operation: "deleteNode", id }
          );
        }
      }
      throw new ValidationError(
        `operation failed: ${(err as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "deleteNode", id }
      );
    }

    return { id, status: "deleted" };
  }

  // -------------------------------------------------------------------------
  // putEdge — create an edge (idempotent)
  // -------------------------------------------------------------------------

  async putEdge(edge: Edge): Promise<void> {
    if (!edge.source_id || edge.source_id.trim() === '') {
      throw new ValidationError('Edge source_id required', 'MISSING_EDGE_SOURCE', {});
    }
    if (!edge.target_id || edge.target_id.trim() === '') {
      throw new ValidationError('Edge target_id required', 'MISSING_EDGE_TARGET', {});
    }
    if (!edge.edge_type) {
      throw new ValidationError('Edge type required', 'MISSING_EDGE_TYPE', {});
    }
    if (!(EDGE_TYPES as readonly string[]).includes(edge.edge_type)) {
      throw new ValidationError(`Invalid EdgeType: ${edge.edge_type}`, 'INVALID_EDGE_TYPE', { value: edge.edge_type });
    }
    try {
      insertEdge(this.drizzleDb, {
        source_id: edge.source_id,
        target_id: edge.target_id,
        edge_type: edge.edge_type,
        props: edge.properties && Object.keys(edge.properties).length > 0
          ? JSON.stringify(edge.properties)
          : null,
      });
    } catch (dbErr) {
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "putEdge" }
      );
    }
  }

  // -------------------------------------------------------------------------
  // removeEdges — remove all edges from a source node with specified types
  // -------------------------------------------------------------------------

  async removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void> {
    if (typeof source_id !== 'string' || source_id.trim() === '') {
      throw new ValidationError('source_id must be a non-empty string', 'INVALID_NODE_ID', { value: source_id });
    }
    for (const edge_type of edge_types) {
      if (!(EDGE_TYPES as readonly string[]).includes(edge_type)) {
        throw new ValidationError(`Invalid EdgeType: ${edge_type}`, 'INVALID_EDGE_TYPE', { value: edge_type });
      }
    }
    if (edge_types.length === 0) return;
    const placeholders = edge_types.map(() => "?").join(", ");
    try {
      this.db.prepare(
        `DELETE FROM edges WHERE source_id = ? AND edge_type IN (${placeholders})`
      ).run(source_id, ...edge_types);
    } catch (dbErr) {
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "removeEdges" }
      );
    }
  }

  // -------------------------------------------------------------------------
  // batchMutate — atomically create/update multiple nodes and edges
  // -------------------------------------------------------------------------

  async batchMutate(input: BatchMutateInput): Promise<BatchMutateResult> {
    const { nodes, edges: extraEdges = [] } = input;
    const results: MutateNodeResult[] = [];
    const errors: Array<{ id: string; error: string }> = [];

    // ---------- Input validation ----------
    if (!nodes || nodes.length === 0) {
      throw new ValidationError(
        "Batch mutation requires at least one node",
        "EMPTY_BATCH",
        {}
      );
    }

    const validNodeTypes = new Set<string>(ALL_NODE_TYPES);

    for (const node of nodes) {
      // Validate node has an id property (can be null/undefined for auto-generation)
      if (!("id" in node)) {
        throw new ValidationError(
          "Node is missing required 'id' field",
          "MISSING_NODE_ID",
          { node }
        );
      }

      if (node.type === undefined || node.type === null) {
        throw new ValidationError(
          "Node is missing required 'type' field",
          "MISSING_NODE_TYPE",
          { id: node.id }
        );
      }

      if (!node.properties || typeof node.properties !== "object") {
        throw new ValidationError(
          "Node is missing required 'properties' field",
          "MISSING_NODE_PROPERTIES",
          { id: node.id }
        );
      }

      if (!validNodeTypes.has(node.type)) {
        throw new ValidationError(
          `Invalid node type: "${node.type}"`,
          "INVALID_NODE_TYPE",
          { id: node.id, type: node.type }
        );
      }
    }

    // Valid edge types for validation
    const validEdgeTypes = new Set<string>(EDGE_TYPES);

    for (const edge of extraEdges) {
      if (!edge.source_id) {
        throw new ValidationError(
          "Edge is missing required 'source_id' field",
          "MISSING_EDGE_SOURCE",
          { edge }
        );
      }

      if (!edge.target_id) {
        throw new ValidationError(
          "Edge is missing required 'target_id' field",
          "MISSING_EDGE_TARGET",
          { edge }
        );
      }

      if (!edge.edge_type) {
        throw new ValidationError(
          "Edge is missing required 'edge_type' field",
          "MISSING_EDGE_TYPE",
          { edge }
        );
      }

      if (!validEdgeTypes.has(edge.edge_type)) {
        throw new ValidationError(
          `Invalid edge type: "${edge.edge_type}"`,
          "INVALID_EDGE_TYPE",
          { edge }
        );
      }
    }

    // ---------- Assign IDs to nodes that don't have one ----------
    // For work_item nodes, query current max ID
    const workItemNodes = nodes.filter(n => n.type === "work_item");
    let nextWiId = 0;
    if (workItemNodes.some(n => !n.id)) {
      const maxIdRow = this.db.prepare(
        `SELECT MAX(CAST(REPLACE(n.id, 'WI-', '') AS INTEGER)) as max_id FROM nodes n WHERE n.type = 'work_item'`
      ).get() as { max_id: number | null };
      nextWiId = (maxIdRow?.max_id ?? 0) + 1;
    }

    const resolvedNodes = nodes.map((node) => {
      if (node.id) return { ...node, resolvedId: node.id };
      if (node.type === "work_item") {
        const assignedId = `WI-${String(nextWiId).padStart(3, "0")}`;
        nextWiId++;
        return { ...node, resolvedId: assignedId };
      }
      // For other types without IDs, generate one
      return { ...node, resolvedId: node.id ?? `${node.type}-${Date.now()}` };
    });

    // ---------- DAG cycle detection (for work_item nodes with depends) ----------
    const tempEdgesInserted: Array<{ source: string; target: string }> = [];
    for (const node of resolvedNodes) {
      if (node.type === "work_item" && node.properties.depends && Array.isArray(node.properties.depends)) {
        for (const dep of node.properties.depends as string[]) {
          tempEdgesInserted.push({ source: node.resolvedId, target: dep });
        }
      }
    }

    let cycles: string[][] = [];
    if (tempEdgesInserted.length > 0) {
      const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
      if (fkWasOn) this.db.pragma("foreign_keys = OFF");
      try {
        this.db.exec("SAVEPOINT dag_check");
        const insertEdgeStmt = this.db.prepare(
          `INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`
        );
        for (const { source, target } of tempEdgesInserted) {
          insertEdgeStmt.run(source, target);
        }
        try {
          cycles = detectCycles(this.drizzleDb);
        } catch (err) {
          this.db.exec("ROLLBACK TO dag_check");
          this.db.exec("RELEASE dag_check");
          if (fkWasOn) this.db.pragma("foreign_keys = ON");
          throw new Error(`DAG validation failed: ${(err as Error).message}`);
        }
        this.db.exec("ROLLBACK TO dag_check");
        this.db.exec("RELEASE dag_check");
      } finally {
        if (fkWasOn) this.db.pragma("foreign_keys = ON");
      }
    }

    if (cycles.length > 0) {
      const cycleDesc = cycles.map((c) => c.join(" -> ")).join("; ");
      return {
        results: [],
        errors: [{ id: "*", error: `DAG cycle detected: ${cycleDesc}` }],
      };
    }

    // ---------- Scope collision detection ----------
    const workItemNodesResolved = resolvedNodes.filter(n => n.type === "work_item");
    const itemScopeMap = new Map<string, Set<string>>();
    for (const node of workItemNodesResolved) {
      const filePaths = new Set<string>();
      if (node.properties.scope && Array.isArray(node.properties.scope)) {
        for (const entry of node.properties.scope as Array<{ path: string; op: string }>) {
          if (entry.path) filePaths.add(entry.path);
        }
      }
      itemScopeMap.set(node.resolvedId, filePaths);
    }

    const dependsGraph = new Map<string, Set<string>>();
    for (const node of workItemNodesResolved) {
      const deps = new Set<string>((node.properties.depends as string[] | undefined) ?? []);
      dependsGraph.set(node.resolvedId, deps);
    }

    function isLinkedByDepends(a: string, b: string): boolean {
      function reachable(from: string, to: string): boolean {
        const visited = new Set<string>();
        const queue = [from];
        while (queue.length > 0) {
          const current = queue.shift()!;
          if (current === to) return true;
          if (visited.has(current)) continue;
          visited.add(current);
          for (const dep of dependsGraph.get(current) ?? []) queue.push(dep);
        }
        return false;
      }
      return reachable(a, b) || reachable(b, a);
    }

    const collisionErrors: string[] = [];
    const itemIds = workItemNodesResolved.map(n => n.resolvedId);
    for (let i = 0; i < itemIds.length; i++) {
      for (let j = i + 1; j < itemIds.length; j++) {
        const idA = itemIds[i];
        const idB = itemIds[j];
        if (isLinkedByDepends(idA, idB)) continue;
        const scopeA = itemScopeMap.get(idA) ?? new Set();
        const scopeB = itemScopeMap.get(idB) ?? new Set();
        const shared = [...scopeA].filter(p => scopeB.has(p));
        if (shared.length > 0) {
          collisionErrors.push(`Scope collision between items ${idA} and ${idB}: ${shared.join(", ")}`);
        }
      }
    }

    if (collisionErrors.length > 0) {
      return {
        results: [],
        errors: collisionErrors.map(e => ({ id: "*", error: e })),
      };
    }

    // ---------- Phase 1: Write all YAML files ----------
    const writtenFilePaths: string[] = [];

    for (const node of resolvedNodes) {
      const id = node.resolvedId;
      const type = node.type;
      const properties = node.properties;
      const cycle = node.cycle;

      try {
        const absoluteFilePath = resolveArtifactPath(this.ideateDir, type, id, cycle);
        ensureDir(path.dirname(absoluteFilePath));

        const yamlObj: Record<string, unknown> = {
          id,
          type,
          ...properties,
        };
        if (cycle !== undefined && !("cycle" in yamlObj)) {
          yamlObj.cycle = cycle;
        }

        const contentHash = computeArtifactHash(yamlObj);
        const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
        const tokens = tokenCount(yamlForTokens);
        yamlObj.content_hash = contentHash;
        yamlObj.token_count = tokens;

        const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });
        fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");
        writtenFilePaths.push(absoluteFilePath);
      } catch (err) {
        errors.push({ id, error: (err as Error).message });
      }
    }

    if (errors.length > 0) {
      // Clean up any YAML files written before the error
      for (const fp of writtenFilePaths) {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
      return { results: [], errors };
    }

    // ---------- Check node existence before transaction (for created/updated status) ----------
    const existingNodes = new Set<string>();
    for (const node of resolvedNodes) {
      const existingRow = this.db.prepare(
        `SELECT id FROM nodes WHERE id = ?`
      ).get(node.resolvedId) as { id: string } | undefined;
      if (existingRow) {
        existingNodes.add(node.resolvedId);
      }
    }

    // ---------- Phase 2: SQLite upserts in a single exclusive transaction ----------
    const fkWasOn = this.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) this.db.pragma("foreign_keys = OFF");

    try {
      const upsertPhase = this.db.transaction(() => {
        for (const node of resolvedNodes) {
          const id = node.resolvedId;
          const type = node.type;
          const properties = node.properties;
          const cycle = node.cycle;

          const absoluteFilePath = resolveArtifactPath(this.ideateDir, type, id, cycle);
          const writtenContent = fs.readFileSync(absoluteFilePath, "utf8");
          const parsedWritten = parseYaml(writtenContent) as Record<string, unknown>;
          const contentHash = computeArtifactHash(parsedWritten);

          const cycleForNode = CYCLE_SCOPED_TYPES.has(type) && cycle !== undefined
            ? cycle
            : (properties.cycle_created as number | null) ?? null;

          const nodeRow: NodeRow = {
            id,
            type,
            cycle_created: cycleForNode,
            cycle_modified: null,
            content_hash: contentHash,
            token_count: tokenCount(writtenContent),
            file_path: absoluteFilePath,
            status: (properties.status as string | null) ?? null,
          };

          upsertNode(this.drizzleDb, nodeRow);
          upsertExtensionTableRow(this.drizzleDb, type, id, properties, cycleForNode);
        }

        // Insert extra edges
        for (const edge of extraEdges) {
          insertEdge(this.drizzleDb, {
            source_id: edge.source_id,
            target_id: edge.target_id,
            edge_type: edge.edge_type,
            props: edge.properties && Object.keys(edge.properties).length > 0
              ? JSON.stringify(edge.properties)
              : null,
          });
        }
      });

      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — clean up written YAML files
      for (const fp of writtenFilePaths) {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
      throw new ValidationError(
        `operation failed: ${(dbErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "batchMutate", filePaths: writtenFilePaths }
      );
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    // Build results with correct created/updated status
    for (const node of resolvedNodes) {
      const status = existingNodes.has(node.resolvedId) ? "updated" : "created";
      results.push({ id: node.resolvedId, status });
    }

    return { results, errors };
  }

  // -------------------------------------------------------------------------
  // archiveCycleLocal — atomic cycle archival (copy, verify, delete)
  //
  // Returns a formatted result string. This method is LocalAdapter-specific;
  // the StorageAdapter interface's archiveCycle() delegates here and returns
  // the result string to callers.
  // -------------------------------------------------------------------------

  async archiveCycleLocal(cycle: number): Promise<string> {
    const cycleStr = String(cycle).padStart(3, "0");
    const findingsDir = path.join(this.ideateDir, "cycles", cycleStr, "findings");
    const cycleDir = path.join(this.ideateDir, "archive", "cycles", cycleStr);
    const cycleWorkItemsDir = path.join(cycleDir, "work-items");
    const cycleIncrementalDir = path.join(cycleDir, "incremental");

    // Query SQLite for active work items with cycle_created = cycle
    // This matches the server-side behavior in lifecycle.ts archiveCycle mutation
    const activeWorkItems = this.drizzleDb
      .select({
        id: dbSchema.nodes.id,
        file_path: dbSchema.nodes.file_path,
      })
      .from(dbSchema.nodes)
      .where(
        and(
          eq(dbSchema.nodes.cycle_created, cycle),
          eq(dbSchema.nodes.type, "work_item"),
          eq(dbSchema.nodes.status, "active")
        )
      )
      .all();

    // Query SQLite for active findings with cycle = cycle
    // Findings use the 'cycle' field in the findings table, not cycle_created
    const activeFindings = this.drizzleDb
      .select({
        id: dbSchema.nodes.id,
        file_path: dbSchema.nodes.file_path,
      })
      .from(dbSchema.nodes)
      .innerJoin(dbSchema.findings, eq(dbSchema.nodes.id, dbSchema.findings.id))
      .where(
        and(
          eq(dbSchema.findings.cycle, cycle),
          eq(dbSchema.nodes.type, "finding"),
          eq(dbSchema.nodes.status, "active")
        )
      )
      .all();

    // Build file lists from database queries (no filesystem fallback)
    // This ensures parity with the RemoteAdapter/server behavior
    const incrementalFiles: string[] = [];
    for (const finding of activeFindings) {
      if (finding.file_path && fs.existsSync(finding.file_path)) {
        incrementalFiles.push(finding.file_path);
      }
    }

    const workItemFiles: { src: string; name: string }[] = [];
    for (const wi of activeWorkItems) {
      if (wi.file_path && fs.existsSync(wi.file_path)) {
        workItemFiles.push({ src: wi.file_path, name: path.basename(wi.file_path) });
      }
    }

    // If no files to archive, return early with zero counts
    if (incrementalFiles.length === 0 && workItemFiles.length === 0) {
      return `Archived cycle ${cycle}: 0 work items, 0 incremental reviews moved.`;
    }

    // Phase 1: Copy
    ensureDir(cycleWorkItemsDir);
    ensureDir(cycleIncrementalDir);

    interface CopyRecord { src: string; dst: string; }
    const copied: CopyRecord[] = [];
    const copyErrors: string[] = [];

    for (const srcPath of incrementalFiles) {
      const name = path.basename(srcPath);
      const dstPath = path.join(cycleIncrementalDir, name);
      try {
        fs.copyFileSync(srcPath, dstPath);
        copied.push({ src: srcPath, dst: dstPath });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "ERR_UNKNOWN";
        copyErrors.push(`Failed to copy ${path.basename(srcPath)}: ${code}`);
      }
    }

    for (const { src: srcPath, name } of workItemFiles) {
      const dstPath = path.join(cycleWorkItemsDir, name);
      try {
        fs.copyFileSync(srcPath, dstPath);
        copied.push({ src: srcPath, dst: dstPath });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "ERR_UNKNOWN";
        copyErrors.push(`Failed to copy ${path.basename(srcPath)}: ${code}`);
      }
    }

    if (copyErrors.length > 0) {
      return `Error during cycle archival — no originals deleted:\n${copyErrors.join("\n")}`;
    }

    // Phase 2: Verify
    const verifyErrors: string[] = [];
    for (const { src, dst } of copied) {
      if (!fs.existsSync(dst)) {
        verifyErrors.push(`Verification failed — file missing after copy: ${path.basename(dst)}`);
        continue;
      }
      const srcHash = sha256(fs.readFileSync(src, "utf8"));
      const dstHash = sha256(fs.readFileSync(dst, "utf8"));
      if (srcHash !== dstHash) {
        verifyErrors.push(`Verification failed — content hash mismatch for ${path.basename(dst)}`);
      }
    }

    if (verifyErrors.length > 0) {
      return `Error during cycle archival verification — no originals deleted:\n${verifyErrors.join("\n")}`;
    }

    // Phase 3: Atomic commit — delete originals and update SQLite index in transaction.
    // If anything fails, clean up copied archive files to leave system consistent.
    const deleteStmt = this.db.prepare(`DELETE FROM nodes WHERE file_path = ?`);
    const updatePathStmt = this.db.prepare(`UPDATE nodes SET file_path = ? WHERE file_path = ?`);

    try {
      this.db.transaction(() => {
        // Delete original incremental files
        for (const srcPath of incrementalFiles) {
          fs.unlinkSync(srcPath);
        }
        // Delete original work item files
        for (const { src: srcPath } of workItemFiles) {
          if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
        }
        // Update SQLite index to reflect new paths
        for (const srcPath of incrementalFiles) {
          deleteStmt.run(srcPath);
        }
        for (const { src: srcPath, name } of workItemFiles) {
          const archivePath = path.join(cycleWorkItemsDir, name);
          updatePathStmt.run(archivePath, srcPath);
        }
      }).exclusive();
    } catch (err) {
      // Rollback: remove copied archive files on transaction failure
      for (const { dst } of copied) {
        try {
          if (fs.existsSync(dst)) fs.unlinkSync(dst);
        } catch {
          // Best-effort cleanup
        }
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error during cycle archival — transaction rolled back: ${message}`;
    }

    const workItemCount = workItemFiles.length;
    const incrementalCount = incrementalFiles.length;

    return `Archived cycle ${cycle}: ${workItemCount} work items, ${incrementalCount} incremental reviews moved.`;
  }

  // -------------------------------------------------------------------------
  // archiveCycle — StorageAdapter interface method
  // Delegates to archiveCycleLocal and returns the result string (including
  // error strings) so callers can surface the message to the user.
  // -------------------------------------------------------------------------

  async archiveCycle(cycle: number): Promise<string> {
    return this.archiveCycleLocal(cycle);
  }

  // -------------------------------------------------------------------------
  // appendJournalEntry — StorageAdapter interface method
  // Delegates to putNodeForJournal with the cycle-number parameter renamed.
  // -------------------------------------------------------------------------

  async appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): Promise<string> {
    return this.putNodeForJournal({
      skill: args.skill,
      date: args.date,
      entryType: args.entryType,
      body: args.body,
      cycleNumber: args.cycle,
    });
  }

  // -------------------------------------------------------------------------
  // putNodeForJournal — specialized journal entry writer
  // Three-phase P-44-compliant write: reserve seq (tx1) → YAML (no tx) → finalize (tx2).
  // -------------------------------------------------------------------------

  async putNodeForJournal(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycleNumber: number;
  }): Promise<string> {
    const { skill, date, entryType, body, cycleNumber } = args;
    const cycleStr = String(cycleNumber).padStart(3, "0");

    const journalDir = path.join(this.ideateDir, "cycles", cycleStr, "journal");
    ensureDir(journalDir);

    // -----------------------------------------------------------------------
    // Phase 1 — Allocate and reserve sequence slot (exclusive SQLite tx, raw SQL)
    // Releases the exclusive lock before YAML I/O begins (P-44 requirement).
    // -----------------------------------------------------------------------
    let id: string;
    let filePath: string;
    try {
      const phase1Result = this.db.transaction(() => {
        // MAX+1 strategy prevents sequence-number gaps from deleted entries.
        const maxRow = this.db.prepare(
          `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num FROM nodes WHERE id LIKE ?`
        ).get(`J-${cycleStr}-`.length + 1, `J-${cycleStr}-%`) as { max_num: number | null };
        const seq = (maxRow?.max_num ?? 0) + 1;
        const seqStr = String(seq).padStart(3, "0");
        const allocatedId = `J-${cycleStr}-${seqStr}`;
        const allocatedFilePath = path.join(journalDir, `${allocatedId}.yaml`);

        // Insert placeholder row to reserve the slot; prevents concurrent callers
        // from allocating the same sequence number.
        this.db.prepare(
          `INSERT INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
           VALUES (?, ?, ?, NULL, '', 0, ?, NULL)`
        ).run(allocatedId, "journal_entry", cycleNumber, allocatedFilePath);

        return { id: allocatedId, filePath: allocatedFilePath };
      }).exclusive();
      id = phase1Result.id;
      filePath = phase1Result.filePath;
    } catch (tx1Err) {
      throw new ValidationError(
        `operation failed: ${(tx1Err as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "appendJournalEntry" }
      );
    }

    // -----------------------------------------------------------------------
    // Phase 2 — Write YAML file (outside any transaction, per P-44)
    // On failure: delete placeholder and rethrow.
    // -----------------------------------------------------------------------
    const entryObj = {
      id,
      type: "journal_entry",
      phase: skill,
      date,
      cycle_created: cycleNumber,
      title: entryType,
      content: body,
    };
    const yamlContent = stringifyYaml(entryObj);
    const contentHash = computeArtifactHash(entryObj as Record<string, unknown>);
    const tokens = tokenCount(yamlContent);

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, yamlContent, "utf8");
    } catch (writeErr) {
      // Rollback Phase 1 placeholder (best-effort).
      try {
        this.db.transaction(() => {
          this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
        }).exclusive();
      } catch {
        // best-effort; ignore cleanup errors
      }
      throw writeErr;
    }

    // -----------------------------------------------------------------------
    // Phase 3 — Finalize (exclusive SQLite tx)
    // On failure: unlink YAML, delete placeholder, throw ValidationError.
    // -----------------------------------------------------------------------
    try {
      this.db.transaction(() => {
        const nodeRow: NodeRow = {
          id,
          type: "journal_entry",
          cycle_created: cycleNumber,
          cycle_modified: null,
          content_hash: contentHash,
          token_count: tokens,
          file_path: filePath,
          status: null,
        };
        upsertNode(this.drizzleDb, nodeRow);

        const journalRow: JournalEntryRow = {
          id,
          phase: skill,
          date,
          title: entryType,
          work_item: null,
          content: body,
        };
        upsertJournalEntry(this.drizzleDb, journalRow);
      }).exclusive();
    } catch (txErr) {
      // Rollback: remove YAML and delete placeholder (both best-effort).
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // best-effort; ignore unlink errors
      }
      try {
        this.db.transaction(() => {
          this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
        }).exclusive();
      } catch {
        // best-effort; ignore cleanup errors
      }
      throw new ValidationError(
        `operation failed: ${(txErr as Error).message}`,
        "TRANSACTION_FAILED",
        { operation: "appendJournalEntry", id, filePath }
      );
    }

    return id;
  }
}
