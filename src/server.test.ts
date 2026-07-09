// WI-269 / WI-277 — in-process boot tests for the ideate MCP server entrypoint.
// No real stdio session: constructs the server object directly. The full
// boot-the-shipped-artifact test (spawn node dist/server.js over real stdio)
// lives in tests/composition/server-boot.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RECORD_TOOL_NAMES } from './record/tools.js';
import { createServer, registerTools, toolRegistrars, SERVER_NAME, SERVER_VERSION } from './server.js';

/** The composed production root, captured at import so tests can restore it. */
const composedRegistrars = [...toolRegistrars];

function registeredToolNames(server: McpServer): string[] {
  return Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  );
}

afterEach(() => {
  toolRegistrars.length = 0;
  toolRegistrars.push(...composedRegistrars);
  vi.restoreAllMocks();
});

describe('ideate MCP server boot', () => {
  it('the composed default serves exactly the three record tools (WI-277 composition root)', () => {
    expect(toolRegistrars).toHaveLength(1);
    const server = createServer();
    expect(server).toBeInstanceOf(McpServer);
    expect(registeredToolNames(server).sort()).toEqual([...RECORD_TOOL_NAMES].sort());
  });

  it('a bare server (explicit empty registrars) still boots clean with zero tools', () => {
    const server = createServer([]);
    expect(server).toBeInstanceOf(McpServer);
    expect(registeredToolNames(server)).toHaveLength(0);
  });

  it('exposes the ideate identity', () => {
    expect(SERVER_NAME).toBe('ideate');
    expect(SERVER_VERSION).toBe('3.0.0-dev.0');
  });

  it('accepts a mock tool through the registration extension point, alongside the default surface', () => {
    const registrar = vi.fn((server: McpServer) => {
      server.registerTool(
        'mock_tool',
        { description: 'mock tool for registration-point test' },
        async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      );
    });
    toolRegistrars.push(registrar);

    const server = createServer();

    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar).toHaveBeenCalledWith(server);
    expect(registeredToolNames(server)).toEqual([...RECORD_TOOL_NAMES, 'mock_tool']);
  });

  it('registerTools applies an explicit registrar list in order to an existing server', () => {
    const order: string[] = [];
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerTools(server, [() => order.push('first'), () => order.push('second')]);

    expect(order).toEqual(['first', 'second']);
  });

  it('registerTools defaults to the composed root registrars', () => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerTools(server);
    expect(registeredToolNames(server).sort()).toEqual([...RECORD_TOOL_NAMES].sort());
  });

  it('writes nothing to stdout on boot (stdio protocol purity), even fully composed', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    createServer();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
