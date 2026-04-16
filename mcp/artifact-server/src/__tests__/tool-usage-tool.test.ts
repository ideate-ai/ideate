/**
 * tool-usage-tool.test.ts — Integration tests for handleGetToolUsage (WI-857)
 *
 * Exercises all three view modes, filter pass-through, limit/truncation,
 * limit clamping, no-adapter error, and null-token aggregation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { DrizzleDb } from "../db-helpers.js";
import { insertToolUsage } from "../db-helpers.js";
import { LocalAdapter } from "../adapters/local/index.js";
import type { ToolUsageInsert } from "../adapter.js";
import type { ToolContext } from "../types.js";
import { handleGetToolUsage } from "../tools/tool-usage.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let ideateDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let adapter: LocalAdapter;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-tool-usage-tool-test-"));
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

  ctx = { db, drizzleDb, ideateDir, adapter };
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed data — 5 rows with two distinct tool_name, two cycle, two phase values
// ---------------------------------------------------------------------------

const ROW_1: ToolUsageInsert = {
  tool_name: "ideate_artifact_query",
  request_tokens: 100,
  response_tokens: 200,
  request_bytes: 512,
  response_bytes: 1024,
  session_id: "sess-a",
  cycle: 1,
  phase: "execute",
  timestamp: "2026-04-10T10:00:00.000Z",
};

const ROW_2: ToolUsageInsert = {
  tool_name: "ideate_artifact_query",
  request_tokens: 150,
  response_tokens: 300,
  request_bytes: 768,
  response_bytes: 2048,
  session_id: "sess-a",
  cycle: 1,
  phase: "execute",
  timestamp: "2026-04-10T11:00:00.000Z",
};

const ROW_3: ToolUsageInsert = {
  tool_name: "ideate_write_artifact",
  request_tokens: 80,
  response_tokens: 160,
  request_bytes: 400,
  response_bytes: 800,
  session_id: "sess-b",
  cycle: 2,
  phase: "review",
  timestamp: "2026-04-11T09:00:00.000Z",
};

const ROW_4: ToolUsageInsert = {
  tool_name: "ideate_write_artifact",
  request_tokens: null,
  response_tokens: null,
  request_bytes: 300,
  response_bytes: 600,
  session_id: "sess-b",
  cycle: 2,
  phase: "review",
  timestamp: "2026-04-11T14:00:00.000Z",
};

const ROW_5: ToolUsageInsert = {
  tool_name: "ideate_artifact_query",
  request_tokens: 200,
  response_tokens: 400,
  request_bytes: 900,
  response_bytes: 1800,
  session_id: "sess-c",
  cycle: 2,
  phase: "execute",
  timestamp: "2026-04-12T08:00:00.000Z",
};

const ALL_ROWS = [ROW_1, ROW_2, ROW_3, ROW_4, ROW_5];

function seedAll(): void {
  for (const row of ALL_ROWS) {
    insertToolUsage(drizzleDb, row);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGetToolUsage", () => {
  // -------------------------------------------------------------------------
  // 1. aggregate default
  // -------------------------------------------------------------------------
  it("aggregate default: returns aggregate sorted by tool_name ASC; no rows field", async () => {
    seedAll();
    const result = JSON.parse(await handleGetToolUsage(ctx, {})) as {
      filters: Record<string, unknown>;
      aggregate: Array<{
        tool_name: string;
        count: number;
        request_tokens_total: number;
        response_tokens_total: number;
        request_bytes_total: number;
        response_bytes_total: number;
      }>;
      rows?: unknown;
    };

    expect(result).not.toHaveProperty("rows");
    expect(result.aggregate).toBeDefined();

    // Two distinct tool names, sorted ASC
    const names = result.aggregate.map((r) => r.tool_name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("ideate_artifact_query");
    expect(names).toContain("ideate_write_artifact");

    // ideate_artifact_query: 3 rows, tokens sum = 100+150+200=450 req, 200+300+400=900 resp
    const aqRow = result.aggregate.find((r) => r.tool_name === "ideate_artifact_query")!;
    expect(aqRow.count).toBe(3);
    expect(aqRow.request_tokens_total).toBe(450);
    expect(aqRow.response_tokens_total).toBe(900);
    expect(aqRow.request_bytes_total).toBe(512 + 768 + 900);
    expect(aqRow.response_bytes_total).toBe(1024 + 2048 + 1800);

    // ideate_write_artifact: 2 rows, null treated as 0
    const waRow = result.aggregate.find((r) => r.tool_name === "ideate_write_artifact")!;
    expect(waRow.count).toBe(2);
    expect(waRow.request_tokens_total).toBe(80); // null=0, so 80+0=80
    expect(waRow.response_tokens_total).toBe(160);
    expect(waRow.request_bytes_total).toBe(400 + 300);
    expect(waRow.response_bytes_total).toBe(800 + 600);
  });

  // -------------------------------------------------------------------------
  // 2. detail view
  // -------------------------------------------------------------------------
  it("detail view: returns rows, total_count, truncated:false; no aggregate field", async () => {
    seedAll();
    const result = JSON.parse(await handleGetToolUsage(ctx, { view: "detail" })) as {
      filters: Record<string, unknown>;
      rows: unknown[];
      total_count: number;
      truncated: boolean;
      aggregate?: unknown;
    };

    expect(result).not.toHaveProperty("aggregate");
    expect(result.rows).toHaveLength(5);
    expect(result.total_count).toBe(5);
    expect(result.truncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. both view
  // -------------------------------------------------------------------------
  it("both view: returns aggregate and rows", async () => {
    seedAll();
    const result = JSON.parse(await handleGetToolUsage(ctx, { view: "both" })) as {
      aggregate: unknown[];
      rows: unknown[];
      total_count: number;
      truncated: boolean;
    };

    expect(result.aggregate).toBeDefined();
    expect(result.rows).toBeDefined();
    expect(result.rows).toHaveLength(5);
    expect(result.total_count).toBe(5);
    expect(result.truncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. filter by tool_name
  // -------------------------------------------------------------------------
  it("filter by tool_name: aggregate shows only matching tool; count correct", async () => {
    seedAll();
    const result = JSON.parse(
      await handleGetToolUsage(ctx, { tool_name: "ideate_write_artifact" })
    ) as { aggregate: Array<{ tool_name: string; count: number }> };

    expect(result.aggregate).toHaveLength(1);
    expect(result.aggregate[0].tool_name).toBe("ideate_write_artifact");
    expect(result.aggregate[0].count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 5. filter by cycle
  // -------------------------------------------------------------------------
  it("filter by cycle: aggregate respects cycle filter", async () => {
    seedAll();
    const result = JSON.parse(
      await handleGetToolUsage(ctx, { cycle: 1 })
    ) as { aggregate: Array<{ tool_name: string; count: number }> };

    // Cycle 1 has ROW_1 and ROW_2, both ideate_artifact_query
    expect(result.aggregate).toHaveLength(1);
    expect(result.aggregate[0].tool_name).toBe("ideate_artifact_query");
    expect(result.aggregate[0].count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 6. filter by from/to timestamp range
  // -------------------------------------------------------------------------
  it("filter by from/to: only rows within range are counted", async () => {
    seedAll();
    // Range covers ROW_3 and ROW_4 only (2026-04-11)
    const result = JSON.parse(
      await handleGetToolUsage(ctx, {
        from: "2026-04-11T00:00:00.000Z",
        to: "2026-04-11T23:59:59.999Z",
      })
    ) as { aggregate: Array<{ tool_name: string; count: number }> };

    expect(result.aggregate).toHaveLength(1);
    expect(result.aggregate[0].tool_name).toBe("ideate_write_artifact");
    expect(result.aggregate[0].count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 7. limit truncation
  // -------------------------------------------------------------------------
  it("limit truncation: rows.length === limit, total_count === full count, truncated === true", async () => {
    seedAll();
    const result = JSON.parse(
      await handleGetToolUsage(ctx, { view: "detail", limit: 2 })
    ) as { rows: unknown[]; total_count: number; truncated: boolean };

    expect(result.rows).toHaveLength(2);
    expect(result.total_count).toBe(5);
    expect(result.truncated).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. limit clamping (limit > 10000 → clamped to 10000, doesn't break normal path)
  // -------------------------------------------------------------------------
  it("limit clamping: limit:99999 is clamped to 10000; all 5 rows returned, truncated:false", async () => {
    seedAll();
    const result = JSON.parse(
      await handleGetToolUsage(ctx, { view: "detail", limit: 99999 })
    ) as { rows: unknown[]; total_count: number; truncated: boolean };

    // 5 rows < 10000, so all returned
    expect(result.rows).toHaveLength(5);
    expect(result.total_count).toBe(5);
    expect(result.truncated).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 9. both view — truncation: aggregate.count is exact, rows.length === limit
  // -------------------------------------------------------------------------
  it("both view truncation: aggregate count is N, rows.length is N-1, truncated === true", async () => {
    seedAll(); // seeds 5 rows
    const N = 5;
    const limit = N - 1; // 4

    const result = JSON.parse(
      await handleGetToolUsage(ctx, { view: "both", limit })
    ) as {
      aggregate: Array<{ tool_name: string; count: number }>;
      rows: unknown[];
      total_count: number;
      truncated: boolean;
    };

    // aggregate is always computed from all rows — exact regardless of limit
    const aggregateTotal = result.aggregate.reduce((sum, r) => sum + r.count, 0);
    expect(aggregateTotal).toBe(N);

    // detail section is capped at limit; newest rows (tail) are omitted
    expect(result.rows).toHaveLength(limit);
    expect(result.total_count).toBe(N);
    expect(result.truncated).toBe(true);

    // Direction check: oldest rows (ROW_1..ROW_4) retained, newest (ROW_5) dropped.
    // A reversed-order implementation (DESC) would retain ROW_5 and drop ROW_1.
    const rows = result.rows as Array<{ timestamp: string }>;
    expect(rows[rows.length - 1].timestamp).toBe(ROW_4.timestamp);
    expect(rows.some(r => r.timestamp === ROW_5.timestamp)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 10. no adapter throws
  // -------------------------------------------------------------------------
  it("no adapter: throws with message mentioning 'adapter'", async () => {
    const noAdapterCtx: ToolContext = { ideateDir };
    await expect(handleGetToolUsage(noAdapterCtx, {})).rejects.toThrow(/adapter/i);
  });

  // -------------------------------------------------------------------------
  // 11. null tokens treated as 0 in aggregates (not NaN)
  // -------------------------------------------------------------------------
  it("null tokens: treated as 0 in aggregate sum; result is not NaN", async () => {
    insertToolUsage(drizzleDb, {
      tool_name: "ideate_null_token_tool",
      request_tokens: null,
      response_tokens: null,
      request_bytes: 100,
      response_bytes: 200,
      session_id: null,
      cycle: null,
      phase: null,
      timestamp: "2026-04-15T00:00:00.000Z",
    });

    const result = JSON.parse(
      await handleGetToolUsage(ctx, { tool_name: "ideate_null_token_tool" })
    ) as { aggregate: Array<{ request_tokens_total: number; response_tokens_total: number }> };

    expect(result.aggregate).toHaveLength(1);
    expect(result.aggregate[0].request_tokens_total).toBe(0);
    expect(result.aggregate[0].response_tokens_total).toBe(0);
    expect(Number.isNaN(result.aggregate[0].request_tokens_total)).toBe(false);
    expect(Number.isNaN(result.aggregate[0].response_tokens_total)).toBe(false);
  });
});
