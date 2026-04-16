/**
 * equivalence-journal.test.ts — Equivalence tests for appendJournalEntry
 * across LocalAdapter and RemoteAdapter.
 *
 * Verifies that appendJournalEntry succeeds (returns a string journal entry ID)
 * on both adapters for a valid journal entry input.
 *
 * Follows the D-177 convention:
 *   - LocalAdapter tests use unconditional it(...)
 *   - RemoteAdapter tests use it.skipIf(!remoteAvailable) with an early return guard
 *
 * Prerequisites for RemoteAdapter tests:
 *   docker compose -f docker-compose.test.yml up -d
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { RemoteAdapter } from "../../src/adapters/remote/index.js";
import { ValidationError } from "../../src/adapter.js";
import { isTestServerAvailable } from "./equivalence-helpers.js";

// Evaluated at module level (collection time) so it.skipIf resolves correctly.
const remoteAvailable = isTestServerAvailable();

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

interface JournalTestSetup {
  localAdapter: LocalAdapter;
  remoteAdapter: RemoteAdapter | null;
  tmpDir: string;
  db: Database.Database;
}

async function createJournalTestSetup(): Promise<JournalTestSetup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-journal-eq-test-")
  );
  const ideateDir = path.join(tmpDir, ".ideate");

  // Create the minimal directory structure LocalAdapter expects.
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

  // domains/index.yaml is required by LocalAdapter for cycle operations.
  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  createSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });

  const localAdapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await localAdapter.initialize();

  return { localAdapter, remoteAdapter: null, tmpDir, db };
}

async function teardownJournalTestSetup(
  setup: JournalTestSetup
): Promise<void> {
  try {
    await setup.localAdapter.shutdown();
  } catch {
    // ignore
  }
  try {
    setup.db.close();
  } catch {
    // ignore
  }
  if (setup.remoteAdapter) {
    try {
      await setup.remoteAdapter.shutdown();
    } catch {
      // ignore
    }
  }
  try {
    fs.rmSync(setup.tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Suite: appendJournalEntry equivalence (D-177 convention)
// ---------------------------------------------------------------------------

describe("Equivalence — appendJournalEntry() success path (D-177)", () => {
  let setup: JournalTestSetup;

  beforeAll(async () => {
    setup = await createJournalTestSetup();

    // Wire up RemoteAdapter if the server is available (checked at module level).
    if (remoteAvailable) {
      const remote = new RemoteAdapter({
        endpoint: "http://localhost:4001/graphql",
        org_id: "equivalence-test-org",
        codebase_id: "equivalence-journal-cb",
      });
      try {
        await remote.initialize();
        setup.remoteAdapter = remote;
      } catch {
        // initialize() failed despite server appearing available; tests with
        // it.skipIf(!remoteAvailable) will still run (server was reachable at
        // collection time), but the early-return guard in each test body
        // (if (!setup.remoteAdapter) return) will abort gracefully.
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (setup) await teardownJournalTestSetup(setup);
  });

  // -------------------------------------------------------------------------
  // Local adapter — unconditional it() per D-177
  // -------------------------------------------------------------------------

  it("LocalAdapter appendJournalEntry returns a non-empty string ID", async () => {
    const id = await setup.localAdapter.appendJournalEntry({
      skill: "execute",
      date: "2026-04-07",
      entryType: "work-item-complete",
      body: "Test journal entry body for equivalence test.",
      cycle: 1,
    });

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("LocalAdapter appendJournalEntry ID matches expected journal entry format (J-NNN-NNN)", async () => {
    const id = await setup.localAdapter.appendJournalEntry({
      skill: "review",
      date: "2026-04-07",
      entryType: "cycle-complete",
      body: "Cycle review complete.",
      cycle: 1,
    });

    // Journal entry IDs follow the format J-{cycle}-{sequence}: e.g. J-001-001
    expect(id).toMatch(/^J-\d{3}-\d{3}$/);
  });

  it("LocalAdapter appendJournalEntry creates a retrievable journal_entry node", async () => {
    const id = await setup.localAdapter.appendJournalEntry({
      skill: "execute",
      date: "2026-04-07",
      entryType: "work-item-start",
      body: "Work item WI-TEST-001 started.",
      cycle: 1,
    });

    // The returned ID should be a real node we can fetch back.
    const node = await setup.localAdapter.getNode(id);
    expect(node).not.toBeNull();
    expect(node!.id).toBe(id);
    expect(node!.type).toBe("journal_entry");
  });

  it("LocalAdapter appendJournalEntry: multiple entries increment sequence numbers", async () => {
    const id1 = await setup.localAdapter.appendJournalEntry({
      skill: "execute",
      date: "2026-04-07",
      entryType: "note",
      body: "First note.",
      cycle: 1,
    });

    const id2 = await setup.localAdapter.appendJournalEntry({
      skill: "execute",
      date: "2026-04-07",
      entryType: "note",
      body: "Second note.",
      cycle: 1,
    });

    // Both IDs must be valid journal entry IDs
    expect(id1).toMatch(/^J-\d{3}-\d{3}$/);
    expect(id2).toMatch(/^J-\d{3}-\d{3}$/);

    // They must be different (sequence increments)
    expect(id1).not.toBe(id2);
  });

  // -------------------------------------------------------------------------
  // Remote adapter — it.skipIf(!remoteAvailable) per D-177
  // -------------------------------------------------------------------------

  it.skipIf(!remoteAvailable)(
    "RemoteAdapter appendJournalEntry returns a non-empty string ID",
    async () => {
      if (!setup.remoteAdapter) return;

      const id = await setup.remoteAdapter.appendJournalEntry({
        skill: "execute",
        date: "2026-04-07",
        entryType: "work-item-complete",
        body: "Remote equivalence test journal entry.",
        cycle: 1,
      });

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  );

  it.skipIf(!remoteAvailable)(
    "both adapters appendJournalEntry return string IDs for the same input shape",
    async () => {
      if (!setup.remoteAdapter) return;

      const [localId, remoteId] = await Promise.all([
        setup.localAdapter.appendJournalEntry({
          skill: "refine",
          date: "2026-04-07",
          entryType: "cycle-start",
          body: "Dual-adapter journal entry for shape equivalence.",
          cycle: 1,
        }),
        setup.remoteAdapter.appendJournalEntry({
          skill: "refine",
          date: "2026-04-07",
          entryType: "cycle-start",
          body: "Dual-adapter journal entry for shape equivalence.",
          cycle: 1,
        }),
      ]);

      // Both must return non-empty string IDs
      expect(typeof localId).toBe("string");
      expect(localId.length).toBeGreaterThan(0);

      expect(typeof remoteId).toBe("string");
      expect(remoteId.length).toBeGreaterThan(0);
    }
  );
});

// ---------------------------------------------------------------------------
// Helpers for TRANSACTION_FAILED test (isolated LocalAdapter instance)
// ---------------------------------------------------------------------------

interface TxTestSetup {
  adapter: LocalAdapter;
  db: Database.Database;
  tmpDir: string;
}

async function createTxLocalSetup(): Promise<TxTestSetup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-journal-tx-test-")
  );
  const ideateDir = path.join(tmpDir, ".ideate");
  for (const sub of [
    "work-items", "policies", "decisions", "questions", "principles",
    "constraints", "modules", "research", "interviews",
    "projects", "phases", "plan", "steering", "domains",
    "archive/cycles", "archive/incremental",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(ideateDir, "domains", "index.yaml"), "current_cycle: 1\n", "utf8");
  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  createSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });
  const adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await adapter.initialize();
  return { adapter, db, tmpDir };
}

async function teardownTxLocalSetup(setup: TxTestSetup): Promise<void> {
  try { setup.db.close(); } catch { /* ignore */ }
  try { fs.rmSync(setup.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function makeThrowingTransaction(): ReturnType<Database.Database["transaction"]> {
  const fn: any = () => { throw new Error("simulated SQLite transaction failure"); };
  fn.exclusive = fn;
  fn.immediate = fn;
  fn.deferred = fn;
  return fn as ReturnType<Database.Database["transaction"]>;
}

// ---------------------------------------------------------------------------
// appendJournalEntry — TRANSACTION_FAILED (local only)
// ---------------------------------------------------------------------------
// TRANSACTION_FAILED is an internal SQLite error path — no remote equivalent
// since RemoteAdapter delegates to the server. LocalAdapter-only test per D-177.

describe("appendJournalEntry — TRANSACTION_FAILED (local only)", () => {
  it("throws TRANSACTION_FAILED when SQLite transaction fails", async () => {
    const setup = await createTxLocalSetup();
    const spy = vi
      .spyOn(setup.db, "transaction")
      .mockReturnValue(makeThrowingTransaction());
    try {
      await expect(
        setup.adapter.appendJournalEntry({
          skill: "execute",
          date: "2026-01-01",
          entryType: "test_entry",
          body: "Test journal body",
          cycle: 1,
        })
      ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    } finally {
      spy.mockRestore();
      await teardownTxLocalSetup(setup);
    }
  });
});
