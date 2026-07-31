// plugin/src/work-state/verbs.test.ts — acceptance tests for the
// seven non-claim board verbs (create, get, list, update_meta, cancel,
// reopen, events).
//
// All filesystem work happens in mkdtemp dirs — the real .ideate-work/ is
// never touched. A few tests manufacture `in_progress`/`done` item states
// directly against the `items` table (via schema.ts's exported
// `openForWrite`, the same seam verbs.ts itself uses for cancel/reopen) —
// this is deliberate test scaffolding standing in for the claim/complete
// verbs, which are claims.ts's scope and are not implemented in this file.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { DagError } from './dag.js';
import { openForWrite } from './schema.js';
import { DEFAULT_LIST_LIMIT, WorkStateStore } from './store.js';
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

  it('recovery: a corrected update_meta (no cycle) succeeds after a rejected one', () => {
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

describe('parent_id containment', () => {
  it('create accepts a parent_id and stores it', () => {
    const { verbs } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const child = verbs.create({
      title: 'child',
      spec: 'plain prompt',
      spec_format: 'text/plain',
      created_by: actor(),
      parent_id: parent.id,
    });
    expect(child.parent_id).toBe(parent.id);
  });

  it('create rejects a dangling parent_id with a typed DANGLING_PARENT error, before any write', () => {
    const { verbs } = makeFixture();
    let thrown: unknown;
    try {
      verbs.create({
        title: 'child',
        spec: 'plain prompt',
        spec_format: 'text/plain',
        created_by: actor(),
        parent_id: '01JZM8Z0000000000000000000',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_PARENT');
    // Nothing persisted.
    expect(verbs.list()).toEqual([]);
  });

  it('update_meta sets, moves, and clears parent_id (tri-state)', () => {
    const { verbs } = makeFixture();
    const p1 = createBasic(verbs, 'p1');
    const p2 = createBasic(verbs, 'p2');
    const item = createBasic(verbs, 'x');
    expect(item.parent_id).toBeNull();

    const set = verbs.updateMeta(item.id, item.version, { parent_id: p1.id });
    expect(set.parent_id).toBe(p1.id);

    const moved = verbs.updateMeta(item.id, set.version, { parent_id: p2.id });
    expect(moved.parent_id).toBe(p2.id);

    const cleared = verbs.updateMeta(item.id, moved.version, { parent_id: null });
    expect(cleared.parent_id).toBeNull();
  });

  it('update_meta rejects a self-parent with a typed PARENT_CYCLE naming the cycle', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    let thrown: unknown;
    try {
      verbs.updateMeta(item.id, item.version, { parent_id: item.id });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('PARENT_CYCLE');
    expect((thrown as DagError).message).toContain(`${item.id} → ${item.id}`);
    // Unchanged — the rejected edit never reached the store.
    expect(verbs.get(item.id)?.parent_id).toBeNull();
  });

  it('update_meta rejects a deeper ancestor cycle, naming the full chain with real ids', () => {
    const { verbs } = makeFixture();
    // a is a root; b's parent = a; c's parent = b. Proposing a's parent = c
    // closes a -> c -> b -> a.
    const a = createBasic(verbs, 'a');
    const b = verbs.create({ title: 'b', spec: 's', spec_format: 'text/plain', created_by: actor(), parent_id: a.id });
    const c = verbs.create({ title: 'c', spec: 's', spec_format: 'text/plain', created_by: actor(), parent_id: b.id });

    let thrown: unknown;
    try {
      verbs.updateMeta(a.id, a.version, { parent_id: c.id });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('PARENT_CYCLE');
    expect((thrown as DagError).message).toContain(`${a.id} → ${c.id} → ${b.id} → ${a.id}`);
  });

  it('update_meta rejects a dangling parent_id with a typed DANGLING_PARENT error', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    let thrown: unknown;
    try {
      verbs.updateMeta(item.id, item.version, { parent_id: '01JZM8Z0000000000000000000' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_PARENT');
    expect(verbs.get(item.id)?.version).toBe(item.version);
  });

  it('parent_id is independent of depends_on — setting one never mutates the other', () => {
    const { verbs } = makeFixture();
    const dep = createBasic(verbs, 'dep');
    const parent = createBasic(verbs, 'parent');
    const item = createBasic(verbs, 'x', [dep.id]);
    expect(item.depends_on).toEqual([dep.id]);
    expect(item.parent_id).toBeNull();

    // Setting the parent leaves depends_on untouched.
    const parented = verbs.updateMeta(item.id, item.version, { parent_id: parent.id });
    expect(parented.parent_id).toBe(parent.id);
    expect(parented.depends_on).toEqual([dep.id]);

    // Replacing depends_on leaves the parent untouched.
    const redep = verbs.updateMeta(parented.id, parented.version, { depends_on: [] });
    expect(redep.depends_on).toEqual([]);
    expect(redep.parent_id).toBe(parent.id);
  });

  it('NO cascade: cancelling a parent does not touch its children', () => {
    const { verbs } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const child = verbs.create({ title: 'child', spec: 's', spec_format: 'text/plain', created_by: actor(), parent_id: parent.id });

    verbs.cancel(parent.id, actor());
    expect(verbs.get(parent.id)?.status).toBe('cancelled');
    // The child is entirely unaffected — still open, still parented.
    const childAfter = verbs.get(child.id);
    expect(childAfter?.status).toBe('open');
    expect(childAfter?.parent_id).toBe(parent.id);
  });

  it('list filters children-of a parent and roots-only, with claimable still computed', () => {
    const { verbs } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const childA = verbs.create({ title: 'a', spec: 's', spec_format: 'text/plain', created_by: actor(), parent_id: parent.id });
    const childB = verbs.create({ title: 'b', spec: 's', spec_format: 'text/plain', created_by: actor(), parent_id: parent.id });
    const otherRoot = createBasic(verbs, 'other');

    const children = verbs.list({ parent_id: parent.id });
    expect(children.map((i) => i.id).sort()).toEqual([childA.id, childB.id].sort());
    // claimable is still derived per item (open, no deps => true).
    expect(children.every((i) => i.claimable)).toBe(true);

    const roots = verbs.list({ parent_id: null });
    expect(roots.map((i) => i.id).sort()).toEqual([parent.id, otherRoot.id].sort());
  });
});

describe('containment blocking (claimable)', () => {
  function createChild(verbs: WorkStateVerbs, title: string, parentId: string) {
    return verbs.create({ title, spec: 's', spec_format: 'text/plain', created_by: actor(), parent_id: parentId });
  }

  it('a parent with an open child is claimable=false; once all children are done, claimable=true', () => {
    const { verbs, dbPath } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const childA = createChild(verbs, 'a', parent.id);
    const childB = createChild(verbs, 'b', parent.id);

    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(false);

    forceStatus(dbPath, childA.id, 'done');
    // One child still pending — the parent is still not claimable.
    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(false);

    forceStatus(dbPath, childB.id, 'done');
    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(true);
  });

  it("a childless item's claimability is unchanged (depends_on behavior intact)", () => {
    const { verbs, dbPath } = makeFixture();
    // A childless item sitting NEXT TO a parent-with-pending-children is
    // itself unaffected by the containment gate.
    const parent = createBasic(verbs, 'parent');
    createChild(verbs, 'child', parent.id);
    const childless = createBasic(verbs, 'childless');
    expect(verbs.list().find((i) => i.id === childless.id)?.claimable).toBe(true);

    // And its depends_on gate still works exactly as before.
    const dep = createBasic(verbs, 'dep');
    const dependent = createBasic(verbs, 'dependent', [dep.id]);
    expect(verbs.list().find((i) => i.id === dependent.id)?.claimable).toBe(false);
    forceStatus(dbPath, dep.id, 'done');
    expect(verbs.list().find((i) => i.id === dependent.id)?.claimable).toBe(true);
  });

  it('a cancelled child does NOT block the parent (a cancelled child is resolved, not pending)', () => {
    const { verbs } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const child = createChild(verbs, 'child', parent.id);

    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(false);

    verbs.cancel(child.id, actor());
    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(true);
  });

  it('an in_progress child DOES block the parent', () => {
    const { verbs, dbPath } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const child = createChild(verbs, 'child', parent.id);

    forceStatus(dbPath, child.id, 'in_progress', {
      holderHuman: 'dan',
      token: 1,
      acquiredAt: FIXED_ISO,
      leaseExpires: '2026-07-11T13:00:00.000Z',
    });
    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(false);
  });

  it('containment blocking holds under a roots-only filter (the pending child is not in the result set)', () => {
    const { verbs } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    createChild(verbs, 'child', parent.id);

    const roots = verbs.list({ parent_id: null });
    expect(roots.map((i) => i.id)).toEqual([parent.id]);
    // The child is filtered OUT of the result, but the parent must still be
    // non-claimable — the gate scans the whole board, not the filtered view.
    expect(roots[0]?.claimable).toBe(false);
  });

  it('a non-open parent reports claimable=false regardless of its children', () => {
    const { verbs, dbPath } = makeFixture();
    const parent = createBasic(verbs, 'parent');
    const child = createChild(verbs, 'child', parent.id);
    forceStatus(dbPath, child.id, 'done');
    forceStatus(dbPath, parent.id, 'done');

    expect(verbs.list().find((i) => i.id === parent.id)?.claimable).toBe(false);
  });
});

describe('listSummaries — the projected, keyset-paged twin of list', () => {
  it('returns the same selection and the same claimable as list(), page by page, with spec projected away', () => {
    const fx = makeFixture();
    // A board that exercises BOTH claimability gates across page boundaries:
    // a parent whose pending child lands on a different page, and a dependent
    // whose unfinished dependency does too.
    fx.setNow('2026-07-11T12:00:00.000Z');
    const parent = createBasic(fx.verbs, 'parent');
    fx.setNow('2026-07-11T12:01:00.000Z');
    const dep = createBasic(fx.verbs, 'dep');
    fx.setNow('2026-07-11T12:02:00.000Z');
    const dependent = createBasic(fx.verbs, 'dependent', [dep.id]);
    fx.setNow('2026-07-11T12:03:00.000Z');
    const child = fx.verbs.create({
      title: 'child',
      spec: 'plain prompt',
      spec_format: 'text/plain',
      created_by: actor(),
      parent_id: parent.id,
    });

    const full = fx.verbs.list();
    expect(full.map((i) => i.id)).toEqual([child.id, dependent.id, dep.id, parent.id]);

    // Walk the same board one row at a time.
    const walked: { id: string; claimable: boolean }[] = [];
    let cursor: string | null = null;
    do {
      const page = fx.verbs.listSummaries(undefined, { limit: 1, ...(cursor === null ? {} : { cursor }) });
      for (const item of page.items) {
        expect(item).not.toHaveProperty('spec');
        expect(item.spec_length).toBe('plain prompt'.length);
        walked.push({ id: item.id, claimable: item.claimable });
      }
      cursor = page.next_cursor;
    } while (cursor !== null);

    // Same order, same ids, same claimability — a page boundary is a
    // selection window, never a semantic one.
    expect(walked).toEqual(full.map((i) => ({ id: i.id, claimable: i.claimable })));
    // …and the gates were actually engaged, so the parity above is meaningful.
    expect(walked.find((i) => i.id === parent.id)?.claimable).toBe(false); // pending child, other page
    expect(walked.find((i) => i.id === dependent.id)?.claimable).toBe(false); // unfinished dep, other page
    expect(walked.find((i) => i.id === child.id)?.claimable).toBe(true);
  });

  it('resolves a cross-page dependency status from the shared full-board scan — no per-item read, so no spec body is loaded to compute claimable', () => {
    // Counting subclass: `getItem` is the read that returns a FULL row,
    // opaque spec body included. Under paging, seeding the dependency-status
    // map from the returned page instead of from the spec-free full-board
    // scan turns every off-page dependency into one of these — an N+1 of
    // open/close cycles, each loading a spec to answer a question about
    // `status`. This test is the pin against that regression.
    class CountingStore extends WorkStateStore {
      getItemCalls = 0;
      override getItem(id: string): ReturnType<WorkStateStore['getItem']> {
        this.getItemCalls += 1;
        return super.getItem(id);
      }
    }
    const root = makeTempDir();
    const dbPath = join(root, 'work-state', 'board.db');
    let nowIso = FIXED_ISO;
    const clock: Clock = () => new Date(nowIso);
    const store = new CountingStore(dbPath, clock);
    const verbs = new WorkStateVerbs(store, clock);

    // Oldest -> newest, so a one-row page holds the dependent while its
    // dependency sits two pages away.
    nowIso = '2026-07-11T12:00:00.000Z';
    const dep = createBasic(verbs, 'dep');
    nowIso = '2026-07-11T12:01:00.000Z';
    createBasic(verbs, 'filler');
    nowIso = '2026-07-11T12:02:00.000Z';
    const dependent = createBasic(verbs, 'dependent', [dep.id]);

    store.getItemCalls = 0; // creation itself reads items; measure the READ only
    const page = verbs.listSummaries(undefined, { limit: 1 });
    expect(page.items.map((i) => i.id)).toEqual([dependent.id]);
    // The value is right…
    expect(page.items[0]?.claimable).toBe(false);
    // …and it cost ZERO full-row reads.
    expect(store.getItemCalls).toBe(0);

    // Same for the unpaginated read, which shares the one gate.
    store.getItemCalls = 0;
    expect(verbs.list().find((i) => i.id === dependent.id)?.claimable).toBe(false);
    expect(store.getItemCalls).toBe(0);
  });

  it('list() is untouched by the paging options — it still returns every item WITH its spec', () => {
    const fx = makeFixture();
    for (let i = 0; i < 5; i += 1) {
      fx.setNow(`2026-07-11T12:0${String(i)}:00.000Z`);
      createBasic(fx.verbs, `item ${String(i)}`);
    }
    // The guarantee context/assemble-prototype.ts's full-board reverse-edge
    // sweep rests on: no default page size, and spec bodies present.
    const items = fx.verbs.list();
    expect(items).toHaveLength(5);
    for (const item of items) expect(item.spec).toBe('plain prompt');
  });

  it('an ABSENT limit means EVERY item, past any page default a transport applies — the contract context/assemble-prototype.ts sweeps on', () => {
    const fx = makeFixture();
    // Deliberately MORE than DEFAULT_LIST_LIMIT. The test above seeds 5, which
    // can only catch a leaked default below 5 — not the one anyone would
    // actually write, which is the transport's own page size. A default
    // imposed one layer down here would silently truncate the assembler's
    // full-board sweep and its steering-supersession inputs, and every caller
    // would keep reading a shortened board as the whole board.
    const base = Date.parse(FIXED_ISO);
    const ids: string[] = [];
    for (let i = 0; i < DEFAULT_LIST_LIMIT + 5; i += 1) {
      fx.setNow(new Date(base + i * 60_000).toISOString());
      ids.push(createBasic(fx.verbs, `item ${String(i)}`).id);
    }

    const items = fx.verbs.list();
    expect(items).toHaveLength(DEFAULT_LIST_LIMIT + 5);
    // Every seeded id, not just the right COUNT — newest first, the order
    // every board read emits.
    expect(items.map((i) => i.id)).toEqual([...ids].reverse());
    // …and the same under a filter, which is the form the sweep actually calls.
    expect(fx.verbs.list({ status: 'open' })).toHaveLength(DEFAULT_LIST_LIMIT + 5);
    // …while the transport-facing twin, asked for a page, IS bounded — so the
    // difference between the two reads is real and not an accident of seeding.
    expect(fx.verbs.listSummaries(undefined, { limit: DEFAULT_LIST_LIMIT }).items).toHaveLength(DEFAULT_LIST_LIMIT);
  });
});

describe('supersedes / typed forward references', () => {
  function createWithReferences(verbs: WorkStateVerbs, title: string, references: { rel: string; id: string }[]) {
    return verbs.create({
      title,
      spec: 'plain prompt',
      spec_format: 'text/plain',
      created_by: actor(),
      references,
    });
  }

  it('create with a supersedes edge persists the forward edge; get/list expose the derived superseded_by backlink on the target', () => {
    const { verbs } = makeFixture();
    const old = createBasic(verbs, 'the old plan');
    const replacement = createWithReferences(verbs, 'the new plan', [{ rel: 'supersedes', id: old.id }]);
    expect(replacement.references).toEqual([{ rel: 'supersedes', id: old.id }]);

    // The target announces its replacement on get — derived, never stored.
    expect(verbs.get(old.id)?.referenced_by).toEqual([{ rel: 'supersedes', id: replacement.id }]);
    // …and on list.
    const listed = verbs.list().find((i) => i.id === old.id);
    expect(listed?.referenced_by).toEqual([{ rel: 'supersedes', id: replacement.id }]);
    // The replacement has no backlink of its own.
    expect(verbs.get(replacement.id)?.referenced_by).toEqual([]);
    // Only the forward edge is stored: the target's own references stay [].
    expect(verbs.get(old.id)?.references).toEqual([]);
  });

  it('create rejects a dangling supersedes target with a typed DANGLING_SUPERSEDES DagError, before any write', () => {
    const { verbs } = makeFixture();
    let thrown: unknown;
    try {
      createWithReferences(verbs, 'x', [{ rel: 'supersedes', id: '01JZM8Z0000000000000000000' }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_SUPERSEDES');
    // Nothing was persisted.
    expect(verbs.list()).toEqual([]);
  });

  it('update_meta can set, replace, and clear the supersedes edge (wholesale replace semantics)', () => {
    const { verbs } = makeFixture();
    const a = createBasic(verbs, 'a');
    const b = createBasic(verbs, 'b');
    const item = createBasic(verbs, 'x');

    // Set.
    const set = verbs.updateMeta(item.id, item.version, { references: [{ rel: 'supersedes', id: a.id }] });
    expect(set.references).toEqual([{ rel: 'supersedes', id: a.id }]);
    expect(verbs.get(a.id)?.referenced_by).toEqual([{ rel: 'supersedes', id: item.id }]);

    // Replace — the derived backlink moves with the forward edge.
    const replaced = verbs.updateMeta(item.id, set.version, { references: [{ rel: 'supersedes', id: b.id }] });
    expect(replaced.references).toEqual([{ rel: 'supersedes', id: b.id }]);
    expect(verbs.get(a.id)?.referenced_by).toEqual([]);
    expect(verbs.get(b.id)?.referenced_by).toEqual([{ rel: 'supersedes', id: item.id }]);

    // Absent key: unchanged.
    const renamed = verbs.updateMeta(item.id, replaced.version, { title: 'x2' });
    expect(renamed.references).toEqual([{ rel: 'supersedes', id: b.id }]);

    // Clear.
    const cleared = verbs.updateMeta(item.id, renamed.version, { references: [] });
    expect(cleared.references).toEqual([]);
    expect(verbs.get(b.id)?.referenced_by).toEqual([]);
  });

  it('update_meta rejects a dangling supersedes target with a typed DANGLING_SUPERSEDES DagError, before any write', () => {
    const { verbs } = makeFixture();
    const item = createBasic(verbs, 'x');
    let thrown: unknown;
    try {
      verbs.updateMeta(item.id, item.version, { references: [{ rel: 'supersedes', id: '01JZM8Z0000000000000000000' }] });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_SUPERSEDES');
    // Unchanged.
    expect(verbs.get(item.id)?.version).toBe(item.version);
    expect(verbs.get(item.id)?.references).toEqual([]);
  });

  it('fan-in and chains derive across the board (mirrors the record store’s supersedes coverage)', () => {
    const { verbs, setNow } = makeFixture();
    setNow('2026-05-01T00:00:00.000Z');
    const target = createBasic(verbs, 'the original');
    setNow('2026-06-01T00:00:00.000Z');
    const b = createWithReferences(verbs, 'replacement one', [{ rel: 'supersedes', id: target.id }]);
    setNow('2026-07-01T00:00:00.000Z');
    const c = createWithReferences(verbs, 'replacement two', [{ rel: 'supersedes', id: target.id }]);
    const d = createWithReferences(verbs, 'chain link', [{ rel: 'supersedes', id: b.id }]);

    // Fan-in: both B and C backlink the target, newest first.
    expect(verbs.get(target.id)?.referenced_by).toEqual([
      { rel: 'supersedes', id: c.id },
      { rel: 'supersedes', id: b.id },
    ]);
    // Chain: B is superseded by D; D has no backlink of its own.
    expect(verbs.get(b.id)?.referenced_by).toEqual([{ rel: 'supersedes', id: d.id }]);
    expect(verbs.get(d.id)?.referenced_by).toEqual([]);
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

    // `reopen` is included in this seam test too. The item is
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

describe('"blocked" is never a stored status — it is a derived view only', () => {
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
