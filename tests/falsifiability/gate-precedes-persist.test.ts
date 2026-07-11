// plugin/tests/falsifiability/gate-precedes-persist.test.ts — WI-276: the
// cycle-7 amendment I pin, cross-module. "Gate precedes persist, no exempt
// path" (docs/spikes/v3-boundary-contract.md §2 amendment I; docs/design/
// v3-composable-surface.md §2.1 "Secret gate on every write").
//
// Three angles, one contract:
//   SOURCE  — in store.ts's append path the scanAndMask invocation precedes
//             the module's ONLY filesystem write call (positions asserted in
//             the source text, read at test time).
//   RUNTIME — the same planted fake secret goes through BOTH transports (the
//             MCP verb in-process, the CLI via child_process) against temp
//             roots; the raw on-disk bytes are masked in both and the secret
//             bytes are absent in both.
//   HOOKS   — hooks.json commands only ever invoke bin/ideate-record or a
//             hooks/*.mjs script; no hook script performs a direct fs write
//             (scripts write ONLY through the CLI, so no hook path can skirt
//             the gate); nothing in hooks.json or the scripts can block the
//             host (no decision/permissionDecision/continue:false, no nonzero
//             process.exit argument).
//
// The tests never touch the real `.ideate/` — all runtime work happens in
// mkdtemp roots.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DEFAULT_RECORD_PATH } from '../../src/config/ideate-config.js';
import { createRecordToolsRegistrar } from '../../src/record/tools.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HOOKS_DIR = join(PLUGIN_DIR, 'hooks');
const STORE_TS = join(PLUGIN_DIR, 'src', 'record', 'store.ts');
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-record');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-record.js');

// AWS's canonical documentation-example secret — a FAKE with the real shape.
const SECRET_TOKEN = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const SECRET_LINE = `aws_secret_access_key = ${SECRET_TOKEN}`;
const EXPECTED_MARKER = '[REDACTED:aws-secret-access-key]';

beforeAll(() => {
  // The CLI transport runs against compiled output. Build incrementally if
  // needed (documented order is `pnpm build` then `pnpm test`; this keeps
  // the suite self-sufficient when run in isolation).
  if (!existsSync(DIST_CLI)) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }
}, 120_000);

const tempDirs: string[] = [];
const clients: Client[] = [];

function makeProjectRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Source-analysis helpers
// ---------------------------------------------------------------------------

/** Strip block and line comments (the sources carry none inside strings). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Brace-match the `{...}` body that opens at/after `marker`. */
function extractBlock(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`source drift: marker not found: ${marker}`);
  const open = source.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`source drift: unbalanced braces after marker: ${marker}`);
}

/** Every fs file-write CALL site (mkdir excluded — it persists no content). */
const FS_WRITE_CALL = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*\(/g;

interface GateOrderAnalysis {
  /** fs write call sites in the whole module's code. Must be exactly 1. */
  moduleWriteSites: number;
  /** Position of the first scanAndMask call inside the append body. */
  gateIndex: number;
  /** Positions of every fs write call inside the append body. */
  writeIndices: number[];
  /** True when the gate precedes EVERY write in the append path. */
  gatePrecedesEveryWrite: boolean;
}

function analyzeGateOrder(source: string): GateOrderAnalysis {
  const code = stripComments(source);
  const body = extractBlock(code, 'append(input: RecordInput): AppendResult');
  const gateIndex = body.indexOf('scanAndMask(');
  const writeIndices = [...body.matchAll(FS_WRITE_CALL)].map((m) => m.index);
  return {
    moduleWriteSites: [...code.matchAll(FS_WRITE_CALL)].length,
    gateIndex,
    writeIndices,
    gatePrecedesEveryWrite: gateIndex !== -1 && writeIndices.length > 0 && writeIndices.every((i) => i > gateIndex),
  };
}

// ---------------------------------------------------------------------------
// SOURCE: gate before persist, one write site (store.ts)
// ---------------------------------------------------------------------------

describe('store.ts source: scanAndMask precedes the one and only fs write (amendment I)', () => {
  const storeSource = readFileSync(STORE_TS, 'utf8');
  const analysis = analyzeGateOrder(storeSource);

  it('the whole store module has exactly ONE fs write call site', () => {
    expect(analysis.moduleWriteSites).toBe(1);
  });

  it('the append path invokes scanAndMask, and it precedes every fs write', () => {
    expect(analysis.gateIndex).toBeGreaterThanOrEqual(0);
    expect(analysis.writeIndices).toHaveLength(1);
    expect(analysis.gatePrecedesEveryWrite).toBe(true);
  });

  it('the check FAILS on a mutant that persists before gating', () => {
    // Break an in-memory copy: plant an fs write ahead of the gate.
    const mutant = storeSource.replace(
      '// GATE BEFORE PERSIST',
      "writeFileSync('/tmp/leak', JSON.stringify(record));\n    // GATE BEFORE PERSIST",
    );
    expect(mutant).not.toBe(storeSource);
    const broken = analyzeGateOrder(mutant);
    expect(broken.gatePrecedesEveryWrite).toBe(false);
    expect(broken.moduleWriteSites).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// RUNTIME: the same planted secret is masked through BOTH transports
// ---------------------------------------------------------------------------

/** All raw record files under a project root's record dir. */
function rawRecordFiles(projectRoot: string): string[] {
  const recordDir = join(projectRoot, DEFAULT_RECORD_PATH);
  if (!existsSync(recordDir)) return [];
  const out: string[] = [];
  for (const year of readdirSync(recordDir)) {
    for (const month of readdirSync(join(recordDir, year))) {
      for (const file of readdirSync(join(recordDir, year, month))) {
        out.push(readFileSync(join(recordDir, year, month, file), 'utf8'));
      }
    }
  }
  return out;
}

function expectMaskedAndClean(raw: string): void {
  expect(raw).toContain(EXPECTED_MARKER);
  expect(raw.includes(SECRET_TOKEN)).toBe(false);
}

describe('runtime cross-transport: planted secret never reaches disk unmasked', () => {
  it('MCP transport (in-process record_append): raw file is masked, secret bytes absent', async () => {
    const projectRoot = makeProjectRoot('ideate-gate-mcp-');
    const server = new McpServer({ name: 'gate-test', version: '0.0.0' });
    createRecordToolsRegistrar({ projectRoot, sessionId: 'sess-gate-mcp' })(server);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'gate-test-client', version: '0.0.0' });
    clients.push(client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({
      name: 'record_append',
      arguments: {
        kind: 'finding',
        claim: `The deploy env leaked ${SECRET_LINE} into a log line.`,
        content: `While debugging the deploy the literal line "${SECRET_LINE}" appeared in captured output.`,
      },
    });

    const files = rawRecordFiles(projectRoot);
    expect(files).toHaveLength(1);
    expectMaskedAndClean(files[0] as string);
  });

  it('CLI transport (child_process append): raw file is masked, secret bytes absent', () => {
    const projectRoot = makeProjectRoot('ideate-gate-cli-');
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, 'append', '--kind', 'finding', '--claim', `The deploy env leaked ${SECRET_LINE} into a log line.`, '--content', '-'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        input: `While debugging the deploy the literal line "${SECRET_LINE}" appeared in captured output.`,
      },
    );
    expect(result.status).toBe(0);

    const files = rawRecordFiles(projectRoot);
    expect(files).toHaveLength(1);
    expectMaskedAndClean(files[0] as string);
  });
});

// ---------------------------------------------------------------------------
// HOOKS: commands route through the gated CLI; scripts never write directly;
//        nothing can block the host
// ---------------------------------------------------------------------------

interface HookHandler {
  type: string;
  command: string;
}

function allHookCommands(): string[] {
  const config = JSON.parse(readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ hooks: HookHandler[] }>>;
  };
  const commands: string[] = [];
  for (const entries of Object.values(config.hooks)) {
    for (const entry of entries) {
      for (const handler of entry.hooks) commands.push(handler.command);
    }
  }
  return commands;
}

function hookScriptNames(): string[] {
  return readdirSync(HOOKS_DIR).filter((name) => name.endsWith('.mjs'));
}

describe('hooks.json: every command invokes bin/ideate-record or a hooks/*.mjs script', () => {
  it('registers at least the SessionStart/SessionEnd floor and only sanctioned targets', () => {
    const commands = allHookCommands();
    expect(commands.length).toBeGreaterThanOrEqual(2);
    const sanctioned = /^"\$\{CLAUDE_PLUGIN_ROOT\}\/(bin\/ideate-record|hooks\/[\w-]+\.mjs)"/;
    for (const command of commands) {
      expect(command, `unsanctioned hook command: ${command}`).toMatch(sanctioned);
    }
  });

  it('every hooks/*.mjs a command names actually exists in the plugin', () => {
    for (const command of allHookCommands()) {
      const script = /hooks\/([\w-]+\.mjs)/.exec(command)?.[1];
      if (script !== undefined) expect(existsSync(join(HOOKS_DIR, script))).toBe(true);
    }
  });
});

describe('hook scripts: no direct fs writes — the CLI is the only write path (§2.1)', () => {
  it.each(hookScriptNames())('%s performs no writeFile/appendFile/createWriteStream call', (name) => {
    const source = readFileSync(join(HOOKS_DIR, name), 'utf8');
    expect([...source.matchAll(FS_WRITE_CALL)]).toHaveLength(0);
  });
});

describe('hooks never block (surface §1.1 hook policy, §2.2 falsifiability restated)', () => {
  const blockingSources = ['hooks.json', ...hookScriptNames()];

  it.each(blockingSources)('%s carries no decision / permissionDecision / continue:false', (name) => {
    const source = readFileSync(join(HOOKS_DIR, name), 'utf8');
    expect(source).not.toMatch(/\bdecision\b/i);
    expect(source).not.toMatch(/\bpermissionDecision\b/i);
    expect(source).not.toMatch(/["']?continue["']?\s*:\s*false/);
  });

  it.each(blockingSources)('%s never calls process.exit with a nonzero argument', (name) => {
    const source = readFileSync(join(HOOKS_DIR, name), 'utf8');
    for (const match of source.matchAll(/process\.exit\s*\(\s*([^)]*)\)/g)) {
      const arg = (match[1] as string).trim();
      expect(arg === '' || arg === '0', `${name}: process.exit(${arg})`).toBe(true);
    }
  });
});
