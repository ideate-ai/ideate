// WI-269 — in-process boot tests for the ideate MCP server entrypoint.
// No real stdio session: constructs the server object directly.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createServer, registerTools, toolRegistrars, SERVER_NAME, SERVER_VERSION } from './server.js';

afterEach(() => {
  toolRegistrars.length = 0;
  vi.restoreAllMocks();
});

describe('ideate MCP server boot', () => {
  it('constructs cleanly with zero tools registered', () => {
    expect(toolRegistrars).toHaveLength(0);
    const server = createServer();
    expect(server).toBeInstanceOf(McpServer);
    // Zero tools: the underlying registry is empty on a Layer-0 boot.
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered)).toHaveLength(0);
  });

  it('exposes the ideate identity', () => {
    expect(SERVER_NAME).toBe('ideate');
    expect(SERVER_VERSION).toBe('3.0.0-dev.0');
  });

  it('accepts a mock tool through the registration extension point', () => {
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
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    expect(Object.keys(registered)).toEqual(['mock_tool']);
  });

  it('registerTools applies registrars in order to an existing server', () => {
    const order: string[] = [];
    toolRegistrars.push(() => order.push('first'));
    toolRegistrars.push(() => order.push('second'));

    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerTools(server);

    expect(order).toEqual(['first', 'second']);
  });

  it('writes nothing to stdout on boot (stdio protocol purity)', () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write');
    createServer();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
