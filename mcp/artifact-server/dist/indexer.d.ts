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
export declare function rebuildIndex(db: Database.Database, drizzleDb: BetterSQLite3Database<typeof dbSchema>, ideateDir: string): RebuildStats;
//# sourceMappingURL=indexer.d.ts.map