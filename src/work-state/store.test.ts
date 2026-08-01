// plugin/src/work-state/store.test.ts — acceptance tests for the
// work-state persistence core.
//
// Pins: contract types match the contract exactly (forbidden fields absent from the
// stored shape; `rank` rejected with a typed error); WAL + busy-timeout at
// the store level; config-resolved, lazily-initialized storage path;
// events are append-only (grep-falsifiable — no UPDATE/DELETE against the
// events table anywhere in this package — plus a behavioral accumulate-and-
// never-mutate test); version increments on the metadata-update primitive;
// ULID ids minted via the shared record/id.ts generator; the secret gate
// masks `title` and an event's `note` before persist; the summary read
// projects `spec` away in favour of a SQL-computed `spec_length` (counted in
// CODE POINTS, pinned on non-BMP text), pages by KEYSET (never OFFSET —
// including across a created_at TIE), clamps its page size, and refuses a
// malformed cursor loudly — while absent page options stay byte-identical to
// the unpaginated read the internal callers use. The projection's column list
// is held against the LIVE DDL (`PRAGMA table_info`), so a column added to
// schema.ts and forgotten in the projection fails the build rather than
// vanishing from every summary row; both legacy shapes (v2 without
// `"references"`, pre-v2 without `parent_id` either) are read, not thrown on.
//
// All filesystem work happens in mkdtemp dirs — the real .ideate-work/ is
// never touched.

import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { encodeListCursor } from '../transport/keyset-page.js';
import type { IdResolver } from '../transport/id-lint.js';
import { openForWrite } from './schema.js';
import { DEFAULT_TENANT_ID, WorkStateError } from './types.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  WorkStateStore,
  clampListLimit,
  decodeListCursor,
  summaryColumns,
} from './store.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

// A v2-shaped items table (with `parent_id`, WITHOUT the `"references"`
// column) — the fixture for the legacy pre-v3 view-read guard test. Mirrors
// schema.test.ts's seedLegacyV2Board; the v2->v3 migration only runs on a
// WRITE open, so a view read (openForRead) over this table never migrates and
// is the exact path that used to throw `no such column: "references"`.
const LEGACY_V2_ITEMS_DDL = `
CREATE TABLE items (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  spec                  TEXT NOT NULL,
  spec_format           TEXT NOT NULL,
  status                TEXT NOT NULL,
  depends_on            TEXT NOT NULL,
  parent_id             TEXT,
  created_by_human      TEXT NOT NULL,
  created_by_agent      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL,
  claim_token_counter   INTEGER NOT NULL DEFAULT 0,
  claim_holder_human    TEXT,
  claim_holder_agent    TEXT,
  claim_token           INTEGER,
  claim_acquired_at     TEXT,
  claim_lease_expires   TEXT
)`;

// A pre-v2 items table — WITHOUT `parent_id` AND without `"references"`.
// A different branch of both column guards than LEGACY_V2_ITEMS_DDL above
// exercises: the projected read and the containment read each name
// `parent_id` explicitly, so on this board an unguarded statement throws
// `no such column: parent_id` at PREPARE time — a board the old `SELECT *`
// path read without complaint (P-41).
const LEGACY_V1_ITEMS_DDL = `
CREATE TABLE items (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  spec                  TEXT NOT NULL,
  spec_format           TEXT NOT NULL,
  status                TEXT NOT NULL,
  depends_on            TEXT NOT NULL,
  created_by_human      TEXT NOT NULL,
  created_by_agent      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  version               INTEGER NOT NULL,
  claim_token_counter   INTEGER NOT NULL DEFAULT 0,
  claim_holder_human    TEXT,
  claim_holder_agent    TEXT,
  claim_token           INTEGER,
  claim_acquired_at     TEXT,
  claim_lease_expires   TEXT
)`;

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

function makeFixture(resolveId?: IdResolver): Fixture {
  const root = makeTempDir();
  const dbPath = join(root, 'work-state', 'board.db');
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const store = new WorkStateStore(dbPath, clock, resolveId);
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
  it('a created item carries exactly the fields, nothing else', () => {
    const { store } = makeFixture();
    const item = store.insertItem({
      title: 'Wire the claim compare-and-set',
      spec: 'plain prompt: build T-301',
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
        'parent_id',
        'references',
        'created_by',
        'created_at',
        'updated_at',
        'version',
      ].sort(),
    );
    // A create with no parent_id lands as a root, and with no references
    // lands with no forward edges.
    expect(item.parent_id).toBeNull();
    expect(item.references).toEqual([]);
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

describe('capture-time id-lint for unresolvable ULIDs in free text (correction 01KYV387QKRP3V330WAS6DX95K)', () => {
  const DEAD_ID = '01KYV31MB4BAWG8ZAP2FZDGVGP';
  const LIVE_ID = '01KYTQZXDGVPJRBNY64JJ4YNV1';

  function resolverFor(resolved: ReadonlySet<string>): IdResolver {
    return (id) => (resolved.has(id) ? 'resolved' : 'unresolved');
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a ULID cited in TITLE (create) that resolves nowhere is reported via process.emitWarning; the write still succeeds', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const item = store.insertItem({ title: `see ${DEAD_ID} for prior work`, spec: 'x', spec_format: 'text/plain', created_by: actor() });
    expect(item.title).toContain(DEAD_ID); // report only — never rewritten
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEAD_ID), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
  });

  it('a ULID cited in TITLE that resolves is not reported', () => {
    const { store } = makeFixture(resolverFor(new Set([LIVE_ID])));
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    store.insertItem({ title: `see ${LIVE_ID}`, spec: 'x', spec_format: 'text/plain', created_by: actor() });
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
  });

  it('update_meta re-titling to cite a dead id is reported; leaving title untouched on an unrelated update is NOT re-reported', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const item = store.insertItem({ title: 'clean title', spec: 'x', spec_format: 'text/plain', created_by: actor() });
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    store.updateMeta(item.id, item.version, { title: `now cites ${DEAD_ID}` });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEAD_ID), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
    warn.mockClear();
    const afterTitle = store.getItem(item.id);
    if (afterTitle === null) throw new Error('missing');
    // An unrelated update_meta call that does not touch title must not
    // re-warn about the title it already accepted.
    store.updateMeta(item.id, afterTitle.version, { spec: 'new spec text' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('an event NOTE (appendEvent) citing a dead id is reported; a resolving one is not', () => {
    const dead = makeFixture(resolverFor(new Set()));
    const item = dead.store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    const warnDead = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    dead.store.appendEvent({ item_id: item.id, actor: actor(), transition: 'release', note: `handoff, see ${DEAD_ID}` });
    expect(warnDead).toHaveBeenCalledWith(expect.stringContaining(DEAD_ID), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
    warnDead.mockRestore();

    const live = makeFixture(resolverFor(new Set([LIVE_ID])));
    const item2 = live.store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    const warnLive = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    live.store.appendEvent({ item_id: item2.id, actor: actor(), transition: 'release', note: `handoff, see ${LIVE_ID}` });
    expect(warnLive).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
  });

  it("NON-GOAL / mirrors the secret gate's own posture: spec is NEVER scanned, even when it plainly cites a dead id", () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    store.insertItem({ title: 'x', spec: `plan: see ${DEAD_ID} for context`, spec_format: 'text/plain', created_by: actor() });
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
  });

  it('P-45: an ABSENT resolver reports every candidate as "unknown" with a DISTINCT warning code, never silently clean', () => {
    const { store } = makeFixture(); // no resolver wired
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    store.insertItem({ title: `see ${DEAD_ID}`, spec: 'x', spec_format: 'text/plain', created_by: actor() });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEAD_ID), expect.objectContaining({ code: 'IDEATE_WORK_ID_LINT_UNAVAILABLE' }));
  });

  it('P-41 FALSIFICATION: the guard fires on an induced violation and stays quiet on agreement for the identical title text', () => {
    const inducedId = '01KYTP1H0B2FMFBQ4H9QCXPK2Z';
    const violating = makeFixture(resolverFor(new Set()));
    const warnViolating = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    violating.store.insertItem({ title: `cites ${inducedId}`, spec: 'x', spec_format: 'text/plain', created_by: actor() });
    expect(warnViolating).toHaveBeenCalledWith(expect.stringContaining(inducedId), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
    warnViolating.mockRestore();

    const agreeing = makeFixture(resolverFor(new Set([inducedId])));
    const warnAgreeing = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    agreeing.store.insertItem({ title: `cites ${inducedId}`, spec: 'x', spec_format: 'text/plain', created_by: actor() });
    expect(warnAgreeing).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'IDEATE_WORK_UNRESOLVED_ID' }));
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

describe('references: the stored forward edge (supersedes primary)', () => {
  it('round-trips a supersedes edge through insert and read; absent defaults to []', () => {
    const { store } = makeFixture();
    const old = store.insertItem({ title: 'old plan', spec: 's', spec_format: 'f', created_by: actor() });
    expect(old.references).toEqual([]);

    const replacement = store.insertItem({
      title: 'new plan',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: old.id }],
    });
    expect(replacement.references).toEqual([{ rel: 'supersedes', id: old.id }]);
    expect(store.getItem(replacement.id)?.references).toEqual([{ rel: 'supersedes', id: old.id }]);
    // Only the FORWARD edge is stored — the target's own row is untouched.
    expect(store.getItem(old.id)?.references).toEqual([]);
  });

  it('updateMeta replaces the edge list wholesale: absent leaves it unchanged, [] clears it', () => {
    const { store } = makeFixture();
    const a = store.insertItem({ title: 'a', spec: 's', spec_format: 'f', created_by: actor() });
    const b = store.insertItem({ title: 'b', spec: 's', spec_format: 'f', created_by: actor() });
    const item = store.insertItem({
      title: 'x',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: a.id }],
    });

    // Absent references: unchanged (only title moves).
    const renamed = store.updateMeta(item.id, item.version, { title: 'x2' });
    expect(renamed.references).toEqual([{ rel: 'supersedes', id: a.id }]);

    // Present: wholesale replace.
    const moved = store.updateMeta(renamed.id, renamed.version, { references: [{ rel: 'supersedes', id: b.id }] });
    expect(moved.references).toEqual([{ rel: 'supersedes', id: b.id }]);

    // Empty list: clears every edge.
    const cleared = store.updateMeta(moved.id, moved.version, { references: [] });
    expect(cleared.references).toEqual([]);
  });

  it('rejects a malformed references shape with a typed SCHEMA error and writes nothing', () => {
    const { store } = makeFixture();
    for (const bad of [
      { references: 'not-an-array' },
      { references: [{ rel: 'supersedes' }] },
      { references: [{ id: 'x' }] },
      { references: [{ rel: '', id: 'x' }] },
      { references: ['supersedes'] },
    ]) {
      let thrown: unknown;
      try {
        store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor(), ...bad });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WorkStateError);
      expect((thrown as WorkStateError).code).toBe('SCHEMA');
    }
    expect(store.listItems()).toEqual([]);
  });

  it('rejects a non-ULID reference id at the write chokepoint with a typed SCHEMA error, on create and update_meta', () => {
    const { store } = makeFixture();
    let createThrown: unknown;
    try {
      store.insertItem({
        title: 'x',
        spec: 's',
        spec_format: 'f',
        created_by: actor(),
        references: [{ rel: 'supersedes', id: 'not-a-ulid' }],
      });
    } catch (err) {
      createThrown = err;
    }
    expect(createThrown).toBeInstanceOf(WorkStateError);
    expect((createThrown as WorkStateError).code).toBe('SCHEMA');
    expect((createThrown as WorkStateError).message).toMatch(/not a well-formed ULID/);
    expect(store.listItems()).toEqual([]);

    const item = store.insertItem({ title: 'y', spec: 's', spec_format: 'f', created_by: actor() });
    let updateThrown: unknown;
    try {
      store.updateMeta(item.id, item.version, { references: [{ rel: 'supersedes', id: 'not-a-ulid' }] });
    } catch (err) {
      updateThrown = err;
    }
    expect(updateThrown).toBeInstanceOf(WorkStateError);
    expect((updateThrown as WorkStateError).code).toBe('SCHEMA');
    expect(store.getItem(item.id)?.references).toEqual([]);
  });

  it('accepts a well-formed ULID reference id (existence is the verb layer’s guard, not the store’s)', () => {
    const { store } = makeFixture();
    const item = store.insertItem({
      title: 'x',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: '01JZM8Z0000000000000000000' }],
    });
    expect(item.references).toEqual([{ rel: 'supersedes', id: '01JZM8Z0000000000000000000' }]);
  });
});

describe('view reads: derived referenced_by backlinks, never stored', () => {
  it('attaches referenced_by to a superseded item without persisting it', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const a = fx.store.insertItem({ title: 'the old plan', spec: 's', spec_format: 'f', created_by: actor() });
    fx.setNow('2026-06-01T00:00:00.000Z');
    const b = fx.store.insertItem({
      title: 'the new plan',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: a.id }],
    });

    const viewA = fx.store.getItemView(a.id);
    const viewB = fx.store.getItemView(b.id);
    // A learns it was superseded — the DERIVED reverse edge.
    expect(viewA?.referenced_by).toEqual([{ rel: 'supersedes', id: b.id }]);
    // B carries the forward edge and has no backlinks of its own.
    expect(viewB?.references).toEqual([{ rel: 'supersedes', id: a.id }]);
    expect(viewB?.referenced_by).toEqual([]);
    // Nothing was written back to A — the stored row has no reverse edge.
    expect(fx.store.getItem(a.id)?.references).toEqual([]);
    // The plain (non-view) reads are untouched: no referenced_by key.
    expect(fx.store.getItem(a.id)).not.toHaveProperty('referenced_by');
    // An unknown id still reads null.
    expect(fx.store.getItemView('01JZM8Z0000000000000000000')).toBeNull();
  });

  it('listItemViews derives the backlink even when the referring item is excluded by the filter', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const a = fx.store.insertItem({ title: 'target', spec: 's', spec_format: 'f', created_by: actor() });
    fx.setNow('2026-06-01T00:00:00.000Z');
    const b = fx.store.insertItem({
      title: 'replacement',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: a.id }],
    });
    // Move B out of the 'open' status the filter below selects (test
    // scaffolding standing in for the cancel verb — the same direct-status
    // seam verbs.test.ts uses), so B is scanned but excluded from the result.
    const db = openForWrite(fx.dbPath);
    try {
      db.prepare('UPDATE items SET status = ? WHERE id = ?').run('cancelled', b.id);
    } finally {
      db.close();
    }

    const views = fx.store.listItemViews({ status: 'open' });
    expect(views.map((v) => v.id)).toEqual([a.id]);
    expect(views[0]?.referenced_by).toEqual([{ rel: 'supersedes', id: b.id }]);
  });

  it('a legacy pre-v3 board (no "references" column) reads views as no-edges, never a raw no-such-column throw', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'work-state', 'board.db');
    mkdirSync(join(root, 'work-state'), { recursive: true });
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const seedDb = new sqlite.DatabaseSync(dbPath);
    seedDb.exec(LEGACY_V2_ITEMS_DDL);
    seedDb
      .prepare(
        `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, parent_id, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('legacy', 't', 'L', 's', 'f', 'open', '[]', NULL, 'dan', NULL, 'now', 'now', 1)`,
      )
      .run();
    seedDb.exec('PRAGMA user_version = 2');
    seedDb.close();

    const store = new WorkStateStore(dbPath, () => new Date(FIXED_ISO));
    // A pre-v3 board has no edges by definition: the view read derives an
    // EMPTY backlink via openForRead (no migration) — it does NOT throw
    // `no such column: "references"` at prepare time.
    const views = store.listItemViews();
    expect(views.map((v) => v.id)).toEqual(['legacy']);
    expect(views[0]?.referenced_by).toEqual([]);
    expect(store.getItemView('legacy')?.referenced_by).toEqual([]);
  });

  it('fan-in: two items superseding one target both surface as backlinks on it', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const target = fx.store.insertItem({ title: 'the original', spec: 's', spec_format: 'f', created_by: actor() });
    fx.setNow('2026-06-01T00:00:00.000Z');
    const b = fx.store.insertItem({
      title: 'replacement one',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: target.id }],
    });
    fx.setNow('2026-07-01T00:00:00.000Z');
    const c = fx.store.insertItem({
      title: 'replacement two',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: target.id }],
    });

    const targetView = fx.store.getItemView(target.id);
    // Both B and C point at the target — newest-first read emits both backlinks.
    expect(targetView?.referenced_by).toEqual([
      { rel: 'supersedes', id: c.id },
      { rel: 'supersedes', id: b.id },
    ]);
  });

  it('chain: A←B←C — each link surfaces the next as a backlink, C has none', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const a = fx.store.insertItem({ title: 'oldest', spec: 's', spec_format: 'f', created_by: actor() });
    fx.setNow('2026-06-01T00:00:00.000Z');
    const b = fx.store.insertItem({
      title: 'middle',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: a.id }],
    });
    fx.setNow('2026-07-01T00:00:00.000Z');
    const c = fx.store.insertItem({
      title: 'newest',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: b.id }],
    });

    const views = fx.store.listItemViews();
    const viewA = views.find((v) => v.id === a.id);
    const viewB = views.find((v) => v.id === b.id);
    const viewC = views.find((v) => v.id === c.id);
    // A is superseded only by B (C points at B, not A — chains are not transitive).
    expect(viewA?.referenced_by).toEqual([{ rel: 'supersedes', id: b.id }]);
    expect(viewB?.referenced_by).toEqual([{ rel: 'supersedes', id: c.id }]);
    // C is the newest link — no backlinks of its own.
    expect(viewC?.referenced_by).toEqual([]);
  });
});

describe('parent_id containment', () => {
  it('round-trips a parent_id through insert and read; a missing one is null (root)', () => {
    const { store } = makeFixture();
    const parent = store.insertItem({ title: 'parent', spec: 's', spec_format: 'f', created_by: actor() });
    expect(parent.parent_id).toBeNull();

    const child = store.insertItem({
      title: 'child',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      parent_id: parent.id,
    });
    expect(child.parent_id).toBe(parent.id);
    expect(store.getItem(child.id)?.parent_id).toBe(parent.id);

    // Explicit null on create is a root, identical to absent.
    const rootExplicit = store.insertItem({ title: 'r', spec: 's', spec_format: 'f', created_by: actor(), parent_id: null });
    expect(rootExplicit.parent_id).toBeNull();
  });

  it('updateMeta is tri-state: absent leaves it unchanged, a string sets it, null clears to root', () => {
    const { store } = makeFixture();
    const p1 = store.insertItem({ title: 'p1', spec: 's', spec_format: 'f', created_by: actor() });
    const p2 = store.insertItem({ title: 'p2', spec: 's', spec_format: 'f', created_by: actor() });
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor(), parent_id: p1.id });
    expect(item.parent_id).toBe(p1.id);

    // Absent parent_id: unchanged (only title moves).
    const renamed = store.updateMeta(item.id, item.version, { title: 'x2' });
    expect(renamed.parent_id).toBe(p1.id);

    // String: move the parent.
    const moved = store.updateMeta(item.id, renamed.version, { parent_id: p2.id });
    expect(moved.parent_id).toBe(p2.id);

    // Null: clear to root.
    const cleared = store.updateMeta(item.id, moved.version, { parent_id: null });
    expect(cleared.parent_id).toBeNull();
  });

  it('listItems tri-state filter: children-of a parent, and roots-only', () => {
    const { store } = makeFixture();
    const parent = store.insertItem({ title: 'parent', spec: 's', spec_format: 'f', created_by: actor() });
    const childA = store.insertItem({ title: 'a', spec: 's', spec_format: 'f', created_by: actor(), parent_id: parent.id });
    const childB = store.insertItem({ title: 'b', spec: 's', spec_format: 'f', created_by: actor(), parent_id: parent.id });
    const otherRoot = store.insertItem({ title: 'other', spec: 's', spec_format: 'f', created_by: actor() });

    // No parent_id key: everything (4 items).
    expect(store.listItems()).toHaveLength(4);

    // children-of: exactly the two children.
    const children = store.listItems({ parent_id: parent.id });
    expect(children.map((i) => i.id).sort()).toEqual([childA.id, childB.id].sort());

    // roots-only (null): the two parentless items.
    const roots = store.listItems({ parent_id: null });
    expect(roots.map((i) => i.id).sort()).toEqual([parent.id, otherRoot.id].sort());
  });

  it('parent_id is independent of depends_on — set one without touching the other', () => {
    const { store } = makeFixture();
    const dep = store.insertItem({ title: 'dep', spec: 's', spec_format: 'f', created_by: actor() });
    const parent = store.insertItem({ title: 'parent', spec: 's', spec_format: 'f', created_by: actor() });
    const item = store.insertItem({
      title: 'x',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      depends_on: [dep.id],
      parent_id: parent.id,
    });
    expect(item.depends_on).toEqual([dep.id]);
    expect(item.parent_id).toBe(parent.id);

    // Clearing the parent leaves depends_on intact.
    const cleared = store.updateMeta(item.id, item.version, { parent_id: null });
    expect(cleared.parent_id).toBeNull();
    expect(cleared.depends_on).toEqual([dep.id]);

    // Replacing depends_on leaves the parent intact.
    const reparented = store.updateMeta(cleared.id, cleared.version, { parent_id: parent.id });
    const redep = store.updateMeta(reparented.id, reparented.version, { depends_on: [] });
    expect(redep.depends_on).toEqual([]);
    expect(redep.parent_id).toBe(parent.id);
  });
});

describe('summary projection + keyset paging (the store half)', () => {
  /** Seed `count` items one minute apart, newest last. Returns the ids
   *  NEWEST-FIRST — the order every list read emits. The instant is derived by
   *  ARITHMETIC on the base epoch rather than by formatting the index into the
   *  minute field, which would silently cap a board at 59 items. */
  function seedBoard(fx: Fixture, count: number, spec = 'spec body'): string[] {
    const base = Date.parse(FIXED_ISO);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      fx.setNow(new Date(base + i * 60_000).toISOString());
      ids.push(fx.store.insertItem({ title: `item ${String(i)}`, spec, spec_format: 'f', created_by: actor() }).id);
    }
    return ids.reverse();
  }

  /** Walk the projected read from the first page to a null cursor. */
  function walkAll(fx: Fixture, limit: number): string[] {
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page = fx.store.listItemSummaryViews(undefined, { limit, ...(cursor === null ? {} : { cursor }) });
      // A page that promises more must have moved the walk forward, or this
      // loop would not terminate.
      expect(page.items.length).toBeGreaterThan(0);
      walked.push(...page.items.map((item) => item.id));
      cursor = page.next_cursor;
    } while (cursor !== null);
    return walked;
  }

  it('absent page options behave exactly like the unpaginated read — every matching item, no cursor', () => {
    const fx = makeFixture();
    const ids = seedBoard(fx, 5);
    const page = fx.store.listItemSummaryViews();
    // This is the property context/assemble-prototype.ts's full-board sweep
    // depends on: this layer imposes NO default page size.
    expect(page.items.map((i) => i.id)).toEqual(ids);
    expect(page.next_cursor).toBeNull();
  });

  it('an ABSENT limit is UNBOUNDED at this layer — every item, past any page default a transport applies', () => {
    const fx = makeFixture();
    // MORE than DEFAULT_LIST_LIMIT, deliberately: the test above seeds 5, so
    // it can only catch a leaked default below 5 — never the one anyone would
    // actually write, which is the transport's own page size. Both unbounded
    // reads are checked, because both are what an in-repo consumer sweeping
    // the whole board (context/assemble-prototype.ts) rests on; a default
    // parked in this layer would truncate it silently.
    const ids = seedBoard(fx, DEFAULT_LIST_LIMIT + 5);
    expect(fx.store.listItemViews().map((item) => item.id)).toEqual(ids);
    const page = fx.store.listItemSummaryViews();
    expect(page.items.map((item) => item.id)).toEqual(ids);
    expect(page.next_cursor).toBeNull();
    // …while the same read WITH a page size is bounded, so the contrast is
    // real rather than an artefact of a too-small fixture.
    expect(fx.store.listItemSummaryViews(undefined, { limit: DEFAULT_LIST_LIMIT }).items).toHaveLength(DEFAULT_LIST_LIMIT);
  });

  it('projects spec away and reports SQLite LENGTH(spec) as spec_length; include_spec puts the body back', () => {
    const fx = makeFixture();
    const spec = 'x'.repeat(2048);
    fx.store.insertItem({ title: 'x', spec, spec_format: 'f', created_by: actor() });

    const summary = fx.store.listItemSummaryViews().items[0];
    expect(summary).not.toHaveProperty('spec');
    expect(summary?.spec_length).toBe(2048);
    // Every other current field survives the projection untouched.
    expect(Object.keys(summary ?? {}).sort()).toEqual(
      [
        'id',
        'tenant_id',
        'title',
        'spec_length',
        'spec_format',
        'status',
        'claim',
        'depends_on',
        'parent_id',
        'references',
        'referenced_by',
        'created_by',
        'created_at',
        'updated_at',
        'version',
      ].sort(),
    );

    const withSpec = fx.store.listItemSummaryViews(undefined, { include_spec: true }).items[0];
    expect(withSpec?.spec).toBe(spec);
    expect(withSpec?.spec_length).toBe(2048);
  });

  it('clampListLimit clamps out-of-range sizes and rejects a non-integer with a typed SCHEMA error', () => {
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(-5)).toBe(1);
    expect(clampListLimit(1)).toBe(1);
    expect(clampListLimit(9999)).toBe(MAX_LIST_LIMIT);
    expect(clampListLimit(MAX_LIST_LIMIT)).toBe(MAX_LIST_LIMIT);
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => clampListLimit(bad)).toThrow(WorkStateError);
      expect(() => clampListLimit(bad)).toThrow(/must be an integer/);
    }
  });

  it('never returns more than MAX_LIST_LIMIT rows, whatever the caller asks for', () => {
    const fx = makeFixture();
    // Seeded through one write connection: this test needs MAX+1 rows, and
    // the store's per-call open/close would make that needlessly slow. The
    // rows are read back through the real store.
    const db = openForWrite(fx.dbPath);
    try {
      const insert = db.prepare(
        `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, parent_id, "references",
          created_by_human, created_by_agent, created_at, updated_at, version, claim_token_counter)
         VALUES (?, 'local', 't', 's', 'f', 'open', '[]', NULL, '[]', 'dan', NULL, ?, ?, 1, 0)`,
      );
      for (let i = 0; i <= MAX_LIST_LIMIT; i += 1) {
        const at = `2026-07-11T12:00:00.${String(i).padStart(3, '0')}Z`;
        insert.run(`seed-${String(i).padStart(4, '0')}`, at, at);
      }
    } finally {
      db.close();
    }

    const page = fx.store.listItemSummaryViews(undefined, { limit: 9999 });
    expect(page.items).toHaveLength(MAX_LIST_LIMIT);
    expect(page.next_cursor).toBeTypeOf('string');
  });

  it('encodes/decodes a page cursor as canonical base64url of [created_at, id]', () => {
    const cursor = encodeListCursor('2026-07-11T12:00:00.000Z', '01JZM8Z0000000000000000000');
    // Opaque to callers, but it must be URL-safe base64 with no padding.
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeListCursor(cursor)).toEqual({ created_at: '2026-07-11T12:00:00.000Z', id: '01JZM8Z0000000000000000000' });
  });

  it('rejects every shape of malformed cursor with a typed SCHEMA error (guarding the guard)', () => {
    const cases: [string, string][] = [
      ['not-a-cursor!!', 'non-base64url characters'],
      ['e30=', 'padded, non-canonical base64url'],
      ['', 'empty'],
      [Buffer.from('not json', 'utf8').toString('base64url'), 'valid base64url, not JSON'],
      [Buffer.from('{}', 'utf8').toString('base64url'), 'JSON, but not the [created_at, id] pair'],
      [Buffer.from('["only-one"]', 'utf8').toString('base64url'), 'a one-element array'],
      [Buffer.from('["ts", 7]', 'utf8').toString('base64url'), 'a non-string id'],
    ];
    for (const [cursor, why] of cases) {
      expect(() => decodeListCursor(cursor), why).toThrow(WorkStateError);
      expect(() => decodeListCursor(cursor), why).toThrow(/not a valid page cursor/);
    }
  });

  it('a malformed cursor throws even on a board that does not exist yet — never a silent empty page', () => {
    const fx = makeFixture();
    // Nothing has ever been written: the read path returns null from
    // openForRead, and that must NOT swallow the bad cursor.
    expect(existsSync(fx.dbPath)).toBe(false);
    expect(() => fx.store.listItemSummaryViews(undefined, { cursor: 'not-a-cursor!!' })).toThrow(WorkStateError);
    // A well-formed cursor on an empty board is simply an empty page.
    expect(fx.store.listItemSummaryViews(undefined, { cursor: encodeListCursor('2026-01-01T00:00:00.000Z', 'x') })).toEqual({
      items: [],
      next_cursor: null,
    });
  });

  it('validates a cursor\'s ENCODING, not its CONTENTS: a well-formed cursor naming a boundary no row ever had is simply an empty page', () => {
    const fx = makeFixture();
    seedBoard(fx, 3);
    // The exact non-guarantee decodeListCursor's doc comment now states, kept
    // honest here rather than in prose alone. Cursors are opaque and echoed
    // back verbatim, so this is unreachable without hand-building one — and
    // the same "no rows after this boundary" answer is the CORRECT one at true
    // exhaustion, so there is nothing to distinguish it from.
    const bogus = encodeListCursor('', '');
    expect(decodeListCursor(bogus)).toEqual({ created_at: '', id: '' });
    expect(fx.store.listItemSummaryViews(undefined, { limit: 10, cursor: bogus })).toEqual({ items: [], next_cursor: null });
  });

  it('the containment read carries no spec bodies and covers the whole board', () => {
    const fx = makeFixture();
    const parent = fx.store.insertItem({ title: 'p', spec: 'x'.repeat(5000), spec_format: 'f', created_by: actor() });
    const child = fx.store.insertItem({ title: 'c', spec: 'x'.repeat(5000), spec_format: 'f', created_by: actor(), parent_id: parent.id });
    const rows = fx.store.listContainmentRows();
    expect(rows).toHaveLength(2);
    expect([...rows].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: parent.id, parent_id: null, status: 'open' },
        { id: child.id, parent_id: parent.id, status: 'open' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // Grep-falsifiable: no spec field on the row shape at all.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'parent_id', 'status']);
  });

  it('a legacy pre-v3 board (no "references" column) reads summaries as no-edges, never a raw no-such-column throw', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'work-state', 'board.db');
    mkdirSync(join(root, 'work-state'), { recursive: true });
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const seedDb = new sqlite.DatabaseSync(dbPath);
    seedDb.exec(LEGACY_V2_ITEMS_DDL);
    seedDb
      .prepare(
        `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, parent_id, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('legacy', 't', 'L', 'spec', 'f', 'open', '[]', NULL, 'dan', NULL, 'now', 'now', 1)`,
      )
      .run();
    seedDb.exec('PRAGMA user_version = 2');
    seedDb.close();

    const store = new WorkStateStore(dbPath, () => new Date(FIXED_ISO));
    // The projected SELECT names the migration-added columns EXPLICITLY, so
    // the column-presence guard is what keeps this from throwing `no such
    // column: "references"` at prepare time.
    const page = store.listItemSummaryViews(undefined, { limit: 10 });
    expect(page.items.map((i) => i.id)).toEqual(['legacy']);
    expect(page.items[0]?.references).toEqual([]);
    expect(page.items[0]?.referenced_by).toEqual([]);
    expect(page.items[0]?.spec_length).toBe(4);
    expect(store.listContainmentRows()).toEqual([{ id: 'legacy', parent_id: null, status: 'open' }]);
  });

  it('a summary row carries exactly the full view row keys, minus spec, plus spec_length — derived from the live objects', () => {
    const fx = makeFixture();
    fx.store.insertItem({ title: 't', spec: 'spec body', spec_format: 'f', created_by: actor() });
    const full = fx.store.listItemViews()[0];
    const summary = fx.store.listItemSummaryViews().items[0];
    const expected = new Set(Object.keys(full ?? {}));
    expected.delete('spec');
    expected.add('spec_length');
    // Contract point 1, asserted against the two objects the code actually
    // produces rather than against a copied literal.
    expect(new Set(Object.keys(summary ?? {}))).toEqual(expected);
  });

  it('the projection names EVERY items column except spec — held against the live DDL, so a new column cannot silently vanish (P-52)', () => {
    const fx = makeFixture();
    fx.store.insertItem({ title: 't', spec: 'spec body', spec_format: 'f', created_by: actor() });
    const db = openForWrite(fx.dbPath);
    try {
      const ddlColumns = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map((c) => c.name);
      // EXACTLY two documented exclusions, both named in summaryColumns's own
      // doc comment: `spec` (the point of the projection — replaced by
      // spec_length) and `claim_token_counter` (the internal fencing-token
      // source, which is not a WorkItem field and is absent from the full
      // read's ItemRow too). Everything else the DDL grows must appear here,
      // or this fails — which is the mechanical check the hand-written column
      // list otherwise lacks.
      expect(ddlColumns).toContain('spec');
      expect(ddlColumns).toContain('claim_token_counter');
      const expected = [...ddlColumns.filter((name) => name !== 'spec' && name !== 'claim_token_counter'), 'spec_length'];

      const projected = db.prepare(`SELECT ${summaryColumns(db, false).join(', ')} FROM items LIMIT 1`).get() as Record<string, unknown>;
      expect(Object.keys(projected).sort()).toEqual([...expected].sort());
      // …and include_spec adds back exactly one column, never more.
      const withSpec = db.prepare(`SELECT ${summaryColumns(db, true).join(', ')} FROM items LIMIT 1`).get() as Record<string, unknown>;
      expect(Object.keys(withSpec).sort()).toEqual([...expected, 'spec'].sort());
    } finally {
      db.close();
    }
  });

  it('walks a created_at TIE without duplicating or skipping a row — the case the (created_at = ? AND id < ?) arm exists for', () => {
    const fx = makeFixture();
    // The board mints a ULID and a millisecond stamp together, so a batch
    // create landing several items inside ONE millisecond is ordinary, not
    // exotic — and every other fixture in this file uses distinct stamps, so
    // nothing else exercises the equality arm of the keyset predicate.
    fx.setNow('2026-07-11T12:00:00.000Z');
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(fx.store.insertItem({ title: `tie ${String(i)}`, spec: 's', spec_format: 'f', created_by: actor() }).id);
    }
    const unpaged = fx.store.listItemViews();
    expect(new Set(unpaged.map((item) => item.created_at))).toEqual(new Set(['2026-07-11T12:00:00.000Z']));

    // Paged at a size that lands boundaries INSIDE the tie, twice.
    expect(walkAll(fx, 2)).toEqual(unpaged.map((item) => item.id));
    expect(walkAll(fx, 1)).toEqual(unpaged.map((item) => item.id));
    expect(new Set(walkAll(fx, 2)).size).toBe(ids.length);
  });

  it('spec_length counts CODE POINTS, not UTF-16 units — the SQL LENGTH() semantics this module promises (file header)', () => {
    const fx = makeFixture();
    // Astral-plane text: 10 characters, 20 UTF-16 code units. This is the one
    // input on which SQLite's LENGTH() and String.prototype.length disagree,
    // and the header claims the SQL answer is what ships.
    const spec = '\u{1F600}'.repeat(10);
    expect(spec.length).toBe(20);
    fx.store.insertItem({ title: 't', spec, spec_format: 'f', created_by: actor() });

    const summary = fx.store.listItemSummaryViews().items[0];
    expect(summary?.spec_length).toBe(10);
    expect(summary?.spec_length).not.toBe(spec.length);
    // …and the opted-in body is still the exact string that went in: only the
    // COUNT is measured in code points, never the payload.
    expect(fx.store.listItemSummaryViews(undefined, { include_spec: true }).items[0]?.spec).toBe(spec);
  });

  it('a pre-v2 board (no parent_id column either) reads summaries and containment rows as roots, never a prepare-time no-such-column throw', () => {
    const root = makeTempDir();
    const dbPath = join(root, 'work-state', 'board.db');
    mkdirSync(join(root, 'work-state'), { recursive: true });
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
    const seedDb = new sqlite.DatabaseSync(dbPath);
    seedDb.exec(LEGACY_V1_ITEMS_DDL);
    seedDb
      .prepare(
        `INSERT INTO items (id, tenant_id, title, spec, spec_format, status, depends_on, created_by_human, created_by_agent, created_at, updated_at, version) VALUES ('legacy-v1', 't', 'L', 'spec', 'f', 'open', '[]', 'dan', NULL, 'now', 'now', 1)`,
      )
      .run();
    seedDb.exec('PRAGMA user_version = 1');
    // The guard is load-bearing, not decorative: naming the column outright on
    // this board fails at PREPARE time, before any row is read — so a per-row
    // `?? null` could never have covered it.
    expect(() => seedDb.prepare('SELECT id, parent_id, status FROM items')).toThrow(/no such column/);
    seedDb.close();

    const store = new WorkStateStore(dbPath, () => new Date(FIXED_ISO));
    const page = store.listItemSummaryViews(undefined, { limit: 10 });
    expect(page.items.map((i) => i.id)).toEqual(['legacy-v1']);
    // Both migration-added columns fall back to their documented defaults.
    expect(page.items[0]?.parent_id).toBeNull();
    expect(page.items[0]?.references).toEqual([]);
    expect(page.items[0]?.referenced_by).toEqual([]);
    expect(page.items[0]?.spec_length).toBe(4);
    expect(store.listContainmentRows()).toEqual([{ id: 'legacy-v1', parent_id: null, status: 'open' }]);
  });

  it('derives referenced_by from the WHOLE board even when the referring item is on another page', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const target = fx.store.insertItem({ title: 'target', spec: 's', spec_format: 'f', created_by: actor() });
    fx.setNow('2026-06-01T00:00:00.000Z');
    const replacement = fx.store.insertItem({
      title: 'replacement',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      references: [{ rel: 'supersedes', id: target.id }],
    });

    // Page 2 holds the target alone; its referrer sits on page 1.
    const first = fx.store.listItemSummaryViews(undefined, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([replacement.id]);
    const second = fx.store.listItemSummaryViews(undefined, { limit: 1, cursor: first.next_cursor as string });
    expect(second.items.map((i) => i.id)).toEqual([target.id]);
    expect(second.items[0]?.referenced_by).toEqual([{ rel: 'supersedes', id: replacement.id }]);
    expect(second.next_cursor).toBeNull();
  });
});

describe('P-40 sibling-parity sweep: cross-process freshness (no per-instance read cache)', () => {
  it('an insert from a SECOND WorkStateStore instance is visible on the FIRST instance\'s very next listItemViews(), even after A already listed a WARMED item from its OWN prior insert — no stale cross-instance state', () => {
    // Mirrors record/store.ts's own cross-process freshness test (the bug
    // that motivated this sweep) and the "WAL + busy-timeout" describe
    // block above, but frames it explicitly as a BEFORE/write/AFTER
    // staleness check rather than "both items are eventually visible
    // somehow". getItem/listItems/listItemViews each open (and close) their
    // own connection per call (schema.ts's openForRead/openForWrite) and
    // hold no query result, prepared statement, or referrer map on the
    // store instance between calls — the engine (SQLite), not application
    // memory, owns cross-connection visibility. This test would fail the
    // moment any of those reads started reusing state across calls without
    // invalidating it on a foreign write.
    //
    // A lists a REAL item of its own BEFORE B ever writes, rather than
    // starting from the board empty: an empty-first oracle only exercises a
    // memo's "no rows yet" branch, and a memo that happens not to cache that
    // branch (while still caching the with-data case) would slip straight
    // through it.
    const root = makeTempDir();
    const dbPath = join(root, 'board.db');
    let nowIso = FIXED_ISO;
    const clock: Clock = () => new Date(nowIso);
    const storeA = new WorkStateStore(dbPath, clock);
    const storeB = new WorkStateStore(dbPath, clock);

    // A inserts and lists its OWN item first, warming any per-instance
    // memo with real data.
    const itemA = storeA.insertItem({ title: 'seen first by A', spec: 's', spec_format: 'f', created_by: actor() });
    expect(storeA.listItemViews().map((item) => item.id)).toEqual([itemA.id]);

    // B (a DIFFERENT instance, same db file) inserts a SECOND item, later.
    nowIso = '2026-07-12T00:00:00.000Z';
    const itemB = storeB.insertItem({ title: 'written by instance B', spec: 's', spec_format: 'f', created_by: actor() });

    // A's very next listItemViews() must see BOTH — its own earlier item
    // AND B's, newest first.
    const seen = storeA.listItemViews();
    expect(seen.map((item) => item.id)).toEqual([itemB.id, itemA.id]);
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
