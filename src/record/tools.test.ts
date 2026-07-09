// plugin/src/record/tools.test.ts — WI-273 acceptance tests for the three
// record MCP verbs.
//
// Pins: exactly three tools registered (no update/delete verb exists);
// side-effect-free registration with first-CALL lazy init (config + record
// dir); record_append writes a real file (raw on-disk read), unconditionally
// — a minimal-args call still writes; a planted secret arrives masked on
// disk; record_decision hits the SAME store.append path as record_append
// (prototype spy) and produces kind=decision; record_read returns
// newest-first scope-filtered limited records.
//
// All tools are exercised over a real in-process MCP session
// (InMemoryTransport + Client), so argument schemas and the tools/list
// surface are the protocol truth, not implementation details. All filesystem
// work happens in mkdtemp dirs — the real .ideate/ is never touched.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CursorSchema, ProgressSchema } from '@modelcontextprotocol/sdk/types.js';

import { CONFIG_FILENAME } from '../config/ideate-config.js';
import type { Clock } from './id.js';
import { parseRecord } from './schema.js';
import { RecordStore } from './store.js';
import { RECORD_TOOL_NAMES, createRecordToolsRegistrar } from './tools.js';

const FIXED_ISO = '2026-07-09T12:00:00.000Z';
const SESSION_ID = 'sess-tools-test';

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (clients.length > 0) {
    await clients.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  projectRoot: string;
  server: McpServer;
  setNow: (iso: string) => void;
  connect: () => Promise<Client>;
}

function makeFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'ideate-record-tools-test-'));
  tempDirs.push(projectRoot);
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const registrar = createRecordToolsRegistrar({ projectRoot, clock, sessionId: SESSION_ID });
  const server = new McpServer({ name: 'ideate-test', version: '0.0.0' });
  registrar(server);
  return {
    projectRoot,
    server,
    setNow: (iso) => {
      nowIso = iso;
    },
    connect: async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'tools-test-client', version: '0.0.0' });
      clients.push(client);
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return client;
    },
  };
}

/** The registered tool names, straight off the server's registry. */
function registeredNames(server: McpServer): string[] {
  const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(registry).sort();
}

/** Parse the JSON payload out of a tool result's single text content block. */
function payload(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function callAppend(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return payload(await client.callTool({ name: 'record_append', arguments: args }));
}

const minimalAppend = {
  kind: 'finding',
  claim: 'The fork pool cap is load-bearing.',
  content: 'Raising maxForks above 4 crashed a 32GB box during v2.',
};

describe('SDK zod primitive shape-pin: the zString/zNumber derivation base', () => {
  // tools.ts derives its parameter schemas from the SDK's own exported zod
  // instances (zString = CursorSchema, zNumber = ProgressSchema.shape.progress)
  // rather than adding a zod dependency. These behavioral pins make a future
  // SDK bump that changes those primitives' shapes fail loudly here, instead
  // of silently changing every record verb's argument validation.
  const zString = CursorSchema; // the exact expression tools.ts binds
  const zNumber = ProgressSchema.shape.progress; // ditto

  it('zString (CursorSchema) accepts a string and rejects a number', () => {
    expect(zString.safeParse('a discovery-candidate claim').success).toBe(true);
    expect(zString.safeParse(42).success).toBe(false);
  });

  it('zNumber (ProgressSchema.shape.progress) accepts a number and rejects a string', () => {
    expect(zNumber.safeParse(7).success).toBe(true);
    expect(zNumber.safeParse('7').success).toBe(false);
  });

  it('the derived chains tools.ts mints keep their validation semantics', () => {
    // record_read's limit: zNumber.int().min(0).optional()
    const limit = zNumber.int().min(0).describe('limit').optional();
    expect(limit.safeParse(3).success).toBe(true);
    expect(limit.safeParse(undefined).success).toBe(true); // optional
    expect(limit.safeParse(2.5).success).toBe(false); // .int()
    expect(limit.safeParse(-1).success).toBe(false); // .min(0)
    // Every optional string arg: zString.describe(...).optional()
    const optionalText = zString.describe('scope').optional();
    expect(optionalText.safeParse('auth flow').success).toBe(true);
    expect(optionalText.safeParse(undefined).success).toBe(true);
    expect(optionalText.safeParse(42).success).toBe(false);
  });
});

describe('the tool surface: exactly three verbs, no update/delete (§1.1, §4.2)', () => {
  it('registers exactly record_append, record_read, record_decision — nothing else', async () => {
    const fx = makeFixture();
    expect(registeredNames(fx.server)).toEqual([...RECORD_TOOL_NAMES].sort());

    // The same truth over the wire: tools/list advertises exactly the three.
    const client = await fx.connect();
    const listed = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(listed).toEqual([...RECORD_TOOL_NAMES].sort());
  });

  it('no update/delete/rank verb exists at the MCP surface', () => {
    const fx = makeFixture();
    for (const name of registeredNames(fx.server)) {
      expect(name).not.toMatch(/update|delete|remove|rank|score|edit|patch/i);
    }
  });
});

describe('side-effect-free registration, first-call lazy init (config §2.3)', () => {
  it('registration (and even connecting) creates NO files; the first CALL creates config + record dir', async () => {
    const fx = makeFixture();
    // Registration touched nothing: the temp project root is still empty.
    expect(readdirSync(fx.projectRoot)).toEqual([]);

    const client = await fx.connect();
    // A live session alone still touches nothing.
    await client.listTools();
    expect(readdirSync(fx.projectRoot)).toEqual([]);

    // First tool call: lazy-init onboarding fires — config file + record dir.
    const result = await callAppend(client, minimalAppend);
    expect(result['ok']).toBe(true);
    expect(existsSync(join(fx.projectRoot, CONFIG_FILENAME))).toBe(true);
    expect(existsSync(join(fx.projectRoot, '.ideate', 'record'))).toBe(true);
  });
});

describe('record_append: the unconditional Tier A write (§2.1)', () => {
  it('writes a real record file and returns its id — verified by raw on-disk read', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    const result = await callAppend(client, {
      ...minimalAppend,
      verification_anchor: 'vitest.config.ts',
      scope: 'test infrastructure',
      task_id: 'WI-273',
    });

    expect(result['ok']).toBe(true);
    const id = result['id'] as string;
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/); // a well-formed ULID

    // Fixed clock 2026-07-09 → shard 2026/07; read the raw bytes back.
    const filePath = join(fx.projectRoot, '.ideate', 'record', '2026', '07', `${id}.md`);
    const record = parseRecord(readFileSync(filePath, 'utf8'));
    expect(record.id).toBe(id);
    expect(record.kind).toBe('finding');
    expect(record.claim).toBe(minimalAppend.claim);
    expect(record.verification_anchor).toBe('vitest.config.ts');
    expect(record.scope).toBe('test infrastructure');
    expect(record.content).toBe(minimalAppend.content);
    // Provenance comes from the tool context, not the caller.
    expect(record.source.capture_point).toBe('mcp:record_append');
    expect(record.source.session_id).toBe(SESSION_ID);
    expect(record.source.task_id).toBe('WI-273');
    expect(record.source.timestamp).toBe(FIXED_ISO);
  });

  it('a minimal-args call still writes — no optional parameter gates the write', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    // Only the required args: every optional one omitted.
    const result = await callAppend(client, minimalAppend);
    expect(result['ok']).toBe(true);

    const filePath = join(fx.projectRoot, '.ideate', 'record', '2026', '07', `${result['id'] as string}.md`);
    expect(existsSync(filePath)).toBe(true);
    const record = parseRecord(readFileSync(filePath, 'utf8'));
    // Omitted optionals become empty contract fields — present, empty, valid.
    expect(record.verification_anchor).toBe('');
    expect(record.scope).toBe('');
    expect(record.source.task_id).toBeUndefined();
  });

  it('a planted secret arrives masked on disk and is reported in the redaction summary', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const result = await callAppend(client, {
      ...minimalAppend,
      content: `Deploy fails unless ${awsKey} is set in the env.`,
    });

    expect(result['ok']).toBe(true);
    const filePath = join(fx.projectRoot, '.ideate', 'record', '2026', '07', `${result['id'] as string}.md`);
    const raw = readFileSync(filePath, 'utf8');
    expect(raw).not.toContain(awsKey);
    expect(raw).toContain('[REDACTED:aws-access-key-id]');
    // The redaction tally comes back to the caller.
    expect(result['redactions']).toEqual(expect.arrayContaining([{ pattern: 'aws-access-key-id', count: 1 }]));
  });
});

describe('record_decision: sugar over the identical write path (§2 row 4)', () => {
  it('hits the same store.append path as record_append, with an equivalent input shape', async () => {
    const appendSpy = vi.spyOn(RecordStore.prototype, 'append');
    const fx = makeFixture();
    const client = await fx.connect();

    const viaAppend = await callAppend(client, {
      kind: 'decision',
      claim: 'Ship the record core before the board verbs.',
      content: 'Decision: Ship the record core before the board verbs.',
      scope: 'PR-005 sequencing',
    });
    const viaDecision = payload(
      await client.callTool({
        name: 'record_decision',
        arguments: { claim: 'Ship the record core before the board verbs.', scope: 'PR-005 sequencing' },
      }),
    );
    expect(viaAppend['ok']).toBe(true);
    expect(viaDecision['ok']).toBe(true);

    // Both verbs funneled into RecordStore.append — one write path, called
    // with structurally equivalent inputs (only the minted id differs).
    expect(appendSpy).toHaveBeenCalledTimes(2);
    const [fromAppend] = appendSpy.mock.calls[0] ?? [];
    const [fromDecision] = appendSpy.mock.calls[1] ?? [];
    expect(fromDecision).toEqual(fromAppend);

    // And the sugar produced a real kind=decision record on disk.
    const filePath = join(fx.projectRoot, '.ideate', 'record', '2026', '07', `${viaDecision['id'] as string}.md`);
    const record = parseRecord(readFileSync(filePath, 'utf8'));
    expect(record.kind).toBe('decision');
    expect(record.source.capture_point).toBe('mcp:record_decision');
    expect(record.content).toBe('Decision: Ship the record core before the board verbs.');
  });

  it('composes claim + rationale into recall-shaped prose content', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    const result = payload(
      await client.callTool({
        name: 'record_decision',
        arguments: {
          claim: 'Use ULIDs for record ids.',
          rationale: 'Sortable by construction and collision-safe without a server.',
        },
      }),
    );
    expect(result['ok']).toBe(true);
    expect(result['kind']).toBe('decision');

    const filePath = join(fx.projectRoot, '.ideate', 'record', '2026', '07', `${result['id'] as string}.md`);
    const record = parseRecord(readFileSync(filePath, 'utf8'));
    expect(record.content).toBe(
      'Decision: Use ULIDs for record ids.\n\nRationale: Sortable by construction and collision-safe without a server.',
    );
  });
});

describe('record_read: standalone priming — unranked, scope-filtered, limited (§4.3)', () => {
  async function seedThree(fx: Fixture, client: Client): Promise<{ first: string; second: string; third: string }> {
    fx.setNow('2026-05-01T00:00:00.000Z');
    const first = await callAppend(client, { ...minimalAppend, kind: 'decision', scope: 'auth flow' });
    fx.setNow('2026-06-15T00:00:00.000Z');
    const second = await callAppend(client, { ...minimalAppend, kind: 'finding', scope: 'record store internals' });
    fx.setNow('2026-07-09T00:00:00.000Z');
    const third = await callAppend(client, { ...minimalAppend, kind: 'task-completion', scope: 'auth flow hardening' });
    return { first: first['id'] as string, second: second['id'] as string, third: third['id'] as string };
  }

  interface ReadRecord {
    id: string;
    kind: string;
    claim: string;
    scope: string;
    source: { session_id: string };
    content: string;
  }

  async function read(client: Client, args: Record<string, unknown>): Promise<ReadRecord[]> {
    const result = payload(await client.callTool({ name: 'record_read', arguments: args }));
    expect(result['ok']).toBe(true);
    return result['records'] as ReadRecord[];
  }

  it('returns newest-first records carrying frontmatter fields + content', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    const ids = await seedThree(fx, client);

    const records = await read(client, {});
    expect(records.map((r) => r.id)).toEqual([ids.third, ids.second, ids.first]);
    // Full record shape: frontmatter fields and the prose body.
    expect(records[0]).toMatchObject({
      kind: 'task-completion',
      claim: minimalAppend.claim,
      scope: 'auth flow hardening',
      content: minimalAppend.content,
      source: { session_id: SESSION_ID },
    });
  });

  it('applies the scope filter as substring selection, still newest-first', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    const ids = await seedThree(fx, client);

    const auth = await read(client, { scope: 'auth flow' });
    expect(auth.map((r) => r.id)).toEqual([ids.third, ids.first]);
    expect(await read(client, { scope: 'nonexistent-vocabulary' })).toEqual([]);
  });

  it('caps results with limit', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    const ids = await seedThree(fx, client);
    const capped = await read(client, { limit: 2 });
    expect(capped.map((r) => r.id)).toEqual([ids.third, ids.second]);
  });

  it('reads an empty record tree as an empty list (and lazy-inits on the way)', async () => {
    const fx = makeFixture();
    const client = await fx.connect();
    expect(await read(client, {})).toEqual([]);
    // A read is a first call too: onboarding fired.
    expect(existsSync(join(fx.projectRoot, CONFIG_FILENAME))).toBe(true);
    expect(existsSync(join(fx.projectRoot, '.ideate', 'record'))).toBe(true);
  });
});
