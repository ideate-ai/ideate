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

import { readRawConfig, writeConfig, CONFIG_SCHEMA_VERSION } from "./config.js";

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

    const ts = new Date().toISOString();
    console.error(`[${ts}] [migrations] Running: ${migration.description} (v${migration.fromVersion} → v${migration.toVersion})`);

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
      const errTs = new Date().toISOString();
      console.error(`[${errTs}] [migrations] Failed: ${migration.description} — ${errMsg}`);
      result.errors.push(`v${migration.fromVersion}→v${migration.toVersion}: ${errMsg}`);
      break; // Stop on first failure
    }
  }

  // If no migrations were in the registry but version is behind, just update the version
  // This handles the case where CONFIG_SCHEMA_VERSION was bumped without a migration
  // (e.g., the version bump is purely additive and backward-compatible)
  if (result.migrationsRun === 0 && result.errors.length === 0 && version < targetVersion) {
    const updatedConfig = readRawConfig(ideateDir);
    updatedConfig.schema_version = targetVersion;
    writeConfig(ideateDir, updatedConfig);
    version = targetVersion;
  }

  result.toVersion = version;
  return result;
}
