import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { runPendingMigrations, MIGRATIONS } from "../migrations.js";
import { writeConfig, readRawConfig } from "../config.js";
import { createSchema } from "../schema.js";
import { log } from "../logger.js";

let tmpDir: string;
let ideateDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-migrations-test-"));
  ideateDir = path.join(tmpDir, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
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

  it("runs v4→v7 migration chain when config schema_version is 4 and arrives at target (7)", () => {
    writeConfig(ideateDir, { schema_version: 4 });
    // No index.db — the v4→v5 migration short-circuits when there is no DB,
    // but runPendingMigrations must still update schema_version through all
    // pending migrations (v4→v5, v5→v6, v6→v7) to reach the current target.

    const result = runPendingMigrations(ideateDir);

    expect(result.errors).toHaveLength(0);
    expect(result.migrationsRun).toBeGreaterThanOrEqual(1);
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(7);
  });

  it("updates schema_version to 7 after full migration chain on a DB with schema version 4", () => {
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
    // v4→v5 (real transform) + v5→v6 (no-op stub) + v6→v7 (no-op stub)
    expect(result.migrationsRun).toBe(3);
    const config = readRawConfig(ideateDir);
    expect(config.schema_version).toBe(7);

    // Verify the columns were actually added by the v4→v5 migration
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
// Multi-step chain: v3→v4→v5→v6→v7
// ---------------------------------------------------------------------------

describe("runPendingMigrations — multi-step chain", () => {
  it("applies all migrations in order when starting at v3, arriving at v7", () => {
    // Start at v3 — all four migrations (v3→v4, v4→v5, v5→v6, v6→v7) should run
    writeConfig(ideateDir, { schema_version: 3 });

    // Track which migrations were called and in what order
    const migrationsCalled: string[] = [];

    const v3ToV4 = MIGRATIONS.find((m) => m.fromVersion === 3 && m.toVersion === 4);
    const v4ToV5 = MIGRATIONS.find((m) => m.fromVersion === 4 && m.toVersion === 5);
    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    expect(v3ToV4).toBeDefined();
    expect(v4ToV5).toBeDefined();
    expect(v5ToV6).toBeDefined();
    expect(v6ToV7).toBeDefined();

    const originalV3ToV4 = v3ToV4!.migrate;
    const originalV4ToV5 = v4ToV5!.migrate;
    const originalV5ToV6 = v5ToV6!.migrate;
    const originalV6ToV7 = v6ToV7!.migrate;

    v3ToV4!.migrate = (dir: string) => { migrationsCalled.push("v3→v4"); originalV3ToV4(dir); };
    v4ToV5!.migrate = (dir: string) => { migrationsCalled.push("v4→v5"); originalV4ToV5(dir); };
    v5ToV6!.migrate = (dir: string) => { migrationsCalled.push("v5→v6"); originalV5ToV6(dir); };
    v6ToV7!.migrate = (dir: string) => { migrationsCalled.push("v6→v7"); originalV6ToV7(dir); };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(4);

      // All steps ran in order
      expect(migrationsCalled).toEqual(["v3→v4", "v4→v5", "v5→v6", "v6→v7"]);

      // Final schema_version is 7
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(7);
    } finally {
      v3ToV4!.migrate = originalV3ToV4;
      v4ToV5!.migrate = originalV4ToV5;
      v5ToV6!.migrate = originalV5ToV6;
      v6ToV7!.migrate = originalV6ToV7;
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
// v5→v6 and v6→v7 stubs: loaded from v5, both run, arrive at v7
// ---------------------------------------------------------------------------

describe("runPendingMigrations — v5→v6 and v6→v7 no-op stubs", () => {
  it("starting at v5 runs both stubs exactly once and arrives at v7", () => {
    writeConfig(ideateDir, { schema_version: 5 });

    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    expect(v5ToV6).toBeDefined();
    expect(v6ToV7).toBeDefined();

    let v5ToV6CallCount = 0;
    let v6ToV7CallCount = 0;

    const originalV5ToV6 = v5ToV6!.migrate;
    const originalV6ToV7 = v6ToV7!.migrate;

    v5ToV6!.migrate = (dir: string) => { v5ToV6CallCount++; originalV5ToV6(dir); };
    v6ToV7!.migrate = (dir: string) => { v6ToV7CallCount++; originalV6ToV7(dir); };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(2);

      // Each stub invoked exactly once
      expect(v5ToV6CallCount).toBe(1);
      expect(v6ToV7CallCount).toBe(1);

      // Arrived at v7
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(7);
    } finally {
      v5ToV6!.migrate = originalV5ToV6;
      v6ToV7!.migrate = originalV6ToV7;
    }
  });

  it("starting at v7 invokes neither v5→v6 nor v6→v7 stub (idempotent + forward-only)", () => {
    writeConfig(ideateDir, { schema_version: 7 });

    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    expect(v5ToV6).toBeDefined();
    expect(v6ToV7).toBeDefined();

    let v5ToV6CallCount = 0;
    let v6ToV7CallCount = 0;

    const originalV5ToV6 = v5ToV6!.migrate;
    const originalV6ToV7 = v6ToV7!.migrate;

    v5ToV6!.migrate = (dir: string) => { v5ToV6CallCount++; originalV5ToV6(dir); };
    v6ToV7!.migrate = (dir: string) => { v6ToV7CallCount++; originalV6ToV7(dir); };

    try {
      const result = runPendingMigrations(ideateDir);

      expect(result.errors).toHaveLength(0);
      expect(result.migrationsRun).toBe(0);

      // Neither stub was invoked
      expect(v5ToV6CallCount).toBe(0);
      expect(v6ToV7CallCount).toBe(0);

      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(7);
    } finally {
      v5ToV6!.migrate = originalV5ToV6;
      v6ToV7!.migrate = originalV6ToV7;
    }
  });
});

// ---------------------------------------------------------------------------
// Fallback warn path: log.warn fires when out-of-registry version is encountered
//
// Simulate by temporarily removing all migrations from the MIGRATIONS array
// while pointing at a schema_version below the target. This exercises the
// fallback branch at migrations.ts (migrationsRun===0, no errors, version behind).
// ---------------------------------------------------------------------------

describe("runPendingMigrations — fallback warn path", () => {
  it("emits log.warn when no registry entries cover the version gap", () => {
    // Use a version that is below target but has no registry entry after we
    // splice out all MIGRATIONS temporarily
    writeConfig(ideateDir, { schema_version: 5 });

    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});

    // Temporarily drain the registry so no entries match
    const saved = MIGRATIONS.splice(0, MIGRATIONS.length);

    try {
      const result = runPendingMigrations(ideateDir);

      // Fallback fired: schema stamped to target without transforms
      expect(result.migrationsRun).toBe(0);
      expect(result.errors).toHaveLength(0);
      const config = readRawConfig(ideateDir);
      expect(config.schema_version).toBe(7);

      // log.warn was called at least once with the migrations prefix
      const warnCalls = warnSpy.mock.calls;
      expect(warnCalls.some((args) => args[0] === "migrations")).toBe(true);
    } finally {
      // Restore the registry
      MIGRATIONS.splice(0, 0, ...saved);
    }
  });
});

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

// ---------------------------------------------------------------------------
// v5→v6 and v6→v7 stub idempotency
// ---------------------------------------------------------------------------

describe("v5→v6 and v6→v7 stub idempotency", () => {
  it("v5→v6 migrate() does not throw when called multiple times", () => {
    const v5ToV6 = MIGRATIONS.find((m) => m.fromVersion === 5 && m.toVersion === 6);
    expect(v5ToV6).toBeDefined();
    // Should be callable any number of times without error
    expect(() => v5ToV6!.migrate(ideateDir)).not.toThrow();
    expect(() => v5ToV6!.migrate(ideateDir)).not.toThrow();
  });

  it("v6→v7 migrate() does not throw when called multiple times", () => {
    const v6ToV7 = MIGRATIONS.find((m) => m.fromVersion === 6 && m.toVersion === 7);
    expect(v6ToV7).toBeDefined();
    // Should be callable any number of times without error
    expect(() => v6ToV7!.migrate(ideateDir)).not.toThrow();
    expect(() => v6ToV7!.migrate(ideateDir)).not.toThrow();
  });
});
