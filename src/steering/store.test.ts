// plugin/src/steering/store.test.ts — acceptance tests for the LIGHT
// steering store core.
//
// Pins: round-trip serialization of policies + guiding principles through the
// on-disk Markdown/YAML form (including hostile content); create-or-amend with
// a growing amendment_history (mutable, NOT append-only — the key departure
// from the record store); scope-filtered SELECTION-only reads (domain / status
// / kind, no ranking); gate-before-persist with a PLANTED SECRET asserted
// masked in the raw on-disk bytes; typed no-throw failures;
// CROSS-item supersession — the forward `references` edge persisted on put,
// the DERIVED `referenced_by` backlink surfaced by readViews (never stored),
// the well-formed-id (SCHEMA) and dangling-target (DANGLING_SUPERSEDES) write
// guards, fan-in and chains, amend carry/replace/clear edge semantics, and the
// legacy pre-references file parsing as no-edges; and the
// two-verb / no-hard-delete API surface.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { encodeListCursor } from '../transport/keyset-page.js';
import { SteeringSchemaError, parseSteeringItem, serializeSteeringItem } from './schema.js';
import type { SteeringItem } from './schema.js';
import { MAX_STEERING_READ_LIMIT, SteeringStore, clampSteeringReadLimit, decodeSteeringCursor } from './store.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  store: SteeringStore;
  projectRoot: string;
  steeringDir: string;
  setNow: (iso: string) => void;
}

function makeFixture(): Fixture {
  const projectRoot = makeTempDir('ideate-steering-store-test-');
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const store = new SteeringStore(projectRoot, clock);
  return {
    store,
    projectRoot,
    steeringDir: store.steeringDir,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

describe('round-trip serialization', () => {
  it('parse(serialize(item)) is identity for a guiding principle, including hostile content', () => {
    const item: SteeringItem = {
      id: 'GP-23',
      kind: 'guiding-principle',
      domain: '',
      status: 'active',
      updated_at: FIXED_ISO,
      statement: 'contains: colons, "quotes", and\nan embedded newline\n---\nid: "fake"\n---\ntrailing',
      history: [],
      references: [],
    };
    expect(parseSteeringItem(serializeSteeringItem(item))).toEqual(item);
  });

  it('parse(serialize(item)) is identity for a policy carrying an amendment history and forward edges', () => {
    const item: SteeringItem = {
      id: 'POL-auth-1',
      kind: 'policy',
      domain: 'auth',
      status: 'superseded',
      updated_at: FIXED_ISO,
      statement: 'All tokens must rotate every 24h.',
      history: [
        { at: '2026-07-15T00:00:00.000Z', status: 'active', statement: 'All tokens must rotate every 72h.' },
        { at: '2026-07-14T00:00:00.000Z', status: 'active', statement: 'Tokens should rotate.' },
      ],
      references: [
        { rel: 'supersedes', id: 'POL-auth-0' },
        { rel: 'clarifies: with "quotes" and\na newline', id: 'GP-21' },
      ],
    };
    expect(parseSteeringItem(serializeSteeringItem(item))).toEqual(item);
  });

  it('a pre-references file (no `references` frontmatter line) parses as no-edges, never a throw', () => {
    // The legacy-file posture: steering has no schema-version mechanism, so a
    // file written before the forward-edge field existed simply lacks the line
    // — absence parses to `[]` (the same default `history` already had).
    const legacy = [
      '---',
      'id: "GP-9"',
      'kind: "guiding-principle"',
      'domain: ""',
      'status: "active"',
      `updated_at: "${FIXED_ISO}"`,
      'history: []',
      '---',
      '',
      'Legacy statement.',
      '',
    ].join('\n');
    const item = parseSteeringItem(legacy);
    expect(item.references).toEqual([]);
    expect(item.statement).toBe('Legacy statement.');
  });

  it('items round-trip identically through the store', () => {
    const { store } = makeFixture();
    const result = store.put({ id: 'GP-21', kind: 'guiding-principle', statement: 'Process only.', domain: 'scope' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [read] = store.read();
    expect(read).toEqual(result.item);
  });
});

describe('create-or-amend (mutable, NOT append-only)', () => {
  it('creates a fresh active item with empty history', () => {
    const { store } = makeFixture();
    const result = store.put({ id: 'POL-1', kind: 'policy', statement: 'v1', domain: 'auth' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amended).toBe(false);
    expect(result.item).toMatchObject({ id: 'POL-1', status: 'active', statement: 'v1', history: [] });
  });

  it('amends in place, pushing the prior version onto history newest-first, and flips status', () => {
    const fx = makeFixture();
    fx.setNow('2026-07-14T00:00:00.000Z');
    expect(fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v1', domain: 'auth' }).ok).toBe(true);
    fx.setNow('2026-07-15T00:00:00.000Z');
    expect(fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v2', domain: 'auth' }).ok).toBe(true);
    fx.setNow('2026-07-16T00:00:00.000Z');
    const third = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v3', domain: 'auth', status: 'deprecated' });
    expect(third.ok).toBe(true);
    if (!third.ok) return;

    expect(third.amended).toBe(true);
    expect(third.item.status).toBe('deprecated');
    expect(third.item.statement).toBe('v3');
    // Newest-first amendment trail; no state lost.
    expect(third.item.history).toEqual([
      { at: '2026-07-15T00:00:00.000Z', status: 'active', statement: 'v2' },
      { at: '2026-07-14T00:00:00.000Z', status: 'active', statement: 'v1' },
    ]);
    // Exactly one file — amend rewrote the SAME file, not a new one.
    const [read] = fx.store.read();
    expect(read).toEqual(third.item);
    expect(fx.store.read()).toHaveLength(1);
  });

  it('amend defaults status to the prior status when not supplied', () => {
    const fx = makeFixture();
    expect(fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v1', status: 'deprecated' }).ok).toBe(true);
    const again = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v2' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.item.status).toBe('deprecated');
  });
});

describe('read: selection only, never ranked', () => {
  function seed(fx: Fixture): void {
    fx.setNow('2026-07-14T00:00:00.000Z');
    fx.store.put({ id: 'GP-21', kind: 'guiding-principle', statement: 'Process only.', domain: 'scope' });
    fx.setNow('2026-07-15T00:00:00.000Z');
    fx.store.put({ id: 'POL-auth-1', kind: 'policy', statement: 'Rotate tokens.', domain: 'auth', status: 'active' });
    fx.setNow('2026-07-16T00:00:00.000Z');
    fx.store.put({ id: 'POL-auth-2', kind: 'policy', statement: 'Old rule.', domain: 'auth', status: 'deprecated' });
  }

  it('returns items newest-first by updated_at', () => {
    const fx = makeFixture();
    seed(fx);
    expect(fx.store.read().map((i) => i.id)).toEqual(['POL-auth-2', 'POL-auth-1', 'GP-21']);
  });

  it('filters by domain (case-insensitive substring)', () => {
    const fx = makeFixture();
    seed(fx);
    expect(fx.store.read({ domain: 'AUTH' }).map((i) => i.id)).toEqual(['POL-auth-2', 'POL-auth-1']);
    expect(fx.store.read({ domain: 'scope' }).map((i) => i.id)).toEqual(['GP-21']);
    expect(fx.store.read({ domain: 'nonexistent' })).toEqual([]);
  });

  it('filters by exact status', () => {
    const fx = makeFixture();
    seed(fx);
    expect(fx.store.read({ status: 'active' }).map((i) => i.id)).toEqual(['POL-auth-1', 'GP-21']);
    expect(fx.store.read({ status: 'deprecated' }).map((i) => i.id)).toEqual(['POL-auth-2']);
  });

  it('filters by exact kind', () => {
    const fx = makeFixture();
    seed(fx);
    expect(fx.store.read({ kind: 'guiding-principle' }).map((i) => i.id)).toEqual(['GP-21']);
    expect(fx.store.read({ kind: 'policy' }).map((i) => i.id)).toEqual(['POL-auth-2', 'POL-auth-1']);
  });

  it('combines filters (AND), still selection-only', () => {
    const fx = makeFixture();
    seed(fx);
    expect(fx.store.read({ domain: 'auth', status: 'active' }).map((i) => i.id)).toEqual(['POL-auth-1']);
  });

  it('reads an empty or absent steering tree as an empty list', () => {
    const { store, steeringDir } = makeFixture();
    expect(existsSync(steeringDir)).toBe(false); // read never creates the dir
    expect(store.read()).toEqual([]);
  });
});

describe('gate before persist (secret gate wired ahead of any write)', () => {
  it('masks a planted secret in the statement — the raw file never carries it', () => {
    const { store } = makeFixture();
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const result = store.put({ id: 'POL-secret', kind: 'policy', statement: `Never commit ${awsKey} to the repo.`, domain: 'security' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = readFileSync(result.path, 'utf8');
    expect(raw).not.toContain(awsKey);
    expect(raw).toContain('[REDACTED:aws-access-key-id]');
    expect(result.item.statement).toBe('Never commit [REDACTED:aws-access-key-id] to the repo.');
  });
});

describe('typed failures, no throw', () => {
  it('rejects a malformed id as a typed SCHEMA failure, nothing persisted', () => {
    const { store, steeringDir } = makeFixture();
    const result = store.put({ id: '../escape', kind: 'policy', statement: 'x' });
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(existsSync(steeringDir)).toBe(false);
  });

  it('rejects an unknown status via schema validation', () => {
    const { store } = makeFixture();
    const result = store.put({ id: 'POL-1', kind: 'policy', statement: 'x', status: 'bogus' as never });
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
  });
});

describe('cross-item supersession (forward edge + derived backlink)', () => {
  it('records the forward edge on put; readViews exposes the derived superseded_by backlink on the target', () => {
    const fx = makeFixture();
    fx.setNow('2026-07-14T00:00:00.000Z');
    expect(fx.store.put({ id: 'GP-old', kind: 'guiding-principle', statement: 'Old rule.', domain: 'scope' }).ok).toBe(true);
    fx.setNow('2026-07-15T00:00:00.000Z');
    const put = fx.store.put({
      id: 'GP-new',
      kind: 'guiding-principle',
      statement: 'New rule.',
      domain: 'scope',
      references: [{ rel: 'supersedes', id: 'GP-old' }],
    });
    expect(put.ok).toBe(true);
    if (!put.ok) return;

    // The forward edge is persisted — in the returned item AND the raw file.
    expect(put.item.references).toEqual([{ rel: 'supersedes', id: 'GP-old' }]);
    expect(readFileSync(put.path, 'utf8')).toContain('references: [{"rel":"supersedes","id":"GP-old"}]');

    // The reverse edge is DERIVED on read, newest-first, never stored.
    const views = fx.store.readViews();
    const oldView = views.find((v) => v.id === 'GP-old');
    const newView = views.find((v) => v.id === 'GP-new');
    expect(oldView?.referenced_by).toEqual([{ rel: 'supersedes', id: 'GP-new' }]);
    expect(newView?.referenced_by).toEqual([]);
    // The raw target file carries NO backlink — only the forward direction persists.
    expect(readFileSync(join(fx.steeringDir, 'GP-old.md'), 'utf8')).toContain('references: []');

    // Plain `read` is untouched: no derived field on its items.
    for (const item of fx.store.read()) {
      expect('referenced_by' in item).toBe(false);
    }
  });

  it('derives the backlink even when a selection filter excludes the referring item', () => {
    // Completeness posture (record/store.ts readViews): the referrer map is
    // built over EVERY item, not just the ones the filter returns.
    const fx = makeFixture();
    expect(fx.store.put({ id: 'GP-1', kind: 'guiding-principle', statement: 'x', domain: 'scope' }).ok).toBe(true);
    expect(
      fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'y', domain: 'auth', references: [{ rel: 'supersedes', id: 'GP-1' }] }).ok,
    ).toBe(true);
    const views = fx.store.readViews({ kind: 'guiding-principle' }); // POL-1 filtered OUT
    expect(views.map((v) => v.id)).toEqual(['GP-1']);
    expect(views[0]?.referenced_by).toEqual([{ rel: 'supersedes', id: 'POL-1' }]);
  });

  it('rejects a dangling (nonexistent) target as a typed DANGLING_SUPERSEDES failure, nothing persisted', () => {
    const fx = makeFixture();
    const result = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'x', references: [{ rel: 'supersedes', id: 'POL-nope' }] });
    expect(result).toMatchObject({ ok: false, code: 'DANGLING_SUPERSEDES' });
    if (!result.ok) expect(result.reason).toContain('POL-nope');
    expect(fx.store.read()).toEqual([]);
  });

  it('rejects a supersedes edge to a corrupted (unparseable) target file as a typed DANGLING_SUPERSEDES failure, nothing persisted', () => {
    const fx = makeFixture();
    // Plant a target file that EXISTS but does not parse (bad frontmatter) —
    // a bare existsSync guard would accept it; the parse-check must not.
    mkdirSync(fx.steeringDir, { recursive: true });
    writeFileSync(join(fx.steeringDir, 'POL-corrupt.md'), 'this is not valid steering frontmatter [[[', 'utf8');
    const result = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'x', references: [{ rel: 'supersedes', id: 'POL-corrupt' }] });
    expect(result).toMatchObject({ ok: false, code: 'DANGLING_SUPERSEDES' });
    if (!result.ok) expect(result.reason).toContain('unparseable');
    expect(fx.store.read()).toEqual([]);
  });

  it('lists every missing target, not just the first', () => {
    const fx = makeFixture();
    const result = fx.store.put({
      id: 'POL-1',
      kind: 'policy',
      statement: 'x',
      references: [
        { rel: 'supersedes', id: 'POL-a' },
        { rel: 'supersedes', id: 'POL-b' },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: 'DANGLING_SUPERSEDES' });
    if (!result.ok) {
      expect(result.reason).toContain('POL-a');
      expect(result.reason).toContain('POL-b');
    }
  });

  it('rejects a malformed (non-stem) edge id as a typed SCHEMA failure, nothing persisted', () => {
    const fx = makeFixture();
    for (const bad of ['../escape', 'has space', '']) {
      const result = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'x', references: [{ rel: 'supersedes', id: bad }] });
      expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
    }
    expect(fx.store.read()).toEqual([]);
  });

  it('rejects a malformed edge shape as a typed SCHEMA failure', () => {
    const fx = makeFixture();
    expect(fx.store.put({ id: 'GP-1', kind: 'guiding-principle', statement: 'x' }).ok).toBe(true);
    // Empty rel is a malformed edge, not a valid empty value.
    expect(
      fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'x', references: [{ rel: '', id: 'GP-1' }] }),
    ).toMatchObject({ ok: false, code: 'SCHEMA' });
    // A non-array references value is a schema violation.
    expect(
      fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'x', references: 'not-an-array' as never }),
    ).toMatchObject({ ok: false, code: 'SCHEMA' });
    expect(fx.store.read().map((i) => i.id)).toEqual(['GP-1']);
  });

  it('fan-in: two items superseding one both land on the target backlink, newest-first', () => {
    const fx = makeFixture();
    fx.setNow('2026-07-14T00:00:00.000Z');
    expect(fx.store.put({ id: 'POL-x', kind: 'policy', statement: 'v1', domain: 'auth' }).ok).toBe(true);
    fx.setNow('2026-07-15T00:00:00.000Z');
    expect(fx.store.put({ id: 'POL-y', kind: 'policy', statement: 'v2', domain: 'auth', references: [{ rel: 'supersedes', id: 'POL-x' }] }).ok).toBe(true);
    fx.setNow('2026-07-16T00:00:00.000Z');
    expect(fx.store.put({ id: 'POL-z', kind: 'policy', statement: 'v3', domain: 'auth', references: [{ rel: 'supersedes', id: 'POL-x' }] }).ok).toBe(true);
    const [view] = fx.store.readViews({ domain: 'auth' }).filter((v) => v.id === 'POL-x');
    expect(view?.referenced_by).toEqual([
      { rel: 'supersedes', id: 'POL-z' },
      { rel: 'supersedes', id: 'POL-y' },
    ]);
  });

  it('chains: A <- B <- C gives each item exactly its direct referrer', () => {
    const fx = makeFixture();
    expect(fx.store.put({ id: 'A', kind: 'policy', statement: 'a' }).ok).toBe(true);
    expect(fx.store.put({ id: 'B', kind: 'policy', statement: 'b', references: [{ rel: 'supersedes', id: 'A' }] }).ok).toBe(true);
    expect(fx.store.put({ id: 'C', kind: 'policy', statement: 'c', references: [{ rel: 'supersedes', id: 'B' }] }).ok).toBe(true);
    const views = fx.store.readViews();
    expect(views.find((v) => v.id === 'A')?.referenced_by).toEqual([{ rel: 'supersedes', id: 'B' }]);
    expect(views.find((v) => v.id === 'B')?.referenced_by).toEqual([{ rel: 'supersedes', id: 'C' }]);
    expect(views.find((v) => v.id === 'C')?.referenced_by).toEqual([]);
  });

  it('amend carries prior edges when references is absent, replaces wholesale when present, [] clears', () => {
    const fx = makeFixture();
    fx.setNow('2026-07-14T00:00:00.000Z');
    expect(fx.store.put({ id: 'GP-1', kind: 'guiding-principle', statement: 'x' }).ok).toBe(true);
    expect(fx.store.put({ id: 'GP-2', kind: 'guiding-principle', statement: 'y' }).ok).toBe(true);
    expect(fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v1', references: [{ rel: 'supersedes', id: 'GP-1' }] }).ok).toBe(true);

    // Amend WITHOUT references: the edge list is carried unchanged.
    fx.setNow('2026-07-15T00:00:00.000Z');
    const amend = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v2' });
    expect(amend.ok).toBe(true);
    if (!amend.ok) return;
    expect(amend.item.references).toEqual([{ rel: 'supersedes', id: 'GP-1' }]);

    // Amend WITH references: wholesale replace.
    fx.setNow('2026-07-16T00:00:00.000Z');
    const moved = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v3', references: [{ rel: 'supersedes', id: 'GP-2' }] });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.item.references).toEqual([{ rel: 'supersedes', id: 'GP-2' }]);

    // Amend with []: clears every edge.
    fx.setNow('2026-07-17T00:00:00.000Z');
    const cleared = fx.store.put({ id: 'POL-1', kind: 'policy', statement: 'v4', references: [] });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.item.references).toEqual([]);
    expect(fx.store.readViews().find((v) => v.id === 'GP-2')?.referenced_by).toEqual([]);

    // The WITHIN-item amendment trail is intact — still {at, status, statement}
    // entries only, newest-first, nothing lost, no edge data smuggled in.
    expect(cleared.item.history).toEqual([
      { at: '2026-07-16T00:00:00.000Z', status: 'active', statement: 'v3' },
      { at: '2026-07-15T00:00:00.000Z', status: 'active', statement: 'v2' },
      { at: '2026-07-14T00:00:00.000Z', status: 'active', statement: 'v1' },
    ]);
  });

  it('a legacy pre-references file on disk reads as no-edges through the store, and amending it starts edge-free', () => {
    const fx = makeFixture();
    // Hand-write a file in the pre-references on-disk shape (no references line).
    mkdirSync(fx.steeringDir, { recursive: true });
    const legacy = [
      '---',
      'id: "GP-9"',
      'kind: "guiding-principle"',
      'domain: "scope"',
      'status: "active"',
      `updated_at: "${FIXED_ISO}"`,
      'history: []',
      '---',
      '',
      'Legacy statement.',
      '',
    ].join('\n');
    writeFileSync(join(fx.steeringDir, 'GP-9.md'), legacy, 'utf8');

    const [view] = fx.store.readViews();
    expect(view).toMatchObject({ id: 'GP-9', references: [], referenced_by: [] });

    const amend = fx.store.put({ id: 'GP-9', kind: 'guiding-principle', statement: 'v2', domain: 'scope' });
    expect(amend.ok).toBe(true);
    if (!amend.ok) return;
    expect(amend.item.references).toEqual([]);
  });
});

describe('two-verb API surface, no hard delete', () => {
  it('the store modules export no delete/remove/rank/score verb', async () => {
    for (const mod of [await import('./store.js'), await import('./schema.js')]) {
      for (const name of Object.keys(mod)) {
        expect(name).not.toMatch(/delete|remove|rank|score/i);
      }
    }
  });

  it('SteeringStore exposes only put/read — no delete or ranking method', () => {
    const { store } = makeFixture();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object).filter((n) => n !== 'constructor');
    for (const name of methods) {
      expect(name).not.toMatch(/delete|remove|rank|score/i);
    }
    expect(methods).toContain('put');
    expect(methods).toContain('read');
  });
});

// ---------------------------------------------------------------------------
// The bounded read, at the level the predicate actually lives.
// ---------------------------------------------------------------------------

/** Put `n` items, each one minute OLDER than the last, so the expected
 *  newest-first order is exactly the seed order. */
function seedDescending(fx: Fixture, n: number): string[] {
  const newest = Date.UTC(2026, 6, 16, 12, 0, 0);
  const created: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `GP-${String(i).padStart(3, '0')}`;
    fx.setNow(new Date(newest - i * 60_000).toISOString());
    expect(fx.store.put({ id, kind: 'guiding-principle', statement: `rule ${id}` }).ok).toBe(true);
    created.push(id);
  }
  return created;
}

describe('keyset paging (readViewsPage)', () => {
  it('an ABSENT limit is UNBOUNDED — the contract context/assemble-prototype.ts sweeps on, and the reason no default lives in this store', () => {
    const fx = makeFixture();
    const ids = seedDescending(fx, 150);
    // Well past any page default a transport might apply: readViews and the
    // page method with no limit BOTH return every item. A default parked here
    // would silently truncate the assembler's supersession sweep.
    expect(fx.store.readViews().map((i) => i.id)).toEqual(ids);
    const all = fx.store.readViewsPage(undefined, {});
    expect(all.items.map((i) => i.id)).toEqual(ids);
    expect(all.next_cursor).toBeNull();
  });

  it('pages in (updated_at DESC, id ASC) order and a walk covers every item exactly once, ending with a null cursor', () => {
    const fx = makeFixture();
    const ids = seedDescending(fx, 25);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page = fx.store.readViewsPage(undefined, { limit: 4, ...(cursor === null ? {} : { cursor }) });
      pages += 1;
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
      if (cursor === null) break;
      expect(pages).toBeLessThan(100);
    }
    expect(seen).toEqual(ids);
    expect(pages).toBe(7);
  });

  it('exercises the MIXED-DIRECTION tie-break arm: on an identical updated_at the id arm points ASCENDING while the timestamp arm descends', () => {
    const fx = makeFixture();
    const tied = '2026-07-16T12:00:00.000Z';
    fx.setNow('2026-07-16T13:00:00.000Z');
    fx.store.put({ id: 'GP-newer', kind: 'guiding-principle', statement: 'x' });
    fx.setNow(tied);
    for (const id of ['POL-c', 'POL-a', 'POL-d', 'POL-b']) fx.store.put({ id, kind: 'policy', statement: 'x' });
    fx.setNow('2026-07-16T11:00:00.000Z');
    fx.store.put({ id: 'GP-older', kind: 'guiding-principle', statement: 'x' });

    const unpaged = fx.store.readViewsPage(undefined, {}).items.map((i) => i.id);
    expect(unpaged).toEqual(['GP-newer', 'POL-a', 'POL-b', 'POL-c', 'POL-d', 'GP-older']);

    // Every page boundary lands INSIDE the tie. A predicate whose id arm ran
    // the same direction as the timestamp arm would repeat POL-a forever or
    // skip the rest of the tie outright.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page: ReturnType<SteeringStore['readViewsPage']> = fx.store.readViewsPage(undefined, {
        limit: 1,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(unpaged);
  });

  it('backlinks are PAGE-INDEPENDENT: a superseded item carries its referenced_by wherever it lands', () => {
    const fx = makeFixture();
    fx.setNow('2026-07-16T11:00:00.000Z');
    fx.store.put({ id: 'GP-old', kind: 'guiding-principle', statement: 'old' });
    fx.setNow('2026-07-16T12:00:00.000Z');
    fx.store.put({ id: 'GP-new', kind: 'guiding-principle', statement: 'new', references: [{ rel: 'supersedes', id: 'GP-old' }] });

    // GP-old lands on the SECOND page, and still knows what replaced it.
    const first = fx.store.readViewsPage(undefined, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual(['GP-new']);
    const second = fx.store.readViewsPage(undefined, { limit: 1, cursor: first.next_cursor ?? '' });
    expect(second.items[0]?.id).toBe('GP-old');
    expect(second.items[0]?.referenced_by).toEqual([{ rel: 'supersedes', id: 'GP-new' }]);
  });

  it('the exact id filter is the by-id retrieval path — one selection filter, not a second verb', () => {
    const fx = makeFixture();
    seedDescending(fx, 5);
    expect(fx.store.read({ id: 'GP-003' }).map((i) => i.id)).toEqual(['GP-003']);
    expect(fx.store.readViews({ id: 'GP-003' }).map((i) => i.id)).toEqual(['GP-003']);
    expect(fx.store.readViewsPage({ id: 'GP-003' }, {}).items.map((i) => i.id)).toEqual(['GP-003']);
    // Exact, never a prefix or a substring.
    expect(fx.store.read({ id: 'GP-00' })).toEqual([]);
    expect(fx.store.read({ id: 'gp-003' })).toEqual([]);
  });
});

describe('page-argument guards (typed, this seam’s own)', () => {
  it('clamps an out-of-range limit into [1, MAX] and rejects a NON-INTEGER limit as a typed schema failure', () => {
    expect(clampSteeringReadLimit(0)).toBe(1);
    expect(clampSteeringReadLimit(-5)).toBe(1);
    expect(clampSteeringReadLimit(7)).toBe(7);
    expect(clampSteeringReadLimit(9999)).toBe(MAX_STEERING_READ_LIMIT);
    // A non-integer is a different failure class — the SHAPE of the argument,
    // not its magnitude — so it is raised, not clamped.
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clampSteeringReadLimit(bad)).toThrow(SteeringSchemaError);
      expect(() => clampSteeringReadLimit(bad)).toThrow(/"limit" must be an integer/);
    }
    // …and NaN/Infinity are NAMED, not reported as `null` (which is what
    // JSON.stringify would have produced).
    expect(() => clampSteeringReadLimit(Number.NaN)).toThrow(/NaN/);
  });

  it('decodes a cursor this store minted, and rejects every malformed shape as SteeringSchemaError — never another seam’s error, never a silent empty page', () => {
    expect(decodeSteeringCursor(encodeListCursor('2026-07-16T12:00:00.000Z', 'GP-21'))).toEqual({
      updated_at: '2026-07-16T12:00:00.000Z',
      id: 'GP-21',
    });

    const malformed: Array<[string, string]> = [
      ['wrong alphabet', 'not a cursor!!'],
      ['padded', `${encodeListCursor('2026-07-16T12:00:00.000Z', 'GP-21')}=`],
      ['short final group', 'AAAAA'],
      ['non-canonical tail', 'QR'],
      ['decodes but is not JSON', Buffer.from('nonsense bytes', 'utf8').toString('base64url')],
      ['a one-element (record-shaped) cursor', Buffer.from(JSON.stringify(['GP-21']), 'utf8').toString('base64url')],
      ['a three-element cursor', Buffer.from(JSON.stringify(['a', 'b', 'c']), 'utf8').toString('base64url')],
      ['elements that are not strings', Buffer.from(JSON.stringify([1, 2]), 'utf8').toString('base64url')],
    ];
    for (const [why, cursor] of malformed) {
      expect(() => decodeSteeringCursor(cursor), why).toThrow(SteeringSchemaError);
      expect(() => decodeSteeringCursor(cursor), why).toThrow(/steering store: "cursor" is not a valid page cursor/);
      // P-24: the offending value is never echoed back into the message.
      try {
        decodeSteeringCursor(cursor);
      } catch (err) {
        expect((err as Error).message, why).not.toContain(cursor);
        expect((err as Error).name, why).toBe('SteeringSchemaError');
      }
    }
  });

  it('a malformed page argument is raised even when the selection would have matched nothing (never swallowed by an empty result)', () => {
    const { store } = makeFixture();
    expect(store.readViewsPage(undefined, {}).items).toEqual([]);
    expect(() => store.readViewsPage(undefined, { cursor: 'not a cursor!!' })).toThrow(SteeringSchemaError);
    expect(() => store.readViewsPage(undefined, { limit: 1.5 })).toThrow(SteeringSchemaError);
  });

  it('a WELL-FORMED cursor naming a boundary no item ever had selects nothing — deliberately indistinguishable from exhaustion', () => {
    const fx = makeFixture();
    seedDescending(fx, 3);
    const page = fx.store.readViewsPage(undefined, { cursor: encodeListCursor('1999-01-01T00:00:00.000Z', 'GP-000'), limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });
});

describe('GP-26 narrow seams', () => {
  it('no steering source file imports from work-state/ — the board’s error type is unreachable from here', () => {
    const steeringDirPath = fileURLToPath(new URL('.', import.meta.url));
    for (const entry of readdirSync(steeringDirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const source = readFileSync(join(steeringDirPath, entry.name), 'utf8');
      // No import of the board's module, and no construction of its error type
      // (naming it in PROSE is fine — steering/store.ts's cursor decoder
      // explains why it raises its own error instead).
      expect(source, entry.name).not.toMatch(/from '[^']*work-state\//);
      expect(source, entry.name).not.toMatch(/new WorkStateError\(/);
    }
  });
});
