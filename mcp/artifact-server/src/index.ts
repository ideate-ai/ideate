import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as path from "path";
import { TOOLS, handleTool, ToolContext, signalIndexReady, signalIndexFailed } from "./tools/index.js";
import { artifactWatcher, BatchChangeEvent } from "./watcher.js";
import { resolveArtifactDir } from "./config.js";
import { createSchema, checkSchemaVersion } from "./schema.js";
import { rebuildIndex, indexFiles, removeFiles, RebuildStats } from "./indexer.js";
import * as dbSchema from "./db.js";

// ---------------------------------------------------------------------------
// Startup: resolve ideate dir, open DB, create schema, rebuild index
// ---------------------------------------------------------------------------

let ideateDir: string;
try {
  ideateDir = resolveArtifactDir({});
} catch (err) {
  console.error(`[ideate-artifact-server] ${(err as Error).message}`);
  process.exit(1);
}

const dbPath = path.join(ideateDir, "index.db");
let db: InstanceType<typeof Database>;
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
} catch (err) {
  console.error(`[ideate-artifact-server] Database initialization failed: ${(err as Error).message}`);
  process.exit(1);
}

const drizzleDb = drizzle(db, { schema: dbSchema });

const ctx: ToolContext = { db, drizzleDb, ideateDir };

// ---------------------------------------------------------------------------
// MCP server — connect transport BEFORE indexing so MCP is available immediately
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ideate-artifact-server", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const result = await handleTool(ctx, name, (args ?? {}) as Record<string, unknown>);
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (err) {
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

// ---------------------------------------------------------------------------
// Deferred indexing: rebuild index after transport is connected, then start watcher
// ---------------------------------------------------------------------------

setImmediate(() => {
  try {
    const stats: RebuildStats = rebuildIndex(db, drizzleDb, ideateDir);
    signalIndexReady();
    console.error(`[ideate-artifact-server] started, ${stats.files_scanned} files indexed`);

    // File watcher: incrementally index changed files
    artifactWatcher.watch(ideateDir);
    artifactWatcher.on("change", (event: BatchChangeEvent) => {
      try {
        const yamlChanged = event.changed.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        const yamlDeleted = event.deleted.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        if (yamlChanged.length > 0) indexFiles(db, drizzleDb, yamlChanged);
        if (yamlDeleted.length > 0) removeFiles(db, drizzleDb, yamlDeleted);
      } catch (err) {
        console.error("[watcher] incremental index failed:", err);
      }
    });
  } catch (err) {
    console.error(`[ideate-artifact-server] rebuildIndex failed: ${(err as Error).message}`);
    signalIndexFailed(err as Error);
  }
});
