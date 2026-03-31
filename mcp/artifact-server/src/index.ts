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
  console.error(`[ideate-artifact-server] Startup init failed (dormant mode): ${msg}`);
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

  try {
    return await routeToolCall(state, name, _args, handleTool);
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
  state.db?.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  artifactWatcher.close();
  state.db?.close();
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);

// ---------------------------------------------------------------------------
// Deferred indexing: if we initialized eagerly, the index is already built.
// If dormant, nothing to do here — initServer() handles it after bootstrap.
// ---------------------------------------------------------------------------
