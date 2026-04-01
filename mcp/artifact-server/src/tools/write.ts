import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ToolContext } from "../types.js";
import { detectCycles } from "../indexer.js";
import { TYPE_TO_EXTENSION_TABLE } from "../db.js";
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
  type EdgeRow,
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
  insertEdge,
  upsertProject,
  upsertPhase as upsertPhaseRow,
  computeArtifactHash,
} from "../db-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
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
// handleAppendJournal — per-entry YAML journal write
// ---------------------------------------------------------------------------

export async function handleAppendJournal(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const skill = args.skill as string;
  const date = args.date as string;
  const entryType = args.entry_type as string;
  const body = args.body as string;

  if (!skill || !date || !entryType || !body) {
    throw new Error("Missing required parameters: skill, date, entry_type, body");
  }

  // 1. Determine cycle number: use caller-supplied cycle_number, or query SQLite for max
  let cycleNumber = 0;
  if (args.cycle_number !== undefined && args.cycle_number !== null) {
    cycleNumber = args.cycle_number as number;
  } else {
    const maxCycleRow = ctx.db.prepare(
      `SELECT MAX(cycle_created) as max_cycle FROM nodes WHERE type = 'journal_entry'`
    ).get() as { max_cycle: number | null };
    cycleNumber = maxCycleRow?.max_cycle ?? 0;
  }
  const cycleStr = String(cycleNumber).padStart(3, "0");

  // 2. Ensure journal directory exists before entering transaction
  const journalDir = path.join(ctx.ideateDir, "cycles", cycleStr, "journal");
  ensureDir(journalDir);

  // 3. COUNT, YAML write, and SQLite upserts in a single exclusive transaction
  //    to prevent concurrent callers from deriving the same sequence number (P-44).
  let writtenYamlPath = "";
  let entryId: string;
  try {
    entryId = ctx.db.transaction(() => {
      // 3a. Count existing journal entries for this cycle to get next sequence number
      const seqRow = ctx.db.prepare(
        `SELECT COUNT(*) as cnt FROM nodes WHERE type = 'journal_entry' AND cycle_created = ?`
      ).get(cycleNumber) as { cnt: number };
      const seq = seqRow?.cnt ?? 0;
      const seqStr = String(seq).padStart(3, "0");
      const id = `J-${cycleStr}-${seqStr}`;

      // 3b. Build YAML object
      const entryObj = {
        id,
        type: "journal_entry",
        phase: skill,
        date: date,
        cycle_created: cycleNumber,
        title: entryType,
        content: body,
      };

      // 3c. Serialize and write YAML file (Phase 1 of P-44, inside the exclusive lock)
      const yamlContent = stringifyYaml(entryObj);
      const filePath = path.join(journalDir, `${id}.yaml`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, yamlContent, "utf8");
      writtenYamlPath = filePath;

      // 3d. Upsert SQLite rows (Phase 2 of P-44, same exclusive lock)
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
        date: date,
        title: entryType,
        work_item: null,
        content: body,
      };
      upsertNode(ctx.drizzleDb, nodeRow);
      upsertJournalEntry(ctx.drizzleDb, journalRow);

      return id;
    }).exclusive();
  } catch (txErr) {
    // Transaction failed — SQLite rolled back. If the YAML was written before the
    // upserts threw, clean it up so the filesystem and DB stay in sync.
    if (writtenYamlPath) {
      try {
        if (fs.existsSync(writtenYamlPath)) fs.unlinkSync(writtenYamlPath);
      } catch (cleanupErr) {
        console.error(`handleAppendJournal: failed to remove ${writtenYamlPath} during cleanup:`, (cleanupErr as Error).message);
      }
    }
    throw txErr;
  }

  return `Wrote journal entry ${entryId}.`;
}

// ---------------------------------------------------------------------------
// handleArchiveCycle — atomic cycle archival (3-phase: copy, verify, delete)
// ---------------------------------------------------------------------------

export async function handleArchiveCycle(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const cycleNumber = args.cycle_number as number;

  if (cycleNumber === undefined || cycleNumber === null) {
    throw new Error("Missing required parameters: cycle_number");
  }
  if (typeof cycleNumber !== "number" || !Number.isInteger(cycleNumber) || cycleNumber < 0) {
    throw new Error(`Invalid cycle_number: expected a non-negative integer, got ${JSON.stringify(cycleNumber)}`);
  }

  const cycleStr = String(cycleNumber).padStart(3, "0");
  const findingsDir = path.join(ctx.ideateDir, "cycles", cycleStr, "findings");
  const cycleDir = path.join(ctx.ideateDir, "archive", "cycles", cycleStr);
  const cycleWorkItemsDir = path.join(cycleDir, "work-items");
  const cycleIncrementalDir = path.join(cycleDir, "incremental");

  // Identify findings files (these are passing reviews)
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
    return `Archived cycle ${cycleNumber}: 0 work items, 0 incremental reviews moved.`;
  }

  // Identify work item files referenced by the incremental reviews
  // Parse each review to find the work item ID, then find the work item file
  const workItemsDir = path.join(ctx.ideateDir, "work-items");
  const workItemFiles: { src: string; name: string }[] = [];
  const seenWorkItems = new Set<string>();

  for (const reviewFile of incrementalFiles) {
    let wiId: string | null = null;
    try {
      const content = fs.readFileSync(reviewFile, "utf8");
      // Parse YAML to extract work_item field
      const parsed = parseYaml(content) as Record<string, unknown> | null;
      if (parsed && typeof parsed.work_item === "string" && parsed.work_item.trim()) {
        wiId = parsed.work_item.trim();
      }
    } catch {
      // Skip if unreadable or not valid YAML
    }
    if (wiId && !seenWorkItems.has(wiId)) {
      seenWorkItems.add(wiId);
      const wiFilePath = path.join(workItemsDir, `${wiId}.yaml`);
      if (fs.existsSync(wiFilePath)) {
        workItemFiles.push({ src: wiFilePath, name: `${wiId}.yaml` });
      }
    }
  }

  // Phase 1: Copy — create directories and copy files
  ensureDir(cycleWorkItemsDir);
  ensureDir(cycleIncrementalDir);

  interface CopyRecord {
    src: string;
    dst: string;
  }
  const copied: CopyRecord[] = [];
  const copyErrors: string[] = [];

  // Copy incremental reviews
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

  // Copy work item files
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

  // Phase 2: Verify — confirm all copied files exist and match source content hash
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

  // Phase 3: Delete — only after ALL verifications pass, remove originals
  for (const srcPath of incrementalFiles) {
    fs.unlinkSync(srcPath);
  }
  for (const { src: srcPath } of workItemFiles) {
    if (fs.existsSync(srcPath)) fs.unlinkSync(srcPath);
  }

  // Phase 3b: Update SQLite nodes after file moves.
  // Findings: deleted from the index (archived artifacts are accessed via archive/ paths).
  // Work items: file_path updated to point to archive copy so readArtifactContent still works.
  // All changes wrapped in an exclusive transaction for atomicity.
  const deleteStmt = ctx.db.prepare(`DELETE FROM nodes WHERE file_path = ?`);
  const updatePathStmt = ctx.db.prepare(`UPDATE nodes SET file_path = ? WHERE file_path = ?`);
  ctx.db.transaction(() => {
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

  return `Archived cycle ${cycleNumber}: ${workItemCount} work items, ${incrementalCount} incremental reviews moved.`;
}

// ---------------------------------------------------------------------------
// handleWriteWorkItems — batch work item creation
// ---------------------------------------------------------------------------

interface WorkItemInput {
  id?: string;
  title?: string;
  complexity?: string;
  scope?: Array<{ path: string; op: string }>;
  depends?: string[];
  blocks?: string[];
  criteria?: string[];
  notes_content?: string;
  domain?: string;
  status?: string;
  resolution?: string | null;
  cycle_created?: number | null;
  phase?: string | null;
  work_item_type?: string;
}

export async function handleWriteWorkItems(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const items = args.items as WorkItemInput[];

  if (!items || !Array.isArray(items)) {
    throw new Error("Missing required parameters: items");
  }

  if (items.length === 0) {
    return "items: []\n";
  }

  // Determine next available ID from SQLite
  const maxIdRow = ctx.db.prepare(
    `SELECT MAX(CAST(REPLACE(n.id, 'WI-', '') AS INTEGER)) as max_id FROM nodes n WHERE n.type = 'work_item'`
  ).get() as { max_id: number | null };
  let nextId = (maxIdRow?.max_id ?? 0) + 1;

  // Assign IDs to items that don't have one
  const resolvedItems: (WorkItemInput & { resolvedId: string })[] = items.map((item) => {
    if (item.id) {
      return { ...item, resolvedId: item.id };
    }
    const assigned = `WI-${String(nextId).padStart(3, "0")}`;
    nextId++;
    return { ...item, resolvedId: assigned };
  });

  // DAG validation: read existing edges, add new ones, run cycle detection
  // We temporarily insert edges to run cycle detection, then roll back if cycles detected
  const tempEdgesInserted: Array<{ source: string; target: string }> = [];

  // Collect new dependency edges from the new items
  for (const item of resolvedItems) {
    if (item.depends && item.depends.length > 0) {
      for (const dep of item.depends) {
        tempEdgesInserted.push({ source: item.resolvedId, target: dep });
      }
    }
  }

  // DAG cycle detection: insert temp edges inside a SAVEPOINT, run detection,
  // then always ROLLBACK the savepoint so temp edges never persist.
  let cycles: string[][] = [];
  if (tempEdgesInserted.length > 0) {
    const fkWasOn = ctx.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) ctx.db.pragma("foreign_keys = OFF");
    try {
      ctx.db.exec("SAVEPOINT dag_check");
      const insertEdgeStmt = ctx.db.prepare(
        `INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`
      );
      for (const { source, target } of tempEdgesInserted) {
        insertEdgeStmt.run(source, target);
      }
      try {
        cycles = detectCycles(ctx.drizzleDb);
      } catch (err) {
        ctx.db.exec("ROLLBACK TO dag_check");
        ctx.db.exec("RELEASE dag_check");
        if (fkWasOn) ctx.db.pragma("foreign_keys = ON");
        throw new Error(`DAG validation failed: ${(err as Error).message}`);
      }
      // Always rollback temp edges — they are re-added properly during upsert phase
      ctx.db.exec("ROLLBACK TO dag_check");
      ctx.db.exec("RELEASE dag_check");
    } finally {
      if (fkWasOn) ctx.db.pragma("foreign_keys = ON");
    }
  }

  if (cycles.length > 0) {
    const cycleDesc = cycles.map((c) => c.join(" -> ")).join("; ");
    return `Error: DAG cycle detected — no items written. Cycles: ${cycleDesc}`;
  }

  // Scope collision check: concurrent items must not share file paths
  // Build a map of file paths → items for items not linked by depends_on
  const itemScopeMap = new Map<string, Set<string>>(); // resolvedId -> set of file paths
  for (const item of resolvedItems) {
    const filePaths = new Set<string>();
    if (item.scope) {
      for (const entry of item.scope) {
        if (entry.path) filePaths.add(entry.path);
      }
    }
    itemScopeMap.set(item.resolvedId, filePaths);
  }

  // Build depends_on graph for new items (to identify concurrent pairs)
  const dependsGraph = new Map<string, Set<string>>(); // source -> set of targets
  for (const item of resolvedItems) {
    const deps = new Set<string>(item.depends ?? []);
    dependsGraph.set(item.resolvedId, deps);
  }

  function isLinkedByDepends(a: string, b: string): boolean {
    // BFS to check if a -> ... -> b or b -> ... -> a
    function reachable(from: string, to: string): boolean {
      const visited = new Set<string>();
      const queue = [from];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === to) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const dep of dependsGraph.get(current) ?? []) {
          queue.push(dep);
        }
      }
      return false;
    }
    return reachable(a, b) || reachable(b, a);
  }

  const collisionErrors: string[] = [];
  const itemIds = resolvedItems.map((i) => i.resolvedId);
  for (let i = 0; i < itemIds.length; i++) {
    for (let j = i + 1; j < itemIds.length; j++) {
      const idA = itemIds[i];
      const idB = itemIds[j];
      if (isLinkedByDepends(idA, idB)) continue;

      const scopeA = itemScopeMap.get(idA) ?? new Set();
      const scopeB = itemScopeMap.get(idB) ?? new Set();
      const shared = [...scopeA].filter((p) => scopeB.has(p));
      if (shared.length > 0) {
        collisionErrors.push(
          `Scope collision between items ${idA} and ${idB}: ${shared.join(", ")}`
        );
      }
    }
  }

  if (collisionErrors.length > 0) {
    return `Error: Scope collision detected — no items written.\n${collisionErrors.join("\n")}`;
  }

  // ---------------------------------------------------------------------------
  // Transaction pattern for handleWriteWorkItems:
  //
  //   Phase 1 — YAML files are the source of truth.  Write all files first so
  //             that a crash during this phase leaves no SQLite state at all.
  //             On re-run the caller will re-submit and files are overwritten.
  //
  //   Phase 2 — Wrap ALL SQLite upserts in a single better-sqlite3 transaction.
  //             better-sqlite3 is synchronous, so db.transaction(() => {...})()
  //             is used (not async/await).  If the transaction throws, SQLite is
  //             automatically rolled back by Drizzle/better-sqlite3.
  //
  //   Cleanup  — If the SQLite transaction fails after YAML files were written,
  //              attempt to remove the written files (best-effort: do not
  //              re-throw cleanup errors).  This keeps filesystem and DB in sync.
  //              YAML is the source of truth, so a re-run can always recreate
  //              the DB state from files; removing the files avoids a "ghost"
  //              artifact that the DB does not know about.
  // ---------------------------------------------------------------------------

  // Write Phase: write individual YAML files to {ideateDir}/work-items/{id}.yaml
  const workItemsDir = path.join(ctx.ideateDir, "work-items");
  ensureDir(workItemsDir);

  // Build response entries
  const results: Array<{ id: string; result: string }> = [];
  // Track written file paths for cleanup on SQLite failure
  const writtenFilePaths: string[] = [];

  for (const item of resolvedItems) {
    const id = item.resolvedId;
    const itemStatus = item.status ?? "pending";
    const itemCycleCreated = item.cycle_created ?? null;
    const notesContent = item.notes_content ?? `# ${id}: ${item.title ?? ""}`;

    // Build the absolute file_path stored in both YAML and SQLite for consistency
    const absoluteFilePath = path.join(workItemsDir, `${id}.yaml`);

    // Build complete YAML object with all required fields
    const yamlObj: Record<string, unknown> = {
      id,
      type: "work_item",
      title: item.title ?? "",
      status: itemStatus,
      complexity: item.complexity ?? null,
      scope: item.scope ?? [],
      depends: item.depends ?? [],
      blocks: item.blocks ?? [],
      criteria: item.criteria ?? [],
      domain: item.domain ?? null,
      phase: item.phase ?? null,
      work_item_type: item.work_item_type ?? "feature",
      notes: notesContent,
      resolution: item.resolution !== undefined ? item.resolution : null,
      cycle_created: itemCycleCreated,
      cycle_modified: null,
    };

    // Compute hash over content fields only (excludes content_hash, token_count, file_path)
    // using the shared helper so indexer and write handlers produce identical hashes.
    const contentHash = computeArtifactHash(yamlObj);
    const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
    const tokens = tokenCount(yamlForTokens);

    // Now add the computed fields (no file_path in YAML — storage detail per P-33)
    yamlObj.content_hash = contentHash;
    yamlObj.token_count = tokens;

    const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });

    // Write the YAML file (Phase 1 — source of truth)
    fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");
    writtenFilePaths.push(absoluteFilePath);

    results.push({ id, result: "created" });
  }

  // Phase 2 — Synchronously upsert into SQLite inside a single transaction (GP-8)
  const fkWasOn = ctx.db.pragma("foreign_keys", { simple: true }) as number;
  if (fkWasOn) ctx.db.pragma("foreign_keys = OFF");

  try {
    const upsertPhase = ctx.db.transaction(() => {
      for (const item of resolvedItems) {
        const id = item.resolvedId;
        const itemStatus = item.status ?? "pending";
        const itemCycleCreated = item.cycle_created ?? null;
        const notesContent = item.notes_content ?? `# ${id}: ${item.title ?? ""}`;
        const absoluteFilePath = path.join(workItemsDir, `${id}.yaml`);

        // Read the written YAML file content and parse it; compute hash from content
        // fields only (consistent with indexer and handleWriteArtifact).
        const writtenContent = fs.readFileSync(absoluteFilePath, "utf8");
        const parsedWritten = parseYaml(writtenContent) as Record<string, unknown>;
        const contentHash = computeArtifactHash(parsedWritten);

        const nodeRow: NodeRow = {
          id,
          type: "work_item",
          cycle_created: itemCycleCreated,
          cycle_modified: null,
          content_hash: contentHash,
          token_count: tokenCount(writtenContent),
          file_path: absoluteFilePath,
          status: itemStatus,
        };

        const wiRow: WorkItemRow = {
          id,
          title: item.title ?? "",
          complexity: item.complexity ?? null,
          scope: item.scope ? JSON.stringify(item.scope) : null,
          depends: item.depends ? JSON.stringify(item.depends) : null,
          blocks: item.blocks ? JSON.stringify(item.blocks) : null,
          criteria: item.criteria ? JSON.stringify(item.criteria) : null,
          module: null,
          domain: item.domain ?? null,
          phase: item.phase ?? null,
          notes: notesContent,
          work_item_type: item.work_item_type ?? "feature",
        };

        // Upsert node
        upsertNode(ctx.drizzleDb, nodeRow);

        // Upsert work_items extension
        upsertWorkItem(ctx.drizzleDb, wiRow);

        // Insert dependency edges
        if (item.depends && item.depends.length > 0) {
          for (const dep of item.depends) {
            insertEdge(ctx.drizzleDb, {
              source_id: id,
              target_id: dep,
              edge_type: "depends_on",
              props: null,
            });
          }
        }

        // Insert blocks edges
        if (item.blocks && item.blocks.length > 0) {
          for (const blocked of item.blocks) {
            insertEdge(ctx.drizzleDb, {
              source_id: id,
              target_id: blocked,
              edge_type: "blocks",
              props: null,
            });
          }
        }
      }
    });

    upsertPhase.exclusive();
  } catch (dbErr) {
    // SQLite transaction failed — attempt best-effort cleanup of written YAML files
    // to avoid filesystem/DB divergence.  Do not re-throw cleanup errors.
    console.error("handleWriteWorkItems: SQLite transaction failed, cleaning up YAML files:", (dbErr as Error).message);
    for (const fp of writtenFilePaths) {
      try {
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      } catch (cleanupErr) {
        console.error(`handleWriteWorkItems: failed to remove ${fp} during cleanup:`, (cleanupErr as Error).message);
      }
    }
    throw dbErr;
  } finally {
    if (fkWasOn) ctx.db.pragma("foreign_keys = ON");
  }

  // Format compact YAML response
  const responseYaml = stringifyYaml(results);
  return responseYaml;
}

// ---------------------------------------------------------------------------
// handleWriteArtifact — generic artifact write tool
// ---------------------------------------------------------------------------

/**
 * Determine the output path for an artifact based on its type and id.
 * Returns the absolute file path.
 */
const CYCLE_SCOPED_TYPES = new Set([
  "finding", "cycle_summary", "review_output", "review_manifest", "decision_log",
  "proxy_human_decision",
]);

function resolveArtifactPath(ideateDir: string, type: string, id: string, cycle?: number): string {
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
      // id may include path segments like "refine-029/_general"
      return path.join(ideateDir, "interviews", `${id}.yaml`);
    case "research":
      return path.join(ideateDir, "steering", "research", `${id}.yaml`);
    case "project":
      return path.join(ideateDir, "projects", `${id}.yaml`);
    case "phase":
      return path.join(ideateDir, "phases", `${id}.yaml`);
    default:
      return path.join(ideateDir, type, `${id}.yaml`);
  }
}

export async function handleWriteArtifact(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const type = args.type as string;
  const id = args.id as string;
  const content = args.content as Record<string, unknown>;
  const cycle = typeof args.cycle === "number" ? args.cycle : undefined;

  if (!type || !id) {
    throw new Error("Missing required parameters: type, id");
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("Missing required parameter: content (must be an object)");
  }

  // Redirect specialized types to existing handlers
  if (type === "work_item") {
    return handleWriteWorkItems(ctx, { items: [{ ...content, id }] });
  }
  if (type === "journal_entry") {
    return handleAppendJournal(ctx, content);
  }
  // P-42: Validate that the artifact type is known before resolving the file path
  const validTypes = Object.keys(TYPE_TO_EXTENSION_TABLE);
  if (!validTypes.includes(type)) {
    throw new Error(`Unknown artifact type '${type}'. Valid types: ${validTypes.join(", ")}`);
  }


  // Resolve output path
  const absoluteFilePath = resolveArtifactPath(ctx.ideateDir, type, id, cycle);
  ensureDir(path.dirname(absoluteFilePath));

  // Build YAML object: merge content with id and type
  // For cycle-scoped types, ensure 'cycle' appears as a top-level YAML field so
  // that the indexer can populate document_artifacts.cycle on a rebuild.
  const yamlObj: Record<string, unknown> = {
    id,
    type,
    ...content,
  };
  if (cycle !== undefined && !("cycle" in yamlObj)) {
    yamlObj.cycle = cycle;
  }

  // Compute hash over content fields only (excludes content_hash, token_count, file_path)
  // using the shared helper so indexer and write handlers produce identical hashes.
  const contentHash = computeArtifactHash(yamlObj);
  const yamlForTokens = stringifyYaml(yamlObj, { lineWidth: 0 });
  const tokens = tokenCount(yamlForTokens);

  // Add computed fields (no file_path in YAML — storage detail per P-33)
  yamlObj.content_hash = contentHash;
  yamlObj.token_count = tokens;

  const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });

  // ---------------------------------------------------------------------------
  // Transaction pattern for handleWriteArtifact:
  //
  //   Phase 1 — Write the YAML file first (source of truth).  A crash here
  //             leaves no SQLite state; re-running overwrites the file.
  //
  //   Phase 2 — Wrap ALL SQLite upserts (node row + any extension table rows +
  //             edge inserts) in a single better-sqlite3 synchronous transaction.
  //             better-sqlite3 is synchronous; use db.transaction(() => {...})()
  //             rather than async/await.
  //
  //   Cleanup  — If the SQLite transaction throws, attempt to remove the written
  //              YAML file (best-effort; do not re-throw cleanup errors).
  // ---------------------------------------------------------------------------

  // Phase 1 — Write the YAML file (source of truth)
  fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");

  // Phase 2 — Synchronously upsert into SQLite inside a single transaction (GP-8)
  // For cycle-scoped types, use the cycle parameter for cycle_created
  const cycleForNode = CYCLE_SCOPED_TYPES.has(type) && cycle !== undefined
    ? cycle
    : (content.cycle_created as number | null) ?? null;

  try {
    const upsertPhase = ctx.db.transaction(() => {
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

      upsertNode(ctx.drizzleDb, nodeRow);

      // Insert into type-specific extension tables for domain artifacts
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
        upsertDomainPolicy(ctx.drizzleDb, policyRow);
      } else if (type === "domain_decision") {
        const decisionRow: DomainDecisionRow = {
          id,
          domain: (content.domain as string) ?? "",
          cycle: (content.cycle as number | null) ?? null,
          supersedes: (content.supersedes as string | null) ?? null,
          description: (content.description as string | null) ?? null,
          rationale: (content.rationale as string | null) ?? null,
        };
        upsertDomainDecision(ctx.drizzleDb, decisionRow);
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
        upsertDomainQuestion(ctx.drizzleDb, questionRow);
      } else if (type === "proxy_human_decision") {
        const decisionRow: ProxyHumanDecisionRow = {
          id,
          cycle: (content.cycle as number) ?? 0,
          trigger: (content.trigger as string) ?? "",
          triggered_by: content.triggered_by ? JSON.stringify(content.triggered_by) : null,
          decision: (content.decision as string) ?? "",
          rationale: (content.rationale as string | null) ?? null,
          timestamp: (content.timestamp as string) ?? new Date().toISOString(),
          status: (content.status as string) ?? "resolved",
        };
        upsertProxyHumanDecision(ctx.drizzleDb, decisionRow);

        // Insert triggered_by edges
        if (content.triggered_by && Array.isArray(content.triggered_by)) {
          for (const ref of content.triggered_by as Array<{ type: string; id: string }>) {
            if (ref && ref.id) {
              insertEdge(ctx.drizzleDb, {
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
        upsertGuidingPrinciple(ctx.drizzleDb, principleRow);
      } else if (type === "constraint") {
        const constraintRow: ConstraintRow = {
          id,
          category: (content.category as string) ?? "",
          description: (content.description as string | null) ?? null,
        };
        upsertConstraint(ctx.drizzleDb, constraintRow);
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
          content: typeof content.content === 'string' ? content.content : JSON.stringify(content),
        };
        upsertDocumentArtifact(ctx.drizzleDb, docRow);
      } else if (type === "research_finding") {
        const rfRow: ResearchFindingRow = {
          id,
          topic: (content.topic as string) ?? "",
          date: (content.date as string | null) ?? null,
          content: (content.content as string | null) ?? null,
          sources: content.sources ? JSON.stringify(content.sources) : null,
        };
        upsertResearchFinding(ctx.drizzleDb, rfRow);
      } else if (type === "module_spec") {
        const msRow: ModuleSpecRow = {
          id,
          name: (content.name as string) ?? "",
          scope: (content.scope as string | null) ?? null,
          provides: content.provides ? JSON.stringify(content.provides) : null,
          requires: content.requires ? JSON.stringify(content.requires) : null,
          boundary_rules: content.boundary_rules ? JSON.stringify(content.boundary_rules) : null,
        };
        upsertModuleSpec(ctx.drizzleDb, msRow);
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
        upsertFinding(ctx.drizzleDb, findingRow);
      } else if (type === "metrics_event") {
        // Compute payload JSON from queryable top-level fields (same logic as handleEmitMetric)
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
        upsertMetricsEvent(ctx.drizzleDb, meRow);
      } else if (type === "interview_question") {
        const iqRow: InterviewQuestionRow = {
          id,
          interview_id: (content.interview_id as string) ?? "",
          question: (content.question as string) ?? "",
          answer: (content.answer as string) ?? "",
          domain: (content.domain as string | null) ?? null,
          seq: (content.seq as number) ?? 0,
        };
        upsertInterviewQuestion(ctx.drizzleDb, iqRow);
      } else if (type === "project") {
        const row: ProjectRow = {
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
        upsertProject(ctx.drizzleDb, row);
      } else if (type === "phase") {
        const row: PhaseRow = {
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
        upsertPhaseRow(ctx.drizzleDb, row);
      }
    });
    upsertPhase.exclusive();
  } catch (dbErr) {
    // SQLite transaction failed — attempt best-effort cleanup of the written YAML file
    // to avoid filesystem/DB divergence.  Do not re-throw cleanup errors.
    console.error("handleWriteArtifact: SQLite transaction failed, cleaning up YAML file:", (dbErr as Error).message);
    try {
      if (fs.existsSync(absoluteFilePath)) fs.unlinkSync(absoluteFilePath);
    } catch (cleanupErr) {
      console.error(`handleWriteArtifact: failed to remove ${absoluteFilePath} during cleanup:`, (cleanupErr as Error).message);
    }
    throw dbErr;
  }

  return `Wrote ${type} artifact ${id}.`;
}

// ---------------------------------------------------------------------------
// handleUpdateWorkItems — partial field updates on existing work items
// ---------------------------------------------------------------------------

interface WorkItemUpdate {
  id: string;
  status?: string;
  resolution?: string;
  title?: string;
  complexity?: string;
  depends?: string[];
  blocks?: string[];
  criteria?: string[];
  domain?: string;
  notes?: string;
  scope?: Array<{ path: string; op: string }>;
  phase?: string | null;
  work_item_type?: string;
}

// Fields that must not be overwritten
const IMMUTABLE_FIELDS = new Set(["id", "type", "cycle_created", "file_path"]);

export async function handleUpdateWorkItems(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const updates = args.updates as WorkItemUpdate[];

  if (!updates || !Array.isArray(updates)) {
    throw new Error("Missing required parameter: updates (must be an array)");
  }

  if (updates.length === 0) {
    return "updated: 0\nfailed: 0\nfailures: []\n";
  }

  const workItemsDir = path.join(ctx.ideateDir, "work-items");

  const updatedIds: string[] = [];
  const originalContents = new Map<string, string>(); // id -> original YAML before overwrite
  const failures: Array<{ id: string; reason: string }> = [];

  for (const update of updates) {
    const id = update.id;
    if (!id) {
      failures.push({ id: "(unknown)", reason: "Missing required field: id" });
      continue;
    }

    const filePath = path.join(workItemsDir, `${id}.yaml`);

    // Check file exists
    if (!fs.existsSync(filePath)) {
      failures.push({ id, reason: `Work item not found: ${id}` });
      continue;
    }

    try {
      // Read and parse existing YAML
      const existingContent = fs.readFileSync(filePath, "utf8");
      const existingObj = parseYaml(existingContent) as Record<string, unknown>;

      // Determine current cycle for cycle_modified (try .yaml first, fall back to .md)
      let cycleNumber: number | null = null;
      try {
        const indexYamlPath = path.join(ctx.ideateDir, "domains", "index.yaml");
        const indexMdPath = path.join(ctx.ideateDir, "domains", "index.md");
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
      const updatableFields: Array<keyof WorkItemUpdate> = [
        "status",
        "resolution",
        "title",
        "complexity",
        "depends",
        "blocks",
        "criteria",
        "domain",
        "notes",
        "scope",
        "phase",
        "work_item_type",
      ];

      for (const field of updatableFields) {
        if (field in update && !IMMUTABLE_FIELDS.has(field)) {
          merged[field] = update[field];
        }
      }

      // Update cycle_modified
      merged.cycle_modified = cycleNumber;

      // Recompute hash and token count using shared helper (excludes content_hash,
      // token_count, file_path) so hash is consistent with indexer and other write handlers.
      const contentHash = computeArtifactHash(merged);
      const yamlForTokens = stringifyYaml(merged, { lineWidth: 0 });
      const tokens = tokenCount(yamlForTokens);

      merged.content_hash = contentHash;
      merged.token_count = tokens;
      // Remove file_path from YAML — storage detail per P-33 (also cleans legacy files)
      delete merged.file_path;

      // Write updated YAML back to same path (save original first for rollback)
      const finalYaml = stringifyYaml(merged, { lineWidth: 0 });
      originalContents.set(id, existingContent);
      fs.writeFileSync(filePath, finalYaml, "utf8");

      updatedIds.push(id);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const reason = e.code ? `${e.code} on work item ${id}` : "internal error updating work item";
      failures.push({ id, reason });
    }
  }

  // ---------------------------------------------------------------------------
  // Transaction pattern for handleUpdateWorkItems:
  //
  //   Phase 1 — YAML files are updated in-place per item inside the loop above.
  //             Errors per-item are collected in `failures`; successful writes
  //             accumulate in `updatedIds`.
  //
  //   Phase 2 — Wrap ALL SQLite upserts for successfully-written items in a
  //             single better-sqlite3 synchronous transaction.  If the transaction
  //             throws, attempt best-effort removal of the updated YAML files for
  //             those items (to avoid divergence between filesystem and DB).
  // ---------------------------------------------------------------------------

  // Upsert changed items into SQLite
  if (updatedIds.length > 0) {
    const fkWasOn = ctx.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) ctx.db.pragma("foreign_keys = OFF");

    try {
      const upsertPhase = ctx.db.transaction(() => {
        for (const id of updatedIds) {
          const filePath = path.join(workItemsDir, `${id}.yaml`);
          const writtenContent = fs.readFileSync(filePath, "utf8");
          const parsedObj = parseYaml(writtenContent) as Record<string, unknown>;
          const contentHash = computeArtifactHash(parsedObj);

          const nodeRow = {
            id,
            type: "work_item",
            cycle_created: (parsedObj.cycle_created as number | null) ?? null,
            cycle_modified: (parsedObj.cycle_modified as number | null) ?? null,
            content_hash: contentHash,
            token_count: tokenCount(writtenContent),
            file_path: filePath,
            status: (parsedObj.status as string | null) ?? null,
          };

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

          upsertNode(ctx.drizzleDb, nodeRow);
          upsertWorkItem(ctx.drizzleDb, wiRow);

          // Delete old dependency edges for this item
          ctx.db.prepare(`DELETE FROM edges WHERE source_id = ? AND edge_type IN ('depends_on', 'blocks')`).run(id);

          // Insert new depends_on edges
          for (const dep of (parsedObj.depends as string[] | undefined) || []) {
            ctx.db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`).run(id, dep);
          }

          // Insert new blocks edges
          for (const blk of (parsedObj.blocks as string[] | undefined) || []) {
            ctx.db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'blocks')`).run(id, blk);
          }
        }
      });

      upsertPhase.exclusive();
    } catch (dbErr) {
      // SQLite transaction failed — attempt best-effort cleanup of updated YAML files
      // to avoid filesystem/DB divergence.  Do not re-throw cleanup errors.
      console.error("handleUpdateWorkItems: SQLite transaction failed, restoring original YAML files:", (dbErr as Error).message);
      for (const id of updatedIds) {
        const fp = path.join(workItemsDir, `${id}.yaml`);
        const original = originalContents.get(id);
        try {
          if (original !== undefined) {
            fs.writeFileSync(fp, original, "utf8");
          }
        } catch (cleanupErr) {
          console.error(`handleUpdateWorkItems: failed to restore ${fp} during rollback:`, (cleanupErr as Error).message);
        }
      }
      throw dbErr;
    } finally {
      if (fkWasOn) ctx.db.pragma("foreign_keys = ON");
    }
  }

  const summary = {
    updated: updatedIds.length,
    failed: failures.length,
    failures,
  };

  return stringifyYaml(summary);
}
