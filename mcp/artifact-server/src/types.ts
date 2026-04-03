import type Database from "better-sqlite3";
import type { DrizzleDb } from "./db-helpers.js";
import type { StorageAdapter } from "./adapter.js";

export interface ToolContext {
  db: Database.Database;
  drizzleDb: DrizzleDb;
  ideateDir: string;
  adapter?: StorageAdapter;
}
