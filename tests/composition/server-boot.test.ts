// plugin/tests/composition/server-boot.test.ts — WI-277: boot the SHIPPED
// artifact (P-34's exemplar; fixes cycle-7 CRITICAL C1).
//
// Every other server test hand-wires its own McpServer in-process, so none of
// them could catch the shipped server exposing zero tools. This suite launches
// the artifact EXACTLY as the plugin's .mcp.json does —
//   { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/server.js"] }
// — as a real child process, and speaks stdio JSON-RPC to it as an external
// MCP client:
//   1. initialize  → serverInfo.name is `ideate` AND the tools capability is
//      advertised (a zero-tool boot would omit it),
//   2. tools/list  → exactly record_append, record_read, record_decision,
//   3. one record_append round trip whose record file lands on disk under the
//      child's cwd (a temp project root — lazy-init onboarding writes go
//      there, never to the repo's real .ideate/).
// The child is killed cleanly via the client/transport close.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CONFIG_FILENAME, DEFAULT_RECORD_PATH } from '../../src/config/ideate-config.js';
import { RECORD_TOOL_NAMES } from '../../src/record/tools.js';
import { SERVER_NAME, SERVER_VERSION } from '../../src/server.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = join(PLUGIN_DIR, '..');
const SRC_DIR = join(PLUGIN_DIR, 'src');
const DIST_SERVER = join(PLUGIN_DIR, 'dist', 'server.js');

/** Newest mtime (ms) of any .ts source file under src/. */
function newestSourceMtime(): number {
  let newest = 0;
  for (const entry of readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const mtime = statSync(join(SRC_DIR, entry)).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

/** The shipped artifact must be current: build once if missing or stale. */
function ensureDistCurrent(): void {
  if (!existsSync(DIST_SERVER) || statSync(DIST_SERVER).mtimeMs < newestSourceMtime()) {
    // `pnpm --filter @ideate/plugin build` ≡ `tsc -b` in plugin/; invoke the
    // workspace tsc directly so the test needs nothing beyond node_modules.
    execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }
}

let projectRoot: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  ensureDistCurrent();

  // Temp cwd = the child's project root: lazy-init writes (.ideate.json, the
  // record dir) land here, never in the repository.
  projectRoot = mkdtempSync(join(tmpdir(), 'ideate-server-boot-'));

  // The exact .mcp.json launch shape: `node <plugin-root>/dist/server.js`,
  // stdio transport, spawned as a real external process.
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_SERVER],
    cwd: projectRoot,
    stderr: 'ignore', // server diagnostics are stderr-only by contract; not under test here
  });
  client = new Client({ name: 'server-boot-test-client', version: '0.0.0' });
  await client.connect(transport); // performs the initialize handshake
}, 120_000);

afterAll(async () => {
  // Kill the child cleanly: closing the client closes the stdio transport,
  // which terminates the spawned server process.
  await client?.close();
  if (projectRoot !== undefined) rmSync(projectRoot, { recursive: true, force: true });
});

describe('boot the shipped artifact (node dist/server.js, real stdio)', () => {
  it('initialize: serverInfo is ideate and the tools capability is advertised', () => {
    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe(SERVER_NAME);
    expect(serverInfo?.version).toBe(SERVER_VERSION);
    // A zero-tool boot (the cycle-7 C1 failure) would not advertise `tools`.
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  it('tools/list: exactly the three record verbs, nothing else', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...RECORD_TOOL_NAMES].sort());
  });

  it('record_append round trip: the call succeeds and the record lands on disk in the temp root', async () => {
    const claim = 'The shipped MCP server serves the record tools end to end.';
    const result = await client.callTool({
      name: 'record_append',
      arguments: {
        kind: 'finding',
        claim,
        verification_anchor: 'plugin/tests/composition/server-boot.test.ts',
        scope: 'WI-277 composition remediation',
        content:
          'Booted node dist/server.js exactly as .mcp.json launches it, spoke stdio JSON-RPC ' +
          'as an external client, and appended this record through the real record_append verb.',
      },
    });

    expect(result.isError).not.toBe(true);
    const body = JSON.parse(
      ((result.content as Array<{ type: string; text: string }>)[0] as { text: string }).text,
    ) as { ok: boolean; id: string; kind: string };
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('finding');
    expect(body.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID

    // Lazy-init onboarding fired in the child's cwd = the temp project root.
    expect(existsSync(join(projectRoot, CONFIG_FILENAME))).toBe(true);

    // The record file itself: date-sharded under the temp root's record dir.
    const recordDir = join(projectRoot, DEFAULT_RECORD_PATH);
    const recordFile = readdirSync(recordDir, { recursive: true, encoding: 'utf8' })
      .map((entry) => join(recordDir, entry))
      .find((path) => path.endsWith(`${body.id}.md`));
    expect(recordFile, `record ${body.id}.md not found under ${recordDir}`).toBeDefined();
    expect(readFileSync(recordFile as string, 'utf8')).toContain(claim);
  });
});
