/**
 * migrations.ts — Automatic migration infrastructure for ideate artifact directories.
 *
 * Each migration transforms YAML artifacts, config.json, or directory structure
 * from one schema version to the next. Migrations are:
 * - Ordered: run in sequence from current version to target version
 * - Idempotent: running on already-migrated data is a no-op
 * - Forward-only: no rollback mechanism (git provides rollback if needed)
 *
 * The migration registry is checked on every server startup. If config.json
 * schema_version is behind CONFIG_SCHEMA_VERSION, pending migrations run
 * automatically before the index rebuild.
 */

import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { readRawConfig, writeConfig, CONFIG_SCHEMA_VERSION } from "./config.js";
import { CURRENT_SCHEMA_VERSION } from "./schema.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Migration interface
// ---------------------------------------------------------------------------

export interface Migration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (ideateDir: string) => void;
}

// ---------------------------------------------------------------------------
// Migration registry — add new migrations here in order
// ---------------------------------------------------------------------------

/**
 * Ordered list of all migrations. Each entry migrates from `fromVersion` to
 * `toVersion`. The list must be sorted by fromVersion ascending.
 *
 * To add a migration when bumping CONFIG_SCHEMA_VERSION:
 * 1. Increment CONFIG_SCHEMA_VERSION in config.ts
 * 2. Add a new Migration entry here with fromVersion = old, toVersion = new
 * 3. Implement the migrate function to transform artifacts/config as needed
 */
export const MIGRATIONS: Migration[] = [
  {
    fromVersion: 3,
    toVersion: 4,
    description: "Add backend field to config (default: local)",
    migrate: (ideateDir: string) => {
      const config = readRawConfig(ideateDir);
      if (!config.backend) {
        config.backend = "local";
        writeConfig(ideateDir, config);
      }
    },
  },
  {
    fromVersion: 4,
    toVersion: 5,
    description: "Add missing SQLite extension table columns (resolution, title, source, completed_date, current_phase_id)",
    migrate: (ideateDir: string) => {
      const dbPath = path.join(ideateDir, "index.db");
      if (!fs.existsSync(dbPath)) return; // No DB yet — createSchema will handle it

      const db = new Database(dbPath);
      try {
        const version = db.pragma("user_version", { simple: true }) as number;
        if (version >= CURRENT_SCHEMA_VERSION) return; // Already migrated

        // Helper: add column only if it does not already exist
        const addColumnIfMissing = (table: string, column: string, colType: string) => {
          const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          if (!cols.some((c) => c.name === column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${colType}`);
          }
        };

        db.transaction(() => {
          addColumnIfMissing("work_items", "resolution", "TEXT");
          addColumnIfMissing("findings", "title", "TEXT");
          addColumnIfMissing("domain_decisions", "title", "TEXT");
          addColumnIfMissing("domain_decisions", "source", "TEXT");
          addColumnIfMissing("phases", "completed_date", "TEXT");
          addColumnIfMissing("projects", "current_phase_id", "TEXT");

          db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
        })();
      } finally {
        db.close();
      }
    },
  },
  {
    fromVersion: 5,
    toVersion: 6,
    description:
      "No data transform required. The metrics-refactor commit (5a21db2) bumped CURRENT_SCHEMA_VERSION from 5 to 7 " +
      "in a single step, so version 6 was never an independent production state. The schema changes " +
      "(adding tool_usage table, removing metrics_events from DDL) are all additive: createSchema uses " +
      "CREATE TABLE IF NOT EXISTS, so existing DBs are unaffected and new DBs pick up the new tables " +
      "on first open. No data transform is needed.",
    migrate: (_ideateDir: string) => {
      // No-op — additive DDL change, no data transforms needed.
    },
  },
  {
    fromVersion: 6,
    toVersion: 7,
    description:
      "No data transform required. Version 6 was never an independent production state (see v5→v6 entry). " +
      "The consolidation of the metrics refactor into a single version bump from 5 to 7 means no " +
      "intermediate data exists at v6. No data transform is needed.",
    migrate: (_ideateDir: string) => {
      // No-op — additive DDL change, no data transforms needed.
    },
  },
];

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  migrationsRun: number;
  fromVersion: number;
  toVersion: number;
  errors: string[];
}

/**
 * Run all pending migrations for the given artifact directory.
 *
 * Reads config.json schema_version, finds migrations that need to run,
 * executes them in order, and updates schema_version after each successful
 * migration.
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @returns Summary of migrations run and any errors
 */
export function runPendingMigrations(ideateDir: string): MigrationResult {
  const config = readRawConfig(ideateDir);
  const currentVersion = config.schema_version ?? 1;
  const targetVersion = CONFIG_SCHEMA_VERSION;

  const result: MigrationResult = {
    migrationsRun: 0,
    fromVersion: currentVersion,
    toVersion: currentVersion,
    errors: [],
  };

  if (currentVersion >= targetVersion) {
    return result; // Already up to date
  }

  // Find applicable migrations
  const pending = MIGRATIONS.filter(
    (m) => m.fromVersion >= currentVersion && m.toVersion <= targetVersion
  ).sort((a, b) => a.fromVersion - b.fromVersion);

  let version = currentVersion;

  for (const migration of pending) {
    if (migration.fromVersion !== version) {
      // Gap in migration chain — skip to next applicable
      continue;
    }

    log.info("migrations", `Running: ${migration.description} (v${migration.fromVersion} → v${migration.toVersion})`);

    try {
      migration.migrate(ideateDir);
      version = migration.toVersion;
      result.migrationsRun++;

      // Update schema_version after each successful migration
      const updatedConfig = readRawConfig(ideateDir);
      updatedConfig.schema_version = version;
      writeConfig(ideateDir, updatedConfig);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("migrations", `Failed: ${migration.description} — ${errMsg}`);
      result.errors.push(`v${migration.fromVersion}→v${migration.toVersion}: ${errMsg}`);
      break; // Stop on first failure
    }
  }

  // If no migrations were in the registry but version is behind, just update the version.
  // This handles the case where CONFIG_SCHEMA_VERSION was bumped without a corresponding
  // MIGRATIONS entry. Operators should investigate — every version bump must have a
  // registry entry (even a no-op stub) so the migration chain is fully documented.
  if (result.migrationsRun === 0 && result.errors.length === 0 && version < targetVersion) {
    log.warn(
      "migrations",
      `No registry entries found for schema_version ${version} → ${targetVersion}. ` +
      `Stamping workspace to v${targetVersion} without running transforms. ` +
      `Add MIGRATIONS entries for every version bump (no-op stubs are fine) to eliminate this warning.`
    );
    const updatedConfig = readRawConfig(ideateDir);
    updatedConfig.schema_version = targetVersion;
    writeConfig(ideateDir, updatedConfig);
    version = targetVersion;
  }

  result.toVersion = version;
  return result;
}
