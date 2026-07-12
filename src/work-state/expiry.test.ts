// plugin/src/work-state/expiry.test.ts — WI-301 acceptance tests for the
// hybrid lease-expiry mechanism.
//
// Spec: docs/spikes/v3-work-delegation.md §3.2 rule 2, amended 2026-07-09
// (cycle-6 finding S3 / Q-36): the hybrid is (a) a lazy check evaluated
// first by every claim-engine entry point (exercised end-to-end in
// claims.test.ts; this file pins `checkExpiry` in isolation) and (b) an
// opportunistic board-wide sweep at session boundaries (`sweepBoard`, the
// entry point WI-303's hooks will call).
//
// No test in this file sleeps — lease expiry is simulated by advancing an
// injected fake clock (repo convention, record/id.ts's `Clock`).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../record/id.js';
import { WorkStateStore } from './store.js';
import type { ActorRef } from './types.js';
import { claim, complete } from './claims.js';
import { DEFAULT_LEASE_MS, checkExpiry, sweepBoard } from './expiry.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-work-state-expiry-test-'));
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

describe('DEFAULT_LEASE_MS — "hours, not seconds" (§3.2)', () => {
  it('defaults to an hours-scale lease, not a seconds-scale one', () => {
    expect(DEFAULT_LEASE_MS).toBeGreaterThanOrEqual(60 * 60 * 1000); // at least 1 hour
  });
});

describe('checkExpiry — the lazy check (hybrid part (a))', () => {
  it('is a no-op for an id that does not exist', () => {
    const { store, clock } = makeFixture();
    const result = checkExpiry(store, clock, '01JZM8Z0000000000000000000');
    expect(result).toEqual({ expired: false });
  });

  it('is a no-op for an open (never-claimed) item', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const result = checkExpiry(store, clock, item.id);
    expect(result).toEqual({ expired: false });
    expect(store.getItem(item.id)?.status).toBe('open');
  });

  it('is a no-op for an in_progress item whose lease has not yet passed', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    claim(store, clock, item.id, actor(), { leaseMs: 60 * 60 * 1000 }); // 1 hour, plenty of headroom

    const result = checkExpiry(store, clock, item.id);
    expect(result).toEqual({ expired: false });
    expect(store.getItem(item.id)?.status).toBe('in_progress');
  });

  it('is a no-op for a done or cancelled item, even if claim fields were somehow stale (defense in depth)', () => {
    const { store, clock } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor(), { leaseMs: 1000 });
    complete(store, clock, item.id, claimed.claim!.claim_token);
    const result = checkExpiry(store, clock, item.id);
    expect(result).toEqual({ expired: false });
    expect(store.getItem(item.id)?.status).toBe('done');
  });

  it('atomically transitions an expired in_progress item to open, voids the token, and appends an orphan-recovery event attributed to the former holder', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const claimed = claim(store, clock, item.id, actor('worker-a'), { leaseMs: 60_000 }); // 1 minute

    setNow('2026-07-11T12:05:00.000Z'); // 5 minutes later — well past expiry
    const result = checkExpiry(store, clock, item.id);

    expect(result.expired).toBe(true);
    expect(result.voidedToken).toBe(claimed.claim!.claim_token);
    expect(result.formerHolder).toEqual(actor('worker-a'));

    const after = store.getItem(item.id);
    expect(after?.status).toBe('open');
    expect(after?.claim).toBeNull();

    const events = store.events(item.id);
    const recoveryEvent = events.find((e) => e.transition === 'orphan-recovery');
    expect(recoveryEvent).toBeDefined();
    expect(recoveryEvent?.actor).toEqual(actor('worker-a'));
    expect(recoveryEvent?.claim_token).toBe(claimed.claim!.claim_token);
    expect(recoveryEvent?.at).toBe('2026-07-11T12:05:00.000Z');
  });

  it('is idempotent: calling checkExpiry twice on an already-recovered item is a no-op the second time', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    claim(store, clock, item.id, actor(), { leaseMs: 60_000 });
    setNow('2026-07-11T12:05:00.000Z');

    const first = checkExpiry(store, clock, item.id);
    expect(first.expired).toBe(true);
    const second = checkExpiry(store, clock, item.id);
    expect(second).toEqual({ expired: false });

    // Exactly one orphan-recovery event, not two.
    const events = store.events(item.id).filter((e) => e.transition === 'orphan-recovery');
    expect(events).toHaveLength(1);
  });

  it('token monotonicity survives an expiry-void-then-reclaim cycle: the new token is strictly greater than the voided one', () => {
    const { store, clock, setNow } = makeFixture();
    const item = store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() });
    const first = claim(store, clock, item.id, actor('worker-a'), { leaseMs: 60_000 });

    setNow('2026-07-11T12:05:00.000Z');
    const expiry = checkExpiry(store, clock, item.id);
    expect(expiry.voidedToken).toBe(first.claim!.claim_token);

    const reclaimed = claim(store, clock, item.id, actor('worker-b'));
    expect(reclaimed.claim!.claim_token).toBeGreaterThan(expiry.voidedToken as number);
  });
});

describe('sweepBoard — the opportunistic session-boundary sweep (hybrid part (b))', () => {
  it('returns an empty array when there are no in_progress items', () => {
    const { store, clock } = makeFixture();
    store.insertItem({ title: 'x', spec: 's', spec_format: 'f', created_by: actor() }); // stays open
    expect(sweepBoard(store, clock)).toEqual([]);
  });

  it('recovers every expired in_progress item on an untouched board — the falsifiable orphan-recovery criterion (spec §5)', () => {
    const { store, clock, setNow } = makeFixture();
    const expiredA = store.insertItem({ title: 'a', spec: 's', spec_format: 'f', created_by: actor() });
    const expiredB = store.insertItem({ title: 'b', spec: 's', spec_format: 'f', created_by: actor() });
    const stillFresh = store.insertItem({ title: 'c', spec: 's', spec_format: 'f', created_by: actor() });

    claim(store, clock, expiredA.id, actor('a'), { leaseMs: 60_000 });
    claim(store, clock, expiredB.id, actor('b'), { leaseMs: 60_000 });
    claim(store, clock, stillFresh.id, actor('c'), { leaseMs: 60 * 60 * 1000 }); // 1 hour — survives the sweep

    setNow('2026-07-11T12:05:00.000Z'); // past the two 1-minute leases, within the 1-hour one

    const results = sweepBoard(store, clock);
    expect(results.filter((r) => r.expired)).toHaveLength(2);

    expect(store.getItem(expiredA.id)?.status).toBe('open');
    expect(store.getItem(expiredB.id)?.status).toBe('open');
    expect(store.getItem(stillFresh.id)?.status).toBe('in_progress'); // untouched — not yet expired

    // Both recoveries are audited.
    expect(store.events(expiredA.id).map((e) => e.transition)).toContain('orphan-recovery');
    expect(store.events(expiredB.id).map((e) => e.transition)).toContain('orphan-recovery');
    expect(store.events(stillFresh.id).map((e) => e.transition)).not.toContain('orphan-recovery');
  });

  it('honors an optional tenant_id filter — a sweep never touches another tenant’s claims', () => {
    const { store, clock, setNow } = makeFixture();
    const tenantAItem = store.insertItem({
      title: 'a',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      tenant_id: 'tenant-a',
    });
    const tenantBItem = store.insertItem({
      title: 'b',
      spec: 's',
      spec_format: 'f',
      created_by: actor(),
      tenant_id: 'tenant-b',
    });
    claim(store, clock, tenantAItem.id, actor(), { leaseMs: 60_000 });
    claim(store, clock, tenantBItem.id, actor(), { leaseMs: 60_000 });

    setNow('2026-07-11T12:05:00.000Z');
    const results = sweepBoard(store, clock, { tenant_id: 'tenant-a' });
    expect(results).toHaveLength(1);
    expect(results[0]?.expired).toBe(true);

    expect(store.getItem(tenantAItem.id)?.status).toBe('open');
    expect(store.getItem(tenantBItem.id)?.status).toBe('in_progress'); // untouched — out of scope for this sweep
  });
});
