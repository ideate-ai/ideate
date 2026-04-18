/**
 * telemetry-wiring.test.ts — Tests for WI-861: session_id/cycle/phase wiring.
 *
 * Acceptance criteria covered:
 *   AC-1: initServer populates ctx with session_id, cycle, phase from context
 *   AC-3: getToolUsage returns rows with session_id, cycle, phase populated
 *   AC-4: insert with context → query returns the context values (non-null)
 *
 * Also covers:
 *   - readTelemetryContext reads last_cycle/last_phase from autopilot-state.yaml
 *   - readTelemetryContext returns nulls when autopilot-state.yaml is absent
 *   - session_id is a valid UUID (non-null, non-empty)
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
import type { ToolContext } from "../types.js";
import { handleGetToolUsage } from "../tools/tool-usage.js";
import { readTelemetryContext, initServer, createDormantState } from "../server.js";
import { createIdeateDir } from "../config.js";
import { artifactWatcher } from "../watcher.js";

// ---------------------------------------------------------------------------
// Shared setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-telemetry-wiring-test-"));
});

afterEach(async () => {
  await artifactWatcher.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readTelemetryContext — unit tests for the helper
// ---------------------------------------------------------------------------

describe("readTelemetryContext", () => {
  it("returns a non-empty UUID session_id even when autopilot-state.yaml is absent", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx = readTelemetryContext(ideateDir);

    expect(typeof ctx.session_id).toBe("string");
    expect(ctx.session_id.length).toBeGreaterThan(0);
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    expect(ctx.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("returns null cycle and null phase when autopilot-state.yaml is absent", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx = readTelemetryContext(ideateDir);

    expect(ctx.cycle).toBeNull();
    expect(ctx.phase).toBeNull();
  });

  it("reads last_cycle and last_phase from autopilot-state.yaml when present", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideateDir, "autopilot-state.yaml"),
      "last_cycle: 5\nlast_phase: execute\n",
      "utf8"
    );

    const ctx = readTelemetryContext(ideateDir);

    expect(ctx.cycle).toBe(5);
    expect(ctx.phase).toBe("execute");
  });

  it("returns null cycle/phase if autopilot-state.yaml has no last_cycle/last_phase keys", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideateDir, "autopilot-state.yaml"),
      "cycles_completed: 3\n",
      "utf8"
    );

    const ctx = readTelemetryContext(ideateDir);

    expect(ctx.cycle).toBeNull();
    expect(ctx.phase).toBeNull();
  });

  it("each call returns a distinct session_id (UUID is regenerated per call)", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx1 = readTelemetryContext(ideateDir);
    const ctx2 = readTelemetryContext(ideateDir);

    expect(ctx1.session_id).not.toBe(ctx2.session_id);
  });
});

// ---------------------------------------------------------------------------
// initServer telemetry wiring — ctx.session_id, ctx.cycle, ctx.phase populated
// ---------------------------------------------------------------------------

describe("initServer telemetry wiring", () => {
  it("populates ctx.session_id as a non-empty UUID after initServer", () => {
    const ideateDir = createIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);
    try {
      expect(state.ctx).not.toBeNull();
      expect(typeof state.ctx!.session_id).toBe("string");
      expect(state.ctx!.session_id!.length).toBeGreaterThan(0);
      expect(state.ctx!.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    } finally {
      state.db?.close();
    }
  });

  it("populates ctx.cycle and ctx.phase from autopilot-state.yaml", () => {
    const ideateDir = createIdeateDir(tmpDir);
    fs.writeFileSync(
      path.join(ideateDir, "autopilot-state.yaml"),
      "last_cycle: 7\nlast_phase: review\n",
      "utf8"
    );

    const state = createDormantState();
    initServer(ideateDir, state);
    try {
      expect(state.ctx!.cycle).toBe(7);
      expect(state.ctx!.phase).toBe("review");
    } finally {
      state.db?.close();
    }
  });

  it("ctx.cycle and ctx.phase are null when autopilot-state.yaml is absent", () => {
    const ideateDir = createIdeateDir(tmpDir);
    const state = createDormantState();

    initServer(ideateDir, state);
    try {
      expect(state.ctx!.cycle).toBeNull();
      expect(state.ctx!.phase).toBeNull();
    } finally {
      state.db?.close();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end: insert with context → getToolUsage returns non-null values
// (AC-3, AC-4)
// ---------------------------------------------------------------------------

describe("insert with context → getToolUsage returns non-null context values", () => {
  let db: Database.Database;
  let drizzleDb: DrizzleDb;
  let adapter: LocalAdapter;
  let ctx: ToolContext;
  let ideateDir: string;

  beforeEach(async () => {
    ideateDir = path.join(tmpDir, ".ideate");

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

    // Simulate what initServer does: populate session_id, cycle, phase on ctx
    ctx = {
      db,
      drizzleDb,
      ideateDir,
      adapter,
      session_id: "test-session-wired-001",
      cycle: 3,
      phase: "execute",
    };
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
  });

  it("insertToolUsage with ctx values → getToolUsage returns non-null session_id, cycle, phase", async () => {
    // Insert a row using the populated context values (as instrumentToolDispatch would)
    insertToolUsage(drizzleDb, {
      tool_name: "ideate_artifact_query",
      request_tokens: 50,
      response_tokens: 100,
      request_bytes: 256,
      response_bytes: 512,
      session_id: ctx.session_id ?? null,
      cycle: ctx.cycle ?? null,
      phase: ctx.phase ?? null,
      timestamp: new Date().toISOString(),
    });

    // Query via handleGetToolUsage with view=detail
    const result = JSON.parse(
      await handleGetToolUsage(ctx, { view: "detail" })
    ) as {
      rows: Array<{
        tool_name: string;
        session_id: string | null;
        cycle: number | null;
        phase: string | null;
      }>;
    };

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.session_id).toBe("test-session-wired-001");
    expect(row.cycle).toBe(3);
    expect(row.phase).toBe("execute");
  });

  it("filter by session_id returns only matching rows", async () => {
    insertToolUsage(drizzleDb, {
      tool_name: "ideate_artifact_query",
      request_tokens: 50,
      response_tokens: 100,
      request_bytes: 256,
      response_bytes: 512,
      session_id: "test-session-wired-001",
      cycle: 3,
      phase: "execute",
      timestamp: new Date().toISOString(),
    });

    insertToolUsage(drizzleDb, {
      tool_name: "ideate_write_artifact",
      request_tokens: 20,
      response_tokens: 40,
      request_bytes: 128,
      response_bytes: 256,
      session_id: "other-session-999",
      cycle: 1,
      phase: "review",
      timestamp: new Date().toISOString(),
    });

    const result = JSON.parse(
      await handleGetToolUsage(ctx, {
        view: "detail",
        session_id: "test-session-wired-001",
      })
    ) as { rows: Array<{ session_id: string | null }> };

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].session_id).toBe("test-session-wired-001");
  });
});
