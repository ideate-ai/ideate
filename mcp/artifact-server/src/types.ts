import type Database from "better-sqlite3";
import type { DrizzleDb } from "./db-helpers.js";
import type { StorageAdapter } from "./adapter.js";

export interface ToolContext {
  db?: Database.Database;
  drizzleDb?: DrizzleDb;
  ideateDir: string;
  adapter?: StorageAdapter;
  // Session/cycle/phase context for tool_usage telemetry.
  // Populated by initServer in server.ts: session_id is a per-process UUID,
  // cycle and phase are sourced from autopilot-state.yaml at startup.
  session_id?: string | null;
  cycle?: number | null;
  phase?: string | null;
}
