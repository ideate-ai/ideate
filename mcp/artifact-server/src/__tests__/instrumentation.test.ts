/**
 * instrumentation.test.ts — Tests for countTokens and instrumentToolDispatch (WI-856)
 *
 * Test (a): successful handler → exactly one tool_usage row with correct fields
 * Test (b): handler throws → tool_usage row still recorded; handler error propagates
 * Test (c): insertToolUsage throws → handler result still returned; error logged but not propagated
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { DrizzleDb } from "../db-helpers.js";
import type { ToolContext } from "../types.js";
import { countTokens, instrumentToolDispatch } from "../tools/instrumentation.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-instrumentation-test-"));
  artifactDir = path.join(tmpDir, ".ideate");

  for (const sub of ["work-items", "policies", "decisions", "questions", "domains"]) {
    fs.mkdirSync(path.join(artifactDir, sub), { recursive: true });
  }

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);
  drizzleDb = drizzle(db, { schema: dbSchema });

  ctx = { db, drizzleDb, ideateDir: artifactDir };
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: read all tool_usage rows from the real SQLite DB
// ---------------------------------------------------------------------------

interface ToolUsageDbRow {
  id: number;
  tool_name: string;
  request_tokens: number | null;
  response_tokens: number | null;
  request_bytes: number;
  response_bytes: number;
  session_id: string | null;
  cycle: number | null;
  phase: string | null;
  timestamp: string;
}

function getToolUsageRows(): ToolUsageDbRow[] {
  return db.prepare("SELECT * FROM tool_usage ORDER BY id ASC").all() as ToolUsageDbRow[];
}

// ---------------------------------------------------------------------------
// countTokens — basic sanity test
// ---------------------------------------------------------------------------

describe("countTokens", () => {
  it("returns a non-negative number for non-empty text", () => {
    const n = countTokens("hello world");
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThan(0);
  });

  it("returns 0 for empty string", () => {
    // cl100k_base encodes empty string as 0 tokens
    expect(countTokens("")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test (a): successful handler → exactly one tool_usage row with correct fields
// ---------------------------------------------------------------------------

describe("instrumentToolDispatch", () => {
  it("(a) successful handler → one tool_usage row with correct fields", async () => {
    const result = await instrumentToolDispatch(
      ctx,
      "ideate_test_tool",
      { query: "hello" },
      async () => "ok-response"
    );

    expect(result).toBe("ok-response");

    const rows = getToolUsageRows();
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.tool_name).toBe("ideate_test_tool");
    expect(row.session_id).toBeNull();
    expect(row.cycle).toBeNull();
    expect(row.phase).toBeNull();
    // request_bytes: JSON.stringify({ query: "hello" }) → {"query":"hello"} → 15 bytes
    expect(row.request_bytes).toBe(Buffer.byteLength(JSON.stringify({ query: "hello" }), "utf8"));
    // response_bytes: JSON.stringify("ok-response") → "ok-response" → 13 bytes
    expect(row.response_bytes).toBe(Buffer.byteLength(JSON.stringify("ok-response"), "utf8"));
    // Token counts are non-negative numbers
    expect(typeof row.request_tokens).toBe("number");
    expect(typeof row.response_tokens).toBe("number");
    expect((row.request_tokens as number)).toBeGreaterThanOrEqual(0);
    expect((row.response_tokens as number)).toBeGreaterThanOrEqual(0);
    // Timestamp is a valid ISO string
    expect(() => new Date(row.timestamp)).not.toThrow();
    expect(new Date(row.timestamp).toISOString()).toBe(row.timestamp);
  });

  it("(a) session_id, cycle, phase from ctx are stored in tool_usage row", async () => {
    ctx.session_id = "test-session-123";
    ctx.cycle = 7;
    ctx.phase = "execute";

    await instrumentToolDispatch(ctx, "ideate_foo", {}, async () => "result");

    const rows = getToolUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("test-session-123");
    expect(rows[0].cycle).toBe(7);
    expect(rows[0].phase).toBe("execute");
  });

  // ---------------------------------------------------------------------------
  // Test (b): handler throws → tool_usage row still recorded; error propagates
  // ---------------------------------------------------------------------------

  it("(b) handler throws → tool_usage row recorded AND error propagates", async () => {
    const boom = new Error("handler-failure");

    await expect(
      instrumentToolDispatch(
        ctx,
        "ideate_failing_tool",
        { x: 1 },
        async () => { throw boom; }
      )
    ).rejects.toThrow("handler-failure");

    // Telemetry row must still be present
    const rows = getToolUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("ideate_failing_tool");
    // Response JSON encodes the error
    const responseJson = JSON.stringify({ error: "handler-failure" });
    expect(rows[0].response_bytes).toBe(Buffer.byteLength(responseJson, "utf8"));
  });

  // ---------------------------------------------------------------------------
  // Test (c): insertToolUsage throws → handler result returned; error logged not propagated
  // ---------------------------------------------------------------------------

  it("(c) insertToolUsage throws → handler result returned; telemetry error not propagated", async () => {
    // Sabotage the drizzleDb so that any insert on tool_usage table throws.
    // We replace the drizzleDb.transaction method (used by insertToolUsage) with a
    // function that throws. This simulates a DB write failure without affecting the handler.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drizzleAny = drizzleDb as any;
    const originalTransaction = drizzleAny.transaction;
    let callCount = 0;
    drizzleAny.transaction = () => {
      callCount++;
      throw new Error("db-transaction-failed");
    };

    // Spy on log.warn to verify the telemetry-failure observability path.
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    // Handler must succeed and its result must be returned
    const result = await instrumentToolDispatch(
      ctx,
      "ideate_telemetry_fail",
      {},
      async () => "success-despite-telemetry-failure"
    );

    expect(result).toBe("success-despite-telemetry-failure");
    // The transaction mock was called (i.e. insertToolUsage was attempted)
    expect(callCount).toBeGreaterThan(0);
    // No rows were actually inserted since transaction threw
    const rows = getToolUsageRows();
    expect(rows).toHaveLength(0);
    // log.warn was called with the expected prefix and payload shape
    expect(warnSpy).toHaveBeenCalledWith(
      "instrumentation",
      "tool_usage insert failed",
      expect.objectContaining({ toolName: "ideate_telemetry_fail" })
    );

    // Restore original
    drizzleAny.transaction = originalTransaction;
  });

  // ---------------------------------------------------------------------------
  // Edge case: no drizzleDb → handler runs, no telemetry attempted
  // ---------------------------------------------------------------------------

  it("skips telemetry when ctx.drizzleDb is undefined (dormant mode)", async () => {
    const dormantCtx: ToolContext = { ideateDir: artifactDir };

    const result = await instrumentToolDispatch(
      dormantCtx,
      "ideate_dormant_call",
      {},
      async () => "dormant-result"
    );

    expect(result).toBe("dormant-result");
    // No DB to query, just verify no throw occurred
  });

  // ---------------------------------------------------------------------------
  // Edge case: handler throws `undefined` — the `threw` sentinel must still
  // cause the wrapper to rethrow, not silently return `undefined` as a success.
  // ---------------------------------------------------------------------------

  it("rethrows when handler throws undefined (does not swallow falsy throws)", async () => {
    let caught: { caught: boolean; value: unknown } = { caught: false, value: "not-caught" };
    try {
      await instrumentToolDispatch(
        ctx,
        "ideate_throw_undefined",
        {},
        async () => {
          // eslint-disable-next-line no-throw-literal
          throw undefined;
        }
      );
    } catch (e) {
      caught = { caught: true, value: e };
    }
    expect(caught.caught).toBe(true);
    expect(caught.value).toBeUndefined();
    // Telemetry row is still recorded even for `throw undefined`
    const rows = getToolUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("ideate_throw_undefined");
  });

  // ---------------------------------------------------------------------------
  // Edge case: handler throws `null` — must not produce a secondary TypeError
  // from property access on the thrown value.
  // ---------------------------------------------------------------------------

  it("rethrows original null when handler throws null (no secondary TypeError)", async () => {
    let caught: { caught: boolean; value: unknown } = { caught: false, value: "not-caught" };
    try {
      await instrumentToolDispatch(
        ctx,
        "ideate_throw_null",
        {},
        async () => {
          // eslint-disable-next-line no-throw-literal
          throw null;
        }
      );
    } catch (e) {
      caught = { caught: true, value: e };
    }
    expect(caught.caught).toBe(true);
    expect(caught.value).toBeNull();
    // Telemetry row is still recorded; response JSON encodes "null" via String(null)
    const rows = getToolUsageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("ideate_throw_null");
    const expectedResponseJson = JSON.stringify({ error: "null" });
    expect(rows[0].response_bytes).toBe(Buffer.byteLength(expectedResponseJson, "utf8"));
  });
});
