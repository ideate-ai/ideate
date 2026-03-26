import * as fs from "fs";
import * as path from "path";
import { ToolContext } from "./index.js";
import { resolveArtifactDir } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WorkItemRow {
  id: string;
  status: string | null;
  title: string;
  depends: string | null;
}

interface IncrementalReview {
  wiId: string;
  verdict: "Pass" | "Fail" | null;
  critical: number;
  significant: number;
  minor: number;
  filePath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scan archive/incremental/*.md files and extract review metadata.
 * Filename pattern: {NNN}-{slug}.md  — WI ID is derived from the number prefix.
 */
function scanIncrementalReviews(artifactDir: string): Map<string, IncrementalReview> {
  const incrementalDir = path.join(artifactDir, "archive", "incremental");
  const reviews = new Map<string, IncrementalReview>();

  if (!fs.existsSync(incrementalDir)) {
    return reviews;
  }

  let files: string[];
  try {
    files = fs.readdirSync(incrementalDir);
  } catch {
    return reviews;
  }

  for (const file of files) {
    if (!file.endsWith(".md")) continue;

    const filePath = path.join(incrementalDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    // Extract WI ID from filename: e.g. "181-schema-v7-ddl.md" → "WI-181"
    const numMatch = file.match(/^(\d+)/);
    if (!numMatch) continue;
    const wiId = `WI-${numMatch[1]}`;

    // Extract verdict: first occurrence of "## Verdict: Pass" or "## Verdict: Fail"
    let verdict: "Pass" | "Fail" | null = null;
    const verdictMatch = content.match(/##\s+Verdict:\s*(Pass|Fail)/i);
    if (verdictMatch) {
      verdict = verdictMatch[1].charAt(0).toUpperCase() + verdictMatch[1].slice(1).toLowerCase() as "Pass" | "Fail";
    }

    // Count finding headings by severity prefix: ### C, ### S, ### M
    const criticalMatches = content.match(/^###\s+C\d+/gm);
    const significantMatches = content.match(/^###\s+S\d+/gm);
    const minorMatches = content.match(/^###\s+M\d+/gm);

    reviews.set(wiId, {
      wiId,
      verdict,
      critical: criticalMatches ? criticalMatches.length : 0,
      significant: significantMatches ? significantMatches.length : 0,
      minor: minorMatches ? minorMatches.length : 0,
      filePath,
    });
  }

  return reviews;
}

/**
 * Query all work items from the DB using a JOIN.
 */
function queryAllWorkItems(ctx: ToolContext): WorkItemRow[] {
  const stmt = ctx.db.prepare(
    `SELECT n.id, n.status, w.title, w.depends
     FROM nodes n
     JOIN work_items w ON w.id = n.id`
  );
  return stmt.all() as WorkItemRow[];
}

/**
 * Check journal_entries for work items recorded as complete.
 * Looks for entries where title matches "Work item {id}:" and content contains "Status: complete".
 */
function buildJournalCompletedSet(ctx: ToolContext): Set<string> {
  const completed = new Set<string>();
  let rows: Array<{ title: string | null; content: string | null }>;
  try {
    const stmt = ctx.db.prepare(
      `SELECT title, content FROM journal_entries`
    );
    rows = stmt.all() as Array<{ title: string | null; content: string | null }>;
  } catch {
    return completed;
  }

  for (const row of rows) {
    if (!row.title || !row.content) continue;
    // Match "Work item WI-NNN:" pattern
    const titleMatch = row.title.match(/Work item\s+(WI-\d+):/i);
    if (!titleMatch) continue;
    if (row.content.toLowerCase().includes("status: complete")) {
      completed.add(titleMatch[1]);
    }
  }

  return completed;
}

// ---------------------------------------------------------------------------
// handleGetExecutionStatus
// ---------------------------------------------------------------------------

export async function handleGetExecutionStatus(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const artifactDir = resolveArtifactDir(args, ctx.ideateDir);

  const rows = queryAllWorkItems(ctx);
  const reviews = scanIncrementalReviews(artifactDir);
  const journalCompleted = buildJournalCompletedSet(ctx);

  // Build dependency map: id → array of dependency IDs
  const dependsMap = new Map<string, string[]>();
  for (const row of rows) {
    let deps: string[] = [];
    try {
      deps = JSON.parse(row.depends || "[]") as string[];
    } catch {
      deps = [];
    }
    dependsMap.set(row.id, deps);
  }

  // Categorise each work item
  const completedSet = new Set<string>();
  const pendingSet = new Set<string>();
  const readySet = new Set<string>();
  const blockedMap = new Map<string, string[]>(); // id → unsatisfied dep IDs

  // First pass: determine completed items
  // An item is completed if:
  //   - DB status is "done" or "complete", OR
  //   - incremental review verdict is "Pass", OR
  //   - journal entry records it as complete
  for (const row of rows) {
    const status = (row.status ?? "").toLowerCase();
    const review = reviews.get(row.id);
    const isComplete =
      status === "done" ||
      status === "complete" ||
      (review !== undefined && review.verdict === "Pass") ||
      journalCompleted.has(row.id);
    if (isComplete) {
      completedSet.add(row.id);
    }
  }

  // Second pass: categorise remaining items
  for (const row of rows) {
    if (completedSet.has(row.id)) continue;

    const deps = dependsMap.get(row.id) ?? [];
    const unsatisfied = deps.filter((dep) => !completedSet.has(dep));

    if (unsatisfied.length === 0) {
      // No unsatisfied deps — ready to execute
      readySet.add(row.id);
    } else {
      // Has unmet deps — blocked
      blockedMap.set(row.id, unsatisfied);
    }
  }

  // Any remaining items that are neither completed, ready, nor blocked are pending
  // (this handles items with empty deps that were missed, shouldn't happen but guard anyway)
  for (const row of rows) {
    if (
      completedSet.has(row.id) ||
      readySet.has(row.id) ||
      blockedMap.has(row.id)
    ) {
      continue;
    }
    pendingSet.add(row.id);
  }

  const total = rows.length;
  const completedList = [...completedSet].sort();
  const pendingList = [...pendingSet].sort();
  const readyList = [...readySet].sort();

  const lines: string[] = [
    "## Execution Status",
    `Completed: ${completedSet.size} (${completedList.join(", ") || "none"})`,
    `Pending: ${pendingSet.size} (${pendingList.join(", ") || "none"})`,
    `Ready to execute: ${readySet.size} (${readyList.join(", ") || "none"})`,
    `Blocked: ${blockedMap.size}`,
  ];

  for (const [id, unsatisfied] of [...blockedMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- ${id} blocked by: ${unsatisfied.join(", ")}`);
  }

  lines.push(`Total: ${total}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// handleGetReviewManifest
// ---------------------------------------------------------------------------

export async function handleGetReviewManifest(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // cycle_number is reserved for future use — accepted but not yet applied
  // const cycleNumber = typeof args.cycle_number === "number" ? args.cycle_number : null;

  const artifactDir = resolveArtifactDir(args, ctx.ideateDir);
  const rows = queryAllWorkItems(ctx);
  const reviews = scanIncrementalReviews(artifactDir);

  // Build table header
  const header = "| # | Title | File Scope | Incremental Verdict | Findings (C/S/M) | Work Item Path | Review Path |";
  const divider = "|---|-------|------------|---------------------|------------------|----------------|-------------|";

  const tableRows: string[] = [];

  // Fetch file_path for each work item from nodes
  const pathStmt = ctx.db.prepare(
    `SELECT id, file_path FROM nodes WHERE type = 'work_item'`
  );
  const pathRows = pathStmt.all() as Array<{ id: string; file_path: string }>;
  const filePathMap = new Map(pathRows.map((r) => [r.id, r.file_path]));

  // Fetch scope for each work item (stored as JSON in work_items.scope)
  const scopeStmt = ctx.db.prepare(
    `SELECT id, scope FROM work_items`
  );
  const scopeRows = scopeStmt.all() as Array<{ id: string; scope: string | null }>;
  const scopeMap = new Map(scopeRows.map((r) => [r.id, r.scope]));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const review = reviews.get(row.id);
    const workItemPath = filePathMap.get(row.id) ?? "";
    const reviewPath = review ? review.filePath : "";

    // Resolve scope: extract file paths from scope JSON
    let scopeDisplay = "";
    const rawScope = scopeMap.get(row.id) ?? null;
    if (rawScope) {
      try {
        const scopeEntries = JSON.parse(rawScope) as Array<{ path?: string; op?: string } | string>;
        const paths = scopeEntries
          .map((e) => (typeof e === "string" ? e : (e.path ?? "")))
          .filter(Boolean)
          .join(", ");
        scopeDisplay = paths;
      } catch {
        scopeDisplay = rawScope;
      }
    }

    const verdict = review ? (review.verdict ?? "None") : "None";
    const findings = review
      ? `${review.critical}/${review.significant}/${review.minor}`
      : "—";

    tableRows.push(
      `| ${i + 1} | ${row.title} | ${scopeDisplay} | ${verdict} | ${findings} | ${workItemPath} | ${reviewPath} |`
    );
  }

  const lines = [header, divider, ...tableRows];
  return lines.join("\n");
}
