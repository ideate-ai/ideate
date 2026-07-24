// plugin/src/usage/tools.test.ts — acceptance tests for the two usage
// MCP verbs, exercised over a real in-process MCP session (InMemoryTransport +
// Client) so argument schemas and the tools/list surface are protocol truth.
//
// Pins: exactly two verbs registered (no update/delete); side-effect-free
// registration with first-CALL lazy init; usage_capture writes a signal for a
// cited delivered id and none for an uncited one; usage_query returns the
// used-item denominator. All filesystem work happens in mkdtemp dirs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { USAGE_TOOL_NAMES, createUsageToolsRegistrar } from './tools.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';
const SESSION_ID = 'sess-usage-tools';

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  while (clients.length > 0) {
    await clients.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function makeFixture(): { server: McpServer; connect: () => Promise<Client> } {
  const usageDir = mkdtempSync(join(tmpdir(), 'ideate-usage-tools-test-'));
  tempDirs.push(usageDir);
  const clock: Clock = () => new Date(FIXED_ISO);
  const registrar = createUsageToolsRegistrar({ usageDir, clock, sessionId: SESSION_ID });
  const server = new McpServer({ name: 'ideate-test', version: '0.0.0' });
  registrar(server);
  return {
    server,
    connect: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'usage-tools-test-client', version: '0.0.0' });
      clients.push(client);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    },
  };
}

function registeredNames(server: McpServer): string[] {
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(registry).sort();
}

function payload(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('usage tool registration', () => {
  it('registers exactly the two usage verbs (no update/delete)', () => {
    const { server } = makeFixture();
    expect(registeredNames(server)).toEqual([...USAGE_TOOL_NAMES].sort());
  });
});

describe('usage_capture + usage_query over a real MCP session', () => {
  it('captures a cited delivered item and reads it back as the denominator', async () => {
    const { connect } = makeFixture();
    const client = await connect();

    const captured = payload(
      await client.callTool({
        name: 'usage_capture',
        arguments: {
          text: 'I used T-381 and T-250 to build this; the third delivery was irrelevant.',
          delivered: ['T-381', 'T-250', 'T-999'],
          seed_id: 'T-378',
          manifest_id: 'MF-7',
          task_id: 'T-378',
        },
      }),
    );
    expect(captured['ok']).toBe(true);
    expect(captured['captured']).toBe(2);
    expect(captured['item_ids']).toEqual(['T-381', 'T-250']);

    const queried = payload(await client.callTool({ name: 'usage_query', arguments: { seed_id: 'T-378' } }));
    expect(queried['ok']).toBe(true);
    expect(queried['count']).toBe(2);
    expect(queried['used_item_ids']).toEqual(['T-381', 'T-250']);
  });

  it('captures nothing when no delivered item was cited', async () => {
    const { connect } = makeFixture();
    const client = await connect();
    const captured = payload(
      await client.callTool({
        name: 'usage_capture',
        arguments: { text: 'nothing relevant here', delivered: ['T-1', 'T-2'] },
      }),
    );
    expect(captured['captured']).toBe(0);
    expect(captured['item_ids']).toEqual([]);

    const queried = payload(await client.callTool({ name: 'usage_query', arguments: {} }));
    expect(queried['count']).toBe(0);
    expect(queried['used_item_ids']).toEqual([]);
  });

  it('stamps the registrar session id as provenance', async () => {
    const { connect } = makeFixture();
    const client = await connect();
    await client.callTool({
      name: 'usage_capture',
      arguments: { text: 'cites T-5', delivered: ['T-5'] },
    });
    const queried = payload(await client.callTool({ name: 'usage_query', arguments: { session_id: SESSION_ID } }));
    expect(queried['count']).toBe(1);
    const signals = queried['signals'] as Array<{ source: { session_id: string; capture_point: string } }>;
    expect(signals[0]?.source.session_id).toBe(SESSION_ID);
    expect(signals[0]?.source.capture_point).toBe('mcp:usage_capture');
  });
});
