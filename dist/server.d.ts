import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/** Server identity, mirrored from .claude-plugin/plugin.json. */
export declare const SERVER_NAME = "ideate";
export declare const SERVER_VERSION = "3.0.0-dev.0";
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
 * .mcp.json-launched artifact serves the full default tool surface. The
 * record registrar takes no options: every default (projectRoot =
 * process.cwd(), telemetry dir, session id, wall clock) resolves lazily at
 * the first tool call, which is what makes module-scope composition safe —
 * nothing is read or written until a tool actually runs.
 */
export declare const toolRegistrars: ToolRegistrar[];
/** Apply each registrar in `registrars` (default: the composed root) to `server`, in order. */
export declare function registerTools(server: McpServer, registrars?: readonly ToolRegistrar[]): void;
/**
 * Construct the ideate MCP server and apply the given tool registrars —
 * by default the composed production root (`toolRegistrars`). Tests can pass
 * an explicit list (e.g. `createServer([])` for a bare Layer-0 server).
 * Pure construction — no transport, no I/O, nothing written to stdout.
 */
export declare function createServer(registrars?: readonly ToolRegistrar[]): McpServer;
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
export declare function main(): Promise<void>;
//# sourceMappingURL=server.d.ts.map