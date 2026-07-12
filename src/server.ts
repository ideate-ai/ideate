// ideate MCP server entrypoint (WI-269, PR-005).
//
// Launched by the plugin's `.mcp.json` as `node ${CLAUDE_PLUGIN_ROOT}/dist/server.js`
// over the stdio transport. stdout belongs EXCLUSIVELY to the MCP protocol:
// nothing in this module (or anything it registers) may write diagnostics to
// stdout — stderr only. See docs/design/v3-composable-surface.md §5 (Layer 0).
//
// Tool surface: this module is the COMPOSITION ROOT (WI-277). The record
// verbs (record_append, record_read, record_decision — spec §1.1) and, as of
// WI-303, the eleven work-state verbs (work_create, work_get, work_list,
// work_update_meta, work_claim, work_renew, work_release, work_complete,
// work_cancel, work_reopen, work_events — spec §3.5) are wired into
// `toolRegistrars` at module scope below, so the shipped artifact —
// `node dist/server.js`, exactly as .mcp.json launches it — serves them.
// Registrar construction is side-effect free (record/tools.ts, work-state/
// tools.ts: each store is composed lazily inside the first tool CALL), so
// composing here keeps boot pure: no filesystem writes, nothing on stdout.

import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createRecordToolsRegistrar } from './record/tools.js';
import { createWorkStateToolsRegistrar } from './work-state/tools.js';

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
 *
 * COMPOSITION ROOT — populated here, in production code, so the
 * .mcp.json-launched artifact serves the full default tool surface. Both
 * registrars take no options: every default (projectRoot = process.cwd(),
 * telemetry dir, session id, wall clock) resolves lazily at the first tool
 * call, which is what makes module-scope composition safe — nothing is read
 * or written until a tool actually runs.
 */
export const toolRegistrars: ToolRegistrar[] = [createRecordToolsRegistrar(), createWorkStateToolsRegistrar()];

/** Apply each registrar in `registrars` (default: the composed root) to `server`, in order. */
export function registerTools(server: McpServer, registrars: readonly ToolRegistrar[] = toolRegistrars): void {
  for (const registrar of registrars) {
    registrar(server);
  }
}

/**
 * Construct the ideate MCP server and apply the given tool registrars —
 * by default the composed production root (`toolRegistrars`). Tests can pass
 * an explicit list (e.g. `createServer([])` for a bare Layer-0 server).
 * Pure construction — no transport, no I/O, nothing written to stdout.
 */
export function createServer(registrars: readonly ToolRegistrar[] = toolRegistrars): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, registrars);
  return server;
}

/**
 * Boot the server on the stdio transport. Diagnostics go to stderr only.
 *
 * Graceful-shutdown handling (SIGINT/SIGTERM handlers, transport.close())
 * is DELIBERATELY absent, not forgotten: every write on this surface is a
 * synchronous single-file record write inside a tool call
 * (RecordStore.append), so there is no in-flight async state to drain and
 * no partially-written record a kill can leave behind — default process
 * teardown is already safe. Revisit this the moment async writes (e.g. a
 * remote graph backend) land on this path.
 */
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
