/**
 * writer.test.ts — Unit tests for LocalWriterAdapter fixes (WI-695)
 *
 * Covers three bug fixes:
 *   S1 — putNode rollback for updates: when the SQLite transaction fails on an
 *        update, the original YAML content is restored (not deleted).
 *   M4 — deleteNode write order: YAML file is removed before the SQLite DELETE
 *        (YAML-first per P-44).
 *   M3 — nextId error type: unsupported node type throws ValidationError with
 *        code INVALID_NODE_TYPE (not a plain Error).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../schema.js";
import * as dbSchema from "../../db.js";
import type { DrizzleDb } from "../../db-helpers.js";
import { LocalAdapter } from "../../adapters/local/index.js";
import { LocalWriterAdapter } from "../../adapters/local/writer.js";
import { ValidationError } from "../../adapter.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let ideateDir: string;
let db: Database.Database;
let drizzleDb: DrizzleDb;
let adapter: LocalAdapter;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-writer-test-"));
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
// Helper: build a LocalAdapter with a drizzleDb whose insert() always throws
// ---------------------------------------------------------------------------

function makeAdapterWithFailingDb(): LocalAdapter {
  const failingDrizzleDb = new Proxy(drizzleDb, {
    get(target, prop) {
      if (prop === "insert") {
        return () => {
          throw new Error("simulated SQLite constraint violation");
        };
      }
      const val = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof val === "function") return val.bind(target);
      return val;
    },
  }) as DrizzleDb;

  return new LocalAdapter({ db, drizzleDb: failingDrizzleDb, ideateDir });
}

// ---------------------------------------------------------------------------
// S1 — putNode rollback for updates
// ---------------------------------------------------------------------------

describe("putNode — rollback for existing node on SQLite transaction failure", () => {
  it("restores original YAML content (not deletes file) when SQLite transaction fails on update", async () => {
    // First write the node with the working adapter
    await adapter.putNode({
      id: "GP-001",
      type: "guiding_principle",
      properties: { name: "Original principle", description: "Original description" },
    });

    // Verify it was written
    const filePath = path.join(ideateDir, "principles", "GP-001.yaml");
    expect(fs.existsSync(filePath)).toBe(true);
    const originalContent = fs.readFileSync(filePath, "utf8");
    expect(originalContent).toContain("Original principle");

    // Now attempt an update with a failing adapter
    const failingAdapter = makeAdapterWithFailingDb();

    await expect(
      failingAdapter.putNode({
        id: "GP-001",
        type: "guiding_principle",
        properties: { name: "Updated principle", description: "Updated description" },
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // File must still exist (not deleted)
    expect(fs.existsSync(filePath)).toBe(true);

    // File content must be the original (not the updated version)
    const restoredContent = fs.readFileSync(filePath, "utf8");
    expect(restoredContent).toBe(originalContent);
    expect(restoredContent).not.toContain("Updated principle");
  });

  it("throws ValidationError with TRANSACTION_FAILED on update rollback", async () => {
    // Create a node first
    await adapter.putNode({
      id: "GP-002",
      type: "guiding_principle",
      properties: { name: "Principle Two", description: "Desc two" },
    });

    const failingAdapter = makeAdapterWithFailingDb();

    let caughtError: unknown;
    try {
      await failingAdapter.putNode({
        id: "GP-002",
        type: "guiding_principle",
        properties: { name: "Updated Two", description: "Updated desc two" },
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("putNode");
  });

  it("deletes YAML file (not restores) when SQLite transaction fails on insert (new node)", async () => {
    const failingAdapter = makeAdapterWithFailingDb();
    const filePath = path.join(ideateDir, "principles", "GP-003.yaml");

    await expect(
      failingAdapter.putNode({
        id: "GP-003",
        type: "guiding_principle",
        properties: { name: "New principle", description: "Never persisted" },
      })
    ).rejects.toThrow("simulated SQLite constraint violation");

    // File must have been removed (rollback for inserts removes the file)
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("removes newly-written file on rollback when isUpdate=true but originalContent read failed (file unreadable)", async () => {
    // Create a node so isUpdate=true on the next call
    await adapter.putNode({
      id: "GP-004",
      type: "guiding_principle",
      properties: { name: "Unreadable principle", description: "Original desc" },
    });

    const filePath = path.join(ideateDir, "principles", "GP-004.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    // Make the file write-only (no read) so originalContent will be null after silent read failure,
    // but the new content write can still succeed before the SQLite transaction fails.
    fs.chmodSync(filePath, 0o222);

    let caughtError: unknown;
    const failingAdapter = makeAdapterWithFailingDb();
    try {
      await failingAdapter.putNode({
        id: "GP-004",
        type: "guiding_principle",
        properties: { name: "Updated principle", description: "Updated desc" },
      });
    } catch (err) {
      caughtError = err;
    } finally {
      // Restore permissions so afterEach cleanup can remove the temp directory (if file still exists)
      try { fs.chmodSync(filePath, 0o644); } catch { /* already gone — that's the expected success case */ }
    }

    // An error must have been thrown
    expect(caughtError).toBeDefined();

    // The newly-written file must have been cleaned up (either deleted or restored)
    // When originalContent is null, the rollback branch removes the file
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M4 — deleteNode write order: YAML removed before SQLite DELETE
// ---------------------------------------------------------------------------

describe("deleteNode — YAML-first write order (P-44)", () => {
  it("YAML file is absent after deleteNode completes", async () => {
    // Create a node
    await adapter.putNode({
      id: "GP-DEL-001",
      type: "guiding_principle",
      properties: { name: "To be deleted", description: "Will be removed" },
    });

    const filePath = path.join(ideateDir, "principles", "GP-DEL-001.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    // Delete it
    const result = await adapter.deleteNode("GP-DEL-001");

    expect(result.status).toBe("deleted");
    expect(result.id).toBe("GP-DEL-001");

    // YAML file must be absent after deleteNode completes
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("YAML file is removed before SQLite DELETE executes", async () => {
    // Create a node
    await adapter.putNode({
      id: "GP-DEL-002",
      type: "guiding_principle",
      properties: { name: "Order test principle", description: "Tests write order" },
    });

    const filePath = path.join(ideateDir, "principles", "GP-DEL-002.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    let fileExistedAtDeleteTime: boolean | null = null;

    // Patch db.transaction to intercept the SQLite DELETE and check file state at that point
    const originalTransaction = db.transaction.bind(db);
    (db as any).transaction = (fn: () => void) => {
      const txFn = () => {
        // At the time SQLite DELETE runs, the YAML file should already be gone
        fileExistedAtDeleteTime = fs.existsSync(filePath);
        return originalTransaction(fn)();
      };
      txFn.exclusive = txFn;
      return txFn;
    };

    try {
      await adapter.deleteNode("GP-DEL-002");
    } finally {
      // Restore
      (db as any).transaction = originalTransaction;
    }

    // The file should have already been removed when the SQLite transaction ran
    expect(fileExistedAtDeleteTime).toBe(false);
    // And it should still not exist after
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WI-702 — deleteNode YAML rollback on SQLite failure
// ---------------------------------------------------------------------------

describe("deleteNode — YAML rollback on SQLite failure (WI-702)", () => {
  it("restores YAML file when SQLite transaction fails", async () => {
    await adapter.putNode({
      id: "del-rollback",
      type: "guiding_principle",
      properties: { name: "Rollback test principle", description: "Should survive SQLite failure" },
    });

    const nodeBefore = await adapter.getNode("del-rollback");
    expect(nodeBefore).not.toBeNull();

    const originalTransaction = db.transaction.bind(db);
    db.transaction = ((_fn: () => void) => {
      const txFn = () => { throw new Error("SQLite failure"); };
      txFn.exclusive = txFn;
      return txFn;
    }) as any;

    try {
      await expect(adapter.deleteNode("del-rollback")).rejects.toMatchObject({
        code: "TRANSACTION_FAILED",
      });
    } finally {
      db.transaction = originalTransaction;
    }

    // YAML file should still exist — getNode should return the node
    const nodeAfter = await adapter.getNode("del-rollback");
    expect(nodeAfter).not.toBeNull();
  });

  it("throws ValidationError with TRANSACTION_FAILED when SQLite transaction fails", async () => {
    await adapter.putNode({
      id: "del-error-code",
      type: "guiding_principle",
      properties: { name: "Error code test", description: "Check error code" },
    });

    const originalTransaction = db.transaction.bind(db);
    db.transaction = ((_fn: () => void) => {
      const txFn = () => { throw new Error("simulated SQLite transaction failure"); };
      txFn.exclusive = txFn;
      return txFn;
    }) as any;

    let caughtError: unknown;
    try {
      try {
        await adapter.deleteNode("del-error-code");
      } catch (err) {
        caughtError = err;
      }
    } finally {
      db.transaction = originalTransaction;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.details?.operation).toBe("deleteNode");
    expect(error.details?.id).toBe("del-error-code");
  });

  // S1: double-failure — SQLite throws AND fs.writeFileSync (restore) also throws.
  // The restore is made to fail by removing the principles directory so writeFileSync
  // has no parent directory to write into — this causes a real ENOENT throw.
  it("throws TRANSACTION_FAILED with 'cleanup also failed' message when both SQLite and restore fail", async () => {
    await adapter.putNode({
      id: "del-double-fail",
      type: "guiding_principle",
      properties: { name: "Double failure test", description: "Both phases fail" },
    });

    const principlesDir = path.join(ideateDir, "principles");
    const originalTransaction = db.transaction.bind(db);
    db.transaction = ((_fn: () => void) => {
      const txFn = () => {
        fs.rmSync(principlesDir, { recursive: true, force: true });
        throw new Error("SQLite failure");
      };
      txFn.exclusive = txFn;
      return txFn;
    }) as any;

    let caughtError: unknown;
    try {
      try {
        await adapter.deleteNode("del-double-fail");
      } catch (err) {
        caughtError = err;
      }
    } finally {
      db.transaction = originalTransaction;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
    expect(error.message).toContain("SQLite failure");
    expect(error.message).toContain("cleanup also failed");
  });

  // S2: null originalContent — file is already missing before deleteNode is called
  it("throws TRANSACTION_FAILED without crashing when YAML file is missing before unlink", async () => {
    await adapter.putNode({
      id: "del-missing-yaml",
      type: "guiding_principle",
      properties: { name: "Missing YAML test", description: "File deleted out-of-band" },
    });

    // Delete the YAML file manually to simulate out-of-band deletion
    const yamlFilePath = path.join(ideateDir, "principles", "del-missing-yaml.yaml");
    fs.unlinkSync(yamlFilePath);

    const originalTransaction = db.transaction.bind(db);
    db.transaction = ((_fn: () => void) => {
      const txFn = () => { throw new Error("SQLite failure"); };
      txFn.exclusive = txFn;
      return txFn;
    }) as any;

    let caughtError: unknown;
    try {
      try {
        await adapter.deleteNode("del-missing-yaml");
      } catch (err) {
        caughtError = err;
      }
    } finally {
      db.transaction = originalTransaction;
    }

    // Should throw TRANSACTION_FAILED, not crash from writeFileSync(path, null)
    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("TRANSACTION_FAILED");
  });

  // WI-705: FILESYSTEM_ERROR — unlinkSync fails with non-ENOENT error
  // Replace the YAML file with a directory so unlinkSync throws a non-ENOENT error
  // (EPERM on macOS, EISDIR on Linux), triggering the FILESYSTEM_ERROR path.
  it("throws FILESYSTEM_ERROR when unlinkSync fails with non-ENOENT error", async () => {
    await adapter.putNode({
      id: "del-fs-error",
      type: "guiding_principle",
      properties: { name: "FS error test", description: "Simulates unlink failure" },
    });

    // Swap the YAML file for a directory — unlinkSync on a directory throws EPERM (macOS) or EISDIR (Linux)
    const yamlFilePath = path.join(ideateDir, "principles", "del-fs-error.yaml");
    fs.unlinkSync(yamlFilePath);
    fs.mkdirSync(yamlFilePath);

    try {
      await expect(adapter.deleteNode("del-fs-error")).rejects.toMatchObject({
        code: "FILESYSTEM_ERROR",
      });
    } finally {
      // Clean up the dir so afterEach rmSync works
      fs.rmdirSync(yamlFilePath);
    }
  });
});

// ---------------------------------------------------------------------------
// M3 — nextId: unsupported node type throws ValidationError with INVALID_NODE_TYPE
//
// The fix is in LocalWriterAdapter.nextId. The LocalAdapter dispatches
// journal_entry and finding to the writer; all other types go to the reader.
// We test the writer directly to verify the error type change.
// ---------------------------------------------------------------------------

describe("LocalWriterAdapter.nextId — ValidationError for unsupported node type", () => {
  let writer: LocalWriterAdapter;

  beforeEach(() => {
    writer = new LocalWriterAdapter({ db, drizzleDb, ideateDir });
  });

  it("throws ValidationError (not plain Error) for unsupported type", async () => {
    let caughtError: unknown;
    try {
      // domain_policy is a NodeType not handled by the writer's if-branches
      await writer.nextId("domain_policy" as any);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
  });

  it("error has code INVALID_NODE_TYPE for unsupported type", async () => {
    let caughtError: unknown;
    try {
      await writer.nextId("domain_policy" as any);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.code).toBe("INVALID_NODE_TYPE");
  });

  it("error message mentions the unsupported type", async () => {
    let caughtError: unknown;
    try {
      await writer.nextId("domain_policy" as any);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const error = caughtError as ValidationError;
    expect(error.message).toContain("domain_policy");
  });

  it("does NOT throw for writer-native types (journal_entry, work_item, finding)", async () => {
    // These are handled by the writer's own if-branches and should not throw
    await expect(writer.nextId("journal_entry", 1)).resolves.toMatch(/^J-/);
    await expect(writer.nextId("work_item")).resolves.toMatch(/^WI-/);
    await expect(writer.nextId("finding", 1)).resolves.toMatch(/^F-/);
  });
});
