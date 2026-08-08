// plugin/src/config/project-root.test.ts — the guard for upward project-root
// discovery.
//
// THE DEFECT THIS PINS. `loadConfig` lazily creates a project wherever it is
// pointed, and every cwd-defaulted caller pointed it at `process.cwd()`. Any
// invocation from a subdirectory therefore onboarded a brand-new empty store
// right there and wrote its whole invocation into it, reporting success.
// Twenty-one such phantom stores accumulated across six projects under
// ~/code, holding roughly 2,470 stranded records — the largest, ~2,392
// records spanning two months, under this repository's own `plugin/`, because
// `cd plugin` is where its build and tests are run from.
//
// TWO LAYERS, DELIBERATELY. The unit tests below certify the WALK (where it
// stops, what overrides it). The behavioral tests drive the REAL `bin/`
// executables as child processes — the same discipline as
// record/transport-parity.test.ts — because the walk being correct in
// isolation is not the claim; the claim is that the shipped binaries, which
// are the only door a subagent has, attach to the enclosing project. A unit
// test alone would have passed while both binaries still seeded phantoms.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CONFIG_FILENAME,
  PROJECT_ROOT_ENV,
  V3_SCHEMA_VERSION,
  DEFAULT_RECORD_PATH,
  findProjectRoot,
  resolveProjectRoot,
} from './ideate-config.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const RECORD_BIN = join(PLUGIN_DIR, 'bin', 'ideate-record');
const WORK_BIN = join(PLUGIN_DIR, 'bin', 'ideate-work');

const tempDirs: string[] = [];

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  // The bins run compiled output; build UNCONDITIONALLY (P-50: the verified
  // path must BE the shipped path), mirroring transport-parity.test.ts.
  execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
}, 180_000);

/**
 * A project root with a real `.ideate.json` and a nested subdirectory.
 * `realpathSync` because macOS's tmpdir is a symlink (`/var` →
 * `/private/var`) and a child process reports the RESOLVED cwd — comparing
 * an unresolved fixture path against a resolved result fails for the wrong
 * reason.
 */
function makeProject(): { root: string; nested: string; deeplyNested: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-project-root-')));
  tempDirs.push(root);
  writeFileSync(
    join(root, CONFIG_FILENAME),
    `${JSON.stringify(
      { schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' },
      null,
      2,
    )}\n`,
  );
  const nested = join(root, 'plugin');
  const deeplyNested = join(nested, 'src', 'cli');
  mkdirSync(deeplyNested, { recursive: true });
  return { root, nested, deeplyNested };
}

// ---------------------------------------------------------------------------
// The walk itself
// ---------------------------------------------------------------------------

describe('findProjectRoot — the upward walk', () => {
  it('returns the start directory when it is itself the project root', () => {
    const { root } = makeProject();
    expect(findProjectRoot(root, {})).toEqual({ root, origin: 'enclosing', startedFrom: root });
  });

  it('finds the enclosing project from one level down', () => {
    const { root, nested } = makeProject();
    expect(findProjectRoot(nested, {})).toEqual({ root, origin: 'enclosing', startedFrom: nested });
  });

  it('finds the enclosing project from several levels down', () => {
    const { root, deeplyNested } = makeProject();
    const result = findProjectRoot(deeplyNested, {});
    expect(result.root).toBe(root);
    expect(result.origin).toBe('enclosing');
  });

  it('stops at the NEAREST enclosing project when projects nest', () => {
    // A phantom store inside a real one is not hypothetical: two of the
    // twenty-one found were inside the real store's own directory tree
    // (`.ideate-record/.ideate.json`). Nearest-wins is what lets a
    // deliberately nested project (a vendored checkout) still work.
    const { root, nested, deeplyNested } = makeProject();
    writeFileSync(join(nested, CONFIG_FILENAME), '{"schema_version":10,"record":{"path":".ideate/record/"},"backend":"local"}\n');
    expect(findProjectRoot(deeplyNested, {}).root).toBe(nested);
    expect(findProjectRoot(root, {}).root).toBe(root);
  });

  it('reports onboarding — not a found project — when no enclosing config exists', () => {
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-orphan-')));
    tempDirs.push(orphan);
    const result = findProjectRoot(orphan, {});
    expect(result.origin).toBe('onboarding');
    expect(result.root).toBe(orphan);
  });

  it('creates NOTHING while resolving — the walk is side-effect-free', () => {
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-orphan-pure-')));
    tempDirs.push(orphan);
    findProjectRoot(orphan, {});
    expect(existsSync(join(orphan, CONFIG_FILENAME))).toBe(false);
  });

  it(`honors ${PROJECT_ROOT_ENV} and performs no walk at all`, () => {
    const { root, deeplyNested } = makeProject();
    const result = findProjectRoot(deeplyNested, { [PROJECT_ROOT_ENV]: root });
    expect(result).toEqual({ root, origin: 'env', startedFrom: root });
  });

  it(`ignores a blank ${PROJECT_ROOT_ENV} rather than resolving it to the process cwd`, () => {
    // `path.resolve('')` is `process.cwd()`. An empty or whitespace env var
    // must fall through to the walk, not silently redirect every write to
    // wherever the process happens to be standing.
    const { root, nested } = makeProject();
    expect(findProjectRoot(nested, { [PROJECT_ROOT_ENV]: '   ' }).root).toBe(root);
    expect(findProjectRoot(nested, { [PROJECT_ROOT_ENV]: '' }).root).toBe(root);
  });

  it('never accepts $HOME itself as a project root, even when $HOME/.ideate.json exists', () => {
    // NOT a hypothetical: `$HOME/.ideate.json` existed on the machine this
    // defect was found on, holding 24 records — itself one of the phantom
    // stores this walk exists to stop creating. If the walk accepted it,
    // every directory under the user's home that is not inside a real
    // project would silently attach to one catch-all store, which is a
    // worse defect than the one being fixed.
    //
    // Uses a temp directory under the REAL $HOME so the bound is exercised
    // rather than simulated, and asserts on origin rather than on whether
    // that config happens to exist — the guarantee must hold either way.
    const home = realpathSync(homedir());
    const inHome = realpathSync(mkdtempSync(join(home, '.ideate-project-root-test-')));
    tempDirs.push(inHome);
    const deep = join(inHome, 'a', 'b');
    mkdirSync(deep, { recursive: true });

    const result = findProjectRoot(deep, {});
    expect(result.origin).toBe('onboarding');
    expect(result.root).toBe(deep);
    expect(result.root).not.toBe(home);
  });

  it('still finds a real project that lives directly under $HOME', () => {
    // The exclusion is $HOME itself, not "anything near $HOME". A project
    // at ~/code/thing must still be found from ~/code/thing/sub.
    const home = realpathSync(homedir());
    const container = realpathSync(mkdtempSync(join(home, '.ideate-project-root-test-')));
    tempDirs.push(container);
    const projectRoot = join(container, 'thing');
    const sub = join(projectRoot, 'sub', 'deeper');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(projectRoot, CONFIG_FILENAME), '{"schema_version":10,"record":{"path":".ideate/record/"},"backend":"local"}\n');

    const result = findProjectRoot(sub, {});
    expect(result.origin).toBe('enclosing');
    expect(result.root).toBe(projectRoot);
  });
});

describe('resolveProjectRoot — the loud-onboarding notice (P-45)', () => {
  it('says so on the warn channel when it is about to onboard a new project', () => {
    const orphan = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-orphan-warn-')));
    tempDirs.push(orphan);
    const warnings: string[] = [];
    const root = resolveProjectRoot(orphan, { env: {}, warn: (m) => warnings.push(m) });
    expect(root).toBe(orphan);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(orphan);
    expect(warnings[0]).toContain(PROJECT_ROOT_ENV);
  });

  it('stays silent when an enclosing project was found', () => {
    const { root, nested } = makeProject();
    const warnings: string[] = [];
    expect(resolveProjectRoot(nested, { env: {}, warn: (m) => warnings.push(m) })).toBe(root);
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shipped binaries — the door a subagent actually has
// ---------------------------------------------------------------------------

/** Run a bin from `cwd`, returning stdout. */
function run(bin: string, args: readonly string[], cwd: string): string {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    // Inherit nothing that could name a root: the walk is what's under test.
    env: { ...process.env, [PROJECT_ROOT_ENV]: '' },
  });
}

describe('the real executables, run from a subdirectory (the reported defect)', () => {
  it('ideate-record attaches to the enclosing project and seeds no store beside it', () => {
    const { root, deeplyNested } = makeProject();

    const id = run(
      RECORD_BIN,
      ['append', '--kind', 'finding', '--claim', 'written from a subdirectory', '--anchor', 'a.ts', '--content', 'Body.'],
      deeplyNested,
    ).trim();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The write landed in the PROJECT's store...
    const fromRoot = JSON.parse(run(RECORD_BIN, ['read', '--json'], root)) as { records: { id: string }[] };
    expect(fromRoot.records.map((r) => r.id)).toContain(id);

    // ...and the subdirectory gained no config and no store of its own.
    expect(existsSync(join(deeplyNested, CONFIG_FILENAME))).toBe(false);
    expect(existsSync(join(deeplyNested, '.ideate'))).toBe(false);

    // Reading from the subdirectory sees the project's records, not an
    // empty phantom — the symptom a caller would actually notice.
    const fromNested = JSON.parse(run(RECORD_BIN, ['read', '--json'], deeplyNested)) as { records: { id: string }[] };
    expect(fromNested.records.map((r) => r.id)).toContain(id);
  });

  it('ideate-work attaches to the enclosing board and seeds no board beside it', () => {
    const { root, deeplyNested } = makeProject();

    const created = JSON.parse(
      run(
        WORK_BIN,
        [
          'create',
          '--title', 'created from a subdirectory',
          '--spec', 'Body.',
          '--spec-format', 'plan/outline',
          '--human', 'test',
        ],
        deeplyNested,
      ),
    ) as { id: string };
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const listed = JSON.parse(run(WORK_BIN, ['list', '--json'], root)) as { items: { id: string }[] };
    expect(listed.items.map((i) => i.id)).toContain(created.id);

    expect(existsSync(join(deeplyNested, CONFIG_FILENAME))).toBe(false);
    expect(existsSync(join(deeplyNested, '.ideate-work'))).toBe(false);
  });

  it('an explicit IDEATE_PROJECT_ROOT still targets a chosen directory', () => {
    // The migration tool and the isolated board-validation runs deliberately
    // target a directory that is NOT an enclosing project; the walk must not
    // take that ability away.
    const { deeplyNested } = makeProject();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ideate-explicit-target-')));
    tempDirs.push(elsewhere);

    const id = execFileSync(
      process.execPath,
      [RECORD_BIN, 'append', '--kind', 'finding', '--claim', 'explicitly targeted', '--anchor', 'a.ts', '--content', 'Body.'],
      { cwd: deeplyNested, encoding: 'utf8', env: { ...process.env, [PROJECT_ROOT_ENV]: elsewhere } },
    ).trim();

    const there = JSON.parse(
      execFileSync(process.execPath, [RECORD_BIN, 'read', '--json'], {
        cwd: deeplyNested,
        encoding: 'utf8',
        env: { ...process.env, [PROJECT_ROOT_ENV]: elsewhere },
      }),
    ) as { records: { id: string }[] };
    expect(there.records.map((r) => r.id)).toEqual([id]);
    expect(existsSync(join(elsewhere, CONFIG_FILENAME))).toBe(true);
  });
});
