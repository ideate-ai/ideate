// plugin/src/cli/ideate-work.test.ts — WI-303 acceptance tests for the
// `ideate-work` CLI, the second transport over the work-state logic layer.
//
// Every test drives the REAL executable (bin/ideate-work) through
// child_process against a mkdtemp project root — the real `.ideate-work/`
// is never touched. Pins: --help/-h/no-args prints USAGE and exits 0 (WI-296
// pattern); direct-use subcommands exit 1 on failure; renew/release/complete
// accept no actor flags at all (mirrors the engine's own signatures); --json
// on get/list/events; the CLI-only `sweep` subcommand always exits 0 with
// silent stdout.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BIN_PATH = join(PLUGIN_DIR, 'bin', 'ideate-work');
const DIST_CLI = join(PLUGIN_DIR, 'dist', 'cli', 'ideate-work.js');

const tempDirs: string[] = [];
function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface RunOptions {
  cwd: string;
}

/** Run the real bin. execFileSync throws on nonzero exit, so success IS exit 0. */
function runCli(args: string[], options: RunOptions): string {
  return execFileSync(process.execPath, [BIN_PATH, ...args], { cwd: options.cwd, encoding: 'utf8' });
}

/** Run the bin without throwing; returns the exit status and streams. */
function runCliRaw(args: string[], options: RunOptions): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], { cwd: options.cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  // The CLI runs against compiled output. Build incrementally if needed
  // (documented order is `pnpm build` then `pnpm test`; this keeps the
  // suite self-sufficient when run in isolation).
  if (!existsSync(DIST_CLI)) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }
}, 120_000);

describe('bin wiring', () => {
  it('the executable is resolvable at the plugin bin path and is executable', () => {
    const stat = statSync(BIN_PATH);
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
    const pkg = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    expect(pkg.bin?.['ideate-work']).toBe('bin/ideate-work');
  });
});

describe('--help / -h / no-args (general usage edge, WI-296 pattern)', () => {
  it('prints usage covering all twelve subcommands and exits 0 for --help', () => {
    const root = makeProjectRoot();
    const result = runCliRaw(['--help'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ideate-work');
    for (const sub of ['create', 'get', 'list', 'update-meta', 'claim', 'renew', 'release', 'complete', 'cancel', 'reopen', 'events', 'sweep']) {
      expect(result.stdout).toContain(sub);
    }
  });

  it('prints usage and exits 0 for -h', () => {
    const result = runCliRaw(['-h'], { cwd: makeProjectRoot() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ideate-work');
  });

  it('prints usage and exits 0 for no args at all', () => {
    const result = runCliRaw([], { cwd: makeProjectRoot() });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: ideate-work');
  });
});

describe('create / get / list / update-meta', () => {
  it('creates an item and round-trips it through get, list, and update-meta', () => {
    const root = makeProjectRoot();
    const created = JSON.parse(
      runCli(['create', '--title', 'do the thing', '--spec', 'plain prompt', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string; version: number; status: string };
    expect(created.status).toBe('open');

    const got = JSON.parse(runCli(['get', '--id', created.id, '--json'], { cwd: root })) as { id: string };
    expect(got.id).toBe(created.id);

    const listed = runCli(['list'], { cwd: root });
    expect(listed).toContain(created.id);

    const updated = JSON.parse(
      runCli(['update-meta', '--id', created.id, '--expected-version', String(created.version), '--title', 'renamed'], { cwd: root }),
    ) as { title: string; version: number };
    expect(updated.title).toBe('renamed');
    expect(updated.version).toBe(created.version + 1);
  });

  it('get --id on a nonexistent item prints "(not found)" and exits 0', () => {
    const root = makeProjectRoot();
    const result = runCliRaw(['get', '--id', 'no-such-id'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('(not found)');
  });

  it('update-meta with a stale expected-version exits 1 with a VERSION_CONFLICT message', () => {
    const root = makeProjectRoot();
    const created = JSON.parse(
      runCli(['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };
    const result = runCliRaw(['update-meta', '--id', created.id, '--expected-version', '99'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VERSION_CONFLICT');
  });
});

describe('claim lifecycle: actor flags mirror the engine signatures exactly', () => {
  it('claim/cancel/reopen accept --human; renew/release/complete accept NO actor flag at all', () => {
    const root = makeProjectRoot();
    const created = JSON.parse(
      runCli(['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };

    const claimed = JSON.parse(runCli(['claim', '--id', created.id, '--human', 'dan'], { cwd: root })) as {
      claim: { claim_token: number };
    };
    const token = claimed.claim.claim_token;
    expect(typeof token).toBe('number');

    // renew/release/complete reject --human as an unrecognized argument —
    // there is no actor flag on these subcommands at all.
    const renewWithActor = runCliRaw(['renew', '--id', created.id, '--token', String(token), '--human', 'dan'], { cwd: root });
    expect(renewWithActor.status).toBe(1);
    expect(renewWithActor.stderr).toContain('unknown argument --human');

    const renewed = JSON.parse(runCli(['renew', '--id', created.id, '--token', String(token)], { cwd: root })) as {
      claim: { claim_token: number };
    };
    expect(renewed.claim.claim_token).toBe(token);

    const completed = JSON.parse(runCli(['complete', '--id', created.id, '--token', String(token), '--note', 'done'], { cwd: root })) as {
      status: string;
    };
    expect(completed.status).toBe('done');

    const reopened = JSON.parse(runCli(['reopen', '--id', created.id, '--human', 'dan'], { cwd: root })) as { status: string };
    expect(reopened.status).toBe('open');

    const cancelled = JSON.parse(runCli(['cancel', '--id', created.id, '--human', 'dan'], { cwd: root })) as { status: string };
    expect(cancelled.status).toBe('cancelled');
  });

  it('release requires --token, not --human', () => {
    const root = makeProjectRoot();
    const created = JSON.parse(
      runCli(['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };
    const claimed = JSON.parse(runCli(['claim', '--id', created.id, '--human', 'dan'], { cwd: root })) as {
      claim: { claim_token: number };
    };
    const released = JSON.parse(
      runCli(['release', '--id', created.id, '--token', String(claimed.claim.claim_token), '--note', 'handoff'], { cwd: root }),
    ) as { status: string };
    expect(released.status).toBe('open');
  });
});

describe('events --json', () => {
  it('lists the immutable event trail as JSON, oldest first', () => {
    const root = makeProjectRoot();
    const created = JSON.parse(
      runCli(['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };
    runCli(['claim', '--id', created.id, '--human', 'dan'], { cwd: root });

    const events = JSON.parse(runCli(['events', '--id', created.id, '--json'], { cwd: root })) as Array<{ transition: string }>;
    expect(events.map((e) => e.transition)).toEqual(['create', 'claim']);
  });
});

describe('sweep — CLI-only, hook path (always exit 0, silent stdout)', () => {
  it('exits 0 with empty stdout on a fresh board with nothing to sweep', () => {
    const root = makeProjectRoot();
    const result = runCliRaw(['sweep'], { cwd: root });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('is not part of the eleven-verb MCP surface (usage names it as CLI-ONLY)', () => {
    const result = runCliRaw(['--help'], { cwd: makeProjectRoot() });
    expect(result.stdout).toContain('CLI-ONLY');
  });
});
