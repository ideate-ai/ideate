/**
 * execution-status-equivalence.test.ts
 *
 * Tests for handleGetExecutionStatus using a seeded LocalAdapter.
 *
 * Verifies that:
 *   - Completed, obsolete, ready, blocked, and pending items are correctly
 *     categorised from adapter-sourced data (no ctx.db.prepare / ctx.drizzleDb).
 *   - The handler output shape is stable (line prefixes, counts, IDs).
 *
 * RemoteAdapter dual-path:
 *   A RemoteAdapter test requires a running Docker Compose stack
 *   (docker compose -f docker-compose.test.yml up -d) and the migration CLI.
 *   When the server is available (isTestServerAvailable() === true) the suite
 *   runs a dual-adapter check; otherwise it is skipped with a clear message.
 *
 * To run equivalence tests locally:
 *   docker compose -f docker-compose.test.yml up -d
 *   pnpm test --run tests/adapters/execution-status-equivalence.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { handleGetExecutionStatus } from "../../src/tools/execution.js";
import type { ToolContext } from "../../src/types.js";
import {
  isTestServerAvailable,
  createDualAdapters,
  type DualAdapters,
} from "./equivalence-helpers.js";

// ---------------------------------------------------------------------------
// Local-only setup helper
// ---------------------------------------------------------------------------

interface LocalSetup {
  adapter: LocalAdapter;
  ctx: ToolContext;
  tmpDir: string;
  db: Database.Database;
}

async function createLocalSetup(): Promise<LocalSetup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-exec-equiv-test-")
  );
  const ideateDir = path.join(tmpDir, ".ideate");

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
  const db = new Database(dbPath);
  createSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });

  const adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await adapter.initialize();

  const ctx: ToolContext = { db, drizzleDb, ideateDir, adapter };

  return { adapter, ctx, tmpDir, db };
}

async function cleanupLocalSetup(setup: LocalSetup): Promise<void> {
  try { await setup.adapter.shutdown(); } catch { /* ignore */ }
  try { setup.db.close(); } catch { /* ignore */ }
  try { fs.rmSync(setup.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// LocalAdapter — handleGetExecutionStatus unit tests
// ---------------------------------------------------------------------------

describe("handleGetExecutionStatus — LocalAdapter", () => {
  let setup: LocalSetup;

  beforeAll(async () => {
    setup = await createLocalSetup();

    // Seed work items:
    //   WI-DONE-1  — status=done, no deps
    //   WI-DONE-2  — status=complete, no deps
    //   WI-OBSOLETE — status=obsolete, no deps
    //   WI-READY   — status=pending, depends=[WI-DONE-1]  (dep satisfied)
    //   WI-BLOCKED — status=pending, depends=[WI-READY]   (dep not satisfied)

    await setup.adapter.putNode({
      id: "WI-DONE-1",
      type: "work_item",
      properties: {
        title: "Done item one",
        status: "done",
        depends: [],
        complexity: "small",
        work_item_type: "feature",
        domain: "artifact-structure",
        phase: "PH-001",
      },
      cycle: 1,
    });

    await setup.adapter.putNode({
      id: "WI-DONE-2",
      type: "work_item",
      properties: {
        title: "Done item two",
        status: "complete",
        depends: [],
        complexity: "small",
        work_item_type: "feature",
        domain: "artifact-structure",
        phase: "PH-001",
      },
      cycle: 1,
    });

    await setup.adapter.putNode({
      id: "WI-OBSOLETE",
      type: "work_item",
      properties: {
        title: "Obsolete item",
        status: "obsolete",
        depends: [],
        complexity: "small",
        work_item_type: "feature",
        domain: "artifact-structure",
        phase: "PH-001",
      },
      cycle: 1,
    });

    await setup.adapter.putNode({
      id: "WI-READY",
      type: "work_item",
      properties: {
        title: "Ready item",
        status: "pending",
        depends: ["WI-DONE-1"],
        complexity: "small",
        work_item_type: "feature",
        domain: "artifact-structure",
        phase: "PH-001",
      },
      cycle: 1,
    });

    await setup.adapter.putNode({
      id: "WI-BLOCKED",
      type: "work_item",
      properties: {
        title: "Blocked item",
        status: "pending",
        depends: ["WI-READY"],
        complexity: "small",
        work_item_type: "feature",
        domain: "artifact-structure",
        phase: "PH-001",
      },
      cycle: 1,
    });
  }, 30_000);

  afterAll(async () => {
    await cleanupLocalSetup(setup);
  });

  it("returns the ## Execution Status header", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    expect(result).toContain("## Execution Status");
  });

  it("counts completed items correctly (done + complete statuses)", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    // WI-DONE-1 (done) + WI-DONE-2 (complete) = 2 completed
    expect(result).toMatch(/Completed: 2/);
  });

  it("counts obsolete items correctly", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    expect(result).toMatch(/Obsolete: 1/);
  });

  it("identifies ready items (deps satisfied by done items)", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    // WI-READY depends on WI-DONE-1 which is done
    expect(result).toMatch(/Ready to execute: 1/);
    expect(result).toContain("WI-READY");
  });

  it("identifies blocked items (deps not yet satisfied)", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    // WI-BLOCKED depends on WI-READY which is still pending/not complete
    expect(result).toMatch(/Blocked: 1/);
    expect(result).toContain("WI-BLOCKED blocked by: WI-READY");
  });

  it("reports correct total", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    expect(result).toContain("Total: 5");
  });

  it("does not include obsolete item id in ready or blocked lists", async () => {
    const result = await handleGetExecutionStatus(setup.ctx, {});
    // Obsolete items should never appear in ready/blocked lists
    expect(result).not.toMatch(/WI-OBSOLETE.*blocked by/);
    // The "Ready to execute" line should not mention WI-OBSOLETE
    const readyLine = result.split("\n").find((l) => l.startsWith("Ready to execute:")) ?? "";
    expect(readyLine).not.toContain("WI-OBSOLETE");
  });

  it("obsolete items satisfy dependencies for downstream items", async () => {
    // Create a fresh context with WI-A (obsolete) and WI-B (pending, depends WI-A)
    const fresh = await createLocalSetup();
    try {
      await fresh.adapter.putNode({
        id: "WI-A",
        type: "work_item",
        properties: {
          title: "Obsolete dep",
          status: "obsolete",
          depends: [],
          complexity: "small",
          work_item_type: "feature",
          domain: "test",
          phase: "PH-001",
        },
        cycle: 1,
      });
      await fresh.adapter.patchNode({ id: "WI-A", properties: { status: "obsolete" } });

      await fresh.adapter.putNode({
        id: "WI-B",
        type: "work_item",
        properties: {
          title: "Downstream item",
          status: "pending",
          depends: ["WI-A"],
          complexity: "small",
          work_item_type: "feature",
          domain: "test",
          phase: "PH-001",
        },
        cycle: 1,
      });

      const result = await handleGetExecutionStatus(fresh.ctx, {});
      expect(result).toContain("Ready to execute: 1");
      expect(result).toContain("WI-B");
      expect(result).toContain("Blocked: 0");
    } finally {
      await cleanupLocalSetup(fresh);
    }
  });
});

// ---------------------------------------------------------------------------
// RemoteAdapter dual-path (skipped if Docker stack is not running)
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const remoteSuite = serverAvailable ? describe : describe.skip;

remoteSuite(
  "handleGetExecutionStatus — LocalAdapter vs RemoteAdapter (equivalence fixture)",
  () => {
    let adapters: DualAdapters;

    beforeAll(async () => {
      adapters = await createDualAdapters();
    }, 120_000);

    afterAll(async () => {
      if (adapters) await adapters.cleanup();
    });

    it("both adapters produce the same Completed count for fixture data", async () => {
      const localCtx: ToolContext = {
        db: (adapters.local as unknown as { db: Database.Database }).db,
        drizzleDb: (adapters.local as unknown as { drizzleDb: ReturnType<typeof drizzle> }).drizzleDb,
        ideateDir: "",
        adapter: adapters.local,
      };
      const remoteCtx: ToolContext = {
        db: (adapters.local as unknown as { db: Database.Database }).db,
        drizzleDb: (adapters.local as unknown as { drizzleDb: ReturnType<typeof drizzle> }).drizzleDb,
        ideateDir: "",
        adapter: adapters.remote,
      };

      const [localResult, remoteResult] = await Promise.all([
        handleGetExecutionStatus(localCtx, {}),
        handleGetExecutionStatus(remoteCtx, {}),
      ]);

      // Extract Completed line from both
      const extractCount = (output: string, label: string): string =>
        output.split("\n").find((l) => l.startsWith(label)) ?? "";

      expect(extractCount(localResult, "Completed:")).toBe(
        extractCount(remoteResult, "Completed:")
      );
      expect(extractCount(localResult, "Obsolete:")).toBe(
        extractCount(remoteResult, "Obsolete:")
      );
      expect(extractCount(localResult, "Total:")).toBe(
        extractCount(remoteResult, "Total:")
      );
    });
  }
);
