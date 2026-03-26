import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ToolContext } from "./index.js";
import { detectCycles } from "../indexer.js";
import { nodes, workItems, edges, journalEntries } from "../db.js";

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

  // 1. Determine cycle number from domains/index.md
  let cycleNumber = 0;
  const indexMdPath = path.join(ctx.ideateDir, "domains", "index.md");
  if (fs.existsSync(indexMdPath)) {
    const indexContent = fs.readFileSync(indexMdPath, "utf8");
    const match = indexContent.match(/current_cycle:\s*(\d+)/);
    if (match) {
      cycleNumber = parseInt(match[1], 10);
    }
  }
  const cycleStr = String(cycleNumber).padStart(3, "0");

  // 2. Determine sequence number from existing files in the journal directory
  const journalDir = path.join(ctx.ideateDir, "cycles", cycleStr, "journal");
  ensureDir(journalDir);

  let seq = 0;
  const prefix = `J-${cycleStr}-`;
  const existingFiles = fs.readdirSync(journalDir).filter(
    (f) => f.startsWith(prefix) && f.endsWith(".yaml")
  );
  seq = existingFiles.length;
  const seqStr = String(seq).padStart(3, "0");

  // 3. Generate ID
  const entryId = `J-${cycleStr}-${seqStr}`;

  // 4. Build YAML object
  const entryObj = {
    id: entryId,
    type: "journal_entry",
    phase: skill,
    date: date,
    cycle_created: cycleNumber,
    title: entryType,
    content: body,
  };

  // 5. Serialize with yaml library
  const yamlContent = stringifyYaml(entryObj);

  // 6. Write to .ideate/cycles/{NNN}/journal/{id}.yaml
  const yamlFilePath = path.join(journalDir, `${entryId}.yaml`);
  fs.writeFileSync(yamlFilePath, yamlContent, "utf8");

  // 7. Synchronously upsert into SQLite with file_path pointing to YAML file
  const contentHash = sha256(yamlContent);

  const nodeRow = {
    id: entryId,
    type: "journal_entry",
    cycle_created: cycleNumber,
    cycle_modified: null,
    content_hash: contentHash,
    token_count: tokenCount(yamlContent),
    file_path: yamlFilePath,
    status: null,
  };

  const journalRow = {
    phase: skill,
    date: date,
    title: entryType,
    work_item: null,
    content: body,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.drizzleDb.insert(nodes as any).values(nodeRow as any).onConflictDoUpdate({
    target: (nodes as any).id,
    set: nodeRow as any,
  }).run();

  const journalRowWithId = { id: entryId, ...journalRow };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.drizzleDb.insert(journalEntries as any).values(journalRowWithId as any).onConflictDoUpdate({
    target: (journalEntries as any).id,
    set: journalRow as any,
  }).run();

  return `Wrote journal entry ${entryId} to ${yamlFilePath}.`;
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

  const cycleStr = String(cycleNumber).padStart(3, "0");
  const incrementalDir = path.join(ctx.ideateDir, "archive", "incremental");
  const cycleDir = path.join(ctx.ideateDir, "archive", "cycles", cycleStr);
  const cycleWorkItemsDir = path.join(cycleDir, "work-items");
  const cycleIncrementalDir = path.join(cycleDir, "incremental");

  // Identify incremental review files (these are passing reviews)
  const incrementalFiles: string[] = [];
  if (fs.existsSync(incrementalDir)) {
    for (const entry of fs.readdirSync(incrementalDir)) {
      const fullPath = path.join(incrementalDir, entry);
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
  const workItemsDir = path.join(ctx.ideateDir, "plan", "work-items");
  const workItemFiles: { src: string; name: string }[] = [];
  const seenWorkItems = new Set<string>();

  for (const reviewFile of incrementalFiles) {
    const reviewName = path.basename(reviewFile);
    // Convention: review files are named like {NNN}-{name}.md
    // Extract the numeric prefix to find matching work item
    const match = reviewName.match(/^(\d+)/);
    if (match) {
      const wiId = match[1];
      if (!seenWorkItems.has(wiId)) {
        seenWorkItems.add(wiId);
        // Look for the work item file in plan/work-items/
        if (fs.existsSync(workItemsDir)) {
          const wiEntries = fs.readdirSync(workItemsDir);
          const wiFile = wiEntries.find((e) => e.startsWith(wiId + "-") || e === wiId + ".md" || e === wiId + ".yaml");
          if (wiFile) {
            workItemFiles.push({ src: path.join(workItemsDir, wiFile), name: wiFile });
          }
        }
      }
    }
  }

  // Phase 1: Copy — create directories and copy files
  ensureDir(cycleWorkItemsDir);
  ensureDir(cycleIncrementalDir);

  interface CopyRecord {
    src: string;
    dst: string;
    srcSize: number;
  }
  const copied: CopyRecord[] = [];
  const copyErrors: string[] = [];

  // Copy incremental reviews
  for (const srcPath of incrementalFiles) {
    const name = path.basename(srcPath);
    const dstPath = path.join(cycleIncrementalDir, name);
    try {
      fs.copyFileSync(srcPath, dstPath);
      const srcSize = fs.statSync(srcPath).size;
      copied.push({ src: srcPath, dst: dstPath, srcSize });
    } catch (err) {
      copyErrors.push(`Failed to copy ${srcPath}: ${(err as Error).message}`);
    }
  }

  // Copy work item files
  for (const { src: srcPath, name } of workItemFiles) {
    const dstPath = path.join(cycleWorkItemsDir, name);
    try {
      fs.copyFileSync(srcPath, dstPath);
      const srcSize = fs.statSync(srcPath).size;
      copied.push({ src: srcPath, dst: dstPath, srcSize });
    } catch (err) {
      copyErrors.push(`Failed to copy ${srcPath}: ${(err as Error).message}`);
    }
  }

  if (copyErrors.length > 0) {
    return `Error during cycle archival — no originals deleted:\n${copyErrors.join("\n")}`;
  }

  // Phase 2: Verify — confirm all copied files exist and match source size
  const verifyErrors: string[] = [];
  for (const { dst, srcSize } of copied) {
    if (!fs.existsSync(dst)) {
      verifyErrors.push(`Verification failed — destination missing: ${dst}`);
      continue;
    }
    const dstSize = fs.statSync(dst).size;
    if (dstSize !== srcSize) {
      verifyErrors.push(`Verification failed — size mismatch for ${dst} (expected ${srcSize}, got ${dstSize})`);
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
    fs.unlinkSync(srcPath);
  }

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

  // Insert temp edges (FK is OFF or nodes may not exist yet — use raw SQL to avoid FK issues)
  if (tempEdgesInserted.length > 0) {
    const fkWasOn = ctx.db.pragma("foreign_keys", { simple: true }) as number;
    if (fkWasOn) ctx.db.pragma("foreign_keys = OFF");
    try {
      const insertEdgeStmt = ctx.db.prepare(
        `INSERT OR IGNORE INTO edges (source_id, target_id, edge_type) VALUES (?, ?, 'depends_on')`
      );
      for (const { source, target } of tempEdgesInserted) {
        insertEdgeStmt.run(source, target);
      }
    } finally {
      if (fkWasOn) ctx.db.pragma("foreign_keys = ON");
    }
  }

  // Run cycle detection
  let cycles: string[][];
  try {
    cycles = detectCycles(ctx.drizzleDb);
  } catch (err) {
    // Roll back temp edges
    if (tempEdgesInserted.length > 0) {
      const delStmt = ctx.db.prepare(
        `DELETE FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = 'depends_on'`
      );
      for (const { source, target } of tempEdgesInserted) {
        delStmt.run(source, target);
      }
    }
    throw new Error(`DAG validation failed: ${(err as Error).message}`);
  }

  if (cycles.length > 0) {
    // Roll back temp edges
    const delStmt = ctx.db.prepare(
      `DELETE FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = 'depends_on'`
    );
    for (const { source, target } of tempEdgesInserted) {
      delStmt.run(source, target);
    }
    const cycleDesc = cycles.map((c) => c.join(" -> ")).join("; ");
    return `Error: DAG cycle detected — no items written. Cycles: ${cycleDesc}`;
  }

  // Remove temp edges (they'll be re-added properly during upsert phase)
  if (tempEdgesInserted.length > 0) {
    const delStmt = ctx.db.prepare(
      `DELETE FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = 'depends_on'`
    );
    for (const { source, target } of tempEdgesInserted) {
      delStmt.run(source, target);
    }
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

  // Write Phase: write individual YAML files to {ideateDir}/work-items/{id}.yaml
  const workItemsDir = path.join(ctx.ideateDir, "work-items");
  ensureDir(workItemsDir);

  // Build response entries
  const results: Array<{ id: string; result: string; file_path: string }> = [];

  for (const item of resolvedItems) {
    const id = item.resolvedId;
    const itemStatus = item.status ?? "pending";
    const itemCycleCreated = item.cycle_created ?? null;
    const notesContent = item.notes_content ?? `# ${id}: ${item.title ?? ""}`;

    // Build the relative file_path stored in the YAML and SQLite
    const relativeFilePath = path.join(".ideate", "work-items", `${id}.yaml`);
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
      notes: notesContent,
      resolution: item.resolution !== undefined ? item.resolution : null,
      cycle_created: itemCycleCreated,
      cycle_modified: null,
    };

    // Serialize to YAML string (before adding hash/token fields so hash is stable)
    // We compute hash over the content excluding hash/token fields themselves
    const yamlForHash = stringifyYaml(yamlObj, { lineWidth: 0 });
    const contentHash = sha256(yamlForHash);
    const tokens = tokenCount(yamlForHash);

    // Now add the computed fields and file_path
    yamlObj.content_hash = contentHash;
    yamlObj.token_count = tokens;
    yamlObj.file_path = relativeFilePath;

    const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });

    // Write the YAML file
    fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");

    results.push({ id, result: "created", file_path: relativeFilePath });
  }

  // Synchronously upsert into SQLite (GP-8)
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

        // Read the written YAML file content for hashing (consistent with what was written)
        const writtenContent = fs.readFileSync(absoluteFilePath, "utf8");
        const contentHash = sha256(writtenContent);

        const nodeRow = {
          id,
          type: "work_item",
          cycle_created: itemCycleCreated,
          cycle_modified: null,
          content_hash: contentHash,
          token_count: tokenCount(writtenContent),
          file_path: absoluteFilePath,
          status: itemStatus,
        };

        const wiRow = {
          title: item.title ?? "",
          complexity: item.complexity ?? null,
          scope: item.scope ? JSON.stringify(item.scope) : null,
          depends: item.depends ? JSON.stringify(item.depends) : null,
          blocks: item.blocks ? JSON.stringify(item.blocks) : null,
          criteria: item.criteria ? JSON.stringify(item.criteria) : null,
          module: null,
          domain: item.domain ?? null,
          notes: notesContent,
        };

        // Upsert node
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.drizzleDb.insert(nodes as any).values(nodeRow as any).onConflictDoUpdate({
          target: (nodes as any).id,
          set: nodeRow as any,
        }).run();

        // Upsert work_items extension
        const wiRowWithId = { id, ...wiRow };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ctx.drizzleDb.insert(workItems as any).values(wiRowWithId as any).onConflictDoUpdate({
          target: (workItems as any).id,
          set: wiRow as any,
        }).run();

        // Insert dependency edges
        if (item.depends && item.depends.length > 0) {
          for (const dep of item.depends) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.drizzleDb.insert(edges as any).values({
              source_id: id,
              target_id: dep,
              edge_type: "depends_on",
              props: null,
            } as any).onConflictDoNothing().run();
          }
        }

        // Insert blocks edges
        if (item.blocks && item.blocks.length > 0) {
          for (const blocked of item.blocks) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx.drizzleDb.insert(edges as any).values({
              source_id: id,
              target_id: blocked,
              edge_type: "blocks",
              props: null,
            } as any).onConflictDoNothing().run();
          }
        }
      }
    });

    upsertPhase();
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
function resolveArtifactPath(ideateDir: string, type: string, id: string): string {
  switch (type) {
    case "overview":
    case "execution_strategy":
    case "architecture":
      return path.join(ideateDir, "plan", `${id}.yaml`);
    case "guiding_principles":
    case "constraints":
      return path.join(ideateDir, "steering", `${id}.yaml`);
    case "interview":
      // id may include path segments like "refine-029/_general"
      return path.join(ideateDir, "interviews", `${id}.yaml`);
    case "research":
      return path.join(ideateDir, "steering", "research", `${id}.yaml`);
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

  if (!type || !id) {
    throw new Error("Missing required parameters: type, id");
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    throw new Error("Missing required parameter: content (must be an object)");
  }

  // Redirect specialized types to existing handlers
  if (type === "work_item") {
    return handleWriteWorkItems(ctx, { items: [{ id, ...content }] });
  }
  if (type === "journal_entry") {
    return handleAppendJournal(ctx, content);
  }

  // Resolve output path
  const absoluteFilePath = resolveArtifactPath(ctx.ideateDir, type, id);
  ensureDir(path.dirname(absoluteFilePath));

  // Compute relative file_path from the .ideate/ directory name
  // e.g., if ideateDir = /project/.ideate, file_path = .ideate/plan/overview.yaml
  const ideateDirName = path.basename(ctx.ideateDir);
  const relativeFilePath = path.join(
    ideateDirName,
    path.relative(ctx.ideateDir, absoluteFilePath)
  );

  // Build YAML object: merge content with id and type
  const yamlObj: Record<string, unknown> = {
    id,
    type,
    ...content,
  };

  // Remove computed fields before hashing so hash is stable
  const forHash: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(yamlObj)) {
    if (k !== "content_hash" && k !== "token_count" && k !== "file_path") {
      forHash[k] = v;
    }
  }

  const yamlForHash = stringifyYaml(forHash, { lineWidth: 0 });
  const contentHash = sha256(yamlForHash);
  const tokens = tokenCount(yamlForHash);

  // Add computed fields
  yamlObj.content_hash = contentHash;
  yamlObj.token_count = tokens;
  yamlObj.file_path = relativeFilePath;

  const finalYaml = stringifyYaml(yamlObj, { lineWidth: 0 });

  // Write the YAML file
  fs.writeFileSync(absoluteFilePath, finalYaml, "utf8");

  // Upsert into SQLite (GP-8 write pattern)
  const nodeRow = {
    id,
    type,
    cycle_created: (content.cycle_created as number | null) ?? null,
    cycle_modified: (content.cycle_modified as number | null) ?? null,
    content_hash: contentHash,
    token_count: tokens,
    file_path: absoluteFilePath,
    status: (content.status as string | null) ?? null,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx.drizzleDb.insert(nodes as any).values(nodeRow as any).onConflictDoUpdate({
    target: (nodes as any).id,
    set: nodeRow as any,
  }).run();

  return `Wrote ${type} artifact ${id} to ${absoluteFilePath}.`;
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
      failures.push({ id, reason: `Work item file not found: ${filePath}` });
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
          const match = indexContent.match(/current_cycle:\s*(\d+)/);
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
      ];

      for (const field of updatableFields) {
        if (field in update && !IMMUTABLE_FIELDS.has(field)) {
          merged[field] = update[field];
        }
      }

      // Update cycle_modified
      merged.cycle_modified = cycleNumber;

      // Recompute hash and token count (over content without hash/token/file_path fields)
      const forHash: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(merged)) {
        if (k !== "content_hash" && k !== "token_count" && k !== "file_path") {
          forHash[k] = v;
        }
      }
      const yamlForHash = stringifyYaml(forHash, { lineWidth: 0 });
      const contentHash = sha256(yamlForHash);
      const tokens = tokenCount(yamlForHash);

      merged.content_hash = contentHash;
      merged.token_count = tokens;

      // Write updated YAML back to same path
      const finalYaml = stringifyYaml(merged, { lineWidth: 0 });
      fs.writeFileSync(filePath, finalYaml, "utf8");

      updatedIds.push(id);
    } catch (err) {
      failures.push({ id, reason: (err as Error).message });
    }
  }

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
          const contentHash = sha256(writtenContent);

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

          const wiRow = {
            title: (parsedObj.title as string) ?? "",
            complexity: (parsedObj.complexity as string | null) ?? null,
            scope: parsedObj.scope ? JSON.stringify(parsedObj.scope) : null,
            depends: parsedObj.depends ? JSON.stringify(parsedObj.depends) : null,
            blocks: parsedObj.blocks ? JSON.stringify(parsedObj.blocks) : null,
            criteria: parsedObj.criteria ? JSON.stringify(parsedObj.criteria) : null,
            module: null,
            domain: (parsedObj.domain as string | null) ?? null,
            notes: (parsedObj.notes as string | null) ?? null,
          };

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx.drizzleDb.insert(nodes as any).values(nodeRow as any).onConflictDoUpdate({
            target: (nodes as any).id,
            set: nodeRow as any,
          }).run();

          const wiRowWithId = { id, ...wiRow };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ctx.drizzleDb.insert(workItems as any).values(wiRowWithId as any).onConflictDoUpdate({
            target: (workItems as any).id,
            set: wiRow as any,
          }).run();
        }
      });

      upsertPhase();
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
