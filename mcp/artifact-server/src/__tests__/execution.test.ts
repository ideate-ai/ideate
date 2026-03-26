/**
 * execution.test.ts — Tests for handleGetExecutionStatus focusing on
 * obsolete status handling.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import { ToolContext } from "../tools/index.js";
import { handleGetExecutionStatus } from "../tools/execution.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-execution-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  for (const sub of [
    "archive/incremental",
    "archive/cycles",
    "plan/work-items",
    "domains",
  ]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  fs.writeFileSync(path.join(artifactDir, "journal.md"), "", "utf8");
  fs.writeFileSync(
    path.join(artifactDir, "domains", "index.md"),
    "current_cycle: 1\n\n## Domains\n",
    "utf8"
  );

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

function insertWorkItem(
  id: string,
  title: string,
  options: {
    depends?: string[];
  } = {}
): void {
  db.prepare(`
    INSERT OR REPLACE INTO work_items (id, title, complexity, domain, depends, blocks, criteria, scope)
    VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)
  `).run(
    id,
    title,
    "small",
    null,
    options.depends ? JSON.stringify(options.depends) : null
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGetExecutionStatus — obsolete items", () => {
  it("obsolete items are excluded from execution status counts", async () => {
    // Insert one obsolete work item and two regular ones
    insertNode("WI-001", "work_item", { status: "obsolete" });
    insertWorkItem("WI-001", "Obsolete item");

    insertNode("WI-002", "work_item", { status: "pending" });
    insertWorkItem("WI-002", "Pending item");

    insertNode("WI-003", "work_item", { status: "done" });
    insertWorkItem("WI-003", "Done item");

    const result = await handleGetExecutionStatus(ctx, {});

    // WI-001 should appear in the Obsolete count, not in pending/ready/blocked
    expect(result).toContain("Obsolete: 1");

    // Pending count should not include the obsolete item
    // WI-002 has no deps, so it goes to ready (not pending)
    expect(result).not.toMatch(/Pending:\s*[1-9]/); // pending should be 0
    expect(result).toContain("Ready to execute: 1"); // only WI-002 is ready
    expect(result).toContain("Completed: 1"); // WI-003

    // Blocked count should be 0
    expect(result).toContain("Blocked: 0");

    // WI-001 should be listed under the obsolete section
    expect(result).toContain("WI-001");
  });

  it("obsolete items satisfy dependencies for downstream items", async () => {
    // WI-A is obsolete; WI-B depends on WI-A
    insertNode("WI-A", "work_item", { status: "obsolete" });
    insertWorkItem("WI-A", "Obsolete dependency");

    insertNode("WI-B", "work_item", { status: "pending" });
    insertWorkItem("WI-B", "Downstream item", { depends: ["WI-A"] });

    const result = await handleGetExecutionStatus(ctx, {});

    // WI-B's dependency on WI-A is satisfied because WI-A is obsolete
    // So WI-B should appear as ready, not blocked
    expect(result).toContain("Ready to execute: 1");
    expect(result).toContain("WI-B");
    expect(result).toContain("Blocked: 0");

    // WI-A should be reported as obsolete
    expect(result).toContain("Obsolete: 1");
    expect(result).toContain("WI-A");

    // WI-B should NOT appear in blocked
    expect(result).not.toMatch(/WI-B blocked by/);
  });
});
