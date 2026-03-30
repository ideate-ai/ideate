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
import { createIdeateDir, CONFIG_SCHEMA_VERSION, IDEATE_SUBDIRS, IdeateConfigJson } from "./config.js";
import { createSchema, checkSchemaVersion } from "./schema.js";
import { rebuildIndex, indexFiles, removeFiles, RebuildStats } from "./indexer.js";
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
// openDatabase — create + configure a SQLite DB in the given directory
// ---------------------------------------------------------------------------

export function openDatabase(dir: string): InstanceType<typeof Database> {
  const dbPath = path.join(dir, "index.db");
  let newDb = new Database(dbPath);
  newDb.pragma("journal_mode = WAL");
  newDb.pragma("busy_timeout = 5000");
  newDb.pragma("foreign_keys = ON");
  if (!checkSchemaVersion(newDb, dbPath)) {
    // DB was stale — reopen fresh
    newDb = new Database(dbPath);
    newDb.pragma("journal_mode = WAL");
    newDb.pragma("busy_timeout = 5000");
    newDb.pragma("foreign_keys = ON");
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
        const yamlChanged = event.changed.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const yamlDeleted = event.deleted.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (yamlChanged.length > 0 && state.db) {
          const dDb = drizzle(state.db, { schema: dbSchema });
          indexFiles(state.db, dDb, yamlChanged);
        }
        if (yamlDeleted.length > 0 && state.db) {
          const dDb = drizzle(state.db, { schema: dbSchema });
          removeFiles(state.db, dDb, yamlDeleted);
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

export function handleBootstrapDormant(
  state: ServerState,
  args: Record<string, unknown>
): string {
  const projectRoot = process.cwd();
  const projectName = args.project_name as string | undefined;
  const config: IdeateConfigJson = { schema_version: CONFIG_SCHEMA_VERSION };
  if (projectName) config.project_name = projectName;

  const ideateDir = createIdeateDir(projectRoot, config);

  // Lazy initialization: now that .ideate/ exists, spin up DB + index
  if (!state.ctx) {
    try {
      initServer(ideateDir, state);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[ideate-artifact-server] Late initialization failed: ${msg}`);
      return JSON.stringify(
        { status: "initialized", subdirectories: [...IDEATE_SUBDIRS], warning: `DB initialization failed: ${msg}. Server is still dormant.` },
        null,
        2
      );
    }
  }

  return JSON.stringify(
    { status: "initialized", subdirectories: [...IDEATE_SUBDIRS] },
    null,
    2
  );
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
    const result = JSON.stringify({
      status: "not_initialized",
      message: "No .ideate/ directory found. Run /ideate:init to initialize the project.",
    }, null, 2);
    return { content: [{ type: "text", text: result }] };
  }

  // --- All other tools require full initialization ---

  if (!state.ctx) {
    return {
      content: [{ type: "text", text: "Error: Project not initialized. Run /ideate:init to set up the .ideate/ directory." }],
      isError: true,
    };
  }

  const result = await handleToolFn(state.ctx, name, args);
  return { content: [{ type: "text", text: result }] };
}
