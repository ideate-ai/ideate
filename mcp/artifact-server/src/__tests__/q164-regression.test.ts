/**
 * q164-regression.test.ts — Regression tests for Q-164: MCP stale SQLite read bug.
 *
 * Q-164 scenario: ideate_get_convergence_status returns stale finding counts
 * because the SQLite `findings.addressed_by` column lags behind YAML ground
 * truth.  This happens via two mechanisms:
 *
 *   (A) Two-write sequence: finding written without addressed_by, convergence
 *       checked, finding re-written with addressed_by — the MCP call between
 *       writes saw a stale count of 1.
 *
 *   (B) Index/watcher lag: YAML file updated with addressed_by but the
 *       re-index has not yet propagated it to the findings extension table.
 *
 * The fix in reader.ts getConvergenceData performs per-row YAML verification:
 * for each finding SQLite considers unresolved (addressed_by IS NULL), the YAML
 * file is read and authoritative.  If YAML has addressed_by populated, the
 * finding is treated as resolved regardless of the SQLite row state.
 *
 * See: RF-q164-stale-reads.yaml, WI-887.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import { LocalAdapter } from "../adapters/local/index.js";
import { LocalReaderAdapter } from "../adapters/local/reader.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Setup / teardown helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let ideateDir: string;
let db: Database.Database;
let drizzleDb: ReturnType<typeof drizzle<typeof dbSchema>>;
let adapter: LocalAdapter;
let reader: LocalReaderAdapter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-q164-test-"));
  ideateDir = path.join(tmpDir, ".ideate");

  // Minimal directory structure matching what LocalAdapter expects
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
    "cycles",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  // domains/index.yaml — needed for cycle_modified resolution in putNode
  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 99\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  drizzleDb = drizzle(db, { schema: dbSchema });
  adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  // Access the reader directly for getConvergenceData
  reader = new LocalReaderAdapter(db, drizzleDb, ideateDir);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: write a finding via putNode (exercises the full write path)
// ---------------------------------------------------------------------------

async function writeFinding(
  id: string,
  cycle: number,
  addressedBy: string | null
): Promise<void> {
  const properties: Record<string, unknown> = {
    severity: "significant",
    work_item: "WI-001",
    verdict: "needs-fix",
    reviewer: "test-reviewer",
    cycle,
    description: `Test finding ${id}`,
  };
  if (addressedBy !== null) {
    properties.addressed_by = addressedBy;
  }
  await adapter.putNode({
    id,
    type: "finding",
    cycle,
    properties,
  });
}

// ---------------------------------------------------------------------------
// Test 1 — Two-write sequence (mechanism A)
//
// Simulates the PH-050 cycle 2 incident: finding written without addressed_by,
// convergence checked (sees it open), finding re-written with addressed_by,
// convergence checked again — must return 0 without a server restart.
// ---------------------------------------------------------------------------

describe("Q-164 regression — Test 1: two-write sequence (mechanism A)", () => {
  // Note: the in-process race window of mechanism A (SQLite update committing
  // between YAML-phase-1 and SQLite-phase-2 of the second write) cannot be
  // reproduced here because putNode is synchronous and atomic.  These tests
  // verify the happy-path behavior after an addressed_by update.  The
  // YAML-verification branch is covered end-to-end in Test 2 via SQLite
  // corruption that mimics the stale-DB state that mechanism A could leave.
  it("convergence reflects addressed_by after an in-session update", async () => {
    const CYCLE = 99;

    await writeFinding("F-099-001", CYCLE, null);

    const before = await reader.getConvergenceData(CYCLE);
    expect(before.findings_by_severity["significant"]).toBe(1);

    await writeFinding("F-099-001", CYCLE, "WI-TEST");

    const after = await reader.getConvergenceData(CYCLE);
    expect(after.findings_by_severity["significant"] ?? 0).toBe(0);
  });

  it("multiple open findings all resolved in sequence", async () => {
    const CYCLE = 99;
    const ids = ["F-099-010", "F-099-011", "F-099-012"];

    for (const id of ids) {
      await writeFinding(id, CYCLE, null);
    }

    const before = await reader.getConvergenceData(CYCLE);
    expect(before.findings_by_severity["significant"]).toBe(ids.length);

    for (const id of ids) {
      await writeFinding(id, CYCLE, "WI-887");
    }

    const after = await reader.getConvergenceData(CYCLE);
    expect(after.findings_by_severity["significant"] ?? 0).toBe(0);
  });

  it("YAML-verification path treats SQLite-stale row as resolved (mechanism A post-write residual)", async () => {
    // Simulates the residual SQLite staleness that mechanism A's race window
    // could produce: YAML says resolved, SQLite still says open.  This is the
    // code path the Q-164 fix specifically targets.
    const CYCLE = 99;

    await writeFinding("F-099-013", CYCLE, "WI-TEST");
    db.prepare("UPDATE findings SET addressed_by = NULL WHERE id = ?").run("F-099-013");

    const result = await reader.getConvergenceData(CYCLE);
    expect(result.findings_by_severity["significant"] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — YAML-DB skew (mechanism B)
//
// Simulates a watcher-lag scenario: YAML is written with addressed_by populated
// but we manually corrupt the SQLite findings table to set addressed_by = NULL,
// mimicking the lag window.  getConvergenceData must read YAML and return 0.
// ---------------------------------------------------------------------------

describe("Q-164 regression — Test 2: YAML-DB skew (mechanism B)", () => {
  it("returns 0 for a finding addressed in YAML but stale (NULL) in SQLite", async () => {
    const CYCLE = 99;

    // Write finding normally — addressed_by goes to both YAML and SQLite
    await writeFinding("F-099-020", CYCLE, "WI-887");

    // Verify it is not counted as open by the normal path
    const consistent = await reader.getConvergenceData(CYCLE);
    expect(consistent.findings_by_severity["significant"] ?? 0).toBe(0);

    // Now manually corrupt the SQLite findings table: set addressed_by = NULL
    // (simulating a watcher-lag / historical-bug scenario where SQLite is stale)
    db.prepare(
      "UPDATE findings SET addressed_by = NULL WHERE id = ?"
    ).run("F-099-020");

    // YAML still has addressed_by = 'WI-887' on disk.
    // getConvergenceData should read YAML and return 0, not 1.
    const afterSkew = await reader.getConvergenceData(CYCLE);
    expect(afterSkew.findings_by_severity["significant"] ?? 0).toBe(0);
  });

  it("correctly counts only findings that are genuinely open in both YAML and SQLite", async () => {
    const CYCLE = 99;

    // Write two open findings and one resolved finding
    await writeFinding("F-099-030", CYCLE, null);       // open in both
    await writeFinding("F-099-031", CYCLE, null);       // open in both
    await writeFinding("F-099-032", CYCLE, "WI-887");  // resolved in both

    // Corrupt SQLite for the resolved finding (simulate watcher lag)
    db.prepare("UPDATE findings SET addressed_by = NULL WHERE id = ?").run("F-099-032");

    // Expected: 2 genuinely open, 1 YAML-resolved-but-SQLite-stale → 2 total open
    const result = await reader.getConvergenceData(CYCLE);
    expect(result.findings_by_severity["significant"]).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — MCP / raw-SELECT agreement after fix
//
// After any write-then-read sequence, getConvergenceData must return counts
// consistent with a YAML-verified raw SELECT on the same connection.
// This is the invariant from the Q-164 incident report.
// ---------------------------------------------------------------------------

describe("Q-164 regression — Test 3: MCP and raw-SELECT agreement", () => {
  it("getConvergenceData called twice returns identical counts", async () => {
    const CYCLE = 99;

    await writeFinding("F-099-040", CYCLE, null);
    await writeFinding("F-099-041", CYCLE, "WI-887");
    await writeFinding("F-099-042", CYCLE, null);

    const first = await reader.getConvergenceData(CYCLE);
    const second = await reader.getConvergenceData(CYCLE);

    expect(first.findings_by_severity).toEqual(second.findings_by_severity);
  });

  it("getConvergenceData matches manual YAML-verified SELECT after mixed writes", async () => {
    const CYCLE = 99;

    // Write a mix: some open, some resolved
    await writeFinding("F-099-050", CYCLE, null);       // open
    await writeFinding("F-099-051", CYCLE, "WI-887");  // resolved
    await writeFinding("F-099-052", CYCLE, null);       // open
    await writeFinding("F-099-053", CYCLE, "WI-887");  // resolved

    // Corrupt two rows in SQLite to force YAML-verification path
    db.prepare("UPDATE findings SET addressed_by = NULL WHERE id = ?").run("F-099-051");
    db.prepare("UPDATE findings SET addressed_by = NULL WHERE id = ?").run("F-099-053");

    // After corruption: SQLite says 4 open, YAML says 2 open.
    // getConvergenceData must apply YAML verification and return 2.
    const result = await reader.getConvergenceData(CYCLE);
    expect(result.findings_by_severity["significant"]).toBe(2);

    // Manual YAML verification matching what getConvergenceData does:
    // fetch SQLite NULL rows, read YAML, filter by addressed_by state
    const rawRows = db.prepare(
      `SELECT f.id, f.severity, n.file_path
       FROM findings f
       JOIN nodes n ON f.id = n.id
       WHERE f.cycle = ? AND f.addressed_by IS NULL`
    ).all(CYCLE) as Array<{ id: string; severity: string; file_path: string }>;

    // Apply the same YAML-verification logic manually using parseYaml — the
    // exact same mechanism the production code uses, so any divergence here
    // would reveal a genuine implementation bug rather than a string-matching
    // false positive/negative.
    let manualOpen = 0;
    for (const row of rawRows) {
      try {
        const content = fs.readFileSync(row.file_path, "utf8");
        const parsed = parseYaml(content) as Record<string, unknown> | null;
        const addressedBy = parsed?.["addressed_by"];
        const yamlHasAddressedBy =
          addressedBy !== null && addressedBy !== undefined && addressedBy !== "";
        if (!yamlHasAddressedBy) {
          manualOpen++;
        }
      } catch {
        manualOpen++;
      }
    }

    expect(result.findings_by_severity["significant"]).toBe(manualOpen);
  });

  it("empty cycle returns empty findings_by_severity", async () => {
    const CYCLE = 88; // no findings written for this cycle

    const result = await reader.getConvergenceData(CYCLE);
    expect(result.findings_by_severity).toEqual({});
    expect(result.cycle_summary_content).toBeNull();
  });

  it("convergence is stable after back-to-back write sequences without restart", async () => {
    // Simulate the PH-050 cycle 2 scenario: N Significant findings all with
    // addressed_by set are written, then getConvergenceData(N) is called.
    // Significant count must be 0 without any intervening server restart.
    const CYCLE = 99;
    const N = 5;

    // Write N findings — first without, then immediately with addressed_by
    for (let i = 1; i <= N; i++) {
      const id = `F-099-${String(i + 100).padStart(3, "0")}`;
      await writeFinding(id, CYCLE, null);
      await writeFinding(id, CYCLE, `WI-PH050-cycle2`);
    }

    const result = await reader.getConvergenceData(CYCLE);
    expect(result.findings_by_severity["significant"] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — ENOENT fallback path
//
// When a finding's YAML file has been deleted from disk (ENOENT), the
// getConvergenceData YAML-verification branch must fall back to the SQLite
// value (count as open) and emit a [q164] tagged warn log.
// ---------------------------------------------------------------------------

describe("Q-164 regression — Test 4: ENOENT fallback (deleted YAML file)", () => {
  it("counts finding as open and emits [q164] warn when YAML file is missing", async () => {
    const CYCLE = 99;

    // Write finding — creates both SQLite row and YAML file on disk
    await writeFinding("F-099-060", CYCLE, null);

    // Corrupt SQLite so the YAML-verification path is triggered
    // (SQLite shows addressed_by IS NULL, causing the YAML read attempt)
    // In this case addressed_by IS already NULL so no corruption needed.

    // Retrieve the file_path for the finding from SQLite so we can delete it
    const row = db
      .prepare("SELECT file_path FROM nodes WHERE id = ?")
      .get("F-099-060") as { file_path: string } | undefined;
    expect(row).toBeDefined();
    expect(fs.existsSync(row!.file_path)).toBe(true);

    // Delete the YAML file to simulate ENOENT
    fs.unlinkSync(row!.file_path);

    // Spy on log.warn to verify the [q164] warning is emitted
    const warnSpy = vi.spyOn(log, "warn");

    const result = await reader.getConvergenceData(CYCLE);

    // Finding must be counted as open (fallback to SQLite value)
    expect(result.findings_by_severity["significant"]).toBe(1);

    // A warn log with the [q164] prefix must have been emitted
    const q164Calls = warnSpy.mock.calls.filter(
      ([prefix]) => prefix === "q164"
    );
    expect(q164Calls.length).toBeGreaterThan(0);

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Explicit YAML null treated as open
//
// When the YAML file has `addressed_by: null` as a literal YAML null (not an
// omitted key), getConvergenceData must treat the finding as open.
// This is the "explicit-null" variant of the Q-164 scenario.
// ---------------------------------------------------------------------------

describe("Q-164 regression — Test 5: explicit YAML null treated as open", () => {
  it("counts finding as open when YAML has addressed_by: null (literal null, not missing key)", async () => {
    const CYCLE = 99;

    // Write finding with addressed_by set so the initial SQLite row is clean
    await writeFinding("F-099-070", CYCLE, "WI-PLACEHOLDER");

    // Verify it is resolved (baseline sanity)
    const before = await reader.getConvergenceData(CYCLE);
    expect(before.findings_by_severity["significant"] ?? 0).toBe(0);

    // Corrupt SQLite: set addressed_by = NULL to force YAML-verification path
    db.prepare("UPDATE findings SET addressed_by = NULL WHERE id = ?").run("F-099-070");

    // Overwrite the YAML file on disk with a literal `addressed_by: null`
    const row = db
      .prepare("SELECT file_path FROM nodes WHERE id = ?")
      .get("F-099-070") as { file_path: string } | undefined;
    expect(row).toBeDefined();

    // Read existing YAML, parse it, set addressed_by to null, re-write
    const existingContent = fs.readFileSync(row!.file_path, "utf8");
    const parsed = parseYaml(existingContent) as Record<string, unknown>;
    parsed["addressed_by"] = null;
    fs.writeFileSync(row!.file_path, stringifyYaml(parsed), "utf8");

    // YAML now has `addressed_by: null` (a literal YAML null, not a missing key).
    // getConvergenceData must count this finding as open (null !== resolved).
    const result = await reader.getConvergenceData(CYCLE);
    expect(result.findings_by_severity["significant"]).toBe(1);
  });
});
