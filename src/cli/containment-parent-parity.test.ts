// plugin/src/cli/containment-parent-parity.test.ts — the guard for the
// CONTAINMENT parent reaching the command-line door.
//
// WHAT WAS MISSING. The board has two kinds of edge: what an item DEPENDS ON,
// and what it is CONTAINED BY. The command-line tools supported the first and
// not the second — `parent_id` appeared zero times in cli/ideate-work.ts,
// while the MCP surface accepted it on both work_create and work_update_meta
// with real care taken over the semantics.
//
// WHY THAT MATTERED MORE THAN IT LOOKED. Every subagent is granted
// `Read, Grep, Glob, Bash` and no MCP tools at all, and an MCP connection
// belongs to the session rather than being inherited by a spawned subagent.
// So the CLI is not one of two options for a subagent; it is the only door it
// has. The decomposer agent exists specifically to break a goal into a TREE of
// work items with containment edges, and could not create a containment edge
// itself — the invoking skill compensated from the session side, which worked
// but meant the gap was papered over by convention rather than being visible.
//
// THE TRI-STATE IS THE WHOLE DIFFICULTY. The store distinguishes key-absent
// ("leave the parent alone"), a string ("set or move"), and key-present-null
// ("clear to root"). A CLI has no null, so the three map onto: neither flag,
// `--parent <id>`, and `--clear-parent`. Collapsing the last two — the
// obvious shortcut — would make "move to root" unreachable and silently turn
// it into "leave unchanged", which is why each case is pinned separately here
// against the REAL binary.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const WORK_BIN = join(PLUGIN_DIR, 'bin', 'ideate-work');

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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-containment-')));
  tempDirs.push(root);
  writeFileSync(
    join(root, '.ideate.json'),
    `${JSON.stringify({ schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' }, null, 2)}\n`,
  );
  return root;
}

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function work(root: string, args: readonly string[]): Run {
  const r = spawnSync(process.execPath, [WORK_BIN, ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

interface Item {
  id: string;
  version: number;
  parent_id: string | null;
}

function create(root: string, title: string, extra: readonly string[] = []): Item {
  const run = work(root, ['create', '--title', title, '--spec', 'Body.', '--spec-format', 'plan/outline', '--human', 'test', ...extra]);
  if (run.status !== 0) throw new Error(`create failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as Item;
}

function get(root: string, id: string): Item {
  const run = work(root, ['get', '--id', id, '--json']);
  return JSON.parse(run.stdout) as Item;
}

describe('create --parent: the containment edge is reachable from the command line', () => {
  it('creates a child under an existing parent', () => {
    const root = makeProject();
    const parent = create(root, 'the parent');
    const child = create(root, 'the child', ['--parent', parent.id]);
    expect(child.parent_id).toBe(parent.id);
    expect(get(root, child.id).parent_id).toBe(parent.id);
  });

  it('creates a root item when --parent is omitted', () => {
    const root = makeProject();
    expect(create(root, 'a root item').parent_id).toBeNull();
  });

  it('rejects a parent id that names no item, rather than silently rooting the child', () => {
    const root = makeProject();
    const run = work(root, [
      'create', '--title', 'orphan', '--spec', 'B.', '--spec-format', 'plan/outline', '--human', 't',
      '--parent', '01KZZZZZZZZZZZZZZZZZZZZZZZ',
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/create failed/);
  });

  it('builds a multi-level tree — what the decomposer actually needs', () => {
    const root = makeProject();
    const epic = create(root, 'epic');
    const feature = create(root, 'feature', ['--parent', epic.id]);
    const task = create(root, 'task', ['--parent', feature.id]);
    expect(get(root, feature.id).parent_id).toBe(epic.id);
    expect(get(root, task.id).parent_id).toBe(feature.id);

    // The roots-only view must show the epic alone.
    const listed = JSON.parse(work(root, ['list', '--json']).stdout) as { items: Item[] };
    expect(listed.items.filter((i) => i.parent_id === null).map((i) => i.id)).toEqual([epic.id]);
  });
});

describe('update-meta: the parent is TRI-STATE, and each state is distinct', () => {
  it('ABSENT leaves the existing parent untouched', () => {
    // The case a collapsed two-state implementation gets wrong in the other
    // direction: editing a title must not silently reparent the item.
    const root = makeProject();
    const parent = create(root, 'parent');
    const child = create(root, 'child', ['--parent', parent.id]);

    const run = work(root, ['update-meta', '--id', child.id, '--expected-version', String(child.version), '--title', 'renamed']);
    expect(run.status).toBe(0);
    expect(get(root, child.id).parent_id).toBe(parent.id);
  });

  it('--parent <id> MOVES the item to a different parent', () => {
    const root = makeProject();
    const first = create(root, 'first parent');
    const second = create(root, 'second parent');
    const child = create(root, 'child', ['--parent', first.id]);

    const run = work(root, ['update-meta', '--id', child.id, '--expected-version', String(child.version), '--parent', second.id]);
    expect(run.status).toBe(0);
    expect(get(root, child.id).parent_id).toBe(second.id);
  });

  it('--clear-parent makes the item a root again', () => {
    // Unreachable if the tri-state were collapsed. This is the case whose
    // absence would be silent: without it, "move to root" degrades into
    // "leave unchanged" and nothing reports anything.
    const root = makeProject();
    const parent = create(root, 'parent');
    const child = create(root, 'child', ['--parent', parent.id]);
    expect(child.parent_id).toBe(parent.id);

    const run = work(root, ['update-meta', '--id', child.id, '--expected-version', String(child.version), '--clear-parent']);
    expect(run.status).toBe(0);
    expect(get(root, child.id).parent_id).toBeNull();
  });

  it('refuses --parent and --clear-parent together rather than picking one', () => {
    const root = makeProject();
    const parent = create(root, 'parent');
    const child = create(root, 'child');
    const run = work(root, [
      'update-meta', '--id', child.id, '--expected-version', String(child.version),
      '--parent', parent.id, '--clear-parent',
    ]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/mutually exclusive/);
    expect(get(root, child.id).parent_id).toBeNull(); // unchanged
  });

  it('refuses to make an item its own ancestor', () => {
    const root = makeProject();
    const parent = create(root, 'parent');
    const child = create(root, 'child', ['--parent', parent.id]);
    const run = work(root, ['update-meta', '--id', parent.id, '--expected-version', String(parent.version), '--parent', child.id]);
    expect(run.status).toBe(1);
    expect(get(root, parent.id).parent_id).toBeNull();
  });
});

describe('the usage text agrees with what the tool does', () => {
  it('documents both flags on the subcommands that accept them', () => {
    const usage = work(makeProject(), []).stdout;
    expect(usage).toContain('--parent <id>');
    expect(usage).toContain('--clear-parent');
    expect(usage).toMatch(/TRI-STATE/);
  });
});
