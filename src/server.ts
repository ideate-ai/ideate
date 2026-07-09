// ideate MCP server entrypoint (WI-269, PR-005).
//
// Launched by the plugin's `.mcp.json` as `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js`
// over the stdio transport. stdout belongs EXCLUSIVELY to the MCP protocol:
// nothing in this module (or anything it registers) may write diagnostics to
// stdout — stderr only. See docs/design/v3-composable-surface.md §5 (Layer 0).
//
// Tool surface: this file ships zero tools. Record verbs (record_append,
// record_read, record_decision — spec §1.1) and the work-state verbs are
// contributed by later work items through the `toolRegistrars` extension
// point below.

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/** Server identity, mirrored from .claude-plugin/plugin.json. */
export const SERVER_NAME = 'ideate';
export const SERVER_VERSION = '3.0.0-dev.0';

/**
 * A tool registrar contributes tools to the server at boot.
 *
 * Later work items (record verbs, work-state verbs) push registrars onto
 * `toolRegistrars`; each receives the constructed server and calls
 * `server.registerTool(...)`. Registrars must not write to stdout.
 */
export type ToolRegistrar = (server: McpServer) => void;

/**
 * Extension point: the ordered list of tool registrars applied at boot.
 * Empty by default — the Layer-0 server boots with zero tools.
 */
export const toolRegistrars: ToolRegistrar[] = [];

/** Apply every registered registrar to `server`, in order. */
export function registerTools(server: McpServer): void {
  for (const registrar of toolRegistrars) {
    registrar(server);
  }
}

/**
 * Construct the ideate MCP server and apply all tool registrars.
 * Pure construction — no transport, no I/O, nothing written to stdout.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server);
  return server;
}

/** Boot the server on the stdio transport. Diagnostics go to stderr only. */
export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout would corrupt the stdio protocol stream.
  console.error(`[ideate] MCP server ${SERVER_VERSION} connected (stdio)`);
}

// Run only when executed directly (node dist/server.js), never on import.
const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error('[ideate] MCP server failed to start:', error);
    process.exitCode = 1;
  });
}
