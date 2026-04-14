/**
 * metrics.test.ts — Integration tests for handleEmitMetric and handleGetMetrics tools.
 *
 * Tests metric emission and retrieval with various scopes and filters.
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
import type { ToolContext } from "../types.js";
import { handleEmitMetric, handleGetMetrics } from "../tools/metrics.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-metrics-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  // Create artifact dir structure
  fs.mkdirSync(artifactDir, { recursive: true });

  // Open a temp-file DB
  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  drizzleDb = drizzle(db, { schema: dbSchema });
  ctx = { db, drizzleDb, ideateDir: artifactDir };
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to insert a node row
// ---------------------------------------------------------------------------

function insertNode(id: string, cycleCreated?: number): void {
  db.prepare(`
    INSERT OR REPLACE INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
    VALUES (?, 'metrics_event', ?, NULL, 'test-hash', 100, ?, NULL)
  `).run(id, cycleCreated ?? null, `/tmp/${id}.yaml`);
}

// ---------------------------------------------------------------------------
// Helper to insert a metrics event
// ---------------------------------------------------------------------------

function insertMetricsEvent(
  id: string,
  eventName: string,
  payload: Record<string, unknown>,
  options: {
    inputTokens?: number;
    outputTokens?: number;
    outcome?: string;
    findingCount?: number;
    findingSeverities?: string;
    firstPassAccepted?: number | null;
    reworkCount?: number;
    cycleCreated?: number;
  } = {}
): void {
  insertNode(id, options.cycleCreated);
  db.prepare(`
    INSERT INTO metrics_events (
      id, event_name, timestamp, payload, input_tokens, output_tokens,
      outcome, finding_count, finding_severities, first_pass_accepted, rework_count
    ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    eventName,
    JSON.stringify(payload),
    options.inputTokens ?? null,
    options.outputTokens ?? null,
    options.outcome ?? null,
    options.findingCount ?? null,
    options.findingSeverities ?? null,
    options.firstPassAccepted ?? null,
    options.reworkCount ?? null
  );
}

// ---------------------------------------------------------------------------
// handleEmitMetric tests
// ---------------------------------------------------------------------------

describe("handleEmitMetric", () => {
  describe("required parameters", () => {
    it("throws when payload is missing", async () => {
      await expect(
        handleEmitMetric(ctx, {})
      ).rejects.toThrow("Missing required parameter: payload");
    });

    it("throws when payload is null", async () => {
      await expect(
        handleEmitMetric(ctx, { payload: null })
      ).rejects.toThrow("Missing required parameter: payload");
    });
  });

  describe("no-op emission (soft-deprecated)", () => {
    it("returns deprecation message and creates no file under metrics/", async () => {
      const payload = { event_name: "code-reviewer", input_tokens: 100 };
      const result = await handleEmitMetric(ctx, { payload });

      expect(result).toBe("Metric emission deprecated — event not recorded.");

      // No YAML file should be written
      const metricsDir = path.join(artifactDir, "metrics");
      const files = fs.existsSync(metricsDir)
        ? fs.readdirSync(metricsDir).filter(f => f.endsWith(".yaml"))
        : [];
      expect(files).toHaveLength(0);
    });

    it("inserts no row into metrics_events", async () => {
      await handleEmitMetric(ctx, { payload: { event_name: "architect", input_tokens: 1000, cycle: 3 } });

      const rows = db.prepare("SELECT COUNT(*) as cnt FROM metrics_events").get() as { cnt: number };
      expect(rows.cnt).toBe(0);
    });

    it("does not write metrics.jsonl", async () => {
      await handleEmitMetric(ctx, { payload: { event_name: "test" } });
      const jsonlPath = path.join(artifactDir, "metrics.jsonl");
      expect(fs.existsSync(jsonlPath)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// handleGetMetrics tests
// ---------------------------------------------------------------------------

describe("handleGetMetrics", () => {
  describe("empty database", () => {
    it("returns empty tables when no metrics exist", async () => {
      const result = await handleGetMetrics(ctx, {});
      expect(result).toContain("No agent metrics data found");
      expect(result).toContain("No work item metrics data found");
      expect(result).toContain("No cycle metrics data found");
      expect(result).toContain("**Total events**: 0");
    });
  });

  describe("agent scope aggregation", () => {
    it("aggregates metrics by agent type", async () => {
      insertMetricsEvent("m1", "code-reviewer", { work_item: "WI-1" }, { inputTokens: 1000, outputTokens: 500 });
      insertMetricsEvent("m2", "code-reviewer", { work_item: "WI-2" }, { inputTokens: 2000, outputTokens: 800 });
      insertMetricsEvent("m3", "architect", { work_item: "WI-3" }, { inputTokens: 5000, outputTokens: 2000 });

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      expect(result).not.toContain("No agent metrics data found");
      expect(result).toContain("code-reviewer");
      expect(result).toContain("architect");
      expect(result).toContain("**Total events**: 3");
      // Check aggregation: code-reviewer has 2 events, 3000 total input, 1300 total output
      expect(result).toContain("3000"); // total input for code-reviewer
    });

    it("calculates average tokens correctly", async () => {
      insertMetricsEvent("m1", "test-agent", {}, { inputTokens: 100, outputTokens: 50 });
      insertMetricsEvent("m2", "test-agent", {}, { inputTokens: 300, outputTokens: 150 });

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      // Avg input: (100 + 300) / 2 = 200
      // Avg output: (50 + 150) / 2 = 100
      expect(result).toContain("200"); // avg input
      expect(result).toContain("100"); // avg output
    });

    it("tracks finding severities by agent", async () => {
      insertMetricsEvent("m1", "reviewer", {}, {
        findingCount: 3,
        findingSeverities: '{"critical":1,"significant":1,"minor":1}'
      });
      insertMetricsEvent("m2", "reviewer", {}, {
        findingCount: 2,
        findingSeverities: '{"critical":0,"significant":2,"minor":0}'
      });

      const result = await handleGetMetrics(ctx, { scope: "agent" });
      // Total: critical:1, significant:3, minor:1
      expect(result).toContain("1/3/1");
    });

    it("tracks outcomes by agent", async () => {
      insertMetricsEvent("m1", "worker", {}, { outcome: "pass" });
      insertMetricsEvent("m2", "worker", {}, { outcome: "pass" });
      insertMetricsEvent("m3", "worker", {}, { outcome: "rework" });

      const result = await handleGetMetrics(ctx, { scope: "agent" });
      expect(result).toContain("pass: 2");
      expect(result).toContain("rework: 1");
    });
  });

  describe("work_item scope aggregation", () => {
    it("aggregates metrics by work item", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-100" }, { inputTokens: 1000, outputTokens: 500 });
      insertMetricsEvent("m2", "agent", { work_item: "WI-100" }, { inputTokens: 500, outputTokens: 300 });
      insertMetricsEvent("m3", "agent", { work_item: "WI-200" }, { inputTokens: 2000, outputTokens: 1000 });

      const result = await handleGetMetrics(ctx, { scope: "work_item" });

      expect(result).not.toContain("No work item metrics data found");
      expect(result).toContain("WI-100");
      expect(result).toContain("WI-200");
    });

    it("tracks first pass accepted status", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-001" }, { firstPassAccepted: 1 });
      insertMetricsEvent("m2", "agent", { work_item: "WI-002" }, { firstPassAccepted: 0 });
      insertMetricsEvent("m3", "agent", { work_item: "WI-003" }, { firstPassAccepted: null });

      const result = await handleGetMetrics(ctx, { scope: "work_item" });

      expect(result).toContain("WI-001");
      expect(result).toContain("Yes"); // first_pass_accepted = true
      expect(result).toContain("WI-002");
      expect(result).toContain("No"); // first_pass_accepted = false
    });

    it("sums rework counts", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-010" }, { reworkCount: 2 });
      insertMetricsEvent("m2", "agent", { work_item: "WI-010" }, { reworkCount: 1 });

      const result = await handleGetMetrics(ctx, { scope: "work_item" });
      // Total rework: 3
      expect(result).toContain("3");
    });
  });

  describe("cycle scope aggregation", () => {
    it("aggregates metrics by cycle", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 5 });
      insertMetricsEvent("m2", "agent", { work_item: "WI-2" }, { cycleCreated: 5 });
      insertMetricsEvent("m3", "agent", { work_item: "WI-3" }, { cycleCreated: 6 });

      const result = await handleGetMetrics(ctx, { scope: "cycle" });

      expect(result).not.toContain("No cycle metrics data found");
      expect(result).toContain("| 5 |");
      expect(result).toContain("| 6 |");
    });

    it("tracks finding counts by cycle", async () => {
      insertMetricsEvent("m1", "reviewer", {}, {
        cycleCreated: 10,
        findingSeverities: '{"critical":0,"significant":2,"minor":1}'
      });
      insertMetricsEvent("m2", "reviewer", {}, {
        cycleCreated: 10,
        findingSeverities: '{"critical":1,"significant":0,"minor":3}'
      });

      const result = await handleGetMetrics(ctx, { scope: "cycle" });
      // Total: critical:1, significant:2, minor:4
      expect(result).toContain("1/2/4");
    });
  });

  describe("filtering", () => {
    it("filters by cycle", async () => {
      insertMetricsEvent("m1", "agent", {}, { cycleCreated: 5 });
      insertMetricsEvent("m2", "agent", {}, { cycleCreated: 5 });
      insertMetricsEvent("m3", "agent", {}, { cycleCreated: 6 });

      const result = await handleGetMetrics(ctx, { filter: { cycle: 5 } });

      expect(result).toContain("Filters**: cycle: 5");
      expect(result).toContain("**Total events**: 2");
    });

    it("filters by agent_type using exact json_extract match on payload", async () => {
      insertMetricsEvent("m1", "event", { agent_type: "code-reviewer" }, {});
      insertMetricsEvent("m2", "event", { agent_type: "code-reviewer" }, {});
      insertMetricsEvent("m3", "event", { agent_type: "architect" }, {});

      const result = await handleGetMetrics(ctx, { filter: { agent_type: "code-reviewer" } });

      expect(result).toContain("Filters**: agent_type: code-reviewer");
      expect(result).toContain("**Total events**: 2");
    });

    it("filters by work_item using exact json_extract match on payload", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-100" }, {});
      insertMetricsEvent("m2", "agent", { work_item: "WI-100" }, {});
      insertMetricsEvent("m3", "agent", { work_item: "WI-200" }, {});

      const result = await handleGetMetrics(ctx, { filter: { work_item: "WI-100" } });

      expect(result).toContain("Filters**: work_item: WI-100");
      expect(result).toContain("**Total events**: 2");
    });

    it("work_item filter does not match prefix substrings (WI-1 must not match WI-10 or WI-100)", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-1" }, {});
      insertMetricsEvent("m2", "agent", { work_item: "WI-10" }, {});
      insertMetricsEvent("m3", "agent", { work_item: "WI-100" }, {});

      const result = await handleGetMetrics(ctx, { filter: { work_item: "WI-1" } });

      expect(result).toContain("Filters**: work_item: WI-1");
      expect(result).toContain("**Total events**: 1");
    });

    it("filters by phase using exact json_extract match on payload", async () => {
      insertMetricsEvent("m1", "agent", { phase: "execute" }, {});
      insertMetricsEvent("m2", "agent", { phase: "execute" }, {});
      insertMetricsEvent("m3", "agent", { phase: "review" }, {});

      const result = await handleGetMetrics(ctx, { filter: { phase: "execute" } });

      expect(result).toContain("Filters**: phase: execute");
      expect(result).toContain("**Total events**: 2");
    });

    it("combines multiple filters", async () => {
      insertMetricsEvent("m1", "event", { agent_type: "code-reviewer", work_item: "WI-1" }, { cycleCreated: 5 });
      insertMetricsEvent("m2", "event", { agent_type: "code-reviewer", work_item: "WI-2" }, { cycleCreated: 5 });
      insertMetricsEvent("m3", "event", { agent_type: "architect", work_item: "WI-3" }, { cycleCreated: 5 });
      insertMetricsEvent("m4", "event", { agent_type: "code-reviewer", work_item: "WI-4" }, { cycleCreated: 6 });

      const result = await handleGetMetrics(ctx, {
        filter: { cycle: 5, agent_type: "code-reviewer" }
      });

      expect(result).toContain("Filters**: cycle: 5, agent_type: code-reviewer");
      expect(result).toContain("**Total events**: 2");
    });
  });

  describe("scope selection", () => {
    it("returns all scopes when scope is undefined", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 });

      const result = await handleGetMetrics(ctx, {});

      expect(result).toContain("Agent Aggregates");
      expect(result).toContain("Work Item Aggregates");
      expect(result).toContain("Cycle Aggregates");
    });

    it("returns only agent scope when scope is 'agent'", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 });

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      expect(result).toContain("Agent Aggregates");
      expect(result).not.toContain("Work Item Aggregates");
      expect(result).not.toContain("Cycle Aggregates");
    });

    it("returns only work_item scope when scope is 'work_item'", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 });

      const result = await handleGetMetrics(ctx, { scope: "work_item" });

      expect(result).not.toContain("Agent Aggregates");
      expect(result).toContain("Work Item Aggregates");
      expect(result).not.toContain("Cycle Aggregates");
    });

    it("returns only cycle scope when scope is 'cycle'", async () => {
      insertMetricsEvent("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 });

      const result = await handleGetMetrics(ctx, { scope: "cycle" });

      expect(result).not.toContain("Agent Aggregates");
      expect(result).not.toContain("Work Item Aggregates");
      expect(result).toContain("Cycle Aggregates");
    });
  });
});