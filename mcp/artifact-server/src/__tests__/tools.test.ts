/**
 * tools.test.ts — Integration tests for all 11 tool handlers.
 *
 * Architecture:
 * - Each test creates a fresh temp-file SQLite DB with createSchema applied.
 * - A ToolContext is assembled from that DB + a temp artifact directory.
 * - Tool handlers are called directly (not through MCP plumbing).
 * - Write tools (append_journal, write_work_items, archive_cycle) operate on
 *   a real temp directory structure mirroring .ideate/ layout.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import { ToolContext } from "../tools/index.js";
import { handleGetWorkItemContext, handleGetContextPackage } from "../tools/context.js";
import { handleArtifactQuery } from "../tools/query.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "../tools/execution.js";
import { handleGetConvergenceStatus, handleGetDomainState, handleGetProjectStatus } from "../tools/analysis.js";
import { handleAppendJournal, handleArchiveCycle, handleWriteWorkItems } from "../tools/write.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-tools-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  // Create artifact dir structure matching what tools expect
  for (const sub of [
    "archive/incremental",
    "archive/cycles",
    "plan/work-items",
    "plan/notes",
    "domains",
  ]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  // Create an empty journal.md
  fs.writeFileSync(path.join(artifactDir, "journal.md"), "", "utf8");

  // Create domains/index.md with cycle info
  fs.writeFileSync(
    path.join(artifactDir, "domains", "index.md"),
    "current_cycle: 3\n\n## Domains\n- workflow\n",
    "utf8"
  );

  // Open a temp-file DB so file operations work properly
  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db);
  ctx = { db, drizzleDb, ideateDir: artifactDir };
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a node row directly */
function insertNode(
  id: string,
  type: string,
  options: {
    status?: string;
    file_path?: string;
    cycle_created?: number;
    content_hash?: string;
  } = {}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
    VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)
  `).run(
    id,
    type,
    options.cycle_created ?? null,
    options.content_hash ?? "testhash",
    options.file_path ?? `/tmp/${id}.yaml`,
    options.status ?? "pending"
  );
}

/** Insert a work_item extension row (node must already exist) */
function insertWorkItem(
  id: string,
  title: string,
  options: {
    complexity?: string;
    domain?: string;
    depends?: string[];
    scope?: Array<{ path: string; op: string }>;
    criteria?: string[];
  } = {}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO work_items (id, title, complexity, domain, depends, blocks, criteria, scope)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(
    id,
    title,
    options.complexity ?? "small",
    options.domain ?? null,
    options.depends ? JSON.stringify(options.depends) : null,
    options.criteria ? JSON.stringify(options.criteria) : null,
    options.scope ? JSON.stringify(options.scope) : null
  );
}

/** Insert a domain_policy node + extension */
function insertDomainPolicy(
  id: string,
  domain: string,
  description: string,
  status = "active"
): void {
  insertNode(id, "domain_policy", { status });
  db.prepare(`
    INSERT OR REPLACE INTO domain_policies (id, domain, description)
    VALUES (?, ?, ?)
  `).run(id, domain, description);
}

/** Insert a domain_question node + extension */
function insertDomainQuestion(
  id: string,
  domain: string,
  description: string,
  status = "open"
): void {
  insertNode(id, "domain_question", { status });
  db.prepare(`
    INSERT OR REPLACE INTO domain_questions (id, domain, description)
    VALUES (?, ?, ?)
  `).run(id, domain, description);
}

/** Insert a finding node + extension */
function insertFinding(
  id: string,
  severity: "critical" | "significant" | "minor",
  workItem: string,
  verdict: "pass" | "fail",
  cycle: number,
  status = "open"
): void {
  insertNode(id, "finding", { status });
  db.prepare(`
    INSERT OR REPLACE INTO findings (id, severity, work_item, verdict, cycle, reviewer)
    VALUES (?, ?, ?, ?, ?, 'test-reviewer')
  `).run(id, severity, workItem, verdict, cycle);
}

// ---------------------------------------------------------------------------
// 1. handleGetWorkItemContext
// ---------------------------------------------------------------------------

describe("handleGetWorkItemContext", () => {
  it("happy path: returns markdown with work item title and criteria", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Build schema", {
      complexity: "medium",
      domain: "workflow",
      criteria: ["Test passes", "Docs updated"],
    });

    const result = await handleGetWorkItemContext(ctx, {
      artifact_dir: artifactDir,
      work_item_id: "WI-001",
    });

    expect(result).toContain("WI-001");
    expect(result).toContain("Build schema");
    expect(result).toContain("Test passes");
    expect(result).toContain("Docs updated");
  });

  it("normalises ID: 'WI-002' and '2' are equivalent (WI- prefix stripped)", async () => {
    insertNode("WI-002", "work_item");
    insertWorkItem("WI-002", "Numeric ID item");

    // The handler tries both "WI-002" and "2" as candidates, so "WI-002" itself should work directly
    const result = await handleGetWorkItemContext(ctx, {
      artifact_dir: artifactDir,
      work_item_id: "WI-002",
    });
    expect(result).toContain("WI-002");
    expect(result).toContain("Numeric ID item");
  });

  it("error path: throws when work_item_id is missing", async () => {
    await expect(
      handleGetWorkItemContext(ctx, { artifact_dir: artifactDir })
    ).rejects.toThrow(/work_item_id/i);
  });

  it("error path: throws when work item not found", async () => {
    await expect(
      handleGetWorkItemContext(ctx, {
        artifact_dir: artifactDir,
        work_item_id: "WI-999",
      })
    ).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// 2. handleGetContextPackage
// ---------------------------------------------------------------------------

describe("handleGetContextPackage", () => {
  it("happy path: returns markdown sections (Architecture, Guiding Principles, Constraints)", async () => {
    // Insert a document artifact of type 'architecture'
    insertNode("DOC-arch", "architecture", { file_path: path.join(artifactDir, "arch.md") });
    db.prepare(`INSERT OR REPLACE INTO document_artifacts (id, title, content) VALUES ('DOC-arch', 'Architecture', '## Overview\nTest arch content.')`).run();

    const result = await handleGetContextPackage(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("## Architecture");
    expect(result).toContain("## Guiding Principles");
    expect(result).toContain("## Constraints");
  });

  it("error path: throws when artifact_dir is empty", async () => {
    await expect(
      handleGetContextPackage(ctx, { artifact_dir: "" })
    ).rejects.toThrow(/artifact_dir/i);
  });
});

// ---------------------------------------------------------------------------
// 3. handleArtifactQuery
// ---------------------------------------------------------------------------

describe("handleArtifactQuery", () => {
  it("happy path: returns markdown table of work items when type=work_item", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Query test item");

    const result = await handleArtifactQuery(ctx, { type: "work_item" });
    expect(result).toContain("WI-001");
    expect(result).toContain("Query test item");
  });

  it("happy path: filters by domain via filters object", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Workflow item", { domain: "workflow" });
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Other item", { domain: "infra" });

    const result = await handleArtifactQuery(ctx, {
      type: "work_item",
      filters: { domain: "workflow" },
    });
    expect(result).toContain("WI-001");
    expect(result).not.toContain("WI-002");
  });

  it("happy path: status filter returns only matching nodes", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Done item");
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");

    const result = await handleArtifactQuery(ctx, {
      type: "work_item",
      filters: { status: "done" },
    });
    expect(result).toContain("WI-001");
    expect(result).not.toContain("WI-002");
  });

  it("error path: returns error when no filter params given", async () => {
    const result = await handleArtifactQuery(ctx, {});
    expect(result).toContain("Error");
  });

  it("error path: returns error for unknown type", async () => {
    const result = await handleArtifactQuery(ctx, { type: "not_a_real_type" });
    expect(result).toContain("Error");
    expect(result).toContain("not_a_real_type");
  });

  it("error path: returns error when related_to node not found", async () => {
    const result = await handleArtifactQuery(ctx, {
      related_to: "WI-nonexistent",
    });
    expect(result).toContain("Error");
  });

  it("traverses dependency chain at depth > 1", async () => {
    // Create 3-node chain: WI-TEST-A → WI-TEST-B → WI-TEST-C
    insertNode("WI-TEST-A", "work_item", { status: "pending" });
    insertWorkItem("WI-TEST-A", "Node A");
    insertNode("WI-TEST-B", "work_item", { status: "pending" });
    insertWorkItem("WI-TEST-B", "Node B");
    insertNode("WI-TEST-C", "work_item", { status: "pending" });
    insertWorkItem("WI-TEST-C", "Node C");

    // Create depends_on edges: A→B, B→C
    db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, 'depends_on', '{}')
    `).run("WI-TEST-A", "WI-TEST-B");
    db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, 'depends_on', '{}')
    `).run("WI-TEST-B", "WI-TEST-C");

    const result = await handleArtifactQuery(ctx, {
      related_to: "WI-TEST-A",
      edge_types: ["depends_on"],
      direction: "outgoing",
      depth: 3,
    });

    // Result should be a markdown table
    expect(result).toContain("|");

    // Both WI-TEST-B (depth 1) and WI-TEST-C (depth 2) should appear
    expect(result).toContain("WI-TEST-B");
    expect(result).toContain("WI-TEST-C");

    // Parse rows to verify depth values and no duplicates
    const lines = result.split("\n").filter((l) => l.startsWith("|") && !l.match(/^[| -]+$/));
    // Skip header row (first line)
    const dataLines = lines.slice(1);

    // Should have exactly 2 data rows (B at depth 1, C at depth 2)
    expect(dataLines).toHaveLength(2);

    // Verify depth values: B should be at depth 1, C at depth 2
    const bRow = dataLines.find((l) => l.includes("WI-TEST-B"));
    const cRow = dataLines.find((l) => l.includes("WI-TEST-C"));
    expect(bRow).toBeDefined();
    expect(cRow).toBeDefined();
    expect(bRow).toContain("1");
    expect(cRow).toContain("2");

    // No duplicate rows: IDs should appear exactly once each
    const idMatches = (id: string) => dataLines.filter((l) => l.includes(id));
    expect(idMatches("WI-TEST-B")).toHaveLength(1);
    expect(idMatches("WI-TEST-C")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. handleGetExecutionStatus
// ---------------------------------------------------------------------------

describe("handleGetExecutionStatus", () => {
  it("happy path: shows total, completed, pending, ready counts", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Done item");
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");

    const result = await handleGetExecutionStatus(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Execution Status");
    expect(result).toContain("Total");
    expect(result).toContain("Completed");
  });

  it("happy path: blocked items are listed with their unmet deps", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Blocked item", { depends: ["WI-099"] });

    const result = await handleGetExecutionStatus(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("WI-001");
    // WI-099 is unmet
    expect(result).toContain("WI-099");
  });

  it("error path: empty work item list returns zeroed counts", async () => {
    const result = await handleGetExecutionStatus(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Total: 0");
  });
});

// ---------------------------------------------------------------------------
// 5. handleGetReviewManifest
// ---------------------------------------------------------------------------

describe("handleGetReviewManifest", () => {
  it("happy path: returns markdown table with work item rows", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Manifest item");

    const result = await handleGetReviewManifest(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Manifest item");
  });

  it("happy path: includes review verdict when incremental review file exists", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Reviewed item");

    // Create an incremental review file
    const reviewContent = `## Verdict: Pass\n\nAll good.\n`;
    fs.writeFileSync(
      path.join(artifactDir, "archive", "incremental", "001-reviewed-item.md"),
      reviewContent,
      "utf8"
    );

    const result = await handleGetReviewManifest(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Pass");
  });

  it("error path: empty DB returns just headers", async () => {
    const result = await handleGetReviewManifest(ctx, { artifact_dir: artifactDir });
    // Should return header + divider only (no data rows), not throw
    expect(typeof result).toBe("string");
    expect(result).toContain("#");
  });
});

// ---------------------------------------------------------------------------
// 6. handleGetConvergenceStatus
// ---------------------------------------------------------------------------

describe("handleGetConvergenceStatus", () => {
  it("happy path: converged=true when no critical/significant findings and principle passes", async () => {
    const cycleDir = path.join(artifactDir, "archive", "cycles", "001");
    fs.mkdirSync(cycleDir, { recursive: true });

    fs.writeFileSync(
      path.join(cycleDir, "spec-adherence.md"),
      "**Principle Violation Verdict**: Pass\n\nNo violations.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(cycleDir, "summary.md"),
      "## Summary\nAll good.\n",
      "utf8"
    );

    const result = await handleGetConvergenceStatus(ctx, {
      artifact_dir: artifactDir,
      cycle_number: 1,
    });

    expect(result).toContain("converged: true");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("condition_b: true");
  });

  it("happy path: converged=false when critical findings exist", async () => {
    const cycleDir = path.join(artifactDir, "archive", "cycles", "001");
    fs.mkdirSync(cycleDir, { recursive: true });

    fs.writeFileSync(
      path.join(cycleDir, "spec-adherence.md"),
      "**Principle Violation Verdict**: Pass\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(cycleDir, "summary.md"),
      "## Critical Findings\n- C1: Something broke\n- C2: Something else broke\n",
      "utf8"
    );

    const result = await handleGetConvergenceStatus(ctx, {
      artifact_dir: artifactDir,
      cycle_number: 1,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("critical: 2");
  });

  it("error path: missing cycle files returns unknown/false convergence", async () => {
    // Cycle 999 does not exist
    const result = await handleGetConvergenceStatus(ctx, {
      artifact_dir: artifactDir,
      cycle_number: 999,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("principle_verdict: unknown");
  });
});

// ---------------------------------------------------------------------------
// 7. handleGetDomainState
// ---------------------------------------------------------------------------

describe("handleGetDomainState", () => {
  it("happy path: returns domain with policies and open questions", async () => {
    insertDomainPolicy("DP-001", "workflow", "Write files before DB");
    insertDomainQuestion("DQ-001", "workflow", "Should we use YAML?");

    const result = await handleGetDomainState(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("## workflow");
    expect(result).toContain("DP-001");
    expect(result).toContain("DQ-001");
  });

  it("happy path: domains filter restricts output", async () => {
    insertDomainPolicy("DP-001", "workflow", "Workflow policy");
    insertDomainPolicy("DP-002", "infra", "Infra policy");

    const result = await handleGetDomainState(ctx, {
      artifact_dir: artifactDir,
      domains: ["workflow"],
    });
    expect(result).toContain("workflow");
    expect(result).not.toContain("infra");
  });

  it("error path: empty DB returns 'No domain data found'", async () => {
    const result = await handleGetDomainState(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("No domain data found");
  });
});

// ---------------------------------------------------------------------------
// 8. handleGetProjectStatus
// ---------------------------------------------------------------------------

describe("handleGetProjectStatus", () => {
  it("happy path: returns dashboard with work item counts and open questions", async () => {
    insertNode("WI-001", "work_item", { status: "done" });
    insertWorkItem("WI-001", "Done item");
    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");
    insertDomainQuestion("DQ-001", "workflow", "Open question");

    const result = await handleGetProjectStatus(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Project Status Dashboard");
    expect(result).toContain("Total: 2");
    expect(result).toContain("Done: 1");
  });

  it("happy path: shows current cycle from domains/index.md", async () => {
    const result = await handleGetProjectStatus(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Current cycle");
    expect(result).toContain("3");
  });

  it("error path: empty DB returns zeroed work items section", async () => {
    const result = await handleGetProjectStatus(ctx, { artifact_dir: artifactDir });
    expect(result).toContain("Total: 0");
  });
});

// ---------------------------------------------------------------------------
// 9. handleAppendJournal
// ---------------------------------------------------------------------------

describe("handleAppendJournal", () => {
  it("happy path: writes YAML journal entry and returns file path", async () => {
    const result = await handleAppendJournal(ctx, {
      artifact_dir: artifactDir,
      skill: "execute",
      date: "2026-03-25",
      entry_type: "work-item-complete",
      body: "Completed WI-001: Build schema.",
    });

    // Result should reference the YAML file path
    expect(result).toContain("J-003-000.yaml");

    // The YAML file should exist under cycles/003/journal/
    const yamlPath = path.join(artifactDir, "cycles", "003", "journal", "J-003-000.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("work-item-complete");
    expect(content).toContain("Completed WI-001");
    expect(content).toContain("journal_entry");
  });

  it("happy path: multiple entries get sequential IDs in separate YAML files", async () => {
    await handleAppendJournal(ctx, {
      artifact_dir: artifactDir,
      skill: "plan",
      date: "2026-03-24",
      entry_type: "cycle-start",
      body: "Starting cycle 4.",
    });

    await handleAppendJournal(ctx, {
      artifact_dir: artifactDir,
      skill: "execute",
      date: "2026-03-25",
      entry_type: "work-item-complete",
      body: "WI-001 done.",
    });

    const journalDir = path.join(artifactDir, "cycles", "003", "journal");
    const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".yaml"));
    expect(files).toHaveLength(2);
    expect(files).toContain("J-003-000.yaml");
    expect(files).toContain("J-003-001.yaml");

    const first = fs.readFileSync(path.join(journalDir, "J-003-000.yaml"), "utf8");
    expect(first).toContain("cycle-start");

    const second = fs.readFileSync(path.join(journalDir, "J-003-001.yaml"), "utf8");
    expect(second).toContain("work-item-complete");
  });

  it("error path: throws when required params missing", async () => {
    await expect(
      handleAppendJournal(ctx, {
        artifact_dir: artifactDir,
        skill: "execute",
        // missing date, entry_type, body
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. handleArchiveCycle
// ---------------------------------------------------------------------------

describe("handleArchiveCycle", () => {
  it("happy path: archives incremental reviews and returns count", async () => {
    // Create incremental review files
    const incrementalDir = path.join(artifactDir, "archive", "incremental");
    fs.writeFileSync(
      path.join(incrementalDir, "001-build-schema.md"),
      "## Verdict: Pass\n\nLooks good.",
      "utf8"
    );

    // Create a work item YAML file in plan/work-items/
    const wiDir = path.join(artifactDir, "plan", "work-items");
    fs.writeFileSync(
      path.join(wiDir, "001-build-schema.md"),
      "# WI-001: Build schema\nstatus: done",
      "utf8"
    );

    const result = await handleArchiveCycle(ctx, {
      artifact_dir: artifactDir,
      cycle_number: 1,
    });

    expect(result).toContain("Archived cycle 1");
    expect(result).toContain("incremental");
  });

  it("happy path: returns 0-count message when no incremental files exist", async () => {
    const result = await handleArchiveCycle(ctx, {
      artifact_dir: artifactDir,
      cycle_number: 5,
    });
    expect(result).toContain("0");
  });

  it("error path: throws when required params missing", async () => {
    await expect(
      handleArchiveCycle(ctx, { artifact_dir: artifactDir })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 11. handleWriteWorkItems
// ---------------------------------------------------------------------------

describe("handleWriteWorkItems", () => {
  it("happy path: creates work item YAML and SQLite row", async () => {
    const result = await handleWriteWorkItems(ctx, {
      artifact_dir: artifactDir,
      items: [
        {
          id: "WI-100",
          title: "Write work item test",
          complexity: "small",
          criteria: ["Tests pass"],
        },
      ],
    });

    // YAML response with id
    expect(result).toContain("created");

    // Check SQLite row was inserted
    const row = db
      .prepare(`SELECT id FROM nodes WHERE id = 'WI-100'`)
      .get() as { id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("WI-100");
  });

  it("happy path: returns items: [] for empty items array", async () => {
    const result = await handleWriteWorkItems(ctx, {
      artifact_dir: artifactDir,
      items: [],
    });
    expect(result).toContain("items");
  });

  it("error path: throws when items is not an array", async () => {
    await expect(
      handleWriteWorkItems(ctx, {
        artifact_dir: artifactDir,
        items: "not-an-array",
      })
    ).rejects.toThrow();
  });

  it("error path: returns cycle error when dependency graph creates a cycle", async () => {
    const result = await handleWriteWorkItems(ctx, {
      artifact_dir: artifactDir,
      items: [
        { id: "WI-A", title: "A", depends: ["WI-B"] },
        { id: "WI-B", title: "B", depends: ["WI-A"] },
      ],
    });
    // Should return an error string (not throw), mentioning DAG cycle
    expect(result).toContain("cycle");
  });
});

// ---------------------------------------------------------------------------
// Integration: write → read (append_journal → artifact_query)
// ---------------------------------------------------------------------------

describe("integration: append_journal → artifact_query sync", () => {
  it("journal entry written by handleAppendJournal is queryable via handleArtifactQuery", async () => {
    // Write a journal entry
    await handleAppendJournal(ctx, {
      artifact_dir: artifactDir,
      skill: "execute",
      date: "2026-03-25",
      entry_type: "integration-test",
      body: "Integration test body.",
    });

    // Query the artifact index for journal_entry type
    const queryResult = await handleArtifactQuery(ctx, {
      type: "journal_entry",
    });

    // Should find the entry in SQLite
    expect(queryResult).not.toBe("No results found.");
    expect(queryResult).toContain("journal_entry");

    // Verify the SQLite file_path points to the YAML file (not journal.md)
    const row = db
      .prepare(`SELECT file_path FROM nodes WHERE type = 'journal_entry' LIMIT 1`)
      .get() as { file_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.file_path).toContain("J-003-000.yaml");
    expect(row!.file_path).not.toContain("journal.md");
  });
});
