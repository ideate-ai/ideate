// plugin/src/work-state/completion-record.test.ts — WI-306 acceptance tests
// for the completion-record composer + writer seam and its wiring through
// BOTH transports (work-state/tools.ts's `work_complete` MCP handler and
// cli/ideate-work.ts's `complete` subcommand).
//
// Pins:
// - the composer functions (claim/anchor/scope/content) per the WI-306 brief
//   (title + note; structural fallback when the note is absent; anchor
//   references item id + event; scope from tenant/item);
// - the real writer persists exactly one 'work-completion' record through
//   the real, gated RecordStore — both transports produce it;
// - secret-gate idempotence: already-masked text (the board's own gate at
//   insert time) passes through the record store's second gate unchanged —
//   no double-mask corruption;
// - non-blocking failure semantics, exercised end-to-end through the real
//   CLI subprocess (an unwritable record directory): exit code stays 0
//   (complete() itself never throws) and the failure surfaces on stderr.
//
// completion-record.test.ts intentionally does NOT modify tools.test.ts or
// ideate-work.test.ts (out of this work item's file scope) — "both
// transports" coverage lives here instead, driving each transport's own real
// composition function directly (createWorkStateToolsRegistrar for MCP; the
// real built CLI binary, subprocess, for the CLI path — mirroring each
// sibling test file's own established pattern).

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION, recordPath } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { reportFromDir } from '../telemetry/report.js';
import { createWorkStateToolsRegistrar } from './tools.js';
import {
  COMPLETION_CAPTURE_POINT,
  COMPLETION_RECORD_KIND,
  composeCompletionAnchor,
  composeCompletionClaim,
  composeCompletionContent,
  composeCompletionScope,
  createRealCompletionRecordWriter,
} from './completion-record.js';
import type { CompletionRecordFacts } from './completion-record.js';
import type { ActorRef, WorkItem } from './types.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

// F-306-001 M1: every shipped transport must inject the real completion-
// record writer — complete()'s parameter is optional BY DESIGN (a direct
// engine caller has no project root to resolve a record from), so the
// capture guarantee lives entirely at the transport edges. This pin makes
// that mechanically grep-falsifiable: a future transport (or a refactor of
// an existing one) that drops the injection fails here, not in production
// silence (P-41).
describe('every shipped transport injects the completion-record writer', () => {
  it('tools.ts and ideate-work.ts both construct createRealCompletionRecordWriter and thread completionRecord into complete()', async () => {
    const { readFileSync } = await import('node:fs');
    for (const rel of ['src/work-state/tools.ts', 'src/cli/ideate-work.ts']) {
      const source = readFileSync(join(PLUGIN_DIR, rel), 'utf8');
      expect(source, `${rel} must construct the real writer`).toContain('createRealCompletionRecordWriter');
      expect(source, `${rel} must thread the config into complete()`).toContain('completionRecord');
    }
  });
});
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-work');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-work.js');

const tempDirs: string[] = [];
const permRestores: string[] = [];

function makeTempDir(prefix = 'ideate-completion-record-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (permRestores.length > 0) {
    const dir = permRestores.pop();
    if (dir !== undefined) chmodSync(dir, 0o755);
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
    created_by: actor('creator'),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    version: 2,
    ...overrides,
  };
}

function makeFacts(overrides?: Partial<CompletionRecordFacts>): CompletionRecordFacts {
  return {
    item: makeItem(),
    note: 'shipped and verified',
    completedBy: actor('dan'),
    claimToken: 1,
    completedAt: FIXED_ISO,
    sessionId: 'sess-composer-test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Composer unit tests (the pre-made design decisions from the WI-306 brief)
// ---------------------------------------------------------------------------

describe('composeCompletionClaim / composeCompletionContent — note present vs. structural fallback', () => {
  it('note present: claim is title + note', () => {
    const facts = makeFacts({ note: 'shipped and verified' });
    expect(composeCompletionClaim(facts)).toBe('ship the thing — shipped and verified');
    expect(composeCompletionContent(facts)).toBe('shipped and verified');
  });

  it('note absent: the structural fallback carries the title + transition metadata (holder, timestamp) — never empty', () => {
    const facts = makeFacts({ note: undefined });
    const claimText = composeCompletionClaim(facts);
    expect(claimText).toContain('ship the thing');
    expect(claimText).toContain('dan');
    expect(claimText).toContain(FIXED_ISO);
    expect(claimText).not.toBe('');
    // The content mirrors the same fallback sentence.
    expect(composeCompletionContent(facts)).toBe(claimText);
  });

  it('an empty-string note is treated identically to an absent note', () => {
    const withUndefined = composeCompletionClaim(makeFacts({ note: undefined }));
    const withEmpty = composeCompletionClaim(makeFacts({ note: '' }));
    expect(withEmpty).toBe(withUndefined);
  });

  it('a named agent is included in the fallback claim', () => {
    const facts = makeFacts({ note: undefined, completedBy: { human: 'dan', agent: 'dan/worker-3' } });
    expect(composeCompletionClaim(facts)).toContain('dan/worker-3');
  });
});

describe('composeCompletionAnchor / composeCompletionScope — WI-306 brief', () => {
  it('anchor references the board item id + the completion event', () => {
    expect(composeCompletionAnchor('WI-306-item', FIXED_ISO)).toBe(`board:WI-306-item#complete@${FIXED_ISO}`);
  });

  it('scope is tenant/item', () => {
    expect(composeCompletionScope('local', 'WI-306-item')).toBe('local/WI-306-item');
  });
});

// ---------------------------------------------------------------------------
// The real writer, end to end, against a real (gated) RecordStore
// ---------------------------------------------------------------------------

function realConfig(): IdeateConfigV3 {
  return { schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' };
}

describe('createRealCompletionRecordWriter — persists exactly one work-completion record through the real, gated store', () => {
  it('the persisted record carries kind=work-completion, the composed claim/anchor/scope/content, and reads back through RecordStore.read()', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const telemetryDir = makeTempDir();
    const telemetry = new TelemetryCounters(telemetryDir, clock);

    const writer = createRealCompletionRecordWriter(projectRoot, telemetry, clock);
    const facts = makeFacts();
    const result = writer(facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.kind).toBe(COMPLETION_RECORD_KIND);
    expect(result.record.claim).toBe('ship the thing — shipped and verified');
    expect(result.record.verification_anchor).toBe(`board:${facts.item.id}#complete@${FIXED_ISO}`);
    expect(result.record.scope).toBe(`${facts.item.tenant_id}/${facts.item.id}`);
    expect(result.record.content).toBe('shipped and verified');
    expect(result.record.source.capture_point).toBe(COMPLETION_CAPTURE_POINT);
    expect(result.record.source.task_id).toBe(facts.item.id);
    expect(result.record.source.session_id).toBe(facts.sessionId);

    // Reads back through a fresh RecordStore instance over the same project root.
    const config = realConfig();
    const readerStore = new RecordStore(config, projectRoot, telemetry, clock);
    const [record] = readerStore.read({ scope: facts.item.id });
    expect(record?.id).toBe(result.record.id);
    expect(record?.kind).toBe('work-completion');

    expect(report_captureFired(telemetryDir)).toBe(1);
  });

  function report_captureFired(telemetryDir: string): number {
    return reportFromDir(telemetryDir).report.captureFired.byPoint[COMPLETION_CAPTURE_POINT] ?? 0;
  }
});

describe('secret-gate idempotence (criterion 3) — already-masked text passes through unchanged', () => {
  it('a title already masked at board persist is NOT double-masked when the record store gates it a second time', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const telemetryDir = makeTempDir();
    const telemetry = new TelemetryCounters(telemetryDir, clock);

    // Simulates the board's OWN gate having already masked a secret-shaped
    // title (work-state/store.ts's `gate()` runs at insert time — this is
    // the string `WorkItem.title` would actually carry by the time
    // claims.ts's complete() reads it back).
    const alreadyMaskedTitle = 'rotate [REDACTED:aws-access-key-id] now';
    const alreadyMaskedNote = 'confirmed the key [REDACTED:aws-access-key-id] was rotated';
    const facts = makeFacts({
      item: makeItem({ title: alreadyMaskedTitle }),
      note: alreadyMaskedNote,
    });

    const writer = createRealCompletionRecordWriter(projectRoot, telemetry, clock);
    const result = writer(facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Fixed point: rescanning already-masked content yields the identical
    // text — no `[REDACTED:[REDACTED:...]]` corruption, no second marker.
    expect(result.record.claim).toBe(`${alreadyMaskedTitle} — ${alreadyMaskedNote}`);
    expect(result.record.content).toBe(alreadyMaskedNote);
    expect(result.record.claim).not.toContain('REDACTED:REDACTED');
    expect((result.record.claim.match(/\[REDACTED:/g) ?? []).length).toBe(2); // exactly the two pre-existing markers
    expect(result.redactions).toEqual([]); // zero NEW redactions — nothing left to catch

    const { report } = reportFromDir(telemetryDir);
    expect(report.redactions.total).toBe(0);
  });

  it('a genuinely unmasked secret in the note IS caught by the record store\'s own gate (defense in depth)', () => {
    const projectRoot = makeTempDir();
    const clock: Clock = () => new Date(FIXED_ISO);
    const telemetryDir = makeTempDir();
    const telemetry = new TelemetryCounters(telemetryDir, clock);

    const rawSecretNote = 'the key is AKIAABCDEFGHIJKLMNOP, rotate it';
    const facts = makeFacts({ note: rawSecretNote });

    const writer = createRealCompletionRecordWriter(projectRoot, telemetry, clock);
    const result = writer(facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.content).toBe('the key is [REDACTED:aws-access-key-id], rotate it');
    expect(result.record.content).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

// ---------------------------------------------------------------------------
// Both transports (criterion 1, 4, 5)
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

describe('MCP transport (work-state/tools.ts) — work_complete produces exactly one work-completion record', () => {
  it('claim + complete(note) through the real MCP tool surface persists the record under the same project root', async () => {
    const projectRoot = makeTempDir();
    const telemetryDir = join(projectRoot, '.ideate-telemetry');
    let nowIso = FIXED_ISO;
    const clock: Clock = () => new Date(nowIso);
    const registrar = createWorkStateToolsRegistrar({ projectRoot, telemetryDir, clock, sessionId: 'sess-mcp-completion-test' });
    const server = new McpServer({ name: 'ideate-work-completion-record-test', version: '0.0.0' });
    registrar(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'completion-record-test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const created = await call(client, 'work_create', {
        title: 'do the mcp thing',
        spec: 's',
        spec_format: 'text/plain',
        actor_human: 'dan',
      });
      const id = (created.body.item as Record<string, unknown>).id as string;
      const claimed = await call(client, 'work_claim', { id, actor_human: 'dan' });
      const token = ((claimed.body.item as Record<string, unknown>).claim as Record<string, unknown>).claim_token as number;

      const completed = await call(client, 'work_complete', { id, claim_token: token, note: 'done via mcp' });
      expect(completed.isError).toBe(false);
      expect((completed.body.item as Record<string, unknown>).status).toBe('done');

      const config = realConfig();
      const telemetry = new TelemetryCounters(telemetryDir, clock);
      const readerStore = new RecordStore(config, projectRoot, telemetry, clock);
      const records = readerStore.read({ scope: id }).filter((r) => r.kind === 'work-completion');
      expect(records).toHaveLength(1);
      expect(records[0]?.claim).toBe('do the mcp thing — done via mcp');
      expect(records[0]?.verification_anchor).toBe(`board:${id}#complete@${records[0]?.source.timestamp}`);
      expect(records[0]?.source.task_id).toBe(id);
    } finally {
      await client.close();
    }
  });
});

describe('CLI transport (cli/ideate-work.ts) — complete produces exactly one work-completion record, and a forced failure is non-blocking', () => {
  beforeAll(() => {
    if (!existsSync(DIST_CLI)) {
      execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
    }
  }, 120_000);

  function runCli(args: string[], cwd: string): string {
    return execFileSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8' });
  }

  function runCliRaw(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('claim + complete --note through the real CLI subprocess persists the record under the same project root', () => {
    const root = makeTempDir('ideate-completion-record-cli-test-');
    const created = JSON.parse(
      runCli(['create', '--title', 'do the cli thing', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], root),
    ) as { id: string };
    const claimed = JSON.parse(runCli(['claim', '--id', created.id, '--human', 'dan'], root)) as { claim: { claim_token: number } };
    const completed = JSON.parse(
      runCli(['complete', '--id', created.id, '--token', String(claimed.claim.claim_token), '--note', 'done via cli'], root),
    ) as { status: string };
    expect(completed.status).toBe('done');

    const config = realConfig();
    const clock: Clock = () => new Date();
    const telemetry = new TelemetryCounters(join(root, '.ideate-telemetry'), clock);
    const readerStore = new RecordStore(config, root, telemetry, clock);
    const records = readerStore.read({ scope: created.id }).filter((r) => r.kind === 'work-completion');
    expect(records).toHaveLength(1);
    expect(records[0]?.claim).toBe('do the cli thing — done via cli');
  });

  it('a forced record-write failure (unwritable record directory) is non-blocking: complete still exits 0 and prints the item, with a loud stderr diagnostic', () => {
    const root = makeTempDir('ideate-completion-record-cli-fail-test-');
    const created = JSON.parse(
      runCli(['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], root),
    ) as { id: string };
    const claimed = JSON.parse(runCli(['claim', '--id', created.id, '--human', 'dan'], root)) as { claim: { claim_token: number } };

    // `create`/`claim` above already triggered loadConfig's lazy-init, which
    // creates the record directory (config/ideate-config.ts §2.3) — force
    // every write under it to fail.
    const config = realConfig();
    const dir = recordPath(config, root);
    expect(existsSync(dir)).toBe(true);
    chmodSync(dir, 0o500); // read+execute only: mkdir of the shard fails
    permRestores.push(dir);

    const result = runCliRaw(
      ['complete', '--id', created.id, '--token', String(claimed.claim.claim_token), '--note', 'done despite failure'],
      root,
    );
    expect(result.status).toBe(0); // never blocks — the claim completion itself is unaffected
    const completed = JSON.parse(result.stdout) as { status: string };
    expect(completed.status).toBe('done');
    expect(result.stderr).toContain(created.id);
    expect(result.stderr.toLowerCase()).toContain('completion');

    const { report } = reportFromDir(join(root, '.ideate-telemetry'));
    expect(report.captureWriteFailed.byPoint['work-completion']).toBeGreaterThanOrEqual(1);
  });
});
