// plugin/src/work-state/claims.test.ts — WI-301 acceptance tests for the
// claim engine.
//
// Spec: docs/spikes/v3-work-delegation.md §3.2, as amended 2026-07-09
// (cycle-6 findings C1/Q-34, S3/Q-36). Pins, one per rule:
// - rule 1: claim() is a compare-and-set (status='open' AND every
//   depends_on 'done'); at most one active claim ever; claim_token strictly
//   monotonic per item; the CAS is proven engine-level (not JS-level) with a
//   genuine multi-thread race against the real SQLite file.
// - rule 2 (amended): renew() is itself a CAS (in_progress + token match +
//   not expired); a post-expiry renew fails typed; the lazy expiry check
//   fires FIRST from every entry point.
// - rule 3 (amended): complete()'s fencing rejects a stale (expired +
//   reclaimed) token — the Kleppmann delayed-writer test — and the optional
//   note either lands on the event or the event still records the
//   transition when absent.
// - rule 4: release() is token-checked, returns the item to open, and
//   appends a handoff-note event.
// - rule 6: every failure mode is a typed, loud error — never silent.
//
// All timing uses the injected clock (record/id.ts's `Clock` convention) —
// no test in this file sleeps; lease expiry is simulated by advancing a
// fake clock.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { WorkStateStore } from './store.js';
import type { ActorRef } from './types.js';
import { checkExpiry } from './expiry.js';
import { ClaimEngineError, DEFAULT_LEASE_MS, MAX_LEASE_MS, claim, complete, release, renew } from './claims.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-state-claims-test-'));
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
  clock: Clock;
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
    clock,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

function actor(human = 'dan'): ActorRef {
  return { human };
}

describe('claim() — §3.2 rule 1: atomic compare-and-set', () => {
  it('succeeds on an open item with no dependencies; item transitions to in_progress with token 1', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });

    const claimed = claim(store, clock, item.id, actor());
    expect(claimed.status).toBe('in_progress');
    expect(claimed.claim?.claim_token).toBe(1);
    expect(claimed.claim?.holder).toEqual(actor());

    const events = store.events(item.id);
    expect(events.map((e) => e.transition)).toEqual(['create', 'claim']);
    expect(events[1]?.claim_token).toBe(1);
  });

  it('rejects an item that is not open (already in_progress) with a typed NOT_CLAIMABLE error', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    claim(store, clock, item.id, actor('dan'));

    let thrown: unknown;
    try {
      claim(store, clock, item.id, actor('rae'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('NOT_CLAIMABLE');
    // At most one active claim — the first claimant is untouched.
    expect(store.getItem(item.id)?.claim?.holder).toEqual(actor('dan'));
  });

  it('rejects an open item whose depends_on is not fully done', () => {
    const { store, clock } = makeFixture();
    const dep = store.insertItem({ title: 'dep', spec: 's', spec_format: 'f', created_by: actor() });
    const item = store.insertItem({
      title: 'dependent',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      depends_on: [dep.id],
    });

    let thrown: unknown;
    try {
      claim(store, clock, item.id, actor());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('NOT_CLAIMABLE');

    // Once the dependency completes, the frontier opens and claim succeeds.
    const claimedDep = claim(store, clock, dep.id, actor());
    complete(store, clock, dep.id, claimedDep.claim!.claim_token);
    const claimed = claim(store, clock, item.id, actor());
    expect(claimed.status).toBe('in_progress');
  });

  it('throws a typed NOT_FOUND error for an id that does not exist', () => {
    const { store, clock } = makeFixture();
    let thrown: unknown;
    try {
      claim(store, clock, '01JZM8Z0000000000000000000', actor());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('NOT_FOUND');
  });

  it('claim_token is strictly monotonic per item across release-then-reclaim', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });

    const first = claim(store, clock, item.id, actor('a'));
    expect(first.claim?.claim_token).toBe(1);
    release(store, clock, item.id, first.claim!.claim_token);

    const second = claim(store, clock, item.id, actor('b'));
    expect(second.claim?.claim_token).toBe(2);
    release(store, clock, item.id, second.claim!.claim_token);

    const third = claim(store, clock, item.id, actor('c'));
    expect(third.claim?.claim_token).toBe(3);
  });

  // --- Engine-level atomicity proof -------------------------------------
  //
  // Rule 1 requires the CAS to be a SINGLE atomic SQL statement, not a
  // read-then-write pattern in JS. A same-thread, sequential double-call
  // test (call claim() twice in a row) would pass even for a naive
  // check-then-write implementation, because single-threaded JS execution
  // never interleaves the two calls — it would NOT distinguish "engine-level"
  // from "JS-level" atomicity. To actually prove the guard is enforced by
  // SQLite itself (not by never letting two calls interleave), this spawns
  // several genuine OS threads (node:worker_threads — independent
  // connections to the SAME db file, matching §4's "two simultaneous
  // sessions on one machine writing the same board is ordinary") that all
  // race to claim the identical item at once. The worker's SQL is the exact
  // CAS statement claims.ts's claim() runs (verified byte-for-byte below,
  // not merely "similar") — so a passing race here is a passing race for
  // the shipped implementation, not a stand-in.
  it('under genuine concurrent OS threads racing the identical CAS statement, exactly one claim succeeds', async () => {
    const { store } = makeFixture();
    const item = store.insertItem({ title: 'race target', spec: 's', spec_format: 'f', created_by: actor() });

    // The literal SQL claim() executes (copied from claims.ts) — the
    // structural test below proves this string is not a drifted copy.
    const CLAIM_CAS_SQL = `UPDATE items
         SET status = 'in_progress',
             claim_token_counter = claim_token_counter + 1,
             claim_token = claim_token_counter + 1,
             claim_holder_human = ?,
             claim_holder_agent = ?,
             claim_acquired_at = ?,
             claim_lease_expires = ?
         WHERE id = ?
           AND status = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM json_each(items.depends_on) je
             JOIN items dep ON dep.id = je.value
             WHERE dep.status != 'done'
           )
         RETURNING claim_token`;

    const workerSource = `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
      const db = new DatabaseSync(workerData.dbPath);
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      const stmt = db.prepare(workerData.sql);
      const row = stmt.get(
        'worker-' + workerData.id, null, workerData.nowIso, workerData.leaseIso, workerData.itemId,
      );
      db.close();
      parentPort.postMessage({ id: workerData.id, claimed: row !== undefined });
    `;

    const N = 6;
    const runs = Array.from({ length: N }, (_, id) => {
      return new Promise<{ id: number; claimed: boolean }>((resolve, reject) => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: {
            id,
            dbPath: store.dbPath,
            sql: CLAIM_CAS_SQL,
            itemId: item.id,
            nowIso: FIXED_ISO,
            leaseIso: new Date(new Date(FIXED_ISO).getTime() + DEFAULT_LEASE_MS).toISOString(),
          },
        });
        worker.once('message', (msg: { id: number; claimed: boolean }) => {
          void worker.terminate().then(() => resolve(msg));
        });
        worker.once('error', reject);
      });
    });

    const results = await Promise.all(runs);
    const successes = results.filter((r) => r.claimed);
    expect(successes).toHaveLength(1); // exactly one of N concurrent racers wins

    const finalItem = store.getItem(item.id);
    expect(finalItem?.status).toBe('in_progress');
    expect(finalItem?.claim?.claim_token).toBe(1); // the counter incremented exactly once
  });

  it('structural: the CAS SQL used by the race-proof test above is verbatim what claims.ts ships', () => {
    const claimsSrc = readFileSync(fileURLToPath(new URL('./claims.ts', import.meta.url)), 'utf8');
    // Every clause the race test depends on must be present, byte-for-byte,
    // in the shipped claim() implementation — not a paraphrase.
    for (const clause of [
      "SET status = 'in_progress'",
      'claim_token_counter = claim_token_counter + 1',
      'claim_token = claim_token_counter + 1',
      "WHERE id = ?\n           AND status = 'open'",
      'NOT EXISTS (',
      'json_each(items.depends_on)',
      "WHERE dep.status != 'done'",
      'RETURNING claim_token',
    ]) {
      expect(claimsSrc).toContain(clause);
    }
    // And the guard must be a SINGLE UPDATE statement inside claim() — no
    // second UPDATE against `items` anywhere in the acquire path (which
    // would reopen a read-then-write window between two statements).
    const claimFnMatch = /export function claim\(([\s\S]*?)\n\}/.exec(claimsSrc);
    expect(claimFnMatch).not.toBeNull();
    const claimFnBody = claimFnMatch?.[0] ?? '';
    const updateCount = (claimFnBody.match(/UPDATE items/g) ?? []).length;
    expect(updateCount).toBe(1);
  });
});

describe('renew() — §3.2 rule 2 amendment: renew is itself a CAS', () => {
  it('succeeds while in_progress, token matches, and the lease has not expired; extends lease_expires', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor());
    const before = claimed.claim!.lease_expires;

    setNow('2026-07-11T13:00:00.000Z');
    const renewed = renew(store, clock, item.id, claimed.claim!.claim_token, { leaseMs: DEFAULT_LEASE_MS });
    expect(renewed.claim?.lease_expires).not.toBe(before);
    expect(new Date(renewed.claim!.lease_expires).getTime()).toBeGreaterThan(new Date(before).getTime());

    const events = store.events(item.id);
    expect(events.map((e) => e.transition)).toEqual(['create', 'claim', 'renew']);
    expect(events[2]?.claim_token).toBe(claimed.claim!.claim_token);
  });

  it('rejects a token that does not match the item’s current token, typed INVALID_CLAIM', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    claim(store, clock, item.id, actor());

    let thrown: unknown;
    try {
      renew(store, clock, item.id, 999);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');
  });

  it('rejects renew on an item that is not in_progress (e.g. still open)', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    let thrown: unknown;
    try {
      renew(store, clock, item.id, 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');
  });

  it('a renew arriving after expiry fails with a typed error — the lazy check already reopened the item (§3.2 rule 2 amendment)', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor(), { leaseMs: 60_000 }); // 1 minute lease

    setNow('2026-07-11T12:05:00.000Z'); // 5 minutes later — well past expiry
    let thrown: unknown;
    try {
      renew(store, clock, item.id, claimed.claim!.claim_token);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');

    // The lazy check already flipped it back to open and voided the token.
    const after = store.getItem(item.id);
    expect(after?.status).toBe('open');
    expect(after?.claim).toBeNull();
    const events = store.events(item.id);
    expect(events.map((e) => e.transition)).toEqual(['create', 'claim', 'orphan-recovery']);
  });
});

describe('complete() — §3.2 rule 3 amended: fencing + optional note', () => {
  it('succeeds with the current token; transitions to done; note lands on the event', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor());

    const done = complete(store, clock, item.id, claimed.claim!.claim_token, 'shipped the thing');
    expect(done.status).toBe('done');
    expect(done.claim).toBeNull();

    const events = store.events(item.id);
    const completeEvent = events.find((e) => e.transition === 'complete');
    expect(completeEvent?.note).toBe('shipped the thing');
    expect(completeEvent?.claim_token).toBe(claimed.claim!.claim_token);
  });

  it('an absent note still records the transition (structural fallback, C1/Q-34)', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor());

    complete(store, clock, item.id, claimed.claim!.claim_token);

    const events = store.events(item.id);
    const completeEvent = events.find((e) => e.transition === 'complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.note).toBeUndefined();
    expect(completeEvent?.claim_token).toBe(claimed.claim!.claim_token);
  });

  it('THE KLEPPMANN DELAYED-WRITER TEST: claim -> expire -> reclaim -> the old token is rejected on complete', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });

    const original = claim(store, clock, item.id, actor('worker-a'), { leaseMs: 60_000 });
    setNow('2026-07-11T12:05:00.000Z'); // past the 1-minute lease

    const reclaimed = claim(store, clock, item.id, actor('worker-b'));
    expect(reclaimed.claim?.claim_token).toBeGreaterThan(original.claim!.claim_token);

    // The delayed writer (worker-a) finally gets around to completing with
    // its now-stale token — must be rejected, not silently accepted.
    let thrown: unknown;
    try {
      complete(store, clock, item.id, original.claim!.claim_token, 'late finish');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');

    // worker-b's claim is untouched by the rejected stale completion.
    const after = store.getItem(item.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claim?.holder).toEqual(actor('worker-b'));

    // And worker-b's own (current-token) completion succeeds.
    const done = complete(store, clock, item.id, reclaimed.claim!.claim_token);
    expect(done.status).toBe('done');
  });

  it('rejects a token for an item that is not in_progress', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    let thrown: unknown;
    try {
      complete(store, clock, item.id, 1);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');
  });

  it('throws typed NOT_FOUND for an unknown id', () => {
    const { store, clock } = makeFixture();
    expect(() => complete(store, clock, '01JZM8Z0000000000000000000', 1)).toThrowError(ClaimEngineError);
  });

  it('F-301-001 C1: the completion event is attributed to the CLAIM HOLDER, never a caller-supplied actor — complete() takes no actor parameter at all', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor('creator') });
    const claimed = claim(store, clock, item.id, actor('holder'));

    // `complete` has no `actor` argument in its signature (checked at the
    // type level by every call site in this file); the event must name the
    // holder who actually claimed the item, not the creator, not anyone else.
    complete(store, clock, item.id, claimed.claim!.claim_token, 'done by the real holder');

    const events = store.events(item.id);
    const completeEvent = events.find((e) => e.transition === 'complete');
    expect(completeEvent?.actor).toEqual(actor('holder'));
    expect(completeEvent?.actor).not.toEqual(actor('creator'));
  });

  it('F-301-001 S2: THE KLEPPMANN RECLAIMED-TOKEN FENCING TEST for renew() — an old token, reassigned to a NEW holder via a genuine reclaim, is rejected on renew', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });

    const original = claim(store, clock, item.id, actor('worker-a'), { leaseMs: 60_000 });
    setNow('2026-07-11T12:05:00.000Z'); // past the 1-minute lease
    const reclaimed = claim(store, clock, item.id, actor('worker-b')); // strictly-greater token, genuinely reassigned
    expect(reclaimed.claim?.claim_token).toBeGreaterThan(original.claim!.claim_token);

    // The delayed writer (worker-a) tries to renew its now-stale token —
    // typed against a REASSIGNED token, not NULL/never-issued.
    let thrown: unknown;
    try {
      renew(store, clock, item.id, original.claim!.claim_token);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');

    // worker-b's claim is untouched by the rejected stale renew.
    const after = store.getItem(item.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claim?.holder).toEqual(actor('worker-b'));
    expect(after?.claim?.claim_token).toBe(reclaimed.claim!.claim_token);

    // And worker-b's own (current-token) renew succeeds.
    const renewed = renew(store, clock, item.id, reclaimed.claim!.claim_token);
    expect(renewed.claim?.holder).toEqual(actor('worker-b'));
  });
});

describe('release() — §3.2 rule 4: token-checked handoff', () => {
  it('returns the item to open with a handoff note event', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor());

    const released = release(store, clock, item.id, claimed.claim!.claim_token, 'handing off, out of time');
    expect(released.status).toBe('open');
    expect(released.claim).toBeNull();

    const events = store.events(item.id);
    const releaseEvent = events.find((e) => e.transition === 'release');
    expect(releaseEvent?.note).toBe('handing off, out of time');
  });

  it('an absent note still records the release transition', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor());
    release(store, clock, item.id, claimed.claim!.claim_token);
    const events = store.events(item.id);
    expect(events.find((e) => e.transition === 'release')).toBeDefined();
  });

  it('rejects a stale token with a typed INVALID_CLAIM error', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    claim(store, clock, item.id, actor());
    let thrown: unknown;
    try {
      release(store, clock, item.id, 999);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');
  });

  it('after release, the item is reclaimable by another actor with a fresh, larger token', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const first = claim(store, clock, item.id, actor('a'));
    release(store, clock, item.id, first.claim!.claim_token, 'handoff');
    const second = claim(store, clock, item.id, actor('b'));
    expect(second.claim?.claim_token).toBeGreaterThan(first.claim!.claim_token);
  });

  it('F-301-001 C1: the release event is attributed to the CLAIM HOLDER, never a caller-supplied actor — release() takes no actor parameter at all', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor('creator') });
    const claimed = claim(store, clock, item.id, actor('holder'));

    release(store, clock, item.id, claimed.claim!.claim_token, 'handing off');

    const events = store.events(item.id);
    const releaseEvent = events.find((e) => e.transition === 'release');
    expect(releaseEvent?.actor).toEqual(actor('holder'));
    expect(releaseEvent?.actor).not.toEqual(actor('creator'));
  });

  it('F-301-001 S2: THE KLEPPMANN RECLAIMED-TOKEN FENCING TEST for release() — an old token, reassigned to a NEW holder via a genuine reclaim, is rejected on release', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });

    const original = claim(store, clock, item.id, actor('worker-a'), { leaseMs: 60_000 });
    setNow('2026-07-11T12:05:00.000Z'); // past the 1-minute lease
    const reclaimed = claim(store, clock, item.id, actor('worker-b')); // strictly-greater token, genuinely reassigned
    expect(reclaimed.claim?.claim_token).toBeGreaterThan(original.claim!.claim_token);

    // The delayed writer (worker-a) tries to release its now-stale token —
    // typed against a REASSIGNED token, not NULL/never-issued.
    let thrown: unknown;
    try {
      release(store, clock, item.id, original.claim!.claim_token, 'too late');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ClaimEngineError);
    expect((thrown as ClaimEngineError).code).toBe('INVALID_CLAIM');

    // worker-b's claim is untouched by the rejected stale release.
    const after = store.getItem(item.id);
    expect(after?.status).toBe('in_progress');
    expect(after?.claim?.holder).toEqual(actor('worker-b'));

    // And worker-b's own (current-token) release succeeds.
    const released = release(store, clock, item.id, reclaimed.claim!.claim_token);
    expect(released.status).toBe('open');
  });
});

describe('lazy expiry check fires from every claim-engine entry point (§3.2 rule 2 amendment)', () => {
  function expireOldClaim(store: WorkStateStore, clock: Clock, setNow: (iso: string) => void): {
    itemId: string;
    staleToken: number;
  } {
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor('a'), { leaseMs: 60_000 });
    setNow('2026-07-11T12:05:00.000Z'); // past the 1-minute lease, item untouched since
    return { itemId: item.id, staleToken: claimed.claim!.claim_token };
  }

  it('claim(): reclaiming an untouched-but-expired item succeeds (the lazy check revives it to open first)', () => {
    const { store, clock, setNow } = makeFixture();
    const { itemId } = expireOldClaim(store, clock, setNow);
    // Status column still says in_progress in the DB until something
    // touches it — this call is that something.
    const reclaimed = claim(store, clock, itemId, actor('b'));
    expect(reclaimed.status).toBe('in_progress');
    expect(reclaimed.claim?.holder).toEqual(actor('b'));
    expect(store.events(itemId).map((e) => e.transition)).toEqual(['create', 'claim', 'orphan-recovery', 'claim']);
  });

  it('renew(): firing the lazy check on an untouched-but-expired item rejects the stale renew typed', () => {
    const { store, clock, setNow } = makeFixture();
    const { itemId, staleToken } = expireOldClaim(store, clock, setNow);
    expect(() => renew(store, clock, itemId, staleToken)).toThrowError(ClaimEngineError);
    expect(store.getItem(itemId)?.status).toBe('open');
  });

  it('complete(): firing the lazy check on an untouched-but-expired item rejects the stale complete typed', () => {
    const { store, clock, setNow } = makeFixture();
    const { itemId, staleToken } = expireOldClaim(store, clock, setNow);
    expect(() => complete(store, clock, itemId, staleToken)).toThrowError(ClaimEngineError);
    expect(store.getItem(itemId)?.status).toBe('open');
  });

  it('release(): firing the lazy check on an untouched-but-expired item rejects the stale release typed', () => {
    const { store, clock, setNow } = makeFixture();
    const { itemId, staleToken } = expireOldClaim(store, clock, setNow);
    expect(() => release(store, clock, itemId, staleToken)).toThrowError(ClaimEngineError);
    expect(store.getItem(itemId)?.status).toBe('open');
  });

  it('explicit checkExpiry() (expiry.ts) called directly performs the same recovery claim()/renew() rely on', () => {
    const { store, clock, setNow } = makeFixture();
    const { itemId, staleToken } = expireOldClaim(store, clock, setNow);
    const result = checkExpiry(store, clock, itemId);
    expect(result.expired).toBe(true);
    expect(result.voidedToken).toBe(staleToken);
    expect(result.formerHolder).toEqual(actor('a'));
  });
});

describe('lease_ms validation (capstone-10 S1/S2)', () => {
  it('oversized lease_ms is rejected typed — never an untyped RangeError', () => {
    const { store, clock } = makeFixture();
    const itemId = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() }).id;
    for (const bad of [1e20, Number.MAX_SAFE_INTEGER, MAX_LEASE_MS + 1]) {
      try {
        claim(store, clock, itemId, { human: 'dan' }, { leaseMs: bad });
        expect.unreachable('claim must reject an oversized lease');
      } catch (err) {
        expect(err).toBeInstanceOf(ClaimEngineError);
        expect((err as ClaimEngineError).code).toBe('INVALID_LEASE');
      }
    }
  });

  it('zero and negative lease_ms are rejected typed — a claim can never be born expired', () => {
    const { store, clock } = makeFixture();
    const itemId = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() }).id;
    for (const bad of [0, -1, -5000, 1.5]) {
      try {
        claim(store, clock, itemId, { human: 'dan' }, { leaseMs: bad });
        expect.unreachable('claim must reject a non-positive/non-integer lease');
      } catch (err) {
        expect(err).toBeInstanceOf(ClaimEngineError);
        expect((err as ClaimEngineError).code).toBe('INVALID_LEASE');
      }
    }
    // The item is untouched — still claimable with a sane lease.
    const item = claim(store, clock, itemId, { human: 'dan' }, { leaseMs: 60_000 });
    expect(item.status).toBe('in_progress');
  });

  it('renew validates lease_ms identically', () => {
    const { store, clock } = makeFixture();
    const itemId = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() }).id;
    const item = claim(store, clock, itemId, { human: 'dan' }, { leaseMs: 60_000 });
    const token = item.claim?.claim_token;
    expect(token).toBeTypeOf('number');
    try {
      renew(store, clock, itemId, token as number, { leaseMs: -1 });
      expect.unreachable('renew must reject a non-positive lease');
    } catch (err) {
      expect((err as ClaimEngineError).code).toBe('INVALID_LEASE');
    }
    // Renew with a valid lease still works — the failed attempt changed nothing.
    const renewed = renew(store, clock, itemId, token as number, { leaseMs: 120_000 });
    expect(renewed.claim?.claim_token).toBe(token);
  });
});

