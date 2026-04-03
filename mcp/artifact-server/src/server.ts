/**
 * server.ts — Extracted server initialization and dormant-mode logic.
 *
 * This module owns the ServerState lifecycle:
 *   - openDatabase(dir) creates + configures a SQLite DB
 *   - initServer(dir) opens DB, rebuilds index, starts watcher, returns ServerState
 *   - handleBootstrapDormant(state, args) creates .ideate/, triggers lazy init
 *   - routeToolCall(state, name, args, handleTool) routes MCP calls with dormant guards
 *
 * index.ts imports from here and wires to MCP transport.
 * Tests import from here without triggering MCP side effects.
 */

import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as path from "path";
import type { ToolContext } from "./types.js";
import { signalIndexReady } from "./tools/index.js";
import { artifactWatcher, BatchChangeEvent } from "./watcher.js";
import { createIdeateDir, CONFIG_SCHEMA_VERSION, IDEATE_SUBDIRS, IdeateConfigJson, resolveArtifactDir, readIdeateConfig, readRawConfig } from "./config.js";
import { createSchema, checkSchemaVersion } from "./schema.js";
import { rebuildIndex, indexFiles, removeFiles, RebuildStats } from "./indexer.js";
import { runPendingMigrations } from "./migrations.js";
import * as dbSchema from "./db.js";

// ---------------------------------------------------------------------------
// ServerState — testable value object instead of module-level mutable vars
// ---------------------------------------------------------------------------

export interface ServerState {
  ctx: ToolContext | null;
  ideateDir: string | null;
  db: InstanceType<typeof Database> | null;
}

/**
 * Create a fresh dormant ServerState (all null).
 */
export function createDormantState(): ServerState {
  return { ctx: null, ideateDir: null, db: null };
}

// ---------------------------------------------------------------------------
// selectAdapter — choose backend based on config.backend
// ---------------------------------------------------------------------------

/**
 * Validate the backend field from config and throw a clear error if the
 * selected backend is not yet implemented or is invalid.
 *
 * @param dir - Path to the .ideate/ directory (used to read config)
 * @throws {Error} when backend is "remote" (not yet implemented) or unknown
 */
export function selectAdapter(dir: string): void {
  const config = readRawConfig(dir);
  const backend = config.backend ?? "local";

  if (backend === "local" || backend === undefined) {
    // Local is the only functional backend; nothing additional required.
    return;
  }

  if (backend === "remote") {
    throw new Error(
      "Remote backend not yet implemented. Set backend to local or omit the field."
    );
  }

  throw new Error(
    `Unknown backend "${backend}". Valid values are "local" or "remote".`
  );
}

// ---------------------------------------------------------------------------
// openDatabase — create + configure a SQLite DB in the given directory
// ---------------------------------------------------------------------------

function configurePragmas(db: InstanceType<typeof Database>): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

export function openDatabase(dir: string): InstanceType<typeof Database> {
  const dbPath = path.join(dir, "index.db");
  let newDb = new Database(dbPath);
  configurePragmas(newDb);
  if (!checkSchemaVersion(newDb, dbPath)) {
    // DB was stale — reopen fresh
    newDb = new Database(dbPath);
    configurePragmas(newDb);
  }
  try {
    createSchema(newDb);
  } catch (err) {
    newDb.close();
    throw err;
  }
  return newDb;
}

// ---------------------------------------------------------------------------
// initServer — open DB, create schema, rebuild index, start watcher
// ---------------------------------------------------------------------------

const watchedDirs = new Set<string>();

export function initServer(dir: string, state: ServerState): void {
  // Run pending migrations before opening the database.
  // Migrations may transform YAML files, config.json, or directory structure.
  // They run against the artifact directory (dir), not the SQLite index.
  const migrationResult = runPendingMigrations(dir);
  if (migrationResult.migrationsRun > 0) {
    console.error(`[ideate-artifact-server] ${migrationResult.migrationsRun} migration(s) applied (v${migrationResult.fromVersion} → v${migrationResult.toVersion})`);
  }
  if (migrationResult.errors.length > 0) {
    console.error(`[ideate-artifact-server] Migration errors: ${migrationResult.errors.join("; ")}`);
  }

  // Select adapter based on config.backend. Throws if backend is unsupported.
  selectAdapter(dir);

  // Use locals so server state is only committed after full success
  const newDb = openDatabase(dir);
  let newDrizzle;
  let stats: RebuildStats;
  try {
    newDrizzle = drizzle(newDb, { schema: dbSchema });
    stats = rebuildIndex(newDb, newDrizzle, dir);
  } catch (err) {
    newDb.close();
    throw err;
  }

  // Commit state
  state.ideateDir = dir;
  state.db = newDb;
  state.ctx = { db: newDb, drizzleDb: newDrizzle, ideateDir: dir };

  signalIndexReady();
  console.error(`[ideate-artifact-server] initialized, ${stats.files_scanned} files indexed`);

  // File watcher: incrementally index changed files (guard against duplicate listeners)
  artifactWatcher.watch(dir);
  if (!watchedDirs.has(dir)) {
    watchedDirs.add(dir);
    artifactWatcher.on("change", (event: BatchChangeEvent) => {
      try {
        if (!state.ctx) return;
        if (event.artifactDir !== dir) return;
        const yamlChanged = event.changed.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const yamlDeleted = event.deleted.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (yamlChanged.length > 0) {
          indexFiles(state.ctx.db, state.ctx.drizzleDb, yamlChanged);
        }
        if (yamlDeleted.length > 0) {
          removeFiles(state.ctx.db, state.ctx.drizzleDb, yamlDeleted);
        }
      } catch (err) {
        console.error("[watcher] incremental index failed:", err);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// handleBootstrapDormant — create .ideate/ and lazily initialize
// ---------------------------------------------------------------------------

function buildBootstrapResponse(warning?: string): string {
  const result: Record<string, unknown> = { status: "initialized", subdirectories: [...IDEATE_SUBDIRS] };
  if (warning) result.warning = warning;
  return JSON.stringify(result, null, 2);
}

function tryInitServer(dir: string, state: ServerState): string | null {
  if (state.ctx) return null;
  try {
    initServer(dir, state);
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[ideate-artifact-server] Late initialization failed: ${msg}`);
    return `DB initialization failed: ${msg}. Server is still dormant.`;
  }
}

export function handleBootstrapDormant(
  state: ServerState,
  args: Record<string, unknown>,
  cwd?: string
): string {
  const projectRoot = cwd ?? process.cwd();
  const existingConfig = readIdeateConfig(projectRoot);

  if (existingConfig) {
    const warning = tryInitServer(existingConfig.artifactDir, state);
    return buildBootstrapResponse(warning ?? undefined);
  }

  // No existing .ideate/ — create fresh
  const projectName = args.project_name as string | undefined;
  const config: IdeateConfigJson = { schema_version: CONFIG_SCHEMA_VERSION };
  if (projectName) config.project_name = projectName;

  const ideateDir = createIdeateDir(projectRoot, config);
  const warning = tryInitServer(ideateDir, state);
  return buildBootstrapResponse(warning ?? undefined);
}

// ---------------------------------------------------------------------------
// routeToolCall — dormant-aware routing extracted from index.ts
// ---------------------------------------------------------------------------

export type ToolCallResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

export type HandleToolFn = (
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
) => Promise<string>;

/**
 * Route an MCP tool call with dormant-mode guards.
 * This is the production routing logic, testable without MCP transport.
 */
export async function routeToolCall(
  state: ServerState,
  name: string,
  args: Record<string, unknown>,
  handleToolFn: HandleToolFn
): Promise<ToolCallResult> {
  // --- Dormant-safe tools: handle before requiring full ctx ---

  if (name === "ideate_bootstrap_workspace") {
    if (state.ctx) {
      const result = await handleToolFn(state.ctx, name, args);
      return { content: [{ type: "text", text: result }] };
    }
    try {
      const result = handleBootstrapDormant(state, args);
      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: Bootstrap failed: ${message}` }],
        isError: true,
      };
    }
  }

  if (name === "ideate_get_workspace_status" && !state.ctx) {
    // Lazy recovery: retry artifact dir resolution before reporting dormant
    try {
      const dir = resolveArtifactDir({});
      initServer(dir, state);
      console.error(`[ideate-artifact-server] Lazy initialization succeeded: ${dir}`);
      // Fall through to normal handling now that ctx is set
    } catch {
      const result = JSON.stringify({
        status: "not_initialized",
        message: "No .ideate/ directory found. Run /ideate:init to initialize the project.",
      }, null, 2);
      return { content: [{ type: "text", text: result }] };
    }
  }

  // --- All other tools require full initialization ---

  if (!state.ctx) {
    // Lazy recovery: retry artifact dir resolution before giving up
    try {
      const dir = resolveArtifactDir({});
      initServer(dir, state);
      console.error(`[ideate-artifact-server] Lazy initialization succeeded: ${dir}`);
    } catch {
      return {
        content: [{ type: "text", text: "Error: Project not initialized. Run /ideate:init to set up the .ideate/ directory." }],
        isError: true,
      };
    }
  }

  const result = await handleToolFn(state.ctx!, name, args);
  return { content: [{ type: "text", text: result }] };
}
