// plugin/src/cli/ideate-work.test.ts — acceptance tests for the
// `ideate-work` CLI, the second transport over the work-state logic layer.
//
// Every test drives the REAL executable (bin/ideate-work) through
// child_process against a mkdtemp project root — the real `.ideate-work/`
// is never touched. Pins: --help/-h/no-args prints USAGE and exits 0;
// direct-use subcommands exit 1 on failure; renew/release/complete
// accept no actor flags at all (mirrors the engine's own signatures); --json
// on get/list/events; `list --json` emits the {items, next_cursor} summary
// envelope (no spec bodies unless --include-spec), pages by --limit/--cursor
// AND stays inside the same payload budget the MCP work_list tool enforces
// (this stdout is an agent-facing path — agents/journal-keeper.md runs it — so
// it lands under the same kind of per-tool-result cap), measured on the
// pretty-printed bytes actually written, with the oversized-single-item
// liveness rule intact; the human-readable listing stays exactly what it was; the
// CLI-only `sweep` subcommand always exits 0 with silent stdout.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LIST_PAYLOAD_BUDGET_CHARS } from '../transport/payload-budget.js';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '../work-state/store.js';

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

describe('--help / -h / no-args (general usage edge)', () => {
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

  it('create --supersedes authors the forward edge; the superseded item shows the derived backlink on get', () => {
    const root = makeProjectRoot();
    const old = JSON.parse(
      runCli(['create', '--title', 'the old plan', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };
    const replacement = JSON.parse(
      runCli(
        ['create', '--title', 'the new plan', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan', '--supersedes', old.id],
        { cwd: root },
      ),
    ) as { id: string; references: { rel: string; id: string }[] };
    expect(replacement.references).toEqual([{ rel: 'supersedes', id: old.id }]);

    const gotOld = JSON.parse(runCli(['get', '--id', old.id, '--json'], { cwd: root })) as {
      references: unknown[];
      referenced_by: { rel: string; id: string }[];
    };
    expect(gotOld.referenced_by).toEqual([{ rel: 'supersedes', id: replacement.id }]);
    // Only the forward edge is stored.
    expect(gotOld.references).toEqual([]);
  });

  it('create --supersedes with a malformed or dangling id exits 1 with a typed engine error', () => {
    const root = makeProjectRoot();
    // A malformed id never resolves to an existing item, so the verb-layer
    // existence guard (dag.ts) rejects it before the store's ULID
    // chokepoint is ever reached — a typed, loud failure either way.
    const malformed = runCliRaw(
      ['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan', '--supersedes', 'not-a-ulid'],
      { cwd: root },
    );
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('DANGLING_SUPERSEDES');

    const dangling = runCliRaw(
      ['create', '--title', 'x', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan', '--supersedes', '01JZM8Z0000000000000000000'],
      { cwd: root },
    );
    expect(dangling.status).toBe(1);
    expect(dangling.stderr).toContain('DANGLING_SUPERSEDES');
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

  it('update-meta --supersedes sets and retargets the forward edge (wholesale replace)', () => {
    const root = makeProjectRoot();
    const targetA = JSON.parse(
      runCli(['create', '--title', 'target a', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };
    const targetB = JSON.parse(
      runCli(['create', '--title', 'target b', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string };
    const item = JSON.parse(
      runCli(['create', '--title', 'the plan', '--spec', 's', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root }),
    ) as { id: string; version: number };

    // Set the edge to targetA via update-meta --supersedes.
    runCli(['update-meta', '--id', item.id, '--expected-version', String(item.version), '--supersedes', targetA.id], { cwd: root });
    const afterSet = JSON.parse(runCli(['get', '--id', item.id, '--json'], { cwd: root })) as {
      references: { rel: string; id: string }[];
      version: number;
    };
    expect(afterSet.references).toEqual([{ rel: 'supersedes', id: targetA.id }]);

    // Retarget to targetB — wholesale replace, not append.
    runCli(['update-meta', '--id', item.id, '--expected-version', String(afterSet.version), '--supersedes', targetB.id], { cwd: root });
    const afterMove = JSON.parse(runCli(['get', '--id', item.id, '--json'], { cwd: root })) as {
      references: { rel: string; id: string }[];
    };
    expect(afterMove.references).toEqual([{ rel: 'supersedes', id: targetB.id }]);

    // targetB carries the derived backlink.
    const gotB = JSON.parse(runCli(['get', '--id', targetB.id, '--json'], { cwd: root })) as {
      referenced_by: { rel: string; id: string }[];
    };
    expect(gotB.referenced_by).toEqual([{ rel: 'supersedes', id: item.id }]);
  });
});

describe('list --json: summary rows, --include-spec, and keyset paging', () => {
  interface ListedSummary {
    id: string;
    title: string;
    status: string;
    claimable: boolean;
    spec_length: number;
    spec?: string;
  }
  interface ListEnvelope {
    items: ListedSummary[];
    next_cursor: string | null;
  }

  /** Walk `list --json` to exhaustion, returning every page's raw stdout
   *  alongside the parsed envelope. Following next_cursor to null is the ONLY
   *  honest way to read the whole board through this door: a --json page is
   *  bounded by the payload budget as well as by --limit, so even a board far
   *  under MAX_LIST_LIMIT can span several pages. */
  function walkJson(root: string, args: readonly string[]): { pages: ListEnvelope[]; stdouts: string[] } {
    const pages: ListEnvelope[] = [];
    const stdouts: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const stdout = runCli(['list', '--json', ...args, ...(cursor === null ? [] : ['--cursor', cursor])], { cwd: root });
      const page = JSON.parse(stdout) as ListEnvelope;
      pages.push(page);
      stdouts.push(stdout);
      cursor = page.next_cursor;
      if (cursor === null) return { pages, stdouts };
    }
  }

  /**
   * Create `count` items through the real bin, then return the ids in the
   * board's ACTUAL stored order (newest-created first).
   *
   * The order is read BACK rather than derived from insertion order on
   * purpose: the board stamps `created_at` in milliseconds, and two spawned
   * processes can easily land in the same millisecond — at which point the
   * order is decided by the `id DESC` tie-break, i.e. by ULID randomness, not
   * by the sequence these were created in. Deriving the expectation from
   * insertion order would make every assertion below a coin flip on a fast
   * machine. The read-back WALKS pages (see walkJson): the payload budget can
   * close a --json page before MAX_LIST_LIMIT rows are reached.
   */
  function seedBoard(root: string, count: number, spec: string): string[] {
    expect(count).toBeLessThanOrEqual(MAX_LIST_LIMIT);
    for (let i = 0; i < count; i += 1) {
      runCli(['create', '--title', `item ${String(i)}`, '--spec', spec, '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root });
    }
    const ids = walkJson(root, ['--limit', String(MAX_LIST_LIMIT)]).pages.flatMap((page) => page.items.map((item) => item.id));
    expect(ids).toHaveLength(count);
    return ids;
  }

  it('an empty board: `list --json` returns {items: [], next_cursor: null} — a non-null cursor here would spin every documented walk loop forever', () => {
    const root = makeProjectRoot();
    const page = JSON.parse(runCli(['list', '--json'], { cwd: root })) as ListEnvelope;
    expect(page).toEqual({ items: [], next_cursor: null });
  });

  it('--json emits {items, next_cursor} with no spec key and a correct spec_length; --include-spec puts the spec back', () => {
    const root = makeProjectRoot();
    const spec = 'x'.repeat(4096);
    seedBoard(root, 2, spec);

    const listed = JSON.parse(runCli(['list', '--json'], { cwd: root })) as ListEnvelope;
    expect(listed.items).toHaveLength(2);
    expect(listed.next_cursor).toBeNull();
    for (const item of listed.items) {
      expect(Object.keys(item)).not.toContain('spec');
      expect(item.spec_length).toBe(spec.length);
    }

    const withSpec = JSON.parse(runCli(['list', '--json', '--include-spec'], { cwd: root })) as ListEnvelope;
    for (const item of withSpec.items) {
      expect(item.spec).toBe(spec);
      expect(item.spec_length).toBe(spec.length);
    }
  });

  it('--limit/--cursor round-trip: two pages cover every id exactly once, newest-first', () => {
    const root = makeProjectRoot();
    const newestFirst = seedBoard(root, 4, 'spec body');

    const first = JSON.parse(runCli(['list', '--json', '--limit', '2'], { cwd: root })) as ListEnvelope;
    expect(first.items.map((i) => i.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.next_cursor).toBeTypeOf('string');

    const second = JSON.parse(runCli(['list', '--json', '--limit', '2', '--cursor', first.next_cursor as string], { cwd: root })) as ListEnvelope;
    expect(second.items.map((i) => i.id)).toEqual(newestFirst.slice(2));
    expect(second.next_cursor).toBeNull();
  });

  it('a malformed --cursor exits 1 with the typed SCHEMA error — never an empty page', () => {
    const root = makeProjectRoot();
    seedBoard(root, 1, 'spec body');
    const result = runCliRaw(['list', '--json', '--cursor', 'not-a-cursor!!'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('SCHEMA');
    expect(result.stderr).toContain('cursor');
    expect(result.stdout).toBe('');
  });

  it('the human-readable listing is unchanged: one line per item, whole board, no envelope', () => {
    const root = makeProjectRoot();
    const newestFirst = seedBoard(root, 3, 'spec body');
    const lines = runCli(['list'], { cwd: root }).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.split(' ')[0])).toEqual(newestFirst);
    for (const line of lines) expect(line).toMatch(/^\S+ \[open\] claimable item \d$/);

    // …and it only pages when the operator explicitly asks.
    const paged = runCli(['list', '--limit', '2'], { cwd: root }).trimEnd().split('\n');
    expect(paged).toHaveLength(3); // two items + the resume hint
    expect(paged[2]).toContain('--cursor ');
  });

  it('--json pages are bounded by BOTH the count default and the payload budget, and the walk covers every id exactly once', () => {
    const root = makeProjectRoot();
    // MORE items than the default page size, deliberately: on a smaller board
    // neither bound is observable, so such a fixture would stay green even
    // with the transport's paging deleted.
    const newestFirst = seedBoard(root, DEFAULT_LIST_LIMIT + 3, 'spec body');

    const firstStdout = runCli(['list', '--json'], { cwd: root });
    const first = JSON.parse(firstStdout) as ListEnvelope;
    // The count default is the OUTER bound here. A pretty-printed summary row
    // runs ~500 characters, so ~80 of them already fill the payload budget —
    // on realistic rows the budget is what actually closes a --json page. The
    // exact count default is pinned on the (unbudgeted) human path below.
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThanOrEqual(DEFAULT_LIST_LIMIT);
    expect(firstStdout.length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    expect(first.next_cursor).toBeTypeOf('string');
    expect(first.items.map((i) => i.id)).toEqual(newestFirst.slice(0, first.items.length));

    const { pages, stdouts } = walkJson(root, []);
    for (const stdout of stdouts) expect(stdout.length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    const walked = pages.flatMap((page) => page.items.map((i) => i.id));
    expect(walked).toEqual(newestFirst);
    expect(new Set(walked).size).toBe(newestFirst.length);
    expect(pages[pages.length - 1]?.next_cursor).toBeNull();
  });

  it('--json is BUDGETED exactly like the MCP tool: fat rows close a page early, under --limit, with a cursor — and the emitted stdout stays inside the budget', () => {
    const root = makeProjectRoot();
    // --include-spec is the flag that reaches the budget fastest: 20 x 5k
    // specs pretty-print to >100k characters, larger than the 66k `list
    // --json` payload measured on a real board — the failure this budget
    // exists to prevent, on the transport an AGENT reads (see
    // agents/journal-keeper.md, which runs exactly this command).
    const newestFirst = seedBoard(root, 20, 'x'.repeat(5_000));

    const stdout = runCli(['list', '--json', '--limit', '20', '--include-spec'], { cwd: root });
    const page = JSON.parse(stdout) as ListEnvelope;
    expect(page.items.length).toBeGreaterThan(1);
    expect(page.items.length).toBeLessThan(20); // the BUDGET closed this page, not --limit
    // The bound holds on what was actually WRITTEN — the pretty-printed
    // bytes, not a compact form this stream never emits.
    expect(stdout.length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    // …and the caller is told to come back, even though --limit was not reached.
    expect(page.next_cursor).toBeTypeOf('string');

    // A budget-closed sequence still walks the whole board exactly once.
    const { pages, stdouts } = walkJson(root, ['--limit', '20', '--include-spec']);
    for (const each of stdouts) expect(each.length).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
    const walked = pages.flatMap((p) => p.items.map((i) => i.id));
    expect(walked).toEqual(newestFirst);
    expect(new Set(walked).size).toBe(newestFirst.length);
    expect(pages.every((p) => p.items.length < 20)).toBe(true);
  });

  it('LIVENESS on the CLI path: an item larger than the whole budget is emitted ALONE with a cursor — never an empty page that stalls the walk', () => {
    const root = makeProjectRoot();
    const oversizedSpec = 'x'.repeat(LIST_PAYLOAD_BUDGET_CHARS * 2);
    runCli(['create', '--title', 'huge', '--spec', oversizedSpec, '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root });
    runCli(['create', '--title', 'small', '--spec', 'tiny', '--spec-format', 'text/plain', '--human', 'dan'], { cwd: root });
    // Which of the two sorts first is decided by the ULID tie-break when both
    // land in the same millisecond, so the walk — not a fixed order — is what
    // is asserted.
    const both = walkJson(root, []).pages.flatMap((p) => p.items.map((i) => i.id));
    expect(both).toHaveLength(2);

    const { pages, stdouts } = walkJson(root, ['--limit', '10', '--include-spec']);
    // Two pages of ONE item each: the oversized row cannot share a page, and
    // it is still SENT — dropping it would leave the caller looping on an
    // empty page forever.
    expect(pages.map((p) => p.items.length)).toEqual([1, 1]);
    expect(pages.flatMap((p) => p.items.map((i) => i.id)).sort()).toEqual([...both].sort());
    expect(pages[0]?.next_cursor).toBeTypeOf('string');
    expect(pages[1]?.next_cursor).toBeNull();

    // The oversized row went out whole — over the budget, alone, by design.
    const huge = pages.flatMap((p) => p.items).find((i) => i.title === 'huge');
    expect(huge?.spec).toBe(oversizedSpec);
    const hugeStdout = stdouts.find((s) => s.includes('"huge"')) ?? '';
    expect(hugeStdout.length).toBeGreaterThan(LIST_PAYLOAD_BUDGET_CHARS);
  });

  it('--cursor implies the default page size on the human path too: a resumed listing is a PAGE with an honest resume hint', () => {
    const root = makeProjectRoot();
    const newestFirst = seedBoard(root, DEFAULT_LIST_LIMIT + 3, 'spec body');

    // One explicit page, then resume with NO --limit at all. Without the
    // cursor-implies-a-limit rule this second call would emit no LIMIT clause,
    // dump every remaining row and then claim `next_cursor: null` — a page
    // that is not a page, reporting an exhaustion it never checked.
    const firstLines = runCli(['list', '--limit', '1'], { cwd: root }).trimEnd().split('\n');
    expect(firstLines).toHaveLength(2); // one item + the resume hint
    const cursor = firstLines[1]?.replace(/^.*--cursor /, '').replace(/\)$/, '') ?? '';
    expect(cursor).not.toBe('');

    const resumed = runCli(['list', '--cursor', cursor], { cwd: root }).trimEnd().split('\n');
    expect(resumed).toHaveLength(DEFAULT_LIST_LIMIT + 1); // a full default page + the resume hint
    expect(resumed[resumed.length - 1]).toContain('--cursor ');
    expect(resumed.slice(0, DEFAULT_LIST_LIMIT).map((l) => l.split(' ')[0])).toEqual(
      newestFirst.slice(1, DEFAULT_LIST_LIMIT + 1),
    );
  });

  it('--include-spec is --json-only: the human path rejects it instead of reading spec bodies it would never print', () => {
    const root = makeProjectRoot();
    seedBoard(root, 1, 'spec body');
    const result = runCliRaw(['list', '--include-spec'], { cwd: root });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--include-spec requires --json');
    expect(result.stdout).toBe('');
  });

  it('--limit 1.5 is rejected by the CLI arg parser — the rejection this transport actually ships (P-50)', () => {
    const root = makeProjectRoot();
    seedBoard(root, 1, 'spec body');
    const result = runCliRaw(['list', '--json', '--limit', '1.5'], { cwd: root });
    expect(result.status).toBe(1);
    // The CLI parses its own flag, so the store's clampListLimit non-integer
    // guard is unreachable from here and its wording is NOT what an operator
    // sees; pinning that message instead would test a path this transport
    // cannot take.
    expect(result.stderr).toContain('--limit must be an integer');
    expect(result.stdout).toBe('');
  });

  it('usage text states the summary default, --include-spec, and the paging flags (P-52)', () => {
    const result = runCliRaw(['--help'], { cwd: makeProjectRoot() });
    expect(result.status).toBe(0);
    for (const phrase of [
      '--include-spec',
      '--limit',
      '--cursor',
      'spec_length',
      'next_cursor',
      'opaque',
      'invalidated',
      'requires --json',
      'implies the default',
      'payload budget',
      // …and the budget's consequence for a caller: a page may be SHORTER
      // than --limit, so exhaustion is next_cursor's business, not the page
      // size's (P-52 — the text must not contradict the shipped behavior).
      'SHORTER',
      String(LIST_PAYLOAD_BUDGET_CHARS),
      'follow next_cursor',
    ]) {
      expect(result.stdout).toContain(phrase);
    }
    // The old asymmetry ("the MCP tool budgets, this stream does not") is gone
    // — both transports enforce the same budget now.
    expect(result.stdout).not.toContain('this stdout stream does not have');
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
