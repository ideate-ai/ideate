import { stringify as stringifyYaml } from "yaml";
import type { ToolContext } from "../types.js";
import { TYPE_TO_EXTENSION_TABLE } from "../db.js";
import { LocalAdapter } from "../adapters/local/index.js";
import type { StorageAdapter } from "../adapter.js";

// ---------------------------------------------------------------------------
// Adapter resolution
//
// Handlers call getAdapter(ctx) to get a StorageAdapter.  If ctx.adapter is
// set (production path, injected by server.ts), it is used directly.
// Otherwise a LocalAdapter is constructed on-the-fly from ctx.db/drizzleDb/
// ideateDir — this preserves backward compatibility with existing tests that
// create ctx = { db, drizzleDb, ideateDir } without an adapter.
// ---------------------------------------------------------------------------

function getAdapter(ctx: ToolContext): StorageAdapter {
  if (ctx.adapter) return ctx.adapter;
  if (!ctx.db || !ctx.drizzleDb) {
    throw new Error("write.ts: ToolContext must provide either adapter or db/drizzleDb");
  }
  return new LocalAdapter({ db: ctx.db, drizzleDb: ctx.drizzleDb, ideateDir: ctx.ideateDir });
}

// ---------------------------------------------------------------------------
// handleAppendJournal — per-entry YAML journal write
// ---------------------------------------------------------------------------

export async function handleAppendJournal(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const skill = args.skill as string;
  const date = args.date as string;
  const entryType = args.entry_type as string;
  const body = args.body as string;

  if (!skill || !date || !entryType || !body) {
    throw new Error("Missing required parameters: skill, date, entry_type, body");
  }

  // Determine cycle number: use caller-supplied cycle_number, or query SQLite for max
  let cycleNumber = 0;
  if (args.cycle_number !== undefined && args.cycle_number !== null) {
    cycleNumber = args.cycle_number as number;
  } else {
    if (!ctx.db) throw new Error("handleAppendJournal: ctx.db required when cycle_number is not supplied");
    const maxCycleRow = ctx.db.prepare(
      `SELECT MAX(cycle_created) as max_cycle FROM nodes WHERE type = 'journal_entry'`
    ).get() as { max_cycle: number | null };
    cycleNumber = maxCycleRow?.max_cycle ?? 0;
  }

  const adapter = getAdapter(ctx);

  // Delegate to adapter's journal write (handles exclusive transaction + sequence numbering)
  const entryId = await (adapter as LocalAdapter).putNodeForJournal({
    skill,
    date,
    entryType,
    body,
    cycleNumber,
  });

  return `Wrote journal entry ${entryId}.`;
}

// ---------------------------------------------------------------------------
// handleArchiveCycle — atomic cycle archival (3-phase: copy, verify, delete)
// ---------------------------------------------------------------------------

export async function handleArchiveCycle(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const cycleNumber = args.cycle_number as number;

  if (cycleNumber === undefined || cycleNumber === null) {
    throw new Error("Missing required parameters: cycle_number");
  }
  if (typeof cycleNumber !== "number" || !Number.isInteger(cycleNumber) || cycleNumber < 0) {
    throw new Error(`Invalid cycle_number: expected a non-negative integer, got ${JSON.stringify(cycleNumber)}`);
  }

  const adapter = getAdapter(ctx);

  // Use archiveCycleLocal to get the count/status message when adapter is a LocalAdapter.
  // This preserves the original response format (counts, error strings as return values).
  if (adapter instanceof LocalAdapter) {
    return adapter.archiveCycleLocal(cycleNumber);
  }

  // For non-local adapters (remote), delegate to the interface method and return a generic message.
  await adapter.archiveCycle(cycleNumber);
  return `Archived cycle ${cycleNumber}.`;
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
  const items = args.items as WorkItemInput[];

  if (!items || !Array.isArray(items)) {
    throw new Error("Missing required parameters: items");
  }

  if (items.length === 0) {
    return "items: []\n";
  }

  const adapter = getAdapter(ctx);

  // Assign IDs to items that don't have one.
  // Use adapter.nextId to get the first available ID, then increment locally.
  let nextIdNum = 0;
  if (items.some(item => !item.id)) {
    const firstId = await adapter.nextId("work_item");
    // Parse the numeric part from "WI-NNN"
    nextIdNum = parseInt(firstId.replace("WI-", ""), 10);
  }

  const resolvedItems: (WorkItemInput & { resolvedId: string })[] = items.map((item) => {
    if (item.id) return { ...item, resolvedId: item.id };
    const assigned = `WI-${String(nextIdNum).padStart(3, "0")}`;
    nextIdNum++;
    return { ...item, resolvedId: assigned };
  });

  // Delegate batch operation to adapter (DAG validation, scope collision,
  // two-phase write, rollback all happen inside adapter.batchMutate)
  const batchResult = await adapter.batchMutate({
    nodes: resolvedItems.map(item => ({
      id: item.resolvedId,
      type: "work_item" as const,
      properties: {
        title: item.title ?? "",
        complexity: item.complexity ?? null,
        scope: item.scope ?? [],
        depends: item.depends ?? [],
        blocks: item.blocks ?? [],
        criteria: item.criteria ?? [],
        domain: item.domain ?? null,
        phase: item.phase ?? null,
        work_item_type: item.work_item_type ?? "feature",
        notes: item.notes_content ?? `# ${item.resolvedId}: ${item.title ?? ""}`,
        resolution: item.resolution !== undefined ? item.resolution : null,
        status: item.status ?? "pending",
        cycle_created: item.cycle_created ?? null,
        cycle_modified: null,
      },
    })),
  });

  // If batchMutate returns errors, check for DAG cycle / scope collision
  if (batchResult.errors.length > 0) {
    const dagError = batchResult.errors.find(e => e.error.includes("DAG cycle"));
    if (dagError) {
      const cycleDesc = dagError.error.replace("DAG cycle detected: ", "");
      return `Error: DAG cycle detected — no items written. Cycles: ${cycleDesc}`;
    }
    const collisionErrors = batchResult.errors.filter(e => e.error.includes("Scope collision"));
    if (collisionErrors.length > 0) {
      return `Error: Scope collision detected — no items written.\n${collisionErrors.map(e => e.error).join("\n")}`;
    }
    // Other errors
    return `Error writing work items:\n${batchResult.errors.map(e => e.error).join("\n")}`;
  }

  // Format compact YAML response
  const results = batchResult.results.map(r => ({ id: r.id, result: r.status }));
  return stringifyYaml(results);
}

// ---------------------------------------------------------------------------
// handleWriteArtifact — generic artifact write tool
// ---------------------------------------------------------------------------

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

  const adapter = getAdapter(ctx);

  await adapter.putNode({
    id,
    type: type as import("../adapter.js").NodeType,
    properties: content,
    cycle,
  });

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

  const adapter = getAdapter(ctx);

  const updatedIds: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];

  for (const update of updates) {
    const id = update.id;
    if (!id) {
      failures.push({ id: "(unknown)", reason: "Missing required field: id" });
      continue;
    }

    // Build the properties object from the update (only updatable fields)
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

    const properties: Record<string, unknown> = {};
    for (const field of updatableFields) {
      if (field in update && field !== "id") {
        properties[field] = update[field];
      }
    }

    try {
      const result = await adapter.patchNode({ id, properties });
      if (result.status === "not_found") {
        failures.push({ id, reason: `Work item not found: ${id}` });
      } else {
        updatedIds.push(id);
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const reason = e.code ? `${e.code} on work item ${id}` : "internal error updating work item";
      failures.push({ id, reason });
      // Re-throw errors from the DB layer (test expectations rely on this)
      throw err;
    }
  }

  const summary = {
    updated: updatedIds.length,
    failed: failures.length,
    failures,
  };

  return stringifyYaml(summary);
}
