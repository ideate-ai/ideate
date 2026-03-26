import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as path from "path";
import { TOOLS, handleTool } from "./tools/index.js";
import { artifactWatcher } from "./watcher.js";
import { resolveArtifactDir } from "./config.js";
import { createSchema, checkSchemaVersion } from "./schema.js";
import { rebuildIndex } from "./indexer.js";
import * as dbSchema from "./db.js";
// ---------------------------------------------------------------------------
// Startup: resolve ideate dir, open DB, create schema, rebuild index
// ---------------------------------------------------------------------------
let ideateDir;
try {
    ideateDir = resolveArtifactDir({});
}
catch (err) {
    console.error(`[ideate-artifact-server] ${err.message}`);
    process.exit(1);
}
const dbPath = path.join(ideateDir, "index.db");
let db;
try {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    if (!checkSchemaVersion(db, dbPath)) {
        // DB was stale — reopen fresh
        db = new Database(dbPath);
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
        db.pragma("foreign_keys = ON");
    }
    createSchema(db);
}
catch (err) {
    console.error(`[ideate-artifact-server] Database initialization failed: ${err.message}`);
    process.exit(1);
}
const drizzleDb = drizzle(db, { schema: dbSchema });
const ctx = { db, drizzleDb, ideateDir };
let stats;
try {
    stats = rebuildIndex(db, drizzleDb, ideateDir);
}
catch (err) {
    console.error(`[ideate-artifact-server] Index rebuild failed: ${err.message}`);
    process.exit(1);
}
console.error(`[ideate-artifact-server] started, ${stats.files_scanned} files indexed`);
// ---------------------------------------------------------------------------
// File watcher: re-run rebuild on any change under .ideate/
// ---------------------------------------------------------------------------
artifactWatcher.watch(ideateDir);
artifactWatcher.on("change", () => {
    try {
        rebuildIndex(db, drizzleDb, ideateDir);
    }
    catch (err) {
        console.error("[watcher] rebuildIndex failed:", err);
    }
});
// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new Server({ name: "ideate-artifact-server", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        const result = await handleTool(ctx, name, (args ?? {}));
        return {
            content: [{ type: "text", text: result }],
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Error: ${message}` }],
            isError: true,
        };
    }
});
// Graceful shutdown
process.on("SIGINT", () => {
    artifactWatcher.close();
    db.close();
    process.exit(0);
});
process.on("SIGTERM", () => {
    artifactWatcher.close();
    db.close();
    process.exit(0);
});
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map