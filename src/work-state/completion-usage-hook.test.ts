// plugin/src/work-state/completion-usage-hook.test.ts — acceptance tests
// for the work_complete post-commit USAGE-CAPTURE hook and its wiring through
// BOTH transports (work-state/tools.ts's `work_complete` MCP handler and
// cli/ideate-work.ts's `complete` subcommand).
//
// Pins:
// - deliveredIdsFor: depends_on + parent_id + references[].id, de-duplicated,
//   never the seed's own id;
// - the real writer detects a cited delivered id and writes a usage signal
//   through the real, real UsageStore; an uncited delivered id writes
//   nothing; no delivered ids and/or no note writes nothing;
// - BOTH shipped transports inject the real writer (grep-falsifiable, mirrors
//   completion-record.test.ts's own transport-injection pin);
// - the REAL shipped path, not the store directly (P-50): a
//   work_claim → work_complete round trip over a real MCP session produces a
//   signal that `usage_query` — the OTHER real MCP verb — reads back; the
//   CLI's `complete --note` subcommand produces the same signal on disk
//   (`citations.ndjson` exists and grows);
// - GP-22, grep-falsifiable: no skill or agent prose anywhere in this plugin
//   instructs calling `usage_capture` — capture here fires mechanically, at
//   agent discretion nowhere.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Clock } from '../record/id.js';
import { UsageStore } from '../usage/store.js';
import { createUsageToolsRegistrar } from '../usage/tools.js';
import {
  USAGE_CAPTURE_ENABLED,
  USAGE_CAPTURE_POINT,
  createGatedUsageCaptureWriter,
  createRealUsageCaptureWriter,
  deliveredIdsFor,
} from './completion-usage-hook.js';
import type { UsageCaptureFacts } from './completion-usage-hook.js';
import { createWorkStateToolsRegistrar } from './tools.js';
import type { ActorRef, WorkItem } from './types.js';

const FIXED_ISO = '2026-07-30T12:00:00.000Z';
const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-work');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-work.js');

const tempDirs: string[] = [];
const clients: Client[] = [];

function makeTempDir(prefix = 'ideate-completion-usage-hook-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (clients.length > 0) {
    await clients.pop()?.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function actor(human = 'dan'): ActorRef {
  return { human };
}

function makeItem(overrides?: Partial<WorkItem>): WorkItem {
  return {
    id: '01JZM8Z0000000000000000AA',
    tenant_id: 'local',
    title: 'ship the thing',
    spec: 's',
    spec_format: 'text/plain',
    status: 'done',
    claim: null,
    depends_on: [],
    parent_id: null,
    references: [],
    created_by: actor('creator'),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    version: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deliveredIdsFor — the floor "delivered" definition
// ---------------------------------------------------------------------------

describe('deliveredIdsFor — depends_on + parent_id + references[].id, de-duplicated', () => {
  it('collects all three structural sources', () => {
    const item = makeItem({
      depends_on: ['01AAA', '01BBB'],
      parent_id: '01CCC',
      references: [{ rel: 'relates-to', id: '01DDD' }],
    });
    expect(deliveredIdsFor(item).sort()).toEqual(['01AAA', '01BBB', '01CCC', '01DDD'].sort());
  });

  it('de-duplicates across sources and omits a null parent_id', () => {
    const item = makeItem({
      depends_on: ['01AAA'],
      parent_id: null,
      references: [{ rel: 'supersedes', id: '01AAA' }], // same id as a depends_on entry
    });
    expect(deliveredIdsFor(item)).toEqual(['01AAA']);
  });

  it('is empty for an item with no structural neighbours', () => {
    expect(deliveredIdsFor(makeItem())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The real writer, end to end, against a real UsageStore
// ---------------------------------------------------------------------------

describe('createRealUsageCaptureWriter — mechanical detection over the real UsageStore', () => {
  it('a note citing a depends_on id writes a used_context signal for exactly that id', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const writer = createRealUsageCaptureWriter(projectRoot, undefined, clock);

    const facts: UsageCaptureFacts = {
      item: makeItem({ depends_on: ['01DEPENDS0000000000000AA'] }),
      note: 'this closes out the schema work started in 01DEPENDS0000000000000AA, verified end to end',
      sessionId: 'sess-writer-test',
    };
    const signals = writer(facts);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.item_id).toBe('01DEPENDS0000000000000AA');
    expect(signals[0]?.kind).toBe('used_context');
    expect(signals[0]?.seed_id).toBe(facts.item.id);
    expect(signals[0]?.manifest_id).toBeUndefined(); // no manifest in scope — see the file header
    expect(signals[0]?.source.capture_point).toBe(USAGE_CAPTURE_POINT);
    expect(signals[0]?.source.session_id).toBe('sess-writer-test');
    expect(signals[0]?.source.task_id).toBe(facts.item.id);

    // Reads back through a fresh UsageStore instance over the same project root.
    const store = new UsageStore(join(projectRoot, '.ideate', 'usage'), clock);
    const persisted = store.query({ seed_id: facts.item.id });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.item_id).toBe('01DEPENDS0000000000000AA');
    expect(store.usedItemIds({ seed_id: facts.item.id })).toEqual(['01DEPENDS0000000000000AA']);
  });

  it('a delivered id that is NOT cited in the note writes nothing (delivered != used)', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const writer = createRealUsageCaptureWriter(projectRoot, undefined, clock);
    const facts: UsageCaptureFacts = {
      item: makeItem({ depends_on: ['01NEVERMENTIONED000000AA'] }),
      note: 'shipped and verified, nothing else to say',
      sessionId: 'sess-writer-test',
    };
    expect(writer(facts)).toEqual([]);
  });

  it('no structural neighbours writes nothing, even with a note', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const writer = createRealUsageCaptureWriter(projectRoot, undefined, clock);
    expect(writer({ item: makeItem(), note: 'done', sessionId: 's' })).toEqual([]);
  });

  it('no note (undefined or empty) writes nothing, even with structural neighbours', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const writer = createRealUsageCaptureWriter(projectRoot, undefined, clock);
    const item = makeItem({ depends_on: ['01AAA'] });
    expect(writer({ item, note: undefined, sessionId: 's' })).toEqual([]);
    expect(writer({ item, note: '', sessionId: 's' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every shipped transport injects the real writer (grep-falsifiable)
// ---------------------------------------------------------------------------

describe('every shipped transport injects the GATED usage-capture writer', () => {
  it('tools.ts and ideate-work.ts inject createGatedUsageCaptureWriter — never the real one directly', () => {
    for (const rel of ['src/work-state/tools.ts', 'src/cli/ideate-work.ts']) {
      const source = readFileSync(join(PLUGIN_DIR, rel), 'utf8');
      expect(source, `${rel} must construct the GATED writer`).toContain('createGatedUsageCaptureWriter');
      // The property, not the spelling (P-41): a transport that reached past
      // the gate to the real writer would re-enable a signal review judged
      // dishonest, so the ONLY admissible construction here is the gated one.
      expect(source, `${rel} must not bypass the gate`).not.toContain('createRealUsageCaptureWriter(');
      expect(source, `${rel} must thread the config into complete()`).toContain('usageWriter');
    }
  });

  it('the gate is OFF, so the gated writer is a provable no-op that never constructs a UsageStore', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const gated = createGatedUsageCaptureWriter(projectRoot, undefined, clock);

    // Facts that the REAL writer provably turns into a signal (see the
    // createRealUsageCaptureWriter suite above) — so a passing assertion here
    // is the gate doing the work, not an inert fixture.
    const facts: UsageCaptureFacts = {
      item: makeItem({ depends_on: ['01DEPENDS0000000000000AA'] }),
      note: 'this closes out the schema work started in 01DEPENDS0000000000000AA, verified end to end',
      sessionId: 'sess-gate-test',
    };
    expect(createRealUsageCaptureWriter(makeTempDir(), undefined, clock)(facts), 'fixture sanity: the real writer WOULD signal').toHaveLength(1);

    expect(gated(facts), 'gated writer must return no signals').toEqual([]);
    expect(existsSync(join(projectRoot, '.ideate', 'usage')), 'gated writer must not create the usage store').toBe(false);
    expect(USAGE_CAPTURE_ENABLED, 'gate stays off until an integration point observes genuine USE').toBe(false);
  });
});

describe('GP-22: no skill or agent prose instructs calling usage_capture (mechanical, never agent-discretion)', () => {
  it('grep across every skill/agent markdown surface finds zero occurrences', () => {
    const roots = ['skills', 'agents'];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = join(PLUGIN_DIR, root);
      if (!existsSync(dir)) continue;
      walk(dir, (file) => {
        if (!file.endsWith('.md')) return;
        const text = readFileSync(file, 'utf8');
        if (text.includes('usage_capture')) offenders.push(file);
      });
    }
    expect(offenders).toEqual([]);
  });
});

function walk(dir: string, onFile: (path: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

// ---------------------------------------------------------------------------
// MCP transport — the REAL shipped path (P-50): work_complete → usage_query
// ---------------------------------------------------------------------------

function payload(result: unknown): Record<string, unknown> {
  const content = (result as CallToolResult).content;
  const first = content[0];
  if (first?.type !== 'text') throw new Error(`expected a text content block, got ${JSON.stringify(first)}`);
  return JSON.parse(first.text) as Record<string, unknown>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: payload(result) };
}

describe('MCP transport, end to end — the GATE holds: delivery happens, capture does not', () => {
  it('a completion note citing its depends_on item writes NOTHING while the gate is off, through the real MCP tool surface only', async () => {
    const projectRoot = makeTempDir();
    const telemetryDir = join(projectRoot, '.ideate-telemetry');
    let nowIso = FIXED_ISO;
    const clock: Clock = () => new Date(nowIso);

    // Both registrars share the SAME project root — exactly server.ts's own
    // composition (createRecordToolsRegistrar/createWorkStateToolsRegistrar/
    // createUsageToolsRegistrar all registered on one server, over one root).
    const workRegistrar = createWorkStateToolsRegistrar({ projectRoot, telemetryDir, clock, sessionId: 'sess-mcp-usage-test' });
    const usageRegistrar = createUsageToolsRegistrar({ projectRoot, clock, sessionId: 'sess-mcp-usage-test' });
    const server = new McpServer({ name: 'ideate-work-usage-test', version: '0.0.0' });
    workRegistrar(server);
    usageRegistrar(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'completion-usage-test-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Item A: the dependency. Item B: depends_on A — so A's id is DELIVERED
    // to B's worker in every read of B (work_claim's own response payload).
    const depCreated = await call(client, 'work_create', {
      title: 'lay the groundwork',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
    });
    const depId = (depCreated.body.item as Record<string, unknown>).id as string;
    const depClaimed = await call(client, 'work_claim', { id: depId, actor_human: 'dan' });
    const depToken = ((depClaimed.body.item as Record<string, unknown>).claim as Record<string, unknown>).claim_token as number;
    const depCompleted = await call(client, 'work_complete', { id: depId, claim_token: depToken, note: 'groundwork laid' });
    expect(depCompleted.isError).toBe(false);

    const mainCreated = await call(client, 'work_create', {
      title: 'build on top',
      spec: 's',
      spec_format: 'text/plain',
      actor_human: 'dan',
      depends_on: [depId],
    });
    const mainId = (mainCreated.body.item as Record<string, unknown>).id as string;
    // work_claim's OWN response carries depends_on — the delivered set this
    // hook detects citations against — confirming it really was delivered.
    const mainClaimed = await call(client, 'work_claim', { id: mainId, actor_human: 'dan' });
    expect(((mainClaimed.body.item as Record<string, unknown>).depends_on as string[])).toEqual([depId]);
    const mainToken = ((mainClaimed.body.item as Record<string, unknown>).claim as Record<string, unknown>).claim_token as number;

    const mainCompleted = await call(client, 'work_complete', {
      id: mainId,
      claim_token: mainToken,
      note: `built directly on top of ${depId}, verified against its groundwork`,
    });
    expect(mainCompleted.isError).toBe(false);

    // Everything above is the DELIVERY half, and it is real: work_claim's own
    // response carried depends_on, and the note cites it. The real writer
    // provably turns exactly these facts into a signal (see the
    // createRealUsageCaptureWriter suite). So what follows isolates the GATE.
    //
    // The ONLY read path exercised here is the OTHER real MCP verb,
    // usage_query — never UsageStore directly (P-50).
    const queried = await call(client, 'usage_query', { seed_id: mainId });
    expect(queried.isError).toBe(false);
    expect(queried.body.used_item_ids, 'gate off: no ids may be recorded as used').toEqual([]);
    expect(queried.body.signals as unknown[], 'gate off: no signals may be written').toHaveLength(0);

    // The store itself must never come into existence. An EMPTY store is
    // visibly empty; a store full of coordinator-narration rows would look
    // healthy and be misread as evidence of context reuse — the reason the
    // gate exists (finding 01KYWK5A05EJ8HW5ESTC8ASXQZ).
    const logPath = join(projectRoot, '.ideate', 'usage', 'citations.ndjson');
    expect(existsSync(logPath), 'gate off: citations.ndjson must not be created').toBe(false);
  });

  it('a completion note that cites nothing writes zero signals — usage_query over that seed returns none', async () => {
    const projectRoot = makeTempDir();
    const telemetryDir = join(projectRoot, '.ideate-telemetry');
    const clock: Clock = () => new Date(FIXED_ISO);
    const workRegistrar = createWorkStateToolsRegistrar({ projectRoot, telemetryDir, clock, sessionId: 'sess-mcp-usage-test-2' });
    const usageRegistrar = createUsageToolsRegistrar({ projectRoot, clock, sessionId: 'sess-mcp-usage-test-2' });
    const server = new McpServer({ name: 'ideate-work-usage-test-2', version: '0.0.0' });
    workRegistrar(server);
    usageRegistrar(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'completion-usage-test-client-2', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const created = await call(client, 'work_create', { title: 'standalone', spec: 's', spec_format: 'text/plain', actor_human: 'dan' });
    const id = (created.body.item as Record<string, unknown>).id as string;
    const claimed = await call(client, 'work_claim', { id, actor_human: 'dan' });
    const token = ((claimed.body.item as Record<string, unknown>).claim as Record<string, unknown>).claim_token as number;
    const completed = await call(client, 'work_complete', { id, claim_token: token, note: 'no dependencies, nothing to cite' });
    expect(completed.isError).toBe(false);

    const queried = await call(client, 'usage_query', { seed_id: id });
    expect(queried.isError).toBe(false);
    expect(queried.body.signals).toEqual([]);
    expect(queried.body.used_item_ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CLI transport — the REAL shipped path (P-50), subprocess
// ---------------------------------------------------------------------------

describe('CLI transport (cli/ideate-work.ts) — the GATE holds across the process boundary too', () => {
  beforeAll(() => {
    if (!existsSync(DIST_CLI)) {
      execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
    }
  }, 120_000);

  function runCli(args: string[], cwd: string): string {
    return execFileSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8' });
  }

  it('claim + complete --note through the real CLI subprocess writes NO citations.ndjson while the gate is off', () => {
    const root = makeTempDir('ideate-completion-usage-hook-cli-test-');
    const dep = JSON.parse(
      runCli(['create', '--title', 'cli dep', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], root),
    ) as { id: string };
    const depClaim = JSON.parse(runCli(['claim', '--id', dep.id, '--human', 'dan'], root)) as { claim: { claim_token: number } };
    runCli(['complete', '--id', dep.id, '--token', String(depClaim.claim.claim_token), '--note', 'dep done'], root);

    const main = JSON.parse(
      runCli(
        ['create', '--title', 'cli main', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan', '--depends-on', dep.id],
        root,
      ),
    ) as { id: string };
    const mainClaim = JSON.parse(runCli(['claim', '--id', main.id, '--human', 'dan'], root)) as { claim: { claim_token: number } };
    const completed = JSON.parse(
      runCli(
        ['complete', '--id', main.id, '--token', String(mainClaim.claim.claim_token), '--note', `built on ${dep.id} via the cli`],
        root,
      ),
    ) as { status: string };
    expect(completed.status).toBe('done');

    // The completion succeeded — the board transition is unaffected by the
    // gate. What must NOT happen is a usage row. This runs in a genuinely
    // separate PROCESS, so it pins that the gate is compiled into the shipped
    // dist/ rather than being an in-test constant: a build that shipped the
    // ungated writer would create the file here and fail.
    const logPath = join(root, '.ideate', 'usage', 'citations.ndjson');
    expect(existsSync(logPath), 'gate off: the CLI must not create citations.ndjson').toBe(false);
    expect(existsSync(join(root, '.ideate', 'usage')), 'gate off: no usage store directory at all').toBe(false);
  });
});
