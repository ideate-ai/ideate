/**
 * write-transaction.test.ts — TRANSACTION_FAILED validation tests for LocalAdapter
 *
 * Tests that each write method throws ValidationError with code TRANSACTION_FAILED
 * when the underlying SQLite operation fails. These are local-adapter-only tests;
 * TRANSACTION_FAILED is not part of the cross-adapter equivalence suite.
 *
 * Methods covered: putNode, patchNode, deleteNode, batchMutate, putEdge, removeEdges
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { ValidationError } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

interface TestSetup {
  adapter: LocalAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createSetup(): Promise<TestSetup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-write-tx-test-")
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

  return { adapter, tmpDir, db };
}

async function teardown(setup: TestSetup): Promise<void> {
  try {
    setup.db.close();
  } catch {
    // ignore
  }
  try {
    fs.rmSync(setup.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Helper: create a mock transaction function that throws when called
// ---------------------------------------------------------------------------

function makeThrowingTransaction(): ReturnType<Database.Database["transaction"]> {
  const fn: any = () => {
    throw new Error("simulated SQLite transaction failure");
  };
  fn.exclusive = fn;
  fn.immediate = fn;
  fn.deferred = fn;
  return fn as ReturnType<Database.Database["transaction"]>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LocalAdapter TRANSACTION_FAILED errors (write-transaction.test.ts)", () => {
  let setup: TestSetup;

  beforeAll(async () => {
    setup = await createSetup();
  });

  afterAll(async () => {
    await teardown(setup);
  });

  // -------------------------------------------------------------------------
  // putNode
  // -------------------------------------------------------------------------

  describe("putNode", () => {
    it("throws ValidationError with code TRANSACTION_FAILED when db.transaction throws", async () => {
      const spy = vi
        .spyOn(setup.db, "transaction")
        .mockReturnValue(makeThrowingTransaction());
      try {
        await expect(
          setup.adapter.putNode({
            id: "GP-TX-001",
            type: "guiding_principle",
            properties: { name: "TX test node" },
          })
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.putNode({
            id: "GP-TX-001",
            type: "guiding_principle",
            properties: { name: "TX test node" },
          });
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("TRANSACTION_FAILED");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // patchNode
  // -------------------------------------------------------------------------

  describe("patchNode", () => {
    beforeAll(async () => {
      // Create a node to patch (using the real db, before mocking)
      await setup.adapter.putNode({
        id: "GP-PATCH-001",
        type: "guiding_principle",
        properties: { name: "patch target" },
      });
    });

    it("throws ValidationError with code TRANSACTION_FAILED when db.transaction throws", async () => {
      const spy = vi
        .spyOn(setup.db, "transaction")
        .mockReturnValue(makeThrowingTransaction());
      try {
        await expect(
          setup.adapter.patchNode({
            id: "GP-PATCH-001",
            properties: { name: "patched name" },
          })
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.patchNode({
            id: "GP-PATCH-001",
            properties: { name: "patched name" },
          });
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("TRANSACTION_FAILED");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // deleteNode
  // -------------------------------------------------------------------------

  describe("deleteNode", () => {
    beforeAll(async () => {
      // Create a node to delete (using the real db, before mocking)
      await setup.adapter.putNode({
        id: "GP-DEL-001",
        type: "guiding_principle",
        properties: { name: "delete target" },
      });
    });

    it("throws ValidationError with code TRANSACTION_FAILED when db.transaction throws", async () => {
      const spy = vi
        .spyOn(setup.db, "transaction")
        .mockReturnValue(makeThrowingTransaction());
      try {
        await expect(
          setup.adapter.deleteNode("GP-DEL-001")
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.deleteNode("GP-DEL-001");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("TRANSACTION_FAILED");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // batchMutate
  // -------------------------------------------------------------------------

  describe("batchMutate", () => {
    it("throws ValidationError with code TRANSACTION_FAILED when db.transaction throws", async () => {
      const spy = vi
        .spyOn(setup.db, "transaction")
        .mockReturnValue(makeThrowingTransaction());
      try {
        await expect(
          setup.adapter.batchMutate({
            nodes: [
              {
                id: "GP-BATCH-TX-001",
                type: "guiding_principle",
                properties: { name: "batch tx test" },
              },
            ],
          })
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.batchMutate({
            nodes: [
              {
                id: "GP-BATCH-TX-001",
                type: "guiding_principle",
                properties: { name: "batch tx test" },
              },
            ],
          });
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("TRANSACTION_FAILED");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // putEdge — SG1 from cycle 23
  // -------------------------------------------------------------------------

  describe("putEdge", () => {
    it("throws ValidationError with code TRANSACTION_FAILED when drizzleDb.insert throws", async () => {
      // putEdge calls insertEdge(this.drizzleDb, ...) which uses the chain:
      // drizzleDb.insert(...).values(...).onConflictDoNothing().run()
      // Real DB failures occur at .run(), so mock the full chain and throw there.
      const drizzleDb = (setup.adapter as any).drizzleDb;
      const spy = vi
        .spyOn(drizzleDb, "insert")
        .mockReturnValue({
          values: () => ({
            onConflictDoNothing: () => ({
              run: () => { throw new Error("simulated SQLite insert failure"); }
            })
          })
        } as any);
      try {
        await expect(
          setup.adapter.putEdge({
            source_id: "GP-EDGE-SRC-001",
            target_id: "GP-EDGE-TGT-001",
            edge_type: "relates_to",
            properties: {},
          })
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.putEdge({
            source_id: "GP-EDGE-SRC-001",
            target_id: "GP-EDGE-TGT-001",
            edge_type: "relates_to",
            properties: {},
          });
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("TRANSACTION_FAILED");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  // -------------------------------------------------------------------------
  // removeEdges — SG1 from cycle 23
  // -------------------------------------------------------------------------

  describe("removeEdges", () => {
    it("throws ValidationError with code TRANSACTION_FAILED when db.prepare throws", async () => {
      const spy = vi
        .spyOn(setup.db, "prepare")
        .mockImplementation(() => {
          throw new Error("simulated SQLite prepare failure");
        });
      try {
        await expect(
          setup.adapter.removeEdges("GP-REMOVE-SRC-001", ["relates_to"])
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.removeEdges("GP-REMOVE-SRC-001", ["relates_to"]);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("TRANSACTION_FAILED");
        }
      } finally {
        spy.mockRestore();
      }
    });
  });
});
