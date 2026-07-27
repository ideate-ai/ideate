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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { parseSteeringItem, serializeSteeringItem } from './schema.js';
import type { SteeringItem } from './schema.js';
import { SteeringStore } from './store.js';

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
