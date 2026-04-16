/**
 * local-getToolUsage.test.ts — Integration tests for LocalAdapter.getToolUsage (WI-854)
 *
 * Tests the getToolUsage query method against a real SQLite database via
 * LocalAdapter. Verifies filter semantics, AND-combination, range semantics,
 * ordering, and empty results.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../schema.js";
import * as dbSchema from "../../db.js";
import type { DrizzleDb } from "../../db-helpers.js";
import { insertToolUsage } from "../../db-helpers.js";
import { LocalAdapter } from "../../adapters/local/index.js";
import type { ToolUsageRow, ToolUsageInsert } from "../../adapter.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let ideateDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let adapter: LocalAdapter;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-getToolUsage-test-"));
  ideateDir = path.join(tmpDir, ".ideate");

  // Minimal directory structure LocalAdapter expects
  for (const sub of [
    "work-items",
    "policies",
    "decisions",
    "questions",
    "principles",
    "constraints",
    "modules",
    "research",
    "interviews",
    "projects",
    "phases",
    "plan",
    "steering",
    "domains",
    "archive/cycles",
    "archive/incremental",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  // domains/index.yaml needed for cycle_modified resolution
  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);
  drizzleDb = drizzle(db, { schema: dbSchema });

  adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await adapter.initialize();
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

// 6+ rows with varied tool_name, session_id, cycle, phase, timestamp
const ROW_A: ToolUsageInsert = {
  tool_name: "ideate_get_node",
  request_tokens: 100,
  response_tokens: 200,
  request_bytes: 512,
  response_bytes: 1024,
  session_id: "session-alpha",
  cycle: 1,
  phase: "execute",
  timestamp: "2026-04-01T10:00:00.000Z",
};

const ROW_B: ToolUsageInsert = {
  tool_name: "ideate_query",
  request_tokens: 150,
  response_tokens: 300,
  request_bytes: 768,
  response_bytes: 2048,
  session_id: "session-alpha",
  cycle: 1,
  phase: "review",
  timestamp: "2026-04-01T11:00:00.000Z",
};

const ROW_C: ToolUsageInsert = {
  tool_name: "ideate_get_node",
  request_tokens: 80,
  response_tokens: 160,
  request_bytes: 400,
  response_bytes: 800,
  session_id: "session-beta",
  cycle: 2,
  phase: "execute",
  timestamp: "2026-04-02T09:00:00.000Z",
};

const ROW_D: ToolUsageInsert = {
  tool_name: "ideate_put_node",
  request_tokens: null,
  response_tokens: null,
  request_bytes: 300,
  response_bytes: 600,
  session_id: "session-beta",
  cycle: 2,
  phase: "refine",
  timestamp: "2026-04-02T14:00:00.000Z",
};

const ROW_E: ToolUsageInsert = {
  tool_name: "ideate_query",
  request_tokens: 200,
  response_tokens: 400,
  request_bytes: 900,
  response_bytes: 1800,
  session_id: "session-gamma",
  cycle: 3,
  phase: "execute",
  timestamp: "2026-04-03T08:00:00.000Z",
};

const ROW_F: ToolUsageInsert = {
  tool_name: "ideate_get_node",
  request_tokens: 50,
  response_tokens: 100,
  request_bytes: 256,
  response_bytes: 512,
  session_id: "session-gamma",
  cycle: 3,
  phase: "review",
  timestamp: "2026-04-03T16:00:00.000Z",
};

const ALL_ROWS = [ROW_A, ROW_B, ROW_C, ROW_D, ROW_E, ROW_F];

function insertAll(): void {
  for (const row of ALL_ROWS) {
    insertToolUsage(drizzleDb, row);
  }
}

// ---------------------------------------------------------------------------
// Helper: extract comparable fields from returned rows (ignore auto-id)
// ---------------------------------------------------------------------------

function normalize(rows: ToolUsageRow[]): Omit<ToolUsageRow, "id">[] {
  return rows.map(({ id: _id, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LocalAdapter.getToolUsage", () => {
  it("no filter → returns all rows ordered by timestamp ASC, id ASC", async () => {
    insertAll();
    const rows = await adapter.getToolUsage();
    expect(rows).toHaveLength(6);
    // Verify timestamp ordering
    const timestamps = rows.map((r) => r.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
    // Verify all rows are present
    const toolNames = rows.map((r) => r.tool_name);
    expect(toolNames).toContain("ideate_get_node");
    expect(toolNames).toContain("ideate_query");
    expect(toolNames).toContain("ideate_put_node");
  });

  it("single tool_name filter → only matching rows", async () => {
    insertAll();
    const rows = await adapter.getToolUsage({ tool_name: "ideate_get_node" });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.tool_name).toBe("ideate_get_node");
    }
    // Check ordering
    const timestamps = rows.map((r) => r.timestamp);
    expect(timestamps).toEqual([...timestamps].sort());
  });

  it("single cycle filter → only matching rows", async () => {
    insertAll();
    const rows = await adapter.getToolUsage({ cycle: 2 });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.cycle).toBe(2);
    }
    // Rows should be ROW_C and ROW_D (both cycle 2)
    const toolNames = rows.map((r) => r.tool_name).sort();
    expect(toolNames).toContain("ideate_get_node");
    expect(toolNames).toContain("ideate_put_node");
  });

  it("combined tool_name + cycle filter (AND semantics)", async () => {
    insertAll();
    const rows = await adapter.getToolUsage({ tool_name: "ideate_query", cycle: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("ideate_query");
    expect(rows[0].cycle).toBe(1);
    expect(rows[0].session_id).toBe("session-alpha");
  });

  it("from + to range filter (inclusive on both ends)", async () => {
    insertAll();
    // Range covering ROW_B and ROW_C only
    const from = "2026-04-01T11:00:00.000Z";
    const to = "2026-04-02T09:00:00.000Z";
    const rows = await adapter.getToolUsage({ from, to });
    expect(rows).toHaveLength(2);
    // Both endpoints should be included
    const timestamps = rows.map((r) => r.timestamp);
    expect(timestamps).toContain("2026-04-01T11:00:00.000Z");
    expect(timestamps).toContain("2026-04-02T09:00:00.000Z");
    // No rows outside range
    for (const row of rows) {
      expect(row.timestamp >= from).toBe(true);
      expect(row.timestamp <= to).toBe(true);
    }
  });

  it("phase + session_id combination filter", async () => {
    insertAll();
    const rows = await adapter.getToolUsage({ phase: "execute", session_id: "session-beta" });
    expect(rows).toHaveLength(1);
    expect(rows[0].phase).toBe("execute");
    expect(rows[0].session_id).toBe("session-beta");
    expect(rows[0].tool_name).toBe("ideate_get_node");
    expect(rows[0].cycle).toBe(2);
  });

  it("filter with no matching rows → empty array", async () => {
    insertAll();
    const rows = await adapter.getToolUsage({ tool_name: "ideate_nonexistent_tool" });
    expect(rows).toHaveLength(0);
    expect(rows).toEqual([]);
  });

  it("ordering is stable: timestamp ASC, id ASC (two rows with same timestamp)", async () => {
    // Insert two rows with identical timestamps — ordering should be by id ASC
    const ts = "2026-04-10T00:00:00.000Z";
    insertToolUsage(drizzleDb, {
      tool_name: "ideate_query",
      request_tokens: null,
      response_tokens: null,
      request_bytes: 100,
      response_bytes: 200,
      session_id: null,
      cycle: null,
      phase: null,
      timestamp: ts,
    });
    insertToolUsage(drizzleDb, {
      tool_name: "ideate_get_node",
      request_tokens: null,
      response_tokens: null,
      request_bytes: 100,
      response_bytes: 200,
      session_id: null,
      cycle: null,
      phase: null,
      timestamp: ts,
    });
    const rows = await adapter.getToolUsage({ from: ts, to: ts });
    expect(rows).toHaveLength(2);
    // Both have same timestamp; ids should be in ascending order (first inserted = lower id)
    expect(rows[0].id!).toBeLessThan(rows[1].id!);
    // Both timestamps are equal
    expect(rows[0].timestamp).toBe(ts);
    expect(rows[1].timestamp).toBe(ts);
  });

  it("round-trip: inserted values match retrieved values for all fields", async () => {
    insertToolUsage(drizzleDb, ROW_A);
    const rows = await adapter.getToolUsage({ tool_name: "ideate_get_node", cycle: 1 });
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const { id: _id, ...rest } = row;
    expect(rest).toEqual({
      tool_name: ROW_A.tool_name,
      request_tokens: ROW_A.request_tokens,
      response_tokens: ROW_A.response_tokens,
      request_bytes: ROW_A.request_bytes,
      response_bytes: ROW_A.response_bytes,
      session_id: ROW_A.session_id,
      cycle: ROW_A.cycle,
      phase: ROW_A.phase,
      timestamp: ROW_A.timestamp,
    });
  });

  it("undefined filter argument behaves same as no filter", async () => {
    insertAll();
    const rows = await adapter.getToolUsage(undefined);
    expect(rows).toHaveLength(6);
  });
});
