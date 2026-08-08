// plugin/src/cli/unresolved-id-parity.test.ts — the cross-transport guard for
// the id-lint's unresolved-reference report.
//
// WHAT WENT WRONG. The check that surfaces unresolved reference ids was itself
// added as a correction (01KYV387QKRP3V330WAS6DX95K). The fix landed on ONE
// door: the MCP adapter passes the reporting callback at `work_create`,
// `work_update_meta` and `work_release` and returns the ids to its caller,
// while cli/ideate-work.ts passed it at none of the three, so the report was
// computed and thrown away.
//
// SCOPE, corrected while writing this guard. The item that raised this
// described the gap as "a `--supersedes` pointing at an id that doesn't exist
// is accepted with no warning". That is not what happens: a dangling TYPED
// EDGE is rejected outright by dag.ts's guard, exit 1, on BOTH doors. The lint
// this callback reports is a different and softer thing — ULID-shaped tokens
// in FREE TEXT: `title` on create and update-meta, and an event `note` on
// release. (`spec` is deliberately excluded; see work-state/store.ts:20-32.)
// Free text is where a subagent quotes an id it read rather than one it holds,
// so it is the surface that actually needed the report.
//
// That is the same failure shape as the four transport defects behind
// docs/transport-contract.md — a change lands where the author was working and
// the sibling door is never visited — and the door that was skipped is the
// wrong one: a human in a session got the warning, and a subagent, which has
// no MCP tools and no other door, did not.
//
// WHY THE EXISTING GUARDS MISSED IT. record/transport-parity.test.ts proves a
// write through one door is visible to the other; it says nothing about the
// board and nothing about two doors exposing the same BEHAVIOUR for the same
// call. A flag census would miss it too: the divergence is in a RETURN VALUE,
// not a missing flag. So this test compares observable behaviour on both
// doors, and drives the real executable for the CLI half.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const WORK_BIN = join(PLUGIN_DIR, 'bin', 'ideate-work');

/** A ULID that is well-formed but names no item — the mistyped-id case. */
const DANGLING_ID = '01KZZZZZZZZZZZZZZZZZZZZZZZ';

const tempDirs: string[] = [];
afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
}, 180_000);

function makeProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-unresolved-parity-')));
  tempDirs.push(root);
  writeFileSync(
    join(root, '.ideate.json'),
    `${JSON.stringify(
      { schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' },
      null,
      2,
    )}\n`,
  );
  return root;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Drive the REAL bin, keeping all three observable channels: a warning that
 *  reaches neither stderr nor the exit code is the defect under test, so the
 *  test must be able to see all of them. */
function runWorkCapturing(root: string, args: readonly string[]): Run {
  const r = spawnSync(process.execPath, [WORK_BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function createItem(root: string, title: string, extra: readonly string[] = []): Run {
  return runWorkCapturing(root, [
    'create',
    '--title', title,
    '--spec', 'Body.',
    '--spec-format', 'plan/outline',
    '--human', 'test',
    ...extra,
  ]);
}

describe('the command-line door reports unresolved reference ids (P-40 sibling-surface parity)', () => {
  it('a dangling id quoted in a title warns visibly instead of being swallowed', () => {
    const root = makeProject();
    const run = createItem(root, `follow-up to ${DANGLING_ID}`);

    expect(run.stderr).toContain(DANGLING_ID);
    expect(run.stderr).toMatch(/id-lint/);
    // The item is still created: this is a WARNING, not a rejection.
    expect(JSON.parse(run.stdout).id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('the warning is advisory — it does NOT change the exit code', () => {
    // The session door treats these as advisory and returns them alongside a
    // successful result. Making the command-line door fatal would be a NEW
    // divergence in the opposite direction, which is the trap this whole
    // class of fix keeps falling into.
    const root = makeProject();
    const clean = createItem(root, 'no ids quoted at all');
    const warned = createItem(root, `follow-up to ${DANGLING_ID}`);
    expect(clean.status).toBe(0);
    expect(warned.status).toBe(0);
  });

  it('a resolvable id produces no warning at all — the check does not cry wolf', () => {
    const root = makeProject();
    const first = createItem(root, 'the item that will be referenced');
    const realId = JSON.parse(first.stdout).id as string;

    const second = createItem(root, `follow-up to ${realId}`);
    expect(second.stderr).not.toMatch(/id-lint/);
    expect(second.status).toBe(0);
  });

  it('update-meta reports it too, not just create', () => {
    const root = makeProject();
    const created = createItem(root, 'to be updated');
    const item = JSON.parse(created.stdout) as { id: string; version: number };

    const run = runWorkCapturing(root, [
      'update-meta',
      '--id', item.id,
      '--expected-version', String(item.version),
      '--title', `retitled, see ${DANGLING_ID}`,
    ]);
    expect(run.stderr).toContain(DANGLING_ID);
    expect(run.stderr).toMatch(/id-lint/);
    expect(run.status).toBe(0);
  });

  it('release reports it too — the third of the three call sites the MCP door covers', () => {
    const root = makeProject();
    const created = createItem(root, 'to be claimed and released');
    const id = JSON.parse(created.stdout).id as string;

    const claimed = runWorkCapturing(root, ['claim', '--id', id, '--human', 'test']);
    expect(claimed.status).toBe(0);
    const token = JSON.parse(claimed.stdout).claim.claim_token as number;

    // The note is free text: an id quoted inside it is exactly the case the
    // lint exists for — a subagent constructing an id from something it read.
    const run = runWorkCapturing(root, [
      'release',
      '--id', id,
      '--token', String(token),
      '--note', `superseded by ${DANGLING_ID}`,
    ]);
    expect(run.stderr).toContain(DANGLING_ID);
    expect(run.status).toBe(0);
  });

  it('the human-readable and JSON output paths both keep the warning off stdout', () => {
    // The tools separate the two audiences: stdout is the machine/human
    // RESULT, stderr is diagnostics. A warning leaking into stdout would
    // corrupt `--json` for every scripted consumer.
    const root = makeProject();
    const run = createItem(root, `json audience, quoting ${DANGLING_ID}`);
    expect(run.stdout).not.toMatch(/id-lint/);
    expect(() => JSON.parse(run.stdout)).not.toThrow();
  });
});
