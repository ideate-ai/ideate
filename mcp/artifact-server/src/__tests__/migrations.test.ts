import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { runPendingMigrations, MIGRATIONS } from "../migrations.js";
import { writeConfig, readRawConfig } from "../config.js";
import { createSchema } from "../schema.js";

let tmpDir: string;
let ideateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-migrations-test-"));
  ideateDir = path.join(tmpDir, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runPendingMigrations
// ---------------------------------------------------------------------------

describe("runPendingMigrations", () => {
  it("is a no-op when config schema_version already equals target (7)", () => {
    writeConfig(ideateDir, { schema_version: 7 });

    const result = runPendingMigrations(ideateDir);

    expect(result.migrationsRun).toBe(0);
    expect(result.errors).toHaveLength(0);
    // schema_version must remain 7
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(7);
  });

  it("runs v4→v5 migration when config schema_version is 4", () => {
    writeConfig(ideateDir, { schema_version: 4 });
    // No index.db — the v4→v5 migration short-circuits when there is no DB,
    // but runPendingMigrations must still update schema_version to 5.

    const result = runPendingMigrations(ideateDir);

    expect(result.errors).toHaveLength(0);
    expect(result.migrationsRun).toBeGreaterThanOrEqual(1);
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(5);
  });

  it("updates schema_version to 5 after v4→v5 migration on a DB with schema version 4", () => {
    writeConfig(ideateDir, { schema_version: 4 });

    // Create a DB without the v5 columns (simulate a v4 database by building
    // tables without the columns that the v4→v5 migration adds).
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    try {
      // Create a minimal schema at user_version 4 (missing v5 columns)
      db.exec(`
        CREATE TABLE IF NOT EXISTS nodes (
          id             TEXT PRIMARY KEY,
          type           TEXT NOT NULL,
          cycle_created  INTEGER,
          cycle_modified INTEGER,
          content_hash   TEXT NOT NULL,
          token_count    INTEGER,
          file_path      TEXT NOT NULL,
          status         TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS work_items (
          id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          title      TEXT NOT NULL,
          complexity TEXT,
          scope      TEXT,
          depends    TEXT,
          blocks     TEXT,
          criteria   TEXT,
          module     TEXT,
          domain     TEXT,
          phase      TEXT,
          notes      TEXT,
          work_item_type TEXT DEFAULT 'feature'
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS findings (
          id          TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          severity    TEXT NOT NULL,
          work_item   TEXT NOT NULL,
          file_refs   TEXT,
          verdict     TEXT NOT NULL,
          cycle       INTEGER NOT NULL,
          reviewer    TEXT NOT NULL,
          description TEXT,
          suggestion  TEXT,
          addressed_by TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS domain_decisions (
          id          TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          domain      TEXT NOT NULL,
          cycle       INTEGER,
          supersedes  TEXT,
          description TEXT,
          rationale   TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS phases (
          id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          name       TEXT,
          description TEXT,
          project    TEXT NOT NULL,
          phase_type TEXT NOT NULL,
          intent     TEXT NOT NULL,
          steering   TEXT,
          status     TEXT NOT NULL,
          work_items TEXT
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id               TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          name             TEXT,
          description      TEXT,
          intent           TEXT NOT NULL,
          scope_boundary   TEXT,
          success_criteria TEXT,
          appetite         INTEGER,
          steering         TEXT,
          horizon          TEXT,
          status           TEXT NOT NULL
        )
      `);
      db.pragma("user_version = 4");
    } finally {
      db.close();
    }

    const result = runPendingMigrations(ideateDir);

    expect(result.errors).toHaveLength(0);
    expect(result.migrationsRun).toBe(1);
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(5);

    // Verify the columns were actually added
    const db2 = new Database(dbPath);
    try {
      const workItemCols = db2.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
      expect(workItemCols.some((c) => c.name === "resolution")).toBe(true);

      const findingCols = db2.prepare("PRAGMA table_info(findings)").all() as Array<{ name: string }>;
      expect(findingCols.some((c) => c.name === "title")).toBe(true);

      const decisionCols = db2.prepare("PRAGMA table_info(domain_decisions)").all() as Array<{ name: string }>;
      expect(decisionCols.some((c) => c.name === "title")).toBe(true);
      expect(decisionCols.some((c) => c.name === "source")).toBe(true);

      const phaseCols = db2.prepare("PRAGMA table_info(phases)").all() as Array<{ name: string }>;
      expect(phaseCols.some((c) => c.name === "completed_date")).toBe(true);

      const projectCols = db2.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
      expect(projectCols.some((c) => c.name === "current_phase_id")).toBe(true);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Error path: migration throws
// ---------------------------------------------------------------------------

describe("runPendingMigrations — error path", () => {
  it("records the error and leaves schema_version unchanged when a migration throws", () => {
    // Start at v4 so the v4→v5 migration would normally run
    writeConfig(ideateDir, { schema_version: 4 });

    // Temporarily replace the v4→v5 migration's migrate function with one that throws
    const v4ToV5 = MIGRATIONS.find((m) => m.fromVersion === 4 && m.toVersion === 5);
    expect(v4ToV5).toBeDefined();

    const originalMigrate = v4ToV5!.migrate;
    v4ToV5!.migrate = () => {
      throw new Error("simulated migration failure");
    };

    try {
      const result = runPendingMigrations(ideateDir);

      // Error should be recorded (not re-thrown)
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("simulated migration failure");
      expect(result.migrationsRun).toBe(0);

      // schema_version must remain at the pre-migration value
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(4);
    } finally {
      // Restore the original migrate function
      v4ToV5!.migrate = originalMigrate;
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-step chain: v3→v4→v5
// ---------------------------------------------------------------------------

describe("runPendingMigrations — multi-step chain", () => {
  it("applies all intermediate migrations in order when starting at v3", () => {
    // Start at v3 — both v3→v4 and v4→v5 migrations exist in MIGRATIONS
    writeConfig(ideateDir, { schema_version: 3 });

    // Track which migrations were called
    const migrationsCalled: string[] = [];

    const v3ToV4 = MIGRATIONS.find((m) => m.fromVersion === 3 && m.toVersion === 4);
    const v4ToV5 = MIGRATIONS.find((m) => m.fromVersion === 4 && m.toVersion === 5);
    expect(v3ToV4).toBeDefined();
    expect(v4ToV5).toBeDefined();

    const originalV3ToV4 = v3ToV4!.migrate;
    const originalV4ToV5 = v4ToV5!.migrate;

    v3ToV4!.migrate = (dir: string) => {
      migrationsCalled.push("v3→v4");
      originalV3ToV4(dir);
    };
    v4ToV5!.migrate = (dir: string) => {
      migrationsCalled.push("v4→v5");
      originalV4ToV5(dir);
    };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(2);

      // Both steps ran in order
      expect(migrationsCalled).toEqual(["v3→v4", "v4→v5"]);

      // Final schema_version is 5 — the v5→v6 bump has no migration entry, and the silent-bump path only fires when migrationsRun===0, so a v3-origin workspace stops at 5 on this startup.
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(5);
    } finally {
      v3ToV4!.migrate = originalV3ToV4;
      v4ToV5!.migrate = originalV4ToV5;
    }
  });
});

// ---------------------------------------------------------------------------
// Already-at-target: no migration functions called
// ---------------------------------------------------------------------------

describe("runPendingMigrations — already at target version", () => {
  it("runs no migrations and calls no migrate functions when schema_version equals the target", () => {
    // Start at the current target version (7)
    writeConfig(ideateDir, { schema_version: 7 });

    // Wrap every migration's migrate function to detect if any are called
    const called: string[] = [];
    const originals = MIGRATIONS.map((m) => m.migrate);

    MIGRATIONS.forEach((m) => {
      const orig = m.migrate;
      m.migrate = (dir: string) => {
        called.push(`v${m.fromVersion}→v${m.toVersion}`);
        orig(dir);
      };
    });

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(0);
      // No migration functions should have been invoked
      expect(called).toHaveLength(0);

      // schema_version stays at target
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(7);
    } finally {
      MIGRATIONS.forEach((m, i) => {
        m.migrate = originals[i];
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Known untested path: no-registry-entry silent bump (tracked as WI-758)
// When CONFIG_SCHEMA_VERSION is bumped without a corresponding MIGRATIONS entry,
// runPendingMigrations reaches the branch at migrations.ts:~170 which increments
// schema_version silently without running a migration function.
// Testing this path requires overriding CONFIG_SCHEMA_VERSION — an ESM module-level
// constant that vi.spyOn cannot intercept (D-195). Deferred: no test infrastructure
// for ESM module-level constant override exists in this project yet.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v4→v5 migration idempotency
// ---------------------------------------------------------------------------

describe("v4→v5 migration idempotency", () => {
  it("calling migration.migrate() on a DB created by createSchema does not throw", () => {
    const v4ToV5 = MIGRATIONS.find(
      (m) => m.fromVersion === 4 && m.toVersion === 5
    );
    expect(v4ToV5).toBeDefined();

    // Create a fresh DB using createSchema — it already has all v5 columns
    const dbPath = path.join(ideateDir, "index.db");
    const db = new Database(dbPath);
    createSchema(db);
    db.close();

    // Running the migration again must not throw
    expect(() => v4ToV5!.migrate(ideateDir)).not.toThrow();
  });
});
