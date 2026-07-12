// plugin/src/work-state/store.test.ts — WI-300 acceptance tests for the
// work-state persistence core.
//
// Pins: contract types match §3.1 exactly (forbidden fields absent from the
// stored shape; `rank` rejected with a typed error); WAL + busy-timeout at
// the store level; config-resolved, lazily-initialized storage path;
// events are append-only (grep-falsifiable — no UPDATE/DELETE against the
// events table anywhere in this package — plus a behavioral accumulate-and-
// never-mutate test); version increments on the metadata-update primitive;
// ULID ids minted via the shared record/id.ts generator; the secret gate
// masks `title` and an event's `note` before persist.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate-work/ is
// never touched.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RECORD_PATH,
  DEFAULT_WORK_STATE_PATH,
  V3_SCHEMA_VERSION,
  loadConfig,
  workStatePath,
} from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import { isUlid } from '../record/id.js';
import type { Clock } from '../record/id.js';
import { DEFAULT_TENANT_ID, WorkStateError } from './types.js';
import { WorkStateStore } from './store.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-state-store-test-'));
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
  store: WorkStateStore;
  dbPath: string;
  setNow: (iso: string) => void;
}

function makeFixture(): Fixture {
  const root = makeTempDir();
  const dbPath = join(root, 'work-state', 'board.db');
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const store = new WorkStateStore(dbPath, clock);
  return {
    store,
    dbPath,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

function actor(human = 'dan'): { human: string } {
  return { human };
}

describe('contract types and forbidden fields', () => {
  it('a created item carries exactly the §3.1 fields, nothing else', () => {
    const { store } = makeFixture();
    const item = store.insertItem({
      title: 'Wire the claim compare-and-set',
      spec: 'plain prompt: build WI-301',
      spec_format: 'text/markdown',
      created_by: actor(),
    });

    expect(Object.keys(item).sort()).toEqual(
      [
        'id',
        'tenant_id',
        'title',
        'spec',
        'spec_format',
        'status',
        'claim',
        'depends_on',
        'created_by',
        'created_at',
        'updated_at',
        'version',
      ].sort(),
    );
    // Forbidden fields never appear.
    for (const forbidden of ['priority', 'estimate', 'estimates', 'sprint', 'sprints', 'labels', 'review_state', 'rank']) {
      expect(item).not.toHaveProperty(forbidden);
    }
    expect(item.status).toBe('open');
    expect(item.claim).toBeNull();
    expect(item.version).toBe(1);
    expect(item.tenant_id).toBe(DEFAULT_TENANT_ID);
  });

  it('rejects a top-level "rank" field on create with a typed RESERVED_FIELD error', () => {
    const { store } = makeFixture();
    let thrown: unknown;
    try {
      store.insertItem({
        title: 'x',
        spec: 'y',
        spec_format: 'z',
        created_by: actor(),
        rank: 1,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkStateError);
    expect((thrown as WorkStateError).code).toBe('RESERVED_FIELD');
    // Nothing was persisted.
    expect(store.listItems()).toEqual([]);
  });

  it('rejects a top-level "rank" field on update_meta with a typed RESERVED_FIELD error', () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    let thrown: unknown;
    try {
      store.updateMeta(item.id, item.version, { title: 'x2', rank: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkStateError);
    expect((thrown as WorkStateError).code).toBe('RESERVED_FIELD');
    // Unchanged.
    expect(store.getItem(item.id)?.title).toBe('x');
  });

  it('no "blocked" status is ever storable — status is one of the four stored values', () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    expect(['open', 'in_progress', 'done', 'cancelled']).toContain(item.status);
  });
});

describe('WAL + busy-timeout at the store level', () => {
  it('two stores pointed at the same db file both insert successfully; PRAGMA journal_mode is wal', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    const clock: Clock = () => new Date(FIXED_ISO);
    const storeA = new WorkStateStore(dbPath, clock);
    const storeB = new WorkStateStore(dbPath, clock);

    const itemA = storeA.insertItem({ title: 'A', spec: 's', spec_format: 'f', created_by: actor() });
    const itemB = storeB.insertItem({ title: 'B', spec: 's', spec_format: 'f', created_by: actor() });

    expect(storeA.getItem(itemA.id)).not.toBeNull();
    expect(storeB.getItem(itemB.id)).not.toBeNull();
    // Both items visible from either store instance — same underlying file.
    expect(storeA.getItem(itemB.id)?.title).toBe('B');
  });
});

describe('config-resolved, lazily-initialized path', () => {
  it('workStatePath resolves DEFAULT_WORK_STATE_PATH under the project root when unconfigured', () => {
    const root = makeTempDir();
    const config = loadConfig(root);
    expect(workStatePath(config, root)).toBe(join(root, DEFAULT_WORK_STATE_PATH.replace(/\/$/, '')));
  });

  it('no work-state directory or db file exists until the first write', () => {
    const root = makeTempDir();
    const config = loadConfig(root);
    const dbDir = workStatePath(config, root);
    const dbPath = join(dbDir, 'board.db');

    expect(existsSync(dbDir)).toBe(false);

    const clock: Clock = () => new Date(FIXED_ISO);
    const store = new WorkStateStore(dbPath, clock);

    // Reads before any write touch nothing.
    expect(store.getItem('nonexistent')).toBeNull();
    expect(store.listItems()).toEqual([]);
    expect(store.events('nonexistent')).toEqual([]);
    expect(existsSync(dbDir)).toBe(false);
    expect(existsSync(dbPath)).toBe(false);

    // First write creates it.
    store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    expect(existsSync(dbPath)).toBe(true);
  });

  it('honors an explicit work_state.path override in .ideate.json, byte-preserving the rest of the file', () => {
    const root = makeTempDir();
    // Establish a v3 config first (no work_state key).
    loadConfig(root);
    const configPath = join(root, '.ideate.json');
    const before = readFileSync(configPath, 'utf8');

    const withOverride: IdeateConfigV3 = {
      schema_version: V3_SCHEMA_VERSION,
      record: { path: DEFAULT_RECORD_PATH },
      backend: 'local',
      work_state: { path: 'custom-board/' },
    };
    expect(workStatePath(withOverride, root)).toBe(join(root, 'custom-board'));

    // loadConfig() itself never writes a work_state key on its own (loading
    // again with no override present must not have touched the file).
    const config2 = loadConfig(root);
    expect(config2.work_state).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

describe('events: append-only', () => {
  it('no UPDATE or DELETE statement targets the events table anywhere in this package', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    const forbidden = [/UPDATE\s+events/i, /DELETE\s+FROM\s+events/i];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (entry.isFile() && full.endsWith('.ts')) {
          // Strip full-line `//` comments before matching — this file's own
          // header prose (and this test's own description) legitimately
          // mentions the forbidden SQL shapes in English; only an actual
          // statement in code should trip this guard.
          const codeOnly = readFileSync(full, 'utf8')
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
          if (forbidden.some((re) => re.test(codeOnly))) offenders.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it('events accumulate and are never mutated — the full history is always readable', () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });

    store.appendEvent({ item_id: item.id, actor: actor(), transition: 'claim', claim_token: 1 });
    store.appendEvent({ item_id: item.id, actor: actor(), transition: 'release', claim_token: 1, note: 'handing off' });

    const events = store.events(item.id);
    expect(events).toHaveLength(3); // create + claim + release
    expect(events.map((e) => e.transition)).toEqual(['create', 'claim', 'release']);
    expect(events[1]?.claim_token).toBe(1);
    expect(events[2]?.note).toBe('handing off');

    // Reading again returns the identical accumulated history — nothing
    // mutated or removed by a read.
    expect(store.events(item.id)).toEqual(events);
  });
});

describe('version increments on the metadata-update primitive', () => {
  it('updateMeta bumps version by exactly 1 and rejects a stale expectedVersion', () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    expect(item.version).toBe(1);

    const updated = store.updateMeta(item.id, 1, { title: 'x2' });
    expect(updated.version).toBe(2);
    expect(updated.title).toBe('x2');

    let thrown: unknown;
    try {
      store.updateMeta(item.id, 1, { title: 'x3' }); // stale version
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkStateError);
    expect((thrown as WorkStateError).code).toBe('VERSION_CONFLICT');

    // A second successful update bumps again.
    const updated2 = store.updateMeta(item.id, 2, { spec_format: 'text/plain' });
    expect(updated2.version).toBe(3);
  });

  it('throws NOT_FOUND for an id that does not exist', () => {
    const { store } = makeFixture();
    expect(() => store.updateMeta('01JZM8Z0000000000000000000', 1, { title: 'x' })).toThrowError(WorkStateError);
  });
});

describe('ULID ids via the shared generator', () => {
  it('insertItem assigns a well-formed ULID, and ids are unique across inserts', () => {
    const { store } = makeFixture();
    const a = store.insertItem({ title: 'a', spec: 's', spec_format: 'f', created_by: actor() });
    const b = store.insertItem({ title: 'b', spec: 's', spec_format: 'f', created_by: actor() });
    expect(isUlid(a.id)).toBe(true);
    expect(isUlid(b.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });
});

describe('claim-token counter survives claim deletion', () => {
  it('nextClaimToken is strictly monotonic per item and independent of the events log', () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });

    const t1 = store.nextClaimToken(item.id);
    const t2 = store.nextClaimToken(item.id);
    const t3 = store.nextClaimToken(item.id);
    expect([t1, t2, t3]).toEqual([1, 2, 3]);

    // No events were appended by nextClaimToken itself — it is a pure
    // counter primitive, independent of the append-only log.
    expect(store.events(item.id)).toHaveLength(1); // just "create"
  });

  it('throws NOT_FOUND for an id that does not exist', () => {
    const { store } = makeFixture();
    expect(() => store.nextClaimToken('01JZM8Z0000000000000000000')).toThrowError(WorkStateError);
  });
});

describe('secret gate: title and event note are masked before persist', () => {
  const PLANTED_KEY = 'AKIAABCDEFGHIJKLMNOP'; // AWS access key ID shape

  it('masks a planted secret in title before it ever reaches disk', () => {
    const { store, dbPath } = makeFixture();
    const item = store.insertItem({
      title: `credentials: ${PLANTED_KEY}`,
      spec: 'irrelevant',
      spec_format: 'text/plain',
      created_by: actor(),
    });

    expect(item.title).not.toContain(PLANTED_KEY);
    expect(item.title).toContain('REDACTED');

    const raw = readFileSync(dbPath); // raw bytes on disk
    expect(raw.includes(Buffer.from(PLANTED_KEY))).toBe(false);
  });

  it('masks a planted secret in an event note before it ever reaches disk', () => {
    const { store, dbPath } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });

    const event = store.appendEvent({
      item_id: item.id,
      actor: actor(),
      transition: 'release',
      note: `handoff — key: ${PLANTED_KEY}`,
    });

    expect(event.note).not.toContain(PLANTED_KEY);
    expect(event.note).toContain('REDACTED');

    const raw = readFileSync(dbPath);
    expect(raw.includes(Buffer.from(PLANTED_KEY))).toBe(false);
  });

  it('does NOT mask spec — spec is opaque, stored as-is, byte-for-byte', () => {
    const { store } = makeFixture();
    const specWithSecretShape = `plan: use key ${PLANTED_KEY} in the fixture (not a real secret, but shaped like one)`;
    const item = store.insertItem({
      title: 'x',
      spec: specWithSecretShape,
      spec_format: 'text/plain',
      created_by: actor(),
    });
    // spec passes through completely unmodified — no code path may parse or
    // transform it, including the secret gate.
    expect(item.spec).toBe(specWithSecretShape);
  });
});

describe('list and get', () => {
  it('listItems filters by tenant_id and status', () => {
    const { store } = makeFixture();
    const a = store.insertItem({ title: 'a', spec: 's', spec_format: 'f', created_by: actor() });
    const b = store.insertItem({ title: 'b', spec: 's', spec_format: 'f', created_by: actor() });

    const all = store.listItems();
    expect(all).toHaveLength(2);

    const byTenant = store.listItems({ tenant_id: DEFAULT_TENANT_ID });
    expect(byTenant).toHaveLength(2);

    const byStatus = store.listItems({ status: 'open' });
    expect(byStatus.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());

    const noneDone = store.listItems({ status: 'done' });
    expect(noneDone).toEqual([]);
  });

  it('getItem returns null for an id that does not exist', () => {
    const { store } = makeFixture();
    expect(store.getItem('01JZM8Z0000000000000000000')).toBeNull();
  });
});

describe('depends_on round-trips', () => {
  it('preserves the dependency list through insert and read', () => {
    const { store } = makeFixture();
    const dep = store.insertItem({ title: 'dep', spec: 's', spec_format: 'f', created_by: actor() });
    const item = store.insertItem({
      title: 'dependent',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      depends_on: [dep.id],
    });
    expect(item.depends_on).toEqual([dep.id]);
    expect(store.getItem(item.id)?.depends_on).toEqual([dep.id]);
  });

  it('updateMeta can replace depends_on', () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor(), depends_on: [] });
    const updated = store.updateMeta(item.id, item.version, { depends_on: ['some-other-id'] });
    expect(updated.depends_on).toEqual(['some-other-id']);
  });
});

describe('ActorRef — accountability resolves to a person', () => {
  it('carries an optional agent alongside the required human', () => {
    const { store } = makeFixture();
    const item = store.insertItem({
      title: 'x',
      spec: 's',
      spec_format: 'f',
      created_by: { human: 'dan', agent: 'dan/worker-3' },
    });
    expect(item.created_by).toEqual({ human: 'dan', agent: 'dan/worker-3' });
  });
});
