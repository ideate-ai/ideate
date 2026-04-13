import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import { TOOLS, handleTool } from "./tools/index.js";
import { artifactWatcher } from "./watcher.js";
import { resolveArtifactDir } from "./config.js";
import { createDormantState, initServer, routeToolCall, ServerState } from "./server.js";
import { log } from "./logger.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// ---------------------------------------------------------------------------
// Server state — mutable; populated at startup or lazily after bootstrap
// ---------------------------------------------------------------------------

const state: ServerState = createDormantState();

// ---------------------------------------------------------------------------
// Startup: try to resolve ideate dir — dormant mode if not found
// ---------------------------------------------------------------------------

try {
  const dir = resolveArtifactDir({});
  initServer(dir, state);
} catch (err) {
  // Start in dormant mode — lazy recovery will retry on first tool call.
  const msg = err instanceof Error ? err.message : String(err);
  log.info("server", `Startup init failed (dormant mode): ${msg}`);
}

// ---------------------------------------------------------------------------
// MCP server — connect transport BEFORE indexing so MCP is available immediately
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "ideate-artifact-server", version: pkg.version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const _args = (args ?? {}) as Record<string, unknown>;
  const done = log.toolCall(name, _args);

  try {
    const result = await routeToolCall(state, name, _args, handleTool);
    done();
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("tool", `${name} failed: ${message}`, err);
    done();
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// Graceful shutdown
function shutdown() {
  artifactWatcher.close();
  state.db?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Prevent unhandled errors from crashing the MCP server
process.on("unhandledRejection", (reason) => {
  log.error("process", "Unhandled promise rejection", reason);
});
process.on("uncaughtException", (err) => {
  log.error("process", "Uncaught exception", err);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// ---------------------------------------------------------------------------
// Deferred indexing: if we initialized eagerly, the index is already built.
// If dormant, nothing to do here — initServer() handles it after bootstrap.
// ---------------------------------------------------------------------------
