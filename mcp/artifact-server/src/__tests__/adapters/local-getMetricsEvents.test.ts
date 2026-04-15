/**
 * local-getMetricsEvents.test.ts — Adapter-level integration tests for
 * LocalReaderAdapter.getMetricsEvents (WI-816).
 *
 * Uses a real SQLite database (temp file) via LocalAdapter. Rows are inserted
 * directly into the `nodes` and `metrics_events` tables to avoid needing YAML
 * files on disk for metrics_event nodes (which are written programmatically,
 * not from YAML).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../schema.js";
import * as dbSchema from "../../db.js";
import { LocalAdapter } from "../../adapters/local/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a minimal node row + metrics_events extension row directly into
 * the SQLite database, bypassing the YAML indexer. This is the correct
 * approach for metrics_event nodes which are written programmatically.
 */
function insertMetricsEvent(
  db: Database.Database,
  opts: {
    id: string;
    cycle_created: number;
    event_name: string;
    payload?: Record<string, unknown>;
    timestamp?: string;
    input_tokens?: number;
    output_tokens?: number;
  }
): void {
  const {
    id,
    cycle_created,
    event_name,
    payload,
    timestamp = "2026-01-01T00:00:00.000Z",
    input_tokens = null,
    output_tokens = null,
  } = opts;

  // Insert into nodes base table
  db.prepare(
    `INSERT INTO nodes (id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status)
     VALUES (?, 'metrics_event', ?, NULL, 'hash-' || ?, NULL, 'metrics/' || ? || '.yaml', NULL)`
  ).run(id, cycle_created, id, id);

  // Insert into metrics_events extension table
  db.prepare(
    `INSERT INTO metrics_events (id, event_name, timestamp, payload, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, outcome, finding_count, finding_severities,
       first_pass_accepted, rework_count, work_item_total_tokens, cycle_total_tokens,
       cycle_total_cost_estimate, convergence_cycles, context_artifact_ids)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
  ).run(
    id,
    event_name,
    timestamp,
    payload !== undefined ? JSON.stringify(payload) : null,
    input_tokens,
    output_tokens
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("LocalReaderAdapter — getMetricsEvents", () => {
  let db: Database.Database;
  let adapter: LocalAdapter;
  let tmpDir: string;
  let ideateDir: string;

  beforeAll(() => {
    // Create temp directories
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-metrics-test-"));
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
      "metrics",
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

    // domains/index.yaml — required for fetchCurrentCycle to resolve
    fs.writeFileSync(
      path.join(ideateDir, "domains", "index.yaml"),
      "current_cycle: 5\n",
      "utf8"
    );

    // Create in-memory-backed SQLite database
    const dbPath = path.join(tmpDir, "test-metrics.db");
    db = new Database(dbPath);
    createSchema(db);
    const drizzleDb = drizzle(db, { schema: dbSchema });

    adapter = new LocalAdapter({ db, drizzleDb, ideateDir });

    // Insert test data directly (no YAML files needed for metrics_event nodes):
    //   ME-001: cycle 1, agent_type=code-reviewer, work_item=WI-100, phase=PH-001
    insertMetricsEvent(db, {
      id: "ME-001",
      cycle_created: 1,
      event_name: "work_item_complete",
      payload: { agent_type: "code-reviewer", work_item: "WI-100", phase: "PH-001" },
      input_tokens: 1000,
      output_tokens: 500,
    });

    //   ME-002: cycle 1, agent_type=architect
    insertMetricsEvent(db, {
      id: "ME-002",
      cycle_created: 1,
      event_name: "review_complete",
      payload: { agent_type: "architect", work_item: "WI-101", phase: "PH-001" },
      input_tokens: 2000,
      output_tokens: 800,
    });

    //   ME-003: cycle 2, agent_type=code-reviewer, work_item=WI-100, phase=PH-002
    insertMetricsEvent(db, {
      id: "ME-003",
      cycle_created: 2,
      event_name: "work_item_complete",
      payload: { agent_type: "code-reviewer", work_item: "WI-100", phase: "PH-002" },
      input_tokens: 1500,
      output_tokens: 600,
    });

    //   ME-004: cycle 3, no payload
    insertMetricsEvent(db, {
      id: "ME-004",
      cycle_created: 3,
      event_name: "cycle_start",
      payload: undefined,
    });

    //   ME-005: cycle 2, agent_type=domain-curator, work_item=WI-102, phase=PH-002
    insertMetricsEvent(db, {
      id: "ME-005",
      cycle_created: 2,
      event_name: "domain_update",
      payload: { agent_type: "domain-curator", work_item: "WI-102", phase: "PH-002" },
    });
  });

  afterAll(() => {
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // -------------------------------------------------------------------------
  // (a) cycle filter — SQL pushdown: WHERE n.cycle_created = ?
  // -------------------------------------------------------------------------

  it("(a) cycle filter returns only events from the specified cycle", async () => {
    const results = await adapter.getMetricsEvents({ cycle: 1 });

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.node.id).sort();
    expect(ids).toEqual(["ME-001", "ME-002"]);

    for (const row of results) {
      expect(row.node.cycle_created).toBe(1);
    }
  });

  // -------------------------------------------------------------------------
  // (b) agent_type filter — TypeScript-side payload JSON matching
  // -------------------------------------------------------------------------

  it("(b) agent_type filter returns only events with matching payload.agent_type", async () => {
    const results = await adapter.getMetricsEvents({ agent_type: "code-reviewer" });

    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.node.id).sort();
    expect(ids).toEqual(["ME-001", "ME-003"]);

    for (const row of results) {
      const payload = JSON.parse(row.properties.payload!) as Record<string, unknown>;
      expect(payload.agent_type).toBe("code-reviewer");
    }
  });

  // -------------------------------------------------------------------------
  // (c) all four filters combined (cycle + agent_type + work_item + phase)
  // -------------------------------------------------------------------------

  it("(c) all four filters combined narrows to a single matching event", async () => {
    const results = await adapter.getMetricsEvents({
      cycle: 2,
      agent_type: "code-reviewer",
      work_item: "WI-100",
      phase: "PH-002",
    });

    expect(results).toHaveLength(1);
    expect(results[0].node.id).toBe("ME-003");
    expect(results[0].node.cycle_created).toBe(2);

    const payload = JSON.parse(results[0].properties.payload!) as Record<string, unknown>;
    expect(payload.agent_type).toBe("code-reviewer");
    expect(payload.work_item).toBe("WI-100");
    expect(payload.phase).toBe("PH-002");
  });

  // -------------------------------------------------------------------------
  // (d) empty result — cycle with no matching events
  // -------------------------------------------------------------------------

  it("(d) returns an empty array when no events match the filter", async () => {
    const results = await adapter.getMetricsEvents({ cycle: 999 });
    expect(results).toHaveLength(0);
    expect(results).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // (e) no filter — returns all events, ordered by timestamp then id
  // -------------------------------------------------------------------------

  it("(e) no filter returns all metrics events with correct shape", async () => {
    const results = await adapter.getMetricsEvents();

    expect(results).toHaveLength(5);

    // Verify all expected IDs are present
    const ids = results.map((r) => r.node.id).sort();
    expect(ids).toEqual(["ME-001", "ME-002", "ME-003", "ME-004", "ME-005"]);

    // Verify node shape
    for (const row of results) {
      expect(row.node.id).toBeTruthy();
      expect(row.node.type).toBe("metrics_event");
      expect(typeof row.node.cycle_created).toBe("number");

      // Verify properties shape
      expect(row.properties).toHaveProperty("event_name");
      expect(row.properties).toHaveProperty("timestamp");
      expect(row.properties).toHaveProperty("payload");
    }

    // Verify ME-004 (no payload) returns null payload
    const me004 = results.find((r) => r.node.id === "ME-004");
    expect(me004).toBeDefined();
    expect(me004!.properties.payload).toBeNull();
    expect(me004!.properties.event_name).toBe("cycle_start");
  });
});
