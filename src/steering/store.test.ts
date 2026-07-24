// plugin/src/steering/store.test.ts — acceptance tests for the LIGHT
// steering store core.
//
// Pins: round-trip serialization of policies + guiding principles through the
// on-disk Markdown/YAML form (including hostile content); create-or-amend with
// a growing amendment_history (mutable, NOT append-only — the key departure
// from the record store); scope-filtered SELECTION-only reads (domain / status
// / kind, no ranking); gate-before-persist with a PLANTED SECRET asserted
// masked in the raw on-disk bytes; typed no-throw failures; and the
// two-verb / no-hard-delete API surface.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    };
    expect(parseSteeringItem(serializeSteeringItem(item))).toEqual(item);
  });

  it('parse(serialize(item)) is identity for a policy carrying an amendment history', () => {
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
    };
    expect(parseSteeringItem(serializeSteeringItem(item))).toEqual(item);
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
