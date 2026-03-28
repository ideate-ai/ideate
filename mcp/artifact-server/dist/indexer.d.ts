import Database from "better-sqlite3";
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as dbSchema from "./db.js";
export interface RebuildStats {
    files_scanned: number;
    files_updated: number;
    files_deleted: number;
    edges_created: number;
    cycles_detected: string[][];
    files_failed: number;
    parse_errors: string[];
}
export declare const MAX_DEPENDENCY_NODES = 10000;
export declare const MAX_DEPENDENCY_EDGES = 50000;
export declare function detectCycles(drizzleDb: BetterSQLite3Database<any>): string[][];
export interface IndexFilesResult {
    updated: number;
    failed: number;
    errors: string[];
}
/**
 * Incrementally index specific files. Used by the watcher for add/change events.
 * Only processes the given file paths, not the entire directory.
 */
export declare function indexFiles(db: Database.Database, drizzleDb: BetterSQLite3Database<typeof dbSchema>, filePaths: string[]): IndexFilesResult;
/**
 * Remove files from the index. Used by the watcher for unlink events.
 * Deletes nodes by file_path; CASCADE handles extension tables, edges, and file refs.
 */
export declare function removeFiles(db: Database.Database, drizzleDb: BetterSQLite3Database<typeof dbSchema>, filePaths: string[]): {
    removed: number;
};
export declare function rebuildIndex(db: Database.Database, drizzleDb: BetterSQLite3Database<typeof dbSchema>, ideateDir: string): RebuildStats;
//# sourceMappingURL=indexer.d.ts.map