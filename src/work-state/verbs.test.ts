// plugin/src/work-state/verbs.test.ts — WI-302 acceptance tests for the
// seven non-claim board verbs (create, get, list, update_meta, cancel,
// reopen, events).
//
// All filesystem work happens in mkdtemp dirs — the real .ideate-work/ is
// never touched. A few tests manufacture `in_progress`/`done` item states
// directly against the `items` table (via schema.ts's exported
// `openForWrite`, the same seam verbs.ts itself uses for cancel/reopen) —
// this is deliberate test scaffolding standing in for the claim/complete
// verbs, which are WI-301's scope and are not implemented in this file.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { DagError } from './dag.js';
import { openForWrite } from './schema.js';
import { WorkStateStore } from './store.js';
import { WorkStateError } from './types.js';
import type { ActorRef, WorkItemStatus } from './types.js';
import { VerbError, WorkStateVerbs, noopExpiryCheck } from './verbs.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-state-verbs-test-'));
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
  verbs: WorkStateVerbs;
  dbPath: string;
  setNow: (iso: string) => void;
}

function makeFixture(): Fixture {
  const root = makeTempDir();
  const dbPath = join(root, 'work-state', 'board.db');
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const store = new WorkStateStore(dbPath, clock);
  const verbs = new WorkStateVerbs(store, clock);
  return {
    store,
    verbs,
    dbPath,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

function actor(human = 'dan'): ActorRef {
  return { human };
}

/** Test-only scaffolding: force an item's stored status (and optionally its
 *  claim columns) directly, standing in for the claim/complete verbs that
 *  are out of this work item's scope. Bypasses verbs.ts entirely. */
function forceStatus(
  dbPath: string,
  id: string,
  status: WorkItemStatus,
  claim?: { holderHuman: string; token: number; acquiredAt: string; leaseExpires: string },
): void {
  const db = openForWrite(dbPath);
  try {
    if (claim === undefined) {
      db.prepare('UPDATE items SET status = ? WHERE id = ?').run(status, id);
    } else {
      db.prepare(
        `UPDATE items SET status = ?, claim_holder_human = ?, claim_holder_agent = NULL,
           claim_token = ?, claim_acquired_at = ?, claim_lease_expires = ? WHERE id = ?`,
      ).run(status, claim.holderHuman, claim.token, claim.acquiredAt, claim.leaseExpires, id);
    }
  } finally {
    db.close();
  }
}

function createBasic(verbs: WorkStateVerbs, title: string, dependsOn?: string[]) {
  return verbs.create({
    title,
    spec: 'plain prompt',
    spec_format: 'text/plain',
    created_by: actor(),
    ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
  });
}

describe('create', () => {
  it('creates an item with no depends_on', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    expect(item.status).toBe('open');
    expect(item.depends_on).toEqual([]);
  });

  it('creates an item depending on an existing item', () => {
    const { verbs } = makeFixture();
    const dep = createBasic(verbs, 'dep');
    const item = createBasic(verbs, 'dependent', [dep.id]);
    expect(item.depends_on).toEqual([dep.id]);
  });

  it('rejects a dangling depends_on reference with a typed DagError', () => {
    const { verbs } = makeFixture();
    let thrown: unknown;
    try {
      createBasic(verbs, 'x', ['01JZM8Z0000000000000000000']);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_DEPENDENCY');
    // Nothing was persisted.
    expect(verbs.list()).toEqual([]);
  });

  it('rejects a cycle among the referenced items, named in the typed error (create-time defense-in-depth)', () => {
    const { verbs, dbPath } = makeFixture();
    // Manufacture a pre-existing cycle between two items, bypassing the
    // guard that would normally prevent it (simulating corruption) — this
    // exercises create()'s own cycle check against the REFERENCED
    // sub-graph, since a brand-new item cannot itself be part of a cycle
    // (see verbs.ts's create() doc comment).
    const x = createBasic(verbs, 'x');
    const y = createBasic(verbs, 'y', [x.id]);
    // Force x to also depend on y directly against the DB, closing the loop.
    const db = openForWrite(dbPath);
    try {
      db.prepare('UPDATE items SET depends_on = ? WHERE id = ?').run(JSON.stringify([y.id]), x.id);
    } finally {
      db.close();
    }

    let thrown: unknown;
    try {
      createBasic(verbs, 'new-item', [x.id]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('CYCLE');
    expect((thrown as DagError).message).toContain(`${x.id} → ${y.id} → ${x.id}`);
  });
});

describe('get / list / events', () => {
  it('get returns null for a nonexistent id', () => {
    const { verbs } = makeFixture();
    expect(verbs.get('01JZM8Z0000000000000000000')).toBeNull();
  });

  it('get returns the item for an existing id', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    expect(verbs.get(item.id)?.title).toBe('x');
  });

  it('events returns the full audit trail, oldest first', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    expect(verbs.events(item.id).map((e) => e.transition)).toEqual(['create']);
  });

  it("list() attaches a derived claimable=true for an open item with no depends_on", () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    const listed = verbs.list().find((i) => i.id === item.id);
    expect(listed?.claimable).toBe(true);
  });

  it('list() attaches claimable=false for an open item whose dependency is not done', () => {
    const { verbs } = makeFixture();
    const dep = createBasic(verbs, 'dep');
    const item = createBasic(verbs, 'dependent', [dep.id]);
    const listed = verbs.list().find((i) => i.id === item.id);
    expect(listed?.claimable).toBe(false);
  });

  it('list() attaches claimable=true once the dependency is done', () => {
    const { verbs, dbPath } = makeFixture();
    const dep = createBasic(verbs, 'dep');
    const item = createBasic(verbs, 'dependent', [dep.id]);
    forceStatus(dbPath, dep.id, 'done');
    const listed = verbs.list().find((i) => i.id === item.id);
    expect(listed?.claimable).toBe(true);
  });

  it('list() reflects TRANSITIVELY-satisfied dependencies: A -> B -> C, both done, A is claimable', () => {
    const { verbs, dbPath } = makeFixture();
    const c = createBasic(verbs, 'c');
    forceStatus(dbPath, c.id, 'done');
    const b = createBasic(verbs, 'b', [c.id]);
    forceStatus(dbPath, b.id, 'done');
    const a = createBasic(verbs, 'a', [b.id]);

    const listed = verbs.list().find((i) => i.id === a.id);
    expect(listed?.claimable).toBe(true);
  });

  it('list() is claimable=false for a non-open item regardless of depends_on', () => {
    const { verbs, dbPath } = makeFixture();
    const item = createBasic(verbs, 'x');
    forceStatus(dbPath, item.id, 'done');
    const listed = verbs.list().find((i) => i.id === item.id);
    expect(listed?.claimable).toBe(false);
  });

  it('list() honors the underlying tenant/status filter and still computes claimable per item', () => {
    const { verbs } = makeFixture();
    createBasic(verbs, 'x');
    createBasic(verbs, 'y');
    const open = verbs.list({ status: 'open' });
    expect(open).toHaveLength(2);
    expect(open.every((i) => i.claimable)).toBe(true);
  });
});

describe('update_meta', () => {
  it('updates metadata and bumps version (delegates to the store CAS)', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    const updated = verbs.updateMeta(item.id, item.version, { title: 'x2' });
    expect(updated.title).toBe('x2');
    expect(updated.version).toBe(2);
  });

  it('throws the store\'s typed VERSION_CONFLICT on a stale expectedVersion', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    let thrown: unknown;
    try {
      verbs.updateMeta(item.id, item.version + 1, { title: 'x2' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkStateError);
    expect((thrown as WorkStateError).code).toBe('VERSION_CONFLICT');
  });

  it('rejects a dangling depends_on reference with a typed DagError, before any write', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    let thrown: unknown;
    try {
      verbs.updateMeta(item.id, item.version, { depends_on: ['01JZM8Z0000000000000000000'] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_DEPENDENCY');
    // Unchanged.
    expect(verbs.get(item.id)?.version).toBe(item.version);
  });

  it('rejects a cycle-introducing depends_on edit, naming the cycle path with real ids', () => {
    const { verbs } = makeFixture();
    const a = createBasic(verbs, 'a');
    const b = createBasic(verbs, 'b', [a.id]); // b -> a, fine, acyclic

    let thrown: unknown;
    try {
      // a -> b would close the loop: a -> b -> a.
      verbs.updateMeta(a.id, a.version, { depends_on: [b.id] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('CYCLE');
    expect((thrown as DagError).message).toContain(`${a.id} → ${b.id} → ${a.id}`);
    // Unchanged — the rejected edit never reached the store.
    expect(verbs.get(a.id)?.depends_on).toEqual([]);
  });

  it('recovery per §3.1: a corrected update_meta (no cycle) succeeds after a rejected one', () => {
    const { verbs } = makeFixture();
    const a = createBasic(verbs, 'a');
    const b = createBasic(verbs, 'b', [a.id]);
    expect(() => verbs.updateMeta(a.id, a.version, { depends_on: [b.id] })).toThrow(DagError);
    // Corrected: clear a's depends_on instead of introducing the cycle.
    const fixed = verbs.updateMeta(a.id, a.version, { depends_on: [] });
    expect(fixed.depends_on).toEqual([]);
  });

  it('never parses or transforms spec — an opaque string round-trips byte-for-byte', () => {
    const { verbs } = makeFixture();
    const opaque = '{"not": "json to us"} <also-not-xml/>';
    const item = createBasic(verbs, 'x');
    const updated = verbs.updateMeta(item.id, item.version, { spec: opaque });
    expect(updated.spec).toBe(opaque);
  });
});

describe('cancel', () => {
  it('cancels an open item; audited "cancel" event carries no claim_token (nothing to void)', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    const cancelled = verbs.cancel(item.id, actor());
    expect(cancelled.status).toBe('cancelled');
    const events = verbs.events(item.id);
    const cancelEvent = events.find((e) => e.transition === 'cancel');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.claim_token).toBeUndefined();
  });

  it('cancels an in_progress item AND voids the active claim, recording the voided token', () => {
    const { verbs, dbPath } = makeFixture();
    const item = createBasic(verbs, 'x');
    forceStatus(dbPath, item.id, 'in_progress', {
      holderHuman: 'dan',
      token: 7,
      acquiredAt: FIXED_ISO,
      leaseExpires: '2026-07-11T18:00:00.000Z',
    });

    const cancelled = verbs.cancel(item.id, actor());
    expect(cancelled.status).toBe('cancelled');
    // The item leaves the claimable pool: claim is voided.
    expect(cancelled.claim).toBeNull();

    const cancelEvent = verbs.events(item.id).find((e) => e.transition === 'cancel');
    expect(cancelEvent?.claim_token).toBe(7);
  });

  it('throws typed NOT_FOUND for a nonexistent id', () => {
    const { verbs } = makeFixture();
    let thrown: unknown;
    try {
      verbs.cancel('01JZM8Z0000000000000000000', actor());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WorkStateError);
    expect((thrown as WorkStateError).code).toBe('NOT_FOUND');
  });

  it('throws typed INVALID_TRANSITION for cancel-on-done', () => {
    const { verbs, dbPath } = makeFixture();
    const item = createBasic(verbs, 'x');
    forceStatus(dbPath, item.id, 'done');
    let thrown: unknown;
    try {
      verbs.cancel(item.id, actor());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VerbError);
    expect((thrown as VerbError).code).toBe('INVALID_TRANSITION');
    // Unchanged.
    expect(verbs.get(item.id)?.status).toBe('done');
  });

  it('throws typed INVALID_TRANSITION for cancel-on-cancelled (no double-cancel)', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    verbs.cancel(item.id, actor());
    expect(() => verbs.cancel(item.id, actor())).toThrow(VerbError);
  });
});

describe('reopen', () => {
  it('reopens a done item back to open', () => {
    const { verbs, dbPath } = makeFixture();
    const item = createBasic(verbs, 'x');
    forceStatus(dbPath, item.id, 'done');
    const reopened = verbs.reopen(item.id, actor());
    expect(reopened.status).toBe('open');
    expect(verbs.events(item.id).map((e) => e.transition)).toContain('reopen');
  });

  it('throws typed NOT_FOUND for a nonexistent id', () => {
    const { verbs } = makeFixture();
    expect(() => verbs.reopen('01JZM8Z0000000000000000000', actor())).toThrow(WorkStateError);
  });

  it('throws typed INVALID_TRANSITION for reopen-on-open', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    let thrown: unknown;
    try {
      verbs.reopen(item.id, actor());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VerbError);
    expect((thrown as VerbError).code).toBe('INVALID_TRANSITION');
  });

  it('throws typed INVALID_TRANSITION for reopen-on-in_progress', () => {
    const { verbs, dbPath } = makeFixture();
    const item = createBasic(verbs, 'x');
    forceStatus(dbPath, item.id, 'in_progress', {
      holderHuman: 'dan',
      token: 1,
      acquiredAt: FIXED_ISO,
      leaseExpires: '2026-07-11T18:00:00.000Z',
    });
    expect(() => verbs.reopen(item.id, actor())).toThrow(VerbError);
  });

  it('throws typed INVALID_TRANSITION for reopen-on-cancelled', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    verbs.cancel(item.id, actor());
    expect(() => verbs.reopen(item.id, actor())).toThrow(VerbError);
  });
});

describe('the lazy-expiry seam', () => {
  it('every id-scoped verb calls the injected expiryCheck exactly once, first, with the item id', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    const calls: string[] = [];
    const spy = (itemId: string): void => {
      calls.push(itemId);
    };

    verbs.get(item.id, spy);
    verbs.events(item.id, spy);
    verbs.updateMeta(item.id, item.version, { title: 'renamed' }, spy);
    verbs.cancel(item.id, actor(), spy);

    // F-302-001 M2: `reopen` was missing from this seam test. The item is
    // `cancelled` at this point (from the `cancel` call above), so `reopen`
    // (which requires `done`) is EXPECTED to throw its own typed
    // `INVALID_TRANSITION` error here — that rejection is a different
    // property than the one this test checks. What this test asserts is
    // that the expiry seam still fires FIRST, before that transition guard
    // ever runs — CHECK-fires-first is the property under test, not
    // whether the transition itself succeeds — so the throwing call is
    // wrapped rather than reordered around it.
    let reopenThrew = false;
    try {
      verbs.reopen(item.id, actor(), spy);
    } catch (err) {
      reopenThrew = true;
      expect(err).toBeInstanceOf(VerbError);
      expect((err as VerbError).code).toBe('INVALID_TRANSITION');
    }
    expect(reopenThrew).toBe(true);

    expect(calls).toEqual([item.id, item.id, item.id, item.id, item.id]);
  });

  it('defaults to noopExpiryCheck, which is a genuine no-op', () => {
    expect(() => noopExpiryCheck('anything')).not.toThrow();
  });
});

describe('"blocked" is never a stored status — it is a derived view only (§3.3)', () => {
  it('the word "blocked" is absent from every non-test work-state source file, outside comments', () => {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const full = join(srcDir, entry.name);
      const codeOnly = readFileSync(full, 'utf8')
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        })
        .join('\n');
      if (/\bblocked\b/i.test(codeOnly)) offenders.push(full);
    }
    expect(offenders).toEqual([]);
  });

  it('every status this file ever returns is one of the four stored values', () => {
    const { verbs, dbPath } = makeFixture();
    const item = createBasic(verbs, 'x');
    const cancelled = verbs.cancel(item.id, actor());
    const other = createBasic(verbs, 'y');
    forceStatus(dbPath, other.id, 'done');
    const reopened = verbs.reopen(other.id, actor());

    for (const status of [item.status, cancelled.status, reopened.status]) {
      expect(['open', 'in_progress', 'done', 'cancelled']).toContain(status);
    }
    for (const listed of verbs.list()) {
      expect(['open', 'in_progress', 'done', 'cancelled']).toContain(listed.status);
    }
  });
});
