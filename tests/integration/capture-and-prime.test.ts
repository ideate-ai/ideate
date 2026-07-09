// plugin/tests/integration/capture-and-prime.test.ts — WI-276: the
// end-to-end floor, cross-module, against ONE temp project root.
//
// Spec: docs/design/v3-composable-surface.md §2.2 (capture point 2:
// SessionEnd → session-outcome record), §2.3 (hook floor-raisers), §3 (the
// priming digest); docs/spikes/v3-boundary-contract.md §6.2 (four contract
// fields, recall-shaped prose ≥ the G8 word floor) and §2 amendment I.
//
// The chain proven here, in order, over one project root:
//   1. The real SessionEnd path: a fixture hook payload (with a fixture
//      transcript JSONL) piped into `bin/ideate-record session-end` produces
//      a date-sharded record with all four contract fields and ≥25 words of
//      prose, exiting 0.
//   2. `bin/ideate-record prime` surfaces the just-captured record in its
//      digest — the capture→prime round trip works end to end.
//   3. A hook script (task-completed.mjs) fired with a fixture payload lands
//      its record through the CLI and increments capture_fired (read via the
//      telemetry report API against the state dir).
//   4. A simulated capture-write failure (unwritable record dir) still exits
//      0 — capture never blocks the host — and increments
//      capture_write_failed.
//   5. Registration purity at the integration level: constructing the MCP
//      server + registrar writes NOTHING until the first tool call.
//   6. Redaction observability (WI-281, closes cycle-7 S1): a planted secret
//      pushed through a hook script is masked on disk, increments the
//      dedicated `redactions` telemetry counter (read via reportFromDir),
//      AND its warning text reaches the hook's own stderr — on a SUCCESSFUL
//      append, because the hook transport forwards child stderr
//      unconditionally.
//
// The real `.ideate/` is never touched; everything runs in mkdtemp roots.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CONFIG_FILENAME, DEFAULT_RECORD_PATH } from '../../src/config/ideate-config.js';
import { parseRecord } from '../../src/record/schema.js';
import type { ProcessRecord } from '../../src/record/schema.js';
import { createRecordToolsRegistrar } from '../../src/record/tools.js';
import { reportFromDir } from '../../src/telemetry/report.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = join(PLUGIN_DIR, '..');
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-record');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-record.js');
const TASK_COMPLETED_HOOK = join(PLUGIN_DIR, 'hooks', 'task-completed.mjs');

const SESSION_ID = 'sess-e2e-capture';

/** One project root for the whole capture→prime chain (tests 1–4). */
let projectRoot: string;
let recordDir: string;
let telemetryDir: string;
let transcriptPath: string;

const extraRoots: string[] = [];
const clients: Client[] = [];

beforeAll(() => {
  // The chain runs the real bin against compiled output. Build incrementally
  // if needed (documented order is `pnpm build` then `pnpm test`).
  if (!existsSync(DIST_CLI)) {
    execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }

  projectRoot = mkdtempSync(join(tmpdir(), 'ideate-e2e-'));
  recordDir = join(projectRoot, DEFAULT_RECORD_PATH);
  telemetryDir = join(projectRoot, '.ideate-telemetry');

  // Fixture transcript: one user turn, two assistant turns with tool uses on
  // real-looking file paths and a closing text block — enough structure for
  // the session-end summarizer to compose ≥25 words of prose.
  transcriptPath = join(projectRoot, 'transcript.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the failing shard-path test in the record store.' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: join(projectRoot, 'src', 'record', 'store.ts') } },
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Fixed the failing shard-path test by deriving the shard from the ULID timestamp instead of the wall clock.',
          },
        ],
      },
    }),
  ];
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`, 'utf8');
}, 120_000);

afterAll(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  // Restore permissions before removal — test 4 leaves nothing read-only on
  // success, but a mid-test failure must not strand an unremovable temp dir.
  try {
    if (existsSync(recordDir)) chmodSync(recordDir, 0o755);
  } catch {
    /* best-effort */
  }
  rmSync(projectRoot, { recursive: true, force: true });
  for (const dir of extraRoots) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run the real bin as a child process, never throwing on nonzero exit. */
function runBin(args: string[], input?: string): RunResult {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

interface StoredRecord {
  path: string;
  raw: string;
  record: ProcessRecord;
}

/** Every persisted record under the chain root's record dir, parsed. */
function storedRecords(): StoredRecord[] {
  if (!existsSync(recordDir)) return [];
  const out: StoredRecord[] = [];
  for (const year of readdirSync(recordDir).filter((n) => /^\d{4}$/.test(n))) {
    for (const month of readdirSync(join(recordDir, year)).filter((n) => /^\d{2}$/.test(n))) {
      for (const file of readdirSync(join(recordDir, year, month))) {
        const path = join(recordDir, year, month, file);
        const raw = readFileSync(path, 'utf8');
        out.push({ path, raw, record: parseRecord(raw) });
      }
    }
  }
  return out;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

// ---------------------------------------------------------------------------
// 1. SessionEnd capture: payload in, date-sharded prose record out, exit 0
// ---------------------------------------------------------------------------

/** The session-outcome record test 1 captures; tests 2–3 build on it. */
let sessionOutcome: StoredRecord | undefined;

describe('1. the real SessionEnd path (surface §2.2 capture point 2)', () => {
  it('bin/ideate-record session-end writes the record and exits 0', () => {
    const payload = {
      session_id: SESSION_ID,
      transcript_path: transcriptPath,
      cwd: projectRoot,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    };
    const result = runBin(['session-end'], JSON.stringify(payload));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // the new record's ULID

    const records = storedRecords();
    expect(records).toHaveLength(1);
    sessionOutcome = records[0];
  });

  it('the record file is date-sharded: record.path/YYYY/MM/{ulid}.md', () => {
    expect(sessionOutcome?.path).toMatch(/\/\d{4}\/\d{2}\/[0-9A-HJKMNP-TV-Z]{26}\.md$/);
  });

  it('all four contract fields are physically present in the frontmatter (§6.2)', () => {
    const raw = sessionOutcome?.raw ?? '';
    for (const key of ['claim: ', 'verification_anchor: ', 'scope: ', 'source:']) {
      expect(raw, `frontmatter is missing ${key.trim()}`).toContain(`\n${key}`);
    }
    const record = sessionOutcome?.record as ProcessRecord;
    expect(record.kind).toBe('session-outcome');
    expect(record.claim.length).toBeGreaterThan(0);
    expect(record.verification_anchor).toBe(transcriptPath);
    expect(record.source.capture_point).toBe('session-end');
    expect(record.source.session_id).toBe(SESSION_ID);
    expect(record.source.timestamp.length).toBeGreaterThan(0);
  });

  it('the prose body clears the 25-word recall-shape floor (§6.2 / gate G8)', () => {
    const record = sessionOutcome?.record as ProcessRecord;
    expect(wordCount(record.content)).toBeGreaterThanOrEqual(25);
    // Prose, not bare metadata: the transcript's substance is in the words.
    expect(record.content).toContain('Tools used:');
    expect(record.content).toContain('store.ts');
  });
});

// ---------------------------------------------------------------------------
// 2. Capture → prime round trip: the floor works end to end
// ---------------------------------------------------------------------------

describe('2. bin/ideate-record prime surfaces the just-captured record (surface §3)', () => {
  it('the digest exits 0 and carries the session-outcome claim verbatim', () => {
    const result = runBin(['prime']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ideate process record');
    expect(result.stdout).toContain('[session-outcome]');
    const claim = (sessionOutcome?.record as ProcessRecord).claim;
    expect(result.stdout).toContain(claim);
  });
});

// ---------------------------------------------------------------------------
// 3. A hook .mjs fires: record lands, capture_fired increments
// ---------------------------------------------------------------------------

describe('3. task-completed.mjs: hook payload → record + telemetry (surface §2.3)', () => {
  it('the hook exits 0 with silent stdout and its record lands', () => {
    const payload = {
      session_id: SESSION_ID,
      task_id: 'T-42',
      task_title: 'Wire the capture-and-prime integration suite',
      task_description: 'End-to-end floor test for WI-276.',
      cwd: projectRoot,
    };
    const result = spawnSync(process.execPath, [TASK_COMPLETED_HOOK], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: JSON.stringify(payload),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(''); // hook stdout is host-visible; stays silent

    const taskRecords = storedRecords().filter((r) => r.record.kind === 'native-task-completion');
    expect(taskRecords).toHaveLength(1);
    expect((taskRecords[0] as StoredRecord).record.source.task_id).toBe('T-42');
  });

  it("capture_fired incremented, read via the telemetry report API against the state dir", () => {
    const { report } = reportFromDir(telemetryDir);
    // Point 'session-end' from test 1, point 'cli:append' from the hook's CLI write.
    expect(report.captureFired.byPoint['session-end']).toBeGreaterThanOrEqual(1);
    expect(report.captureFired.byPoint['cli:append']).toBeGreaterThanOrEqual(1);
    expect(report.captureFired.total).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// 4. Capture-write failure: exit 0 (never blocks), counter increments
// ---------------------------------------------------------------------------

describe('4. simulated capture-write failure (unwritable record dir)', () => {
  it('session-end still exits 0 and capture_write_failed increments', () => {
    const before = reportFromDir(telemetryDir).report.captureWriteFailed.total;

    // Make the record dir unwritable: drop the existing shards so the append
    // must mkdir under the now read-only root, which fails.
    for (const year of readdirSync(recordDir).filter((n) => /^\d{4}$/.test(n))) {
      rmSync(join(recordDir, year), { recursive: true, force: true });
    }
    chmodSync(recordDir, 0o555);
    try {
      const payload = { session_id: 'sess-e2e-fail', cwd: projectRoot, hook_event_name: 'SessionEnd', reason: 'other' };
      const result = runBin(['session-end'], JSON.stringify(payload));

      expect(result.status).toBe(0); // capture NEVER blocks the host
      expect(result.stderr).toContain('capture write failed');

      const after = reportFromDir(telemetryDir).report.captureWriteFailed;
      expect(after.total).toBe(before + 1);
      expect(after.byPoint['session-end']).toBeGreaterThanOrEqual(1);
      expect(after.bySession['sess-e2e-fail']).toBeGreaterThanOrEqual(1);
    } finally {
      chmodSync(recordDir, 0o755);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Registration purity at the integration level
// ---------------------------------------------------------------------------

describe('5. constructing server + registrar writes NOTHING until first call (§2.3 lazy init)', () => {
  it('an empty project root stays byte-empty through construction, then first call onboards', async () => {
    const pureRoot = mkdtempSync(join(tmpdir(), 'ideate-e2e-pure-'));
    extraRoots.push(pureRoot);

    const server = new McpServer({ name: 'purity-test', version: '0.0.0' });
    createRecordToolsRegistrar({ projectRoot: pureRoot, sessionId: 'sess-pure' })(server);
    expect(readdirSync(pureRoot)).toEqual([]); // registration wrote nothing

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'purity-test-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    expect(readdirSync(pureRoot)).toEqual([]); // connecting wrote nothing either

    await client.callTool({
      name: 'record_append',
      arguments: {
        kind: 'finding',
        claim: 'Registration is side-effect free.',
        content: 'The first tool call, not registration, performs the lazy-init onboarding.',
      },
    });
    expect(existsSync(join(pureRoot, CONFIG_FILENAME))).toBe(true); // .ideate.json onboarded
    expect(existsSync(join(pureRoot, DEFAULT_RECORD_PATH))).toBe(true); // record dir created
  });
});

// ---------------------------------------------------------------------------
// 6. Redaction observability end to end (WI-281, closes cycle-7 S1)
// ---------------------------------------------------------------------------

describe('6. planted secret through a hook: counted on the dashboard AND visible on hook stderr', () => {
  it('the redactions counter increments and the warning text reaches the hook stderr, exit 0', () => {
    const before = reportFromDir(telemetryDir).report.redactions;
    const ghToken = `ghp_${'Z9y8X7w6'.repeat(5)}`; // ghp_ + 40 alnum chars

    const payload = {
      session_id: SESSION_ID,
      task_id: 'T-81',
      task_title: 'Rotate the leaked staging token',
      task_description: `The old token ${ghToken} was found in a shell history file and must be revoked immediately.`,
      cwd: projectRoot,
    };
    const result = spawnSync(process.execPath, [TASK_COMPLETED_HOOK], {
      cwd: projectRoot,
      encoding: 'utf8',
      input: JSON.stringify(payload),
    });

    // Exit-0 hook policy preserved; stdout stays silent.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');

    // Signal 1 — the dashboard: the SIXTH counter observably incremented,
    // read via the same report API the ideate-telemetry CLI folds with.
    const after = reportFromDir(telemetryDir).report.redactions;
    expect(after.total).toBe(before.total + 1);
    expect(after.events).toBe(before.events + 1);
    expect(after.byPattern['github-token']).toBe((before.byPattern['github-token'] ?? 0) + 1);
    // The CLI append transport mints its own `cli-<ulid>` session id, so the
    // per-session breakdown is keyed under that (not the hook payload's id).
    expect(Object.keys(after.bySession).some((s) => s.startsWith('cli-'))).toBe(true);

    // Signal 2 — the transport: the store's warning survived the hook hop
    // (child stderr forwarded unconditionally, even though the append
    // SUCCEEDED). It names the pattern, never the content.
    expect(result.stderr).toContain('IDEATE_RECORD_REDACTION');
    expect(result.stderr).toContain('github-token');
    expect(result.stderr).not.toContain(ghToken);

    // And the persisted record itself is masked.
    const planted = storedRecords().filter((r) => r.record.source.task_id === 'T-81');
    expect(planted).toHaveLength(1);
    expect((planted[0] as StoredRecord).raw).not.toContain(ghToken);
    expect((planted[0] as StoredRecord).raw).toContain('[REDACTED:github-token]');
  });
});
