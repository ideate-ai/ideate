/**
 * writer.ts — LocalAdapter write operations.
 *
 * Extracted storage logic from tools/write.ts. Implements the write-side of
 * the StorageAdapter interface: putNode, patchNode, deleteNode, putEdge,
 * removeEdges, batchMutate, archiveCycle, nextId.
 *
 * Two-phase write pattern (YAML first, SQLite second) is preserved here and
 * is invisible to tool handlers. Tool handlers call adapter methods; storage
 * details (YAML I/O, SQLite upserts, rollback) are encapsulated in this module.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
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
import { ImmutableFieldError } from "../../adapter.js";

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

  constructor(config: LocalWriterConfig) {
    this.db = config.db;
    this.drizzleDb = config.drizzleDb;
    this.ideateDir = config.ideateDir;
  }

  // -------------------------------------------------------------------------
  // nextId — generate the next available ID for a given node type
  // -------------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    if (type === "journal_entry") {
      // Journal entries: J-{cycleStr}-{seqStr}
      const cycleNum = cycle ?? 0;
      const cycleStr = String(cycleNum).padStart(3, "0");
      const seqRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM nodes WHERE type = 'journal_entry' AND cycle_created = ?`
      ).get(cycleNum) as { cnt: number };
      const seq = seqRow?.cnt ?? 0;
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
      const maxRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM nodes WHERE type = 'finding' AND cycle_created = ?`
      ).get(cycleNum) as { cnt: number };
      const seq = (maxRow?.cnt ?? 0) + 1;
      return `F-${cycleStr}-${String(seq).padStart(3, "0")}`;
    }

    // For all other types, raise an error — ID generation is type-specific
    throw new Error(`nextId: no ID format defined for type '${type}'`);
  }

  // -------------------------------------------------------------------------
  // putNode — create or replace a node (two-phase write)
  // -------------------------------------------------------------------------

  async putNode(input: MutateNodeInput): Promise<MutateNodeResult> {
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

    // Compute hash over content fields only
    const contentHash = computeArtifactHash(yamlObj);
    const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
    const tokens = tokenCount(yamlForTokens);

    // Add computed fields (no file_path in YAML)
    yamlObj.content_hash = contentHash;
    yamlObj.token_count = tokens;

    const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });

    // Determine if this is a create or update
    const existingRow = this.db.prepare(
      `SELECT id FROM nodes WHERE id = ?`
    ).get(id) as { id: string } | undefined;
    const isUpdate = existingRow !== undefined;

    // Phase 1 — Write the YAML file (source of truth)
    fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");

    // Phase 2 — SQLite upserts in a single exclusive transaction
    const cycleForNode = CYCLE_SCOPED_TYPES.has(type) && cycle !== undefined
      ? cycle
      : (content.cycle_created as number | null) ?? null;

    try {
      const upsertPhase = this.db.transaction(() => {
        const nodeRow: NodeRow = {
          id,
          type,
          cycle_created: cycleForNode,
          cycle_modified: (content.cycle_modified as number | null) ?? null,
          content_hash: contentHash,
          token_count: tokens,
          file_path: absoluteFilePath,
          status: (content.status as string | null) ?? null,
        };

        upsertNode(this.drizzleDb, nodeRow);
        upsertExtensionTableRow(this.drizzleDb, type, id, content, cycleForNode);
      });
      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — clean up the YAML file
      console.error("LocalAdapter.putNode: SQLite transaction failed, cleaning up YAML file:", (dbErr as Error).message);
      try {
        if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
      } catch (cleanupErr) {
        console.error(`LocalAdapter.putNode: failed to remove ${absoluteFilePath} during cleanup:`, (cleanupErr as Error).message);
      }
      throw dbErr;
    }

    return { id, status: isUpdate ? "updated" : "created" };
  }

  // -------------------------------------------------------------------------
  // patchNode — partially update an existing node's properties
  // -------------------------------------------------------------------------

  async patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult> {
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

    // Determine current cycle for cycle_modified
    let cycleNumber: number | null = null;
    try {
      const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
      const indexMdPath = path.join(this.ideateDir, "domains", "index.md");
      let indexContent: string | null = null;
      if (fs.existsSync(indexYamlPath)) {
        indexContent = fs.readFileSync(indexYamlPath, "utf8");
      } else if (fs.existsSync(indexMdPath)) {
        indexContent = fs.readFileSync(indexMdPath, "utf8");
      }
      if (indexContent) {
        const match = indexContent.match(/^current_cycle:\s*(\d+)/m);
        if (match) {
          cycleNumber = parseInt(match[1], 10);
        }
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
            work_item_type: (parsedObj.work_item_type as string | null) ?? "feature",
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
      console.error("LocalAdapter.patchNode: SQLite transaction failed, restoring original YAML:", (dbErr as Error).message);
      try {
        fs.writeFileSync(filePath, existingContent, "utf8");
      } catch (cleanupErr) {
        console.error(`LocalAdapter.patchNode: failed to restore ${filePath}:`, (cleanupErr as Error).message);
      }
      throw dbErr;
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    return { id, status: "updated" };
  }

  // -------------------------------------------------------------------------
  // deleteNode — delete a node and its associated edges
  // -------------------------------------------------------------------------

  async deleteNode(id: string): Promise<DeleteNodeResult> {
    const nodeRow = this.db.prepare(
      `SELECT file_path FROM nodes WHERE id = ?`
    ).get(id) as { file_path: string } | undefined;

    if (!nodeRow) {
      return { id, status: "not_found" };
    }

    // Delete from SQLite (edges cascade or are deleted separately)
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).run(id, id);
      this.db.prepare(`DELETE FROM nodes WHERE id = ?`).run(id);
    })();

    // Best-effort: remove YAML file
    try {
      if (fs.existsSync(nodeRow.file_path)) {
        fs.unlinkSync(nodeRow.file_path);
      }
    } catch {
      // ignore filesystem errors
    }

    return { id, status: "deleted" };
  }

  // -------------------------------------------------------------------------
  // putEdge — create an edge (idempotent)
  // -------------------------------------------------------------------------

  async putEdge(edge: Edge): Promise<void> {
    insertEdge(this.drizzleDb, {
      source_id: edge.source_id,
      target_id: edge.target_id,
      edge_type: edge.edge_type,
      props: edge.properties && Object.keys(edge.properties).length > 0
        ? JSON.stringify(edge.properties)
        : null,
    });
  }

  // -------------------------------------------------------------------------
  // removeEdges — remove all edges from a source node with specified types
  // -------------------------------------------------------------------------

  async removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void> {
    if (edge_types.length === 0) return;
    const placeholders = edge_types.map(() => "?").join(", ");
    this.db.prepare(
      `DELETE FROM edges WHERE source_id = ? AND edge_type IN (${placeholders})`
    ).run(source_id, ...edge_types);
  }

  // -------------------------------------------------------------------------
  // batchMutate — atomically create/update multiple nodes and edges
  // -------------------------------------------------------------------------

  async batchMutate(input: BatchMutateInput): Promise<BatchMutateResult> {
    const { nodes, edges: extraEdges = [] } = input;
    const results: MutateNodeResult[] = [];
    const errors: Array<{ id: string; error: string }> = [];

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
            status: (properties.status as string | null) ?? "pending",
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
      console.error("LocalAdapter.batchMutate: SQLite transaction failed, cleaning up YAML files:", (dbErr as Error).message);
      for (const fp of writtenFilePaths) {
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
      }
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
      throw dbErr;
    } finally {
      if (fkWasOn) this.db.pragma("foreign_keys = ON");
    }

    // Build results
    for (const node of resolvedNodes) {
      results.push({ id: node.resolvedId, status: "created" });
    }

    return { results, errors };
  }

  // -------------------------------------------------------------------------
  // archiveCycleLocal — atomic cycle archival (copy, verify, delete)
  //
  // Returns a formatted result string matching the original handleArchiveCycle
  // response format. This method is LocalAdapter-specific; the StorageAdapter
  // interface's archiveCycle() calls this and discards the result (returns void).
  // Tool handlers that need the count message cast to LocalAdapter and call this.
  // -------------------------------------------------------------------------

  async archiveCycleLocal(cycle: number): Promise<string> {
    const cycleStr = String(cycle).padStart(3, "0");
    const findingsDir = path.join(this.ideateDir, "cycles", cycleStr, "findings");
    const cycleDir = path.join(this.ideateDir, "archive", "cycles", cycleStr);
    const cycleWorkItemsDir = path.join(cycleDir, "work-items");
    const cycleIncrementalDir = path.join(cycleDir, "incremental");

    // Identify findings files
    const incrementalFiles: string[] = [];
    if (fs.existsSync(findingsDir)) {
      for (const entry of fs.readdirSync(findingsDir)) {
        const fullPath = path.join(findingsDir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          incrementalFiles.push(fullPath);
        }
      }
    }

    if (incrementalFiles.length === 0) {
      return `Archived cycle ${cycle}: 0 work items, 0 incremental reviews moved.`;
    }

    // Identify work item files referenced by the incremental reviews
    const workItemsDir = path.join(this.ideateDir, "work-items");
    const workItemFiles: { src: string; name: string }[] = [];
    const seenWorkItems = new Set<string>();

    for (const reviewFile of incrementalFiles) {
      let wiId: string | null = null;
      try {
        const content = fs.readFileSync(reviewFile, "utf8");
        const parsed = parseYaml(content) as Record<string, unknown> | null;
        if (parsed && typeof parsed.work_item === "string" && parsed.work_item.trim()) {
          wiId = parsed.work_item.trim();
        }
      } catch {
        // Skip if unreadable
      }
      if (wiId && !seenWorkItems.has(wiId)) {
        seenWorkItems.add(wiId);
        const wiFilePath = path.join(workItemsDir, `${wiId}.yaml`);
        if (fs.existsSync(wiFilePath)) {
          workItemFiles.push({ src: wiFilePath, name: `${wiId}.yaml` });
        }
      }
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

    // Phase 3: Delete originals
    for (const srcPath of incrementalFiles) {
      fs.unlinkSync(srcPath);
    }
    for (const { src: srcPath } of workItemFiles) {
      if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
    }

    // Phase 3b: Update SQLite index
    const deleteStmt = this.db.prepare(`DELETE FROM nodes WHERE file_path = ?`);
    const updatePathStmt = this.db.prepare(`UPDATE nodes SET file_path = ? WHERE file_path = ?`);
    this.db.transaction(() => {
      for (const srcPath of incrementalFiles) {
        deleteStmt.run(srcPath);
      }
      for (const { src: srcPath, name } of workItemFiles) {
        const archivePath = path.join(cycleWorkItemsDir, name);
        updatePathStmt.run(archivePath, srcPath);
      }
    }).exclusive();

    const workItemCount = workItemFiles.length;
    const incrementalCount = incrementalFiles.length;

    return `Archived cycle ${cycle}: ${workItemCount} work items, ${incrementalCount} incremental reviews moved.`;
  }

  // -------------------------------------------------------------------------
  // archiveCycle — StorageAdapter interface method (returns void)
  // Calls archiveCycleLocal and discards the result string.
  // -------------------------------------------------------------------------

  async archiveCycle(cycle: number): Promise<void> {
    const result = await this.archiveCycleLocal(cycle);
    // Propagate errors embedded in the result string as exceptions
    if (result.startsWith("Error during cycle archival")) {
      throw new Error(result);
    }
  }

  // -------------------------------------------------------------------------
  // putNodeForJournal — specialized journal entry writer
  // Handles the exclusive-transaction sequence-number pattern.
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

    let writtenYamlPath = "";
    let entryId: string;

    try {
      entryId = this.db.transaction(() => {
        // Count existing journal entries for this cycle to get next sequence number
        const seqRow = this.db.prepare(
          `SELECT COUNT(*) as cnt FROM nodes WHERE type = 'journal_entry' AND cycle_created = ?`
        ).get(cycleNumber) as { cnt: number };
        const seq = seqRow?.cnt ?? 0;
        const seqStr = String(seq).padStart(3, "0");
        const id = `J-${cycleStr}-${seqStr}`;

        // Build YAML object
        const entryObj = {
          id,
          type: "journal_entry",
          phase: skill,
          date,
          cycle_created: cycleNumber,
          title: entryType,
          content: body,
        };

        // Serialize and write YAML file (inside exclusive lock)
        const yamlContent = stringifyYaml(entryObj);
        const filePath = path.join(journalDir, `${id}.yaml`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, yamlContent, "utf8");
        writtenYamlPath = filePath;

        // Upsert SQLite rows
        const contentHash = computeArtifactHash(entryObj as Record<string, unknown>);
        const nodeRow: NodeRow = {
          id,
          type: "journal_entry",
          cycle_created: cycleNumber,
          cycle_modified: null,
          content_hash: contentHash,
          token_count: tokenCount(yamlContent),
          file_path: filePath,
          status: null,
        };
        const journalRow: JournalEntryRow = {
          id,
          phase: skill,
          date,
          title: entryType,
          work_item: null,
          content: body,
        };
        upsertNode(this.drizzleDb, nodeRow);
        upsertJournalEntry(this.drizzleDb, journalRow);

        return id;
      }).exclusive();
    } catch (txErr) {
      if (writtenYamlPath) {
        try {
          if (fs.existsSync(writtenYamlPath)) fs.unlinkSync(writtenYamlPath);
        } catch (cleanupErr) {
          console.error(`LocalAdapter.putNodeForJournal: failed to remove ${writtenYamlPath}:`, (cleanupErr as Error).message);
        }
      }
      throw txErr;
    }

    return entryId;
  }
}
