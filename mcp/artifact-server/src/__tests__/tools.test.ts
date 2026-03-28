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

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import { ToolContext } from "../tools/index.js";
import { handleGetWorkItemContext, handleGetContextPackage, handleAssembleContext } from "../tools/context.js";
import { handleArtifactQuery, handleGetNextId } from "../tools/query.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "../tools/execution.js";
import { handleGetConvergenceStatus, handleGetDomainState, handleGetProjectStatus } from "../tools/analysis.js";
import { handleAppendJournal, handleArchiveCycle, handleWriteWorkItems, handleUpdateWorkItems, handleWriteArtifact } from "../tools/write.js";
import { handleTool, signalIndexReady } from "../tools/index.js";
import { handleEmitMetric } from "../tools/metrics.js";
import { handleBootstrapProject } from "../tools/bootstrap.js";
import { handleGetAutopilotState, handleUpdateAutopilotState } from "../tools/autopilot-state.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

// Signal the readiness gate so handleTool calls don't block
beforeAll(() => {
  signalIndexReady();
});

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
      work_item_id: "WI-002",
    });
    expect(result).toContain("WI-002");
    expect(result).toContain("Numeric ID item");
  });

  it("error path: throws when work_item_id is missing", async () => {
    await expect(
      handleGetWorkItemContext(ctx, {})
    ).rejects.toThrow(/work_item_id/i);
  });

  it("error path: throws when work item not found", async () => {
    await expect(
      handleGetWorkItemContext(ctx, {
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

    const result = await handleGetContextPackage(ctx, {});
    expect(result).toContain("## Architecture");
    expect(result).toContain("## Guiding Principles");
    expect(result).toContain("## Constraints");
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

    const result = await handleGetExecutionStatus(ctx, {});
    expect(result).toContain("Execution Status");
    expect(result).toContain("Total");
    expect(result).toContain("Completed");
  });

  it("happy path: blocked items are listed with their unmet deps", async () => {
    insertNode("WI-001", "work_item", { status: "pending" });
    insertWorkItem("WI-001", "Blocked item", { depends: ["WI-099"] });

    const result = await handleGetExecutionStatus(ctx, {});
    expect(result).toContain("WI-001");
    // WI-099 is unmet
    expect(result).toContain("WI-099");
  });

  it("error path: empty work item list returns zeroed counts", async () => {
    const result = await handleGetExecutionStatus(ctx, {});
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

    const result = await handleGetReviewManifest(ctx, {});
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

    const result = await handleGetReviewManifest(ctx, {});
    expect(result).toContain("Pass");
  });

  it("error path: empty DB returns just headers", async () => {
    const result = await handleGetReviewManifest(ctx, {});
    // Should return header + divider only (no data rows), not throw
    expect(typeof result).toBe("string");
    expect(result).toContain("#");
  });
});

// ---------------------------------------------------------------------------
// 6. handleGetConvergenceStatus
// ---------------------------------------------------------------------------

describe("handleGetConvergenceStatus", () => {
  /** Helper: insert a cycle_summary node + document_artifacts row */
  function insertCycleSummary(id: string, cycle: number, content: string): void {
    insertNode(id, "cycle_summary", { cycle_created: cycle });
    db.prepare(
      `INSERT OR REPLACE INTO document_artifacts (id, cycle, content) VALUES (?, ?, ?)`
    ).run(id, cycle, content);
  }

  it("happy path: converged=true when no critical/significant findings and principle passes", async () => {
    insertCycleSummary(
      "CS-001",
      1,
      "**Principle Violation Verdict**: Pass\n\n## Summary\nAll good.\n"
    );

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 1,
    });

    expect(result).toContain("converged: true");
    expect(result).toContain("condition_a: true");
    expect(result).toContain("condition_b: true");
  });

  it("happy path: converged=false when critical findings exist", async () => {
    insertCycleSummary(
      "CS-001",
      1,
      "**Principle Violation Verdict**: Pass\n\n## Critical Findings\n- C1: Something broke\n- C2: Something else broke\n"
    );

    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 1,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("critical: 2");
  });

  it("error path: missing cycle_summary for cycle returns unknown/false convergence", async () => {
    // Cycle 999 has no cycle_summary rows in the DB
    const result = await handleGetConvergenceStatus(ctx, {
      cycle_number: 999,
    });

    expect(result).toContain("converged: false");
    expect(result).toContain("principle_verdict: unknown");
  });

  it("error path: missing or invalid cycle_number throws", async () => {
    await expect(handleGetConvergenceStatus(ctx, {})).rejects.toThrow(
      "Missing or invalid required parameter: cycle_number"
    );
    await expect(handleGetConvergenceStatus(ctx, { cycle_number: "bad" })).rejects.toThrow(
      "Missing or invalid required parameter: cycle_number"
    );
  });
});

// ---------------------------------------------------------------------------
// 7. handleGetDomainState
// ---------------------------------------------------------------------------

describe("handleGetDomainState", () => {
  it("happy path: returns domain with policies and open questions", async () => {
    insertDomainPolicy("DP-001", "workflow", "Write files before DB");
    insertDomainQuestion("DQ-001", "workflow", "Should we use YAML?");

    const result = await handleGetDomainState(ctx, {});
    expect(result).toContain("## workflow");
    expect(result).toContain("DP-001");
    expect(result).toContain("DQ-001");
  });

  it("happy path: domains filter restricts output", async () => {
    insertDomainPolicy("DP-001", "workflow", "Workflow policy");
    insertDomainPolicy("DP-002", "infra", "Infra policy");

    const result = await handleGetDomainState(ctx, {
      domains: ["workflow"],
    });
    expect(result).toContain("workflow");
    expect(result).not.toContain("infra");
  });

  it("error path: empty DB returns 'No domain data found'", async () => {
    const result = await handleGetDomainState(ctx, {});
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

    const result = await handleGetProjectStatus(ctx, {});
    expect(result).toContain("Project Status Dashboard");
    expect(result).toContain("Total: 2");
    expect(result).toContain("Done: 1");
  });

  it("happy path: shows current cycle from domains/index.md", async () => {
    const result = await handleGetProjectStatus(ctx, {});
    expect(result).toContain("Current cycle");
    expect(result).toContain("3");
  });

  it("error path: empty DB returns zeroed work items section", async () => {
    const result = await handleGetProjectStatus(ctx, {});
    expect(result).toContain("Total: 0");
  });
});

// ---------------------------------------------------------------------------
// 9. handleAppendJournal
// ---------------------------------------------------------------------------

describe("handleAppendJournal", () => {
  it("happy path: writes YAML journal entry and returns file path", async () => {
    const result = await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-25",
      entry_type: "work-item-complete",
      body: "Completed WI-001: Build schema.",
      cycle_number: 3,
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
      skill: "plan",
      date: "2026-03-24",
      entry_type: "cycle-start",
      body: "Starting cycle 4.",
      cycle_number: 3,
    });

    await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-25",
      entry_type: "work-item-complete",
      body: "WI-001 done.",
      cycle_number: 3,
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
      cycle_number: 1,
    });

    expect(result).toContain("Archived cycle 1");
    expect(result).toContain("incremental");
  });

  it("happy path: returns 0-count message when no incremental files exist", async () => {
    const result = await handleArchiveCycle(ctx, {
      cycle_number: 5,
    });
    expect(result).toContain("0");
  });

  it("error path: throws when required params missing", async () => {
    await expect(
      handleArchiveCycle(ctx, {})
    ).rejects.toThrow();
  });

  it("archive path fix: reads findings from cycles/{NNN}/findings/ not archive/incremental/", async () => {
    // Create findings in the correct new location: cycles/002/findings/
    const findingsDir = path.join(artifactDir, "cycles", "002", "findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(findingsDir, "F-001-build-schema.yaml"),
      "id: F-001\ntype: finding\nverdict: pass\n",
      "utf8"
    );

    // Create a work item YAML in the correct new location: work-items/ (not plan/work-items/)
    const wiDir = path.join(artifactDir, "work-items");
    fs.mkdirSync(wiDir, { recursive: true });
    fs.writeFileSync(
      path.join(wiDir, "001-build-schema.yaml"),
      "id: WI-001\ntype: work_item\ntitle: Build schema\nstatus: done\n",
      "utf8"
    );

    const result = await handleArchiveCycle(ctx, {
      cycle_number: 2,
    });

    // Should have found and archived the finding file
    expect(result).toContain("Archived cycle 2");
    expect(result).toContain("1"); // at least 1 finding archived

    // Finding file should have been moved (deleted from source)
    expect(fs.existsSync(path.join(findingsDir, "F-001-build-schema.yaml"))).toBe(false);

    // archive/cycles/002/incremental/ should contain the finding
    const archivedIncremental = path.join(artifactDir, "archive", "cycles", "002", "incremental");
    expect(fs.existsSync(path.join(archivedIncremental, "F-001-build-schema.yaml"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. handleWriteWorkItems
// ---------------------------------------------------------------------------

describe("handleWriteWorkItems", () => {
  it("happy path: creates individual YAML file at .ideate/work-items/{id}.yaml", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-100",
          title: "Write work item test",
          complexity: "small",
          criteria: ["Tests pass"],
        },
      ],
    });

    // YAML response with id and file_path
    expect(result).toContain("created");
    expect(result).toContain("WI-100");

    // Individual YAML file must exist at {ideateDir}/work-items/WI-100.yaml
    const yamlPath = path.join(artifactDir, "work-items", "WI-100.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    // No plan/notes file should be created
    const notesPath = path.join(artifactDir, "plan", "notes", "WI-100.md");
    expect(fs.existsSync(notesPath)).toBe(false);

    // No plan/work-items.yaml should be created
    const consolidatedPath = path.join(artifactDir, "plan", "work-items.yaml");
    expect(fs.existsSync(consolidatedPath)).toBe(false);

    // Check SQLite row was inserted with correct file_path
    const row = db
      .prepare(`SELECT id, file_path, status FROM nodes WHERE id = 'WI-100'`)
      .get() as { id: string; file_path: string; status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("WI-100");
    expect(row!.file_path).toContain("work-items");
    expect(row!.file_path).toContain("WI-100.yaml");
    expect(row!.status).toBe("pending");
  });

  it("happy path: YAML file contains all required fields", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-101",
          title: "Full fields test",
          complexity: "medium",
          scope: [{ path: "src/foo.ts", op: "modify" }],
          depends: [],
          blocks: [],
          criteria: ["Criterion A", "Criterion B"],
          notes_content: "# Implementation Notes\nDo the thing.",
          domain: "workflow",
          status: "pending",
          resolution: null,
          cycle_created: 2,
        },
      ],
    });

    const yamlPath = path.join(artifactDir, "work-items", "WI-101.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    const content = fs.readFileSync(yamlPath, "utf8");
    // All required fields must be present
    expect(content).toContain("id:");
    expect(content).toContain("WI-101");
    expect(content).toContain("type:");
    expect(content).toContain("work_item");
    expect(content).toContain("title:");
    expect(content).toContain("Full fields test");
    expect(content).toContain("status:");
    expect(content).toContain("pending");
    expect(content).toContain("complexity:");
    expect(content).toContain("medium");
    expect(content).toContain("scope:");
    expect(content).toContain("src/foo.ts");
    expect(content).toContain("depends:");
    expect(content).toContain("blocks:");
    expect(content).toContain("criteria:");
    expect(content).toContain("Criterion A");
    expect(content).toContain("domain:");
    expect(content).toContain("workflow");
    // notes field must contain inline content (not a path to a .md file)
    expect(content).toContain("notes:");
    expect(content).toContain("Implementation Notes");
    expect(content).not.toContain("plan/notes");
    // resolution, cycle fields
    expect(content).toContain("resolution:");
    expect(content).toContain("cycle_created:");
    // computed fields
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
    expect(content).toContain("file_path:");
  });

  it("happy path: notes content is stored inline in YAML (not as a .md path)", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-102",
          title: "Notes inline test",
          notes_content: "# My Notes\nSome implementation detail.",
        },
      ],
    });

    const yamlPath = path.join(artifactDir, "work-items", "WI-102.yaml");
    const content = fs.readFileSync(yamlPath, "utf8");

    // notes field contains the actual content, not a file path reference
    expect(content).toContain("My Notes");
    expect(content).toContain("Some implementation detail");
    // must NOT contain a path to a separate notes file
    expect(content).not.toContain("plan/notes/WI-102.md");
    // no separate .md file should be created
    expect(fs.existsSync(path.join(artifactDir, "plan", "notes", "WI-102.md"))).toBe(false);
  });

  it("happy path: resolution field is included when provided", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-103",
          title: "Obsolete item",
          status: "obsolete",
          resolution: "Superseded by WI-200",
        },
      ],
    });

    const yamlPath = path.join(artifactDir, "work-items", "WI-103.yaml");
    const content = fs.readFileSync(yamlPath, "utf8");

    expect(content).toContain("resolution:");
    expect(content).toContain("Superseded by WI-200");
    expect(content).toContain("status:");
    expect(content).toContain("obsolete");
  });

  it("happy path: SQLite file_path points to the .yaml file", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-104",
          title: "SQLite path test",
        },
      ],
    });

    const row = db
      .prepare(`SELECT file_path FROM nodes WHERE id = 'WI-104'`)
      .get() as { file_path: string } | undefined;
    expect(row).toBeDefined();
    // file_path must end in .yaml, not .md
    expect(row!.file_path).toMatch(/WI-104\.yaml$/);
    expect(row!.file_path).not.toMatch(/\.md$/);
    // file_path must not reference plan/notes
    expect(row!.file_path).not.toContain("plan/notes");
    // file_path must reference work-items directory
    expect(row!.file_path).toContain("work-items");
  });

  it("happy path: status from input is used (not hardcoded 'pending')", async () => {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-105",
          title: "Custom status test",
          status: "in-progress",
        },
      ],
    });

    const row = db
      .prepare(`SELECT status FROM nodes WHERE id = 'WI-105'`)
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("in-progress");

    const yamlPath = path.join(artifactDir, "work-items", "WI-105.yaml");
    const content = fs.readFileSync(yamlPath, "utf8");
    expect(content).toContain("in-progress");
  });

  it("happy path: returns items: [] for empty items array", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [],
    });
    expect(result).toContain("items");
  });

  it("error path: throws when items is not an array", async () => {
    await expect(
      handleWriteWorkItems(ctx, {
        items: "not-an-array",
      })
    ).rejects.toThrow();
  });

  it("error path: returns cycle error when dependency graph creates a cycle", async () => {
    const result = await handleWriteWorkItems(ctx, {
      items: [
        { id: "WI-A", title: "A", depends: ["WI-B"] },
        { id: "WI-B", title: "B", depends: ["WI-A"] },
      ],
    });
    // Should return an error string (not throw), mentioning DAG cycle
    expect(result).toContain("cycle");
  });

  it("backward compat: writes individual files even when plan/work-items.yaml exists", async () => {
    // Pre-create the consolidated file
    const consolidatedPath = path.join(artifactDir, "plan", "work-items.yaml");
    fs.writeFileSync(consolidatedPath, "items:\n  WI-OLD:\n    title: Old item\n", "utf8");

    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-106",
          title: "Backward compat test",
        },
      ],
    });

    // Individual YAML file must be created
    const yamlPath = path.join(artifactDir, "work-items", "WI-106.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    // The consolidated file should still exist but NOT be modified (new item not appended)
    const consolidatedContent = fs.readFileSync(consolidatedPath, "utf8");
    expect(consolidatedContent).not.toContain("WI-106");
  });

  it("auto-assignment: produces WI-051 when highest existing ID is WI-050", async () => {
    // Step 1: Create a work item with explicit id WI-050
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id: "WI-050",
          title: "Explicit seed item",
          complexity: "small",
        },
      ],
    });

    // Step 2: Call writeWorkItems with an item that has no id
    const result = await handleWriteWorkItems(ctx, {
      items: [
        {
          title: "Auto-assigned item",
          complexity: "small",
        },
      ],
    });

    // Step 3: Verify the auto-assigned id is WI-051 (not WI-001)
    expect(result).toContain("WI-051");

    // Confirm the YAML file was written with the correct id
    const yamlPath = path.join(artifactDir, "work-items", "WI-051.yaml");
    expect(fs.existsSync(yamlPath)).toBe(true);

    // Confirm SQLite has WI-051, not WI-001
    const row = db
      .prepare(`SELECT id FROM nodes WHERE id = 'WI-051'`)
      .get() as { id: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe("WI-051");

    // WI-001 must NOT have been created
    const wrongRow = db
      .prepare(`SELECT id FROM nodes WHERE id = 'WI-001'`)
      .get() as { id: string } | undefined;
    expect(wrongRow).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 12. handleUpdateWorkItems
// ---------------------------------------------------------------------------

describe("handleUpdateWorkItems", () => {
  /** Helper: create a work item file via handleWriteWorkItems and return its path */
  async function createWorkItem(id: string, overrides: Record<string, unknown> = {}): Promise<string> {
    await handleWriteWorkItems(ctx, {
      items: [
        {
          id,
          title: `Test item ${id}`,
          complexity: "small",
          status: "pending",
          domain: "workflow",
          criteria: ["Initial criterion"],
          notes_content: `# Notes for ${id}`,
          ...overrides,
        },
      ],
    });
    return path.join(artifactDir, "work-items", `${id}.yaml`);
  }

  it("single-field update: status only", async () => {
    const filePath = await createWorkItem("WI-U01");

    const beforeContent = fs.readFileSync(filePath, "utf8");
    const beforeObj = JSON.parse(JSON.stringify(
      (await import("yaml")).parse(beforeContent)
    ));

    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-U01", status: "done" }],
    });

    // Summary reports 1 updated, 0 failed
    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 0");

    // Read updated file
    const afterContent = fs.readFileSync(filePath, "utf8");
    const afterObj = (await import("yaml")).parse(afterContent);

    // Status changed
    expect(afterObj.status).toBe("done");

    // Other fields preserved
    expect(afterObj.title).toBe(beforeObj.title);
    expect(afterObj.complexity).toBe(beforeObj.complexity);
    expect(afterObj.domain).toBe(beforeObj.domain);
    expect(afterObj.id).toBe(beforeObj.id);
    expect(afterObj.type).toBe("work_item");
    expect(afterObj.cycle_created).toBe(beforeObj.cycle_created);

    // SQLite updated
    const row = db
      .prepare(`SELECT status FROM nodes WHERE id = 'WI-U01'`)
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("done");
  });

  it("multi-field update: status + resolution", async () => {
    const filePath = await createWorkItem("WI-U02");

    const result = await handleUpdateWorkItems(ctx, {
      updates: [
        { id: "WI-U02", status: "obsolete", resolution: "Superseded by WI-U10" },
      ],
    });

    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 0");

    const afterContent = fs.readFileSync(filePath, "utf8");
    const afterObj = (await import("yaml")).parse(afterContent);

    expect(afterObj.status).toBe("obsolete");
    expect(afterObj.resolution).toBe("Superseded by WI-U10");

    // Immutable fields preserved
    expect(afterObj.id).toBe("WI-U02");
    expect(afterObj.type).toBe("work_item");

    // Other fields still present
    expect(afterObj.title).toBe("Test item WI-U02");
    expect(afterObj.domain).toBe("workflow");

    // SQLite reflects new status
    const row = db
      .prepare(`SELECT status FROM nodes WHERE id = 'WI-U02'`)
      .get() as { status: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("obsolete");
  });

  it("nonexistent ID returns error and continues processing others", async () => {
    // Create one real work item
    await createWorkItem("WI-U03");

    const result = await handleUpdateWorkItems(ctx, {
      updates: [
        { id: "WI-NONEXISTENT", status: "done" },
        { id: "WI-U03", status: "in-progress" },
      ],
    });

    // 1 updated (WI-U03), 1 failed (WI-NONEXISTENT)
    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 1");
    expect(result).toContain("WI-NONEXISTENT");

    // The real item was still updated
    const filePath = path.join(artifactDir, "work-items", "WI-U03.yaml");
    const afterContent = fs.readFileSync(filePath, "utf8");
    const afterObj = (await import("yaml")).parse(afterContent);
    expect(afterObj.status).toBe("in-progress");
  });

  it("empty updates array returns zeroed summary", async () => {
    const result = await handleUpdateWorkItems(ctx, { updates: [] });
    expect(result).toContain("updated: 0");
    expect(result).toContain("failed: 0");
  });

  it("updating depends replaces old edges in SQLite", async () => {
    // Create two work items: WI-U10 (the dependency) and WI-U11 (the dependent)
    await createWorkItem("WI-U10");
    await createWorkItem("WI-U11");

    // Initially WI-U11 has no depends edges
    const edgesBefore = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'WI-U11' AND edge_type = 'depends_on'`)
      .all();
    expect(edgesBefore).toHaveLength(0);

    // Update WI-U11 to depend on WI-U10
    const result = await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-U11", depends: ["WI-U10"] }],
    });
    expect(result).toContain("updated: 1");
    expect(result).toContain("failed: 0");

    // Verify the depends_on edge was created in SQLite
    const edgesAfter = db
      .prepare(`SELECT source_id, target_id, edge_type FROM edges WHERE source_id = 'WI-U11' AND edge_type = 'depends_on'`)
      .all() as { source_id: string; target_id: string; edge_type: string }[];
    expect(edgesAfter).toHaveLength(1);
    expect(edgesAfter[0].target_id).toBe("WI-U10");

    // Update WI-U11 again with a different depends to verify old edges are removed
    await handleUpdateWorkItems(ctx, {
      updates: [{ id: "WI-U11", depends: [] }],
    });
    const edgesCleared = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'WI-U11' AND edge_type = 'depends_on'`)
      .all();
    expect(edgesCleared).toHaveLength(0);
  });

  it("throws when updates param is missing", async () => {
    await expect(
      handleUpdateWorkItems(ctx, {})
    ).rejects.toThrow(/updates/i);
  });
});

// ---------------------------------------------------------------------------
// 13. handleWriteArtifact
// ---------------------------------------------------------------------------

describe("handleWriteArtifact", () => {
  it("write overview: creates file at plan/overview.yaml with correct content", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "overview",
      id: "overview",
      content: {
        title: "Project Overview",
        summary: "An overview of the project.",
        goals: ["Build fast", "Stay correct"],
      },
    });

    expect(result).toContain("overview");

    const filePath = path.join(artifactDir, "plan", "overview.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("overview");
    expect(content).toContain("type:");
    expect(content).toContain("title:");
    expect(content).toContain("Project Overview");
    expect(content).toContain("summary:");
    expect(content).toContain("An overview of the project.");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
    expect(content).toContain("file_path:");

    // Verify SQLite upsert
    const row = db
      .prepare(`SELECT id, type, file_path FROM nodes WHERE id = 'overview'`)
      .get() as { id: string; type: string; file_path: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("overview");
    expect(row!.file_path).toContain("plan");
    expect(row!.file_path).toContain("overview.yaml");
  });

  it("write execution_strategy: creates file at plan/execution-strategy.yaml", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "execution_strategy",
      id: "execution-strategy",
      content: {
        title: "Execution Strategy",
        approach: "serial",
        phases: ["planning", "execution", "review"],
      },
    });

    expect(result).toContain("execution_strategy");

    const filePath = path.join(artifactDir, "plan", "execution-strategy.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("execution-strategy");
    expect(content).toContain("type:");
    expect(content).toContain("execution_strategy");
    expect(content).toContain("approach:");
    expect(content).toContain("serial");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");

    // SQLite row
    const row = db
      .prepare(`SELECT id, type FROM nodes WHERE id = 'execution-strategy'`)
      .get() as { id: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("execution_strategy");
  });

  it("write interview: creates file at interviews/refine-029/_general.yaml with nested path", async () => {
    const result = await handleWriteArtifact(ctx, {
      type: "interview",
      id: "refine-029/_general",
      content: {
        title: "General Interview",
        questions: ["What changed?", "Any blockers?"],
        responses: { "What changed?": "Completed WI-230." },
      },
    });

    expect(result).toContain("interview");

    const filePath = path.join(artifactDir, "interviews", "refine-029", "_general.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("refine-029/_general");
    expect(content).toContain("type:");
    expect(content).toContain("interview");
    expect(content).toContain("title:");
    expect(content).toContain("General Interview");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");

    // SQLite row
    const row = db
      .prepare(`SELECT id, type FROM nodes WHERE id = 'refine-029/_general'`)
      .get() as { id: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe("interview");
  });

  it("write research: creates file at steering/research/{id}.yaml", async () => {
    await handleWriteArtifact(ctx, {
      type: "research",
      id: "sqlite-performance",
      content: {
        title: "SQLite Performance Research",
        findings: "WAL mode improves throughput.",
      },
    });

    const filePath = path.join(artifactDir, "steering", "research", "sqlite-performance.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("sqlite-performance");
    expect(content).toContain("research");
  });

  it("write guiding_principles: creates file at steering/{id}.yaml", async () => {
    await handleWriteArtifact(ctx, {
      type: "guiding_principles",
      id: "guiding-principles",
      content: {
        title: "Guiding Principles",
        principles: ["Write YAML first", "SQLite is secondary"],
      },
    });

    const filePath = path.join(artifactDir, "steering", "guiding-principles.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("guiding-principles");
    expect(content).toContain("guiding_principles");
  });

  it("unknown type falls back to {ideateDir}/{type}/{id}.yaml", async () => {
    await handleWriteArtifact(ctx, {
      type: "custom_artifact",
      id: "my-artifact",
      content: { title: "Custom", data: 42 },
    });

    const filePath = path.join(artifactDir, "custom_artifact", "my-artifact.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("error path: throws when type is missing", async () => {
    await expect(
      handleWriteArtifact(ctx, { id: "foo", content: {} })
    ).rejects.toThrow(/type.*id/i);
  });

  it("error path: throws when id is missing", async () => {
    await expect(
      handleWriteArtifact(ctx, { type: "overview", content: {} })
    ).rejects.toThrow(/type.*id/i);
  });

  it("error path: throws when content is not an object", async () => {
    await expect(
      handleWriteArtifact(ctx, { type: "overview", id: "foo", content: "not-an-object" })
    ).rejects.toThrow(/content/i);
  });
});

// ---------------------------------------------------------------------------
// handleAssembleContext — PPR-based context assembly with token budgeting
// ---------------------------------------------------------------------------

describe("handleAssembleContext", () => {
  /** Insert an edge between two existing nodes */
  function insertEdge(sourceId: string, targetId: string, edgeType: string): void {
    db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, edge_type, props)
      VALUES (?, ?, ?, '{}')
    `).run(sourceId, targetId, edgeType);
  }

  /** Write a YAML file to the artifact directory and return its path */
  function writeArtifactFile(relPath: string, content: string): string {
    const fullPath = path.join(artifactDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
    return fullPath;
  }

  it("basic assembly: seed a work item, verify related artifacts appear in output", async () => {
    // Set up a work item node with a YAML file
    const wiFilePath = writeArtifactFile("work-items/WI-001.yaml", [
      "id: WI-001",
      "type: work_item",
      "title: Test Work Item",
      "content: Implementation of the test feature.",
    ].join("\n"));

    insertNode("WI-001", "work_item", {
      file_path: wiFilePath,
      status: "pending",
    });
    insertWorkItem("WI-001", "Test Work Item");

    // Add a related guiding principle
    const gpFilePath = writeArtifactFile("principles/GP-01.yaml", [
      "id: GP-01",
      "type: guiding_principle",
      "name: Test Principle",
      "description: Always test your code.",
    ].join("\n"));

    insertNode("GP-01", "guiding_principle", { file_path: gpFilePath });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-01", "Test Principle", "Always test your code.");

    // Connect them via a governed_by edge
    insertEdge("WI-001", "GP-01", "governed_by");

    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-001"],
      token_budget: 100000,
      include_types: [],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      total_tokens: number;
      ppr_scores: Array<{ id: string; score: number }>;
      context: string;
    };

    // Both the seed and the related artifact should appear
    expect(result.artifact_ids).toContain("WI-001");
    expect(result.artifact_ids).toContain("GP-01");
    expect(result.context).toContain("WI-001");
    expect(result.context).toContain("GP-01");
    expect(result.total_tokens).toBeGreaterThan(0);
    expect(result.ppr_scores.length).toBeGreaterThan(0);
  });

  it("token budget cutoff: small budget limits included artifacts", async () => {
    // Create multiple nodes, each with some content
    for (let i = 1; i <= 5; i++) {
      const id = `WI-B0${i}`;
      // Each file is about 200 characters = ~50 tokens
      const content = `id: ${id}\ntype: work_item\ntitle: Budget Test Item ${i}\ncontent: ${"x".repeat(150)}\n`;
      const filePath = writeArtifactFile(`work-items/${id}.yaml`, content);
      insertNode(id, "work_item", { file_path: filePath, status: "pending" });
      insertWorkItem(id, `Budget Test Item ${i}`);
    }

    // Link them all: WI-B01 → WI-B02 → WI-B03 → WI-B04 → WI-B05
    for (let i = 1; i <= 4; i++) {
      insertEdge(`WI-B0${i}`, `WI-B0${i + 1}`, "depends_on");
    }

    // Token budget tight enough to exclude some artifacts (~50 tokens each, budget = 120)
    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-B01"],
      token_budget: 120,
      include_types: [],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      total_tokens: number;
    };

    // Should have included the seed (WI-B01) plus at most 1-2 more due to budget
    expect(result.artifact_ids).toContain("WI-B01");
    // Should not include all 5 — total_tokens should be within budget
    expect(result.total_tokens).toBeLessThanOrEqual(120);
    // Not all 5 items should be included
    expect(result.artifact_ids.length).toBeLessThan(5);
  });

  it("always-include types: artifacts matching include_types appear even without PPR connection", async () => {
    // Create the seed work item
    const wiFilePath = writeArtifactFile("work-items/WI-AIT-01.yaml", [
      "id: WI-AIT-01",
      "type: work_item",
      "title: Always Include Test",
    ].join("\n"));
    insertNode("WI-AIT-01", "work_item", { file_path: wiFilePath, status: "pending" });
    insertWorkItem("WI-AIT-01", "Always Include Test");

    // Create a guiding_principle with NO edge to the seed (zero PPR score)
    const gpFilePath = writeArtifactFile("principles/GP-AIT-01.yaml", [
      "id: GP-AIT-01",
      "type: guiding_principle",
      "name: Isolated Principle",
      "description: This principle has no edge to the work item.",
    ].join("\n"));
    insertNode("GP-AIT-01", "guiding_principle", { file_path: gpFilePath });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-AIT-01", "Isolated Principle", "This principle has no edge to the work item.");

    // No edge between WI-AIT-01 and GP-AIT-01

    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-AIT-01"],
      token_budget: 100000,
      include_types: ["guiding_principle"],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      context: string;
    };

    // The guiding principle should be included despite having no PPR score
    expect(result.artifact_ids).toContain("GP-AIT-01");
    expect(result.context).toContain("GP-AIT-01");
    expect(result.context).toContain("Isolated Principle");
  });

  it("error path: empty seed_ids array throws error", async () => {
    await expect(
      handleAssembleContext(ctx, { seed_ids: [], token_budget: 50000, include_types: [] })
    ).rejects.toThrow(/seed_ids/i);
  });

  it("edge case: seed_ids with non-existent IDs returns always-include items only", async () => {
    // Insert a guiding_principle that will be always-included
    const gpFilePath = path.join(artifactDir, "principles", "GP-ONLY.yaml");
    fs.mkdirSync(path.dirname(gpFilePath), { recursive: true });
    fs.writeFileSync(gpFilePath, [
      "id: GP-ONLY",
      "type: guiding_principle",
      "name: Only Principle",
      "description: This should always be included.",
    ].join("\n"), "utf8");
    insertNode("GP-ONLY", "guiding_principle", { file_path: gpFilePath });
    db.prepare(`INSERT OR REPLACE INTO guiding_principles (id, name, description) VALUES (?, ?, ?)`)
      .run("GP-ONLY", "Only Principle", "This should always be included.");

    // Seed with an ID that does not exist in the DB
    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-DOES-NOT-EXIST"],
      token_budget: 100000,
      include_types: ["guiding_principle"],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      context: string;
    };

    // Always-include type should be present
    expect(result.artifact_ids).toContain("GP-ONLY");
    // The non-existent seed should not appear in the output
    expect(result.artifact_ids).not.toContain("WI-DOES-NOT-EXIST");
  });

  it("edge case: token_budget of 0 returns always-include items only", async () => {
    // Insert a seed work item
    const wiFilePath = path.join(artifactDir, "work-items", "WI-TB0.yaml");
    fs.mkdirSync(path.dirname(wiFilePath), { recursive: true });
    fs.writeFileSync(wiFilePath, [
      "id: WI-TB0",
      "type: work_item",
      "title: Token Budget Zero",
    ].join("\n"), "utf8");
    insertNode("WI-TB0", "work_item", { file_path: wiFilePath, status: "pending" });
    insertWorkItem("WI-TB0", "Token Budget Zero");

    // Insert a ranked node connected via edge (should be excluded by budget)
    const relFilePath = path.join(artifactDir, "work-items", "WI-TB0-REL.yaml");
    fs.writeFileSync(relFilePath, [
      "id: WI-TB0-REL",
      "type: work_item",
      "title: Related Item",
    ].join("\n"), "utf8");
    insertNode("WI-TB0-REL", "work_item", { file_path: relFilePath, status: "pending" });
    insertWorkItem("WI-TB0-REL", "Related Item");
    db.prepare(`INSERT OR IGNORE INTO edges (source_id, target_id, edge_type, props) VALUES (?, ?, 'depends_on', '{}')`)
      .run("WI-TB0", "WI-TB0-REL");

    const resultStr = await handleAssembleContext(ctx, {
      seed_ids: ["WI-TB0"],
      token_budget: 0,
      include_types: [],
    });

    const result = JSON.parse(resultStr) as {
      artifact_ids: string[];
      total_tokens: number;
    };

    // The seed (always-include) should be present
    expect(result.artifact_ids).toContain("WI-TB0");
    // The ranked related item should be excluded since budget is 0
    expect(result.artifact_ids).not.toContain("WI-TB0-REL");
  });
});

// ---------------------------------------------------------------------------
// ideate_get_config dispatch
// ---------------------------------------------------------------------------

describe("ideate_get_config", () => {
  it("handleTool dispatch returns JSON with agent_budgets and ppr keys with correct defaults", async () => {
    const resultStr = await handleTool(ctx, "ideate_get_config", {});

    const result = JSON.parse(resultStr) as Record<string, unknown>;

    // Must have both top-level keys
    expect(result).toHaveProperty("agent_budgets");
    expect(result).toHaveProperty("ppr");

    // agent_budgets should contain default entries
    const agentBudgets = result.agent_budgets as Record<string, number>;
    expect(agentBudgets["code-reviewer"]).toBe(80);
    expect(agentBudgets["architect"]).toBe(160);
    expect(agentBudgets["proxy-human"]).toBe(160);

    // ppr should contain default sub-keys
    const ppr = result.ppr as Record<string, unknown>;
    expect(ppr).toHaveProperty("alpha");
    expect(ppr).toHaveProperty("max_iterations");
    expect(ppr).toHaveProperty("convergence_threshold");
    expect(ppr).toHaveProperty("edge_type_weights");
    expect(ppr).toHaveProperty("default_token_budget");
    expect(ppr.alpha).toBe(0.15);
    expect(ppr.default_token_budget).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// Integration: write → read (append_journal → artifact_query)
// ---------------------------------------------------------------------------

describe("integration: append_journal → artifact_query sync", () => {
  it("journal entry written by handleAppendJournal is queryable via handleArtifactQuery", async () => {
    // Write a journal entry
    await handleAppendJournal(ctx, {
      skill: "execute",
      date: "2026-03-25",
      entry_type: "integration-test",
      body: "Integration test body.",
      cycle_number: 3,
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

// ---------------------------------------------------------------------------
// handleEmitMetric
// ---------------------------------------------------------------------------

describe("handleEmitMetric", () => {
  it("appends a metric line as valid JSON to metrics.jsonl", async () => {
    const payload = { event: "test", tokens: 1234, phase: "execute" };
    const result = await handleEmitMetric(ctx, { payload });

    expect(result).toBe("Metric appended successfully");

    const metricsPath = path.join(artifactDir, "metrics.jsonl");
    expect(fs.existsSync(metricsPath)).toBe(true);

    const content = fs.readFileSync(metricsPath, "utf8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.event).toBe("test");
    expect(parsed.tokens).toBe(1234);
  });

  it("throws when payload is missing", async () => {
    await expect(handleEmitMetric(ctx, {})).rejects.toThrow("Missing required parameter: payload");
  });
});

// ---------------------------------------------------------------------------
// handleBootstrapProject
// ---------------------------------------------------------------------------

describe("handleBootstrapProject", () => {
  it("creates .ideate/ directory structure with config.json", async () => {
    // Use a fresh temp dir as the project root (not the existing artifactDir)
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-bootstrap-test-"));
    const bootstrapIdeateDir = path.join(projectRoot, ".ideate");

    // Create a temporary context pointing to the new .ideate dir
    const bootstrapCtx: ToolContext = { ...ctx, ideateDir: bootstrapIdeateDir };

    const result = await handleBootstrapProject(bootstrapCtx, { project_name: "test-project" });
    const parsed = JSON.parse(result);

    expect(parsed.created_dir).toBe(bootstrapIdeateDir);
    expect(parsed.subdirectories).toContain("work-items");
    expect(parsed.subdirectories).toContain("plan");

    // Verify config.json exists with correct content
    const configPath = path.join(bootstrapIdeateDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.schema_version).toBe(2);
    expect(config.project_name).toBe("test-project");

    // Verify subdirectories exist
    expect(fs.existsSync(path.join(bootstrapIdeateDir, "work-items"))).toBe(true);
    expect(fs.existsSync(path.join(bootstrapIdeateDir, "cycles"))).toBe(true);

    // Cleanup
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// handleGetNextId
// ---------------------------------------------------------------------------

describe("handleGetNextId", () => {
  it("returns correct next ID with existing work items indexed", async () => {
    // Insert some work item nodes
    insertNode("WI-001", "work_item", { status: "done" });
    insertNode("WI-002", "work_item", { status: "done" });
    insertNode("WI-010", "work_item", { status: "pending" });

    const result = await handleGetNextId(ctx, { type: "work_item" });
    expect(result).toBe("WI-011");
  });

  it("returns first ID when no artifacts exist", async () => {
    const result = await handleGetNextId(ctx, { type: "guiding_principle" });
    expect(result).toBe("GP-01");
  });

  it("throws on unknown type", async () => {
    await expect(handleGetNextId(ctx, { type: "invalid" })).rejects.toThrow("Unknown type");
  });

  it("throws when type is missing", async () => {
    await expect(handleGetNextId(ctx, {})).rejects.toThrow("Missing required parameter: type");
  });
});

// ---------------------------------------------------------------------------
// handleGetAutopilotState
// ---------------------------------------------------------------------------

describe("handleGetAutopilotState", () => {
  it("returns default state when no file exists", async () => {
    const result = await handleGetAutopilotState(ctx, {});
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(0);
    expect(state.convergence_achieved).toBe(false);
    expect(state.started_at).toBeNull();
    expect(state.last_phase).toBeNull();
    expect(state.deferred).toBe(false);
  });

  it("returns persisted state when file exists", async () => {
    // Write a autopilot-state.yaml directly
    const statePath = path.join(artifactDir, "autopilot-state.yaml");
    fs.writeFileSync(statePath, "cycles_completed: 3\nconvergence_achieved: true\nstarted_at: '2026-03-25T10:00:00Z'\n", "utf8");

    const result = await handleGetAutopilotState(ctx, {});
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(3);
    expect(state.convergence_achieved).toBe(true);
    expect(state.started_at).toBe("2026-03-25T10:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// handleUpdateAutopilotState
// ---------------------------------------------------------------------------

describe("handleUpdateAutopilotState", () => {
  it("creates state file and merges update when no file exists", async () => {
    const result = await handleUpdateAutopilotState(ctx, {
      state: { cycles_completed: 1, started_at: "2026-03-26T09:00:00Z" },
    });
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(1);
    expect(state.started_at).toBe("2026-03-26T09:00:00Z");
    expect(state.convergence_achieved).toBe(false); // default preserved

    // Verify file was written
    const statePath = path.join(artifactDir, "autopilot-state.yaml");
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("merges partial update onto existing state", async () => {
    // Create initial state
    await handleUpdateAutopilotState(ctx, {
      state: { cycles_completed: 2, started_at: "2026-03-26T09:00:00Z" },
    });

    // Update only convergence
    const result = await handleUpdateAutopilotState(ctx, {
      state: { convergence_achieved: true, last_phase: "review" },
    });
    const state = JSON.parse(result);

    expect(state.cycles_completed).toBe(2); // preserved
    expect(state.convergence_achieved).toBe(true); // updated
    expect(state.last_phase).toBe("review"); // added
    expect(state.started_at).toBe("2026-03-26T09:00:00Z"); // preserved
  });

  it("throws when state parameter is missing", async () => {
    await expect(handleUpdateAutopilotState(ctx, {})).rejects.toThrow("Missing required parameter: state");
  });
});

// ---------------------------------------------------------------------------
// resolveArtifactPath routing via handleWriteArtifact
// ---------------------------------------------------------------------------

describe("handleWriteArtifact routing", () => {
  it("routes guiding_principle to principles/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "principles"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "guiding_principle",
      id: "GP-99",
      content: { name: "Test Principle", description: "A test guiding principle" },
    });

    expect(result).toContain("principles");
    expect(result).toContain("GP-99");
    const filePath = path.join(artifactDir, "principles", "GP-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes constraint to constraints/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "constraints"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "constraint",
      id: "C-99",
      content: { category: "technical", description: "A test constraint" },
    });

    expect(result).toContain("constraints");
    const filePath = path.join(artifactDir, "constraints", "C-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes domain_policy to policies/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "policies"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "domain_policy",
      id: "P-99",
      content: { domain: "workflow", description: "Test policy" },
    });

    expect(result).toContain("policies");
    const filePath = path.join(artifactDir, "policies", "P-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes domain_decision to decisions/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "decisions"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "domain_decision",
      id: "D-99",
      content: { domain: "workflow", description: "Test decision" },
    });

    expect(result).toContain("decisions");
    const filePath = path.join(artifactDir, "decisions", "D-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes domain_question to questions/ directory", async () => {
    fs.mkdirSync(path.join(artifactDir, "questions"), { recursive: true });

    const result = await handleWriteArtifact(ctx, {
      type: "domain_question",
      id: "Q-99",
      content: { domain: "workflow", description: "Test question" },
    });

    expect(result).toContain("questions");
    const filePath = path.join(artifactDir, "questions", "Q-99.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("routes domain_index to domains/index.yaml", async () => {
    // domains dir already created in beforeEach

    const result = await handleWriteArtifact(ctx, {
      type: "domain_index",
      id: "index",
      content: { current_cycle: 5, domains: ["workflow", "infra"] },
    });

    expect(result).toContain("domains");
    const filePath = path.join(artifactDir, "domains", "index.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
