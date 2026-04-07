/**
 * write-transaction.test.ts — Transaction rollback tests for write.ts handlers.
 *
 * These tests verify that when the SQLite transaction fails after YAML files
 * have been written, the written files are cleaned up (best-effort) so that
 * the filesystem and DB remain in a consistent state.
 *
 * Approach:
 * - Each test sets up a real temp SQLite DB + temp artifact directory.
 * - A write handler is called with a patched drizzleDb whose `insert` method
 *   throws, simulating a mid-transaction failure.  The raw `ctx.db` (better-
 *   sqlite3) stays open so setup queries (max_id, DAG validation, etc.) succeed.
 * - The test asserts:
 *   (a) The call re-throws the error from the DB layer.
 *   (b) The YAML file(s) that were written before the DB failure are removed.
 *   (c) No node rows exist in SQLite (transaction rolled back / never committed).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as crypto from "crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { DrizzleDb } from "../db-helpers.js";
import { computeArtifactHash } from "../db-helpers.js";
import type { ToolContext } from "../types.js";
import { handleWriteWorkItems, handleWriteArtifact, handleUpdateWorkItems, handleAppendJournal } from "../tools/write.js";
import { ValidationError } from "../adapter.js";
import { LocalAdapter } from "../adapters/local/index.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-write-txn-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  // Minimal artifact dir structure
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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count rows in the nodes table */
function nodeCount(): number {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as { cnt: number };
  return row.cnt;
}

/** List files in the work-items directory */
function workItemFiles(): string[] {
  const dir = path.join(artifactDir, "work-items");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

/** List files in the policies directory */
function policyFiles(): string[] {
  const dir = path.join(artifactDir, "policies");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

/** List files in the journal directory for a given cycle */
function journalFiles(cycleStr: string): string[] {
  const dir = path.join(artifactDir, "cycles", cycleStr, "journal");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

/** List YAML files in the findings directory for a given cycle */
function findingFiles(cycleStr: string): string[] {
  const dir = path.join(artifactDir, "cycles", cycleStr, "findings");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".yaml"));
}

/**
 * Build a ToolContext whose drizzleDb.insert() always throws.
 * The raw better-sqlite3 `db` (and its .transaction / .prepare) remain open
 * so that the setup queries (max_id, DAG validation, etc.) succeed normally.
 * Only the Drizzle-layer upserts fail, simulating a mid-transaction error.
 */
function makeFailingDrizzleCtx(): ToolContext {
  // Proxy the drizzleDb so that insert() throws
  const failingDrizzleDb = new Proxy(drizzleDb, {
    get(target, prop) {
      if (prop === "insert") {
        return () => {
          throw new Error("simulated SQLite constraint violation");
        };
      }
      // Delegate all other methods (transaction, select, etc.) to real drizzleDb
      const val = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  }) as DrizzleDb;

  return { db, drizzleDb: failingDrizzleDb, ideateDir: artifactDir };
}

// ---------------------------------------------------------------------------
// Tests: handleWriteWorkItems transaction rollback
// ---------------------------------------------------------------------------

describe("handleWriteWorkItems — transaction rollback", () => {
  it("cleans up written YAML files when the SQLite transaction fails", async () => {
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleWriteWorkItems(failCtx, {
        items: [{ title: "Test work item" }],
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must have been cleaned up by the rollback handler
    expect(workItemFiles()).toHaveLength(0);
  });

  it("cleans up multiple YAML files when a batch fails", async () => {
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleWriteWorkItems(failCtx, {
        items: [
          { title: "Item one" },
          { title: "Item two" },
          { title: "Item three" },
        ],
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // All YAML files must have been cleaned up
    expect(workItemFiles()).toHaveLength(0);
  });

  it("does not insert any nodes on transaction failure", async () => {
    const failCtx = makeFailingDrizzleCtx();
    const before = nodeCount();

    await expect(
      handleWriteWorkItems(failCtx, {
        items: [{ title: "Should not persist" }],
      })
    ).rejects.toThrow();

    // No nodes should have been inserted (transaction never committed)
    expect(nodeCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleWriteArtifact transaction rollback
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — transaction rollback", () => {
  it("cleans up written YAML file when the SQLite transaction fails", async () => {
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleWriteArtifact(failCtx, {
        type: "domain_policy",
        id: "P-99",
        content: {
          domain: "workflow",
          description: "Test policy",
        },
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must have been cleaned up by the rollback handler
    expect(policyFiles()).toHaveLength(0);
  });

  it("does not insert any nodes for domain_policy on transaction failure", async () => {
    const failCtx = makeFailingDrizzleCtx();
    const before = nodeCount();

    await expect(
      handleWriteArtifact(failCtx, {
        type: "domain_policy",
        id: "P-100",
        content: {
          domain: "workflow",
          description: "Another test policy",
        },
      })
    ).rejects.toThrow();

    expect(nodeCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleWriteArtifact rollback — domain_policy extension table
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — domain_policy rollback (extension table)", () => {
  it("rolls back domain_policy: YAML file removed and no nodes row on failure", async () => {
    const artifactId = "P-rollback-001";
    const failCtx = makeFailingDrizzleCtx();
    const expectedPath = path.join(artifactDir, "policies", `${artifactId}.yaml`);

    await expect(
      handleWriteArtifact(failCtx, {
        type: "domain_policy",
        id: artifactId,
        content: { domain: "workflow", description: "Test rollback policy" },
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must be cleaned up
    expect(fs.existsSync(expectedPath)).toBe(false);
    // No node row in SQLite
    const row = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE id = ?").get(artifactId) as { n: number };
    expect(row.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleWriteArtifact rollback — cycle_summary (document_artifacts)
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — cycle_summary rollback (document_artifacts)", () => {
  it("rolls back cycle_summary: YAML file removed and no nodes row on failure", async () => {
    const artifactId = "CS-rollback-001";
    const cycleNumber = 5;
    const failCtx = makeFailingDrizzleCtx();
    const paddedCycle = String(cycleNumber).padStart(3, "0");
    const expectedPath = path.join(artifactDir, "cycles", paddedCycle, `${artifactId}.yaml`);

    await expect(
      handleWriteArtifact(failCtx, {
        type: "cycle_summary",
        id: artifactId,
        content: { title: "Test cycle summary" },
        cycle: cycleNumber,
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must be cleaned up
    expect(fs.existsSync(expectedPath)).toBe(false);
    // No node row in SQLite
    const row = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE id = ?").get(artifactId) as { n: number };
    expect(row.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleWriteArtifact — document_artifacts.content stores raw string
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — document_artifacts.content is raw string (not JSON-wrapped)", () => {
  it("stores the raw content string for cycle_summary, not JSON.stringify of the full object", async () => {
    const artifactId = "CS-content-raw-001";
    const rawContent = "## Summary\nAll pass";

    await handleWriteArtifact(ctx, {
      type: "cycle_summary",
      id: artifactId,
      content: { content: rawContent, cycle: 1 },
      cycle: 1,
    });

    const row = db
      .prepare("SELECT content FROM document_artifacts WHERE id = ?")
      .get(artifactId) as { content: string } | undefined;

    expect(row).toBeDefined();
    // Must be the raw string, not JSON.stringify'd
    expect(row!.content).toBe(rawContent);
    // Confirm it is NOT the JSON-wrapped form
    expect(row!.content).not.toBe(JSON.stringify({ content: rawContent, cycle: 1 }));
  });
});

// ---------------------------------------------------------------------------
// Tests: successful writes (smoke test — no rollback expected)
// ---------------------------------------------------------------------------

describe("handleWriteWorkItems — successful write", () => {
  it("writes YAML file and inserts node on success", async () => {
    await handleWriteWorkItems(ctx, {
      items: [{ title: "Happy path item" }],
    });

    // One YAML file should exist
    expect(workItemFiles()).toHaveLength(1);

    // One node should be in the DB
    expect(nodeCount()).toBe(1);
  });
});

describe("handleWriteArtifact — successful write", () => {
  it("writes YAML file and inserts node on success", async () => {
    await handleWriteArtifact(ctx, {
      type: "domain_policy",
      id: "P-01",
      content: {
        domain: "workflow",
        description: "Happy path policy",
      },
    });

    expect(policyFiles()).toHaveLength(1);
    expect(nodeCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleUpdateWorkItems transaction rollback
// ---------------------------------------------------------------------------

describe("handleUpdateWorkItems — transaction rollback", () => {
  /** Create a work item using the real ctx, return the YAML file path */
  async function seedWorkItem(id: string, title: string): Promise<string> {
    await handleWriteWorkItems(ctx, { items: [{ id, title }] });
    return path.join(artifactDir, "work-items", `${id}.yaml`);
  }

  it("re-throws when the SQLite transaction fails", async () => {
    await seedWorkItem("WI-001", "Original title");
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleUpdateWorkItems(failCtx, {
        updates: [{ id: "WI-001", status: "done" }],
      })
    ).rejects.toThrow("simulated SQLite constraint violation");
  });

  it("restores original YAML content (not delete) when the SQLite transaction fails", async () => {
    const filePath = await seedWorkItem("WI-002", "Original title");
    const originalContent = fs.readFileSync(filePath, "utf8");
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleUpdateWorkItems(failCtx, {
        updates: [{ id: "WI-002", status: "done" }],
      })
    ).rejects.toThrow();

    // File must still exist (not deleted)
    expect(fs.existsSync(filePath)).toBe(true);
    // File content must be restored to original (not the modified version)
    const restoredContent = fs.readFileSync(filePath, "utf8");
    expect(restoredContent).toBe(originalContent);

    // Verify the DB content_hash matches the restored file content (computed from
    // content fields only, excluding metadata, consistent with computeArtifactHash).
    const row = db.prepare("SELECT content_hash FROM nodes WHERE id = 'WI-002'").get() as { content_hash: string } | undefined;
    if (row) {
      const { parse: parseYaml } = await import("yaml");
      const parsedRestored = parseYaml(restoredContent) as Record<string, unknown>;
      const expectedHash = computeArtifactHash(parsedRestored);
      expect(row.content_hash).toBe(expectedHash);
    }
  });

  it("does not change node rows on transaction failure", async () => {
    await seedWorkItem("WI-003", "Stable title");
    const beforeCount = nodeCount();
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleUpdateWorkItems(failCtx, {
        updates: [{ id: "WI-003", status: "in_progress" }],
      })
    ).rejects.toThrow();

    // Node count unchanged — no partial DB writes
    expect(nodeCount()).toBe(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleAppendJournal transaction rollback
// ---------------------------------------------------------------------------

describe("handleAppendJournal — transaction rollback", () => {
  it("cleans up written YAML file when the SQLite transaction fails", async () => {
    const failCtx = makeFailingDrizzleCtx();

    await expect(
      handleAppendJournal(failCtx, {
        skill: "execute",
        date: "2026-01-01",
        entry_type: "test_entry",
        body: "Test journal body",
        cycle_number: 1,
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must have been cleaned up
    expect(journalFiles("001")).toHaveLength(0);
  });

  it("does not insert any nodes on transaction failure", async () => {
    const failCtx = makeFailingDrizzleCtx();
    const before = nodeCount();

    await expect(
      handleAppendJournal(failCtx, {
        skill: "execute",
        date: "2026-01-01",
        entry_type: "test_entry",
        body: "Test journal body",
        cycle_number: 2,
      })
    ).rejects.toThrow();

    expect(nodeCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleWriteArtifact rollback — finding (findings extension table)
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — finding rollback (findings extension table)", () => {
  it("cleans up YAML file and leaves no nodes row on finding transaction failure", async () => {
    const artifactId = "F-rollback-001";
    const cycleNumber = 999;
    const cycleStr = String(cycleNumber).padStart(3, "0");
    const failCtx = makeFailingDrizzleCtx();
    const expectedPath = path.join(artifactDir, "cycles", cycleStr, "findings", `${artifactId}.yaml`);

    await expect(
      handleWriteArtifact(failCtx, {
        type: "finding",
        id: artifactId,
        content: {
          severity: "minor",
          work_item: "WI-rollback",
          verdict: "Fail",
          cycle: cycleNumber,
          reviewer: "rollback-test",
        },
        cycle: cycleNumber,
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must be cleaned up
    expect(fs.existsSync(expectedPath)).toBe(false);
    expect(findingFiles(cycleStr)).toHaveLength(0);
    // No node row in SQLite
    const row = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE id = ?").get(artifactId) as { n: number };
    expect(row.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: handleWriteArtifact rollback — interview_question (interview_questions)
// ---------------------------------------------------------------------------

describe("handleWriteArtifact — interview_question rollback (interview_questions extension table)", () => {
  it("cleans up YAML file and leaves no nodes row on interview_question transaction failure", async () => {
    const artifactId = "IQ-rollback-001";
    const failCtx = makeFailingDrizzleCtx();
    const expectedPath = path.join(artifactDir, "interviews", `${artifactId}.yaml`);

    await expect(
      handleWriteArtifact(failCtx, {
        type: "interview_question",
        id: artifactId,
        content: {
          interview_id: "refine-001",
          question: "What is the plan?",
          answer: "No plan",
          seq: 1,
        },
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // YAML file must be cleaned up
    expect(fs.existsSync(expectedPath)).toBe(false);
    // No node row in SQLite
    const row = db.prepare("SELECT COUNT(*) as n FROM nodes WHERE id = ?").get(artifactId) as { n: number };
    expect(row.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: ValidationError type verification on transaction failures
// ---------------------------------------------------------------------------

describe("Transaction failure error type", () => {
  it("throws ValidationError with code TRANSACTION_FAILED on batchMutate failure", async () => {
    const failCtx = makeFailingDrizzleCtx();

    let caughtError: unknown;
    try {
      await handleWriteWorkItems(failCtx, {
        items: [{ title: "Test work item" }],
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("batchMutate");
    expect(error.message).toContain("SQLite transaction failed");
  });

  it("throws ValidationError with code TRANSACTION_FAILED on patchNode failure", async () => {
    // First create a work item with the real ctx
    await handleWriteWorkItems(ctx, { items: [{ id: "WI-PATCH-TEST", title: "Original" }] });

    const failCtx = makeFailingDrizzleCtx();

    let caughtError: unknown;
    try {
      await handleUpdateWorkItems(failCtx, {
        updates: [{ id: "WI-PATCH-TEST", status: "in_progress" }],
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("patchNode");
  });

  it("throws ValidationError with code TRANSACTION_FAILED on appendJournal failure", async () => {
    const failCtx = makeFailingDrizzleCtx();

    let caughtError: unknown;
    try {
      await handleAppendJournal(failCtx, {
        skill: "execute",
        date: "2026-01-01",
        entry_type: "test_validation_error",
        body: "Test body",
        cycle_number: 1,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("appendJournalEntry");
  });

  it("throws ValidationError with code TRANSACTION_FAILED on putNode failure", async () => {
    const failCtx = makeFailingDrizzleCtx();

    let caughtError: unknown;
    try {
      await handleWriteArtifact(failCtx, {
        type: "domain_policy",
        id: "P-PUT-TEST",
        content: { domain: "workflow", description: "Test" },
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("putNode");
  });
});

// -----------------------------------------------------------------------------
// Tests: LocalAdapter.deleteNode transaction failure
// -----------------------------------------------------------------------------

describe("LocalAdapter.deleteNode — transaction failure", () => {
  it("throws ValidationError with code TRANSACTION_FAILED on deleteNode failure", async () => {
    // Create a LocalAdapter with a patched transaction method that will fail
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-delete-test-"));
    const testArtifactDir = path.join(testDir, "artifact");

    // Minimal directory structure
    for (const sub of ["work-items", "domains", "principles"]) {
      fs.mkdirSync(path.join(testArtifactDir, sub), { recursive: true });
    }
    fs.writeFileSync(
      path.join(testArtifactDir, "domains", "index.yaml"),
      "current_cycle: 1\n",
      "utf8"
    );

    const testDbPath = path.join(testDir, "test.db");
    const testDb = new Database(testDbPath);
    createSchema(testDb);

    const testDrizzleDb = drizzle(testDb, { schema: dbSchema });
    const adapter = new LocalAdapter({ db: testDb, drizzleDb: testDrizzleDb, ideateDir: testArtifactDir });
    await adapter.initialize();

    // Create a node first
    await adapter.putNode({
      id: "GP-DELETE-TEST",
      type: "guiding_principle",
      properties: { name: "Test for deletion", description: "Will be deleted" },
    });

    // Patch the db.transaction method to throw an error
    const originalTransaction = testDb.transaction.bind(testDb);
    testDb.transaction = ((fn: () => void) => {
      return () => {
        throw new Error("simulated SQLite transaction failure");
      };
    }) as any;

    // Attempt deleteNode — should throw ValidationError with TRANSACTION_FAILED
    let caughtError: unknown;
    try {
      await adapter.deleteNode("GP-DELETE-TEST");
    } catch (err) {
      caughtError = err;
    }

    // Restore original transaction method
    testDb.transaction = originalTransaction;

    // Cleanup
    try {
      testDb.close();
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("deleteNode");
    expect(error.details?.id).toBe("GP-DELETE-TEST");
  });
});
