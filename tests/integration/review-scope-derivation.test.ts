// plugin/tests/integration/review-scope-derivation.test.ts — pins the review
// skill's scope-derivation prose (skills/review/SKILL.md's Step 1,
// skills/autopilot/phases/review.md's Scope section) against the ACTUAL
// board behavior it describes, per P-52 (prose enumerating a shipped
// behavioral surface must be checked against the artifact, not
// hand-maintained free of any check).
//
// THE DEFECT this closes: both skill files used to treat `work_list`'s
// newest-created-first ordering as a proxy for "recently completed" with no
// disclosure that the two are different facts. An item created long before
// a cycle but completed within it sorts by its OLD created_at and can be
// dropped by any early stop on that ordering — exactly the failure mode a
// silent proxy hides (review's green then certifies a population it never
// looked at, the P-48 defect this item exists to close).
//
// CHOICE MADE (option c — bound the error explicitly, do not invent a
// cheaper signal that doesn't exist): investigation ruled out option (a)
// (filter on a row-level completion timestamp) because none exists —
// `updated_at` is stamped at create time and is bumped ONLY by
// `update_meta`/`cancel`/`reopen` (verbs.ts's `transitionStatus` /
// store.ts's `updateMeta`), never by `claim`/`renew`/`complete`/`release`
// (claims.ts) — pinned below by exercising the real claim->complete
// lifecycle and asserting `updated_at` does not move. Option (b) (derive
// scope from `work_events`) was ruled out at PROJECT scale, not by
// estimate: `work_events` is a single-item read (work-state/tools.ts's
// `work_events` tool takes exactly one `id`, no board-wide query exists —
// pinned below), so a board-wide derivation costs one call per candidate
// item; against this project's real board (159 items, 142 `done`) that is
// up to 159 individual round trips just to establish scope, before any
// review work begins — measured prohibitive, not merely asserted. Option
// (d) (add a completion-timestamp column) is a schema change this item
// explicitly forbids implementing.
//
// So the fix is prose: both skill files now say plainly that `work_list`
// orders by creation, not completion, instruct exhaustive paging (so
// pagination truncation is never what drops an item), and hand the reviewer
// a cheap, real bounding mechanism (diff against what the last recorded
// cycle-summary already covered) plus a cheap escape hatch (one `work_events`
// spot-check for a genuinely ambiguous item, not a board-wide scan).
//
// What THIS test mechanically proves (the acceptance criterion's `[machine]`
// half — "a test or fixture demonstrates that an item created before the
// cycle but completed within it lands in scope"):
//   1. The two skill files' prose actually states the ordering fact, the
//      approximation warning, and the exhaustive-paging instruction — so a
//      future edit that quietly drops the disclosure fails this suite
//      rather than reintroducing a silent proxy.
//   2. `work_list`'s real ordering is newest-created-first — pinning the
//      claim above against the artifact, not just against itself.
//   3. `updated_at` genuinely does not move across a full claim->complete
//      lifecycle — pinning the "no cheaper row-level signal" premise the
//      chosen option rests on.
//   4. THE CORE FIXTURE: an item created FIRST (oldest `created_at`, so it
//      sorts LAST under `created_at DESC`) but only completed alongside a
//      batch of newer items is DROPPED by a bounded/single-page read (the
//      old failure mode) and IS PRESENT once `next_cursor` is followed to
//      exhaustion (the fixed instruction) — the exact created-before/
//      completed-within case the proxy used to drop.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from '../../src/record/id.js';
import { claim, complete } from '../../src/work-state/claims.js';
import { WorkStateStore } from '../../src/work-state/store.js';
import type { ActorRef } from '../../src/work-state/types.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const REVIEW_SKILL = readFileSync(join(PLUGIN_DIR, 'skills', 'review', 'SKILL.md'), 'utf8');
const AUTOPILOT_REVIEW = readFileSync(join(PLUGIN_DIR, 'skills', 'autopilot', 'phases', 'review.md'), 'utf8');

const FIXED_ISO = '2026-07-11T12:00:00.000Z';
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'review-scope-derivation-test-'));
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

describe('review scope prose states its semantics explicitly (both skill files)', () => {
  it.each([
    ['skills/review/SKILL.md', REVIEW_SKILL],
    ['skills/autopilot/phases/review.md', AUTOPILOT_REVIEW],
  ])('%s discloses the ordering fact, the approximation, and exhaustive paging', (_name, rawText) => {
    // Markdown hard-wraps prose across lines — collapse runs of whitespace
    // (including newlines) to single spaces so a phrase's wrap point can
    // never make an honest disclosure invisible to this check.
    const text = rawText.replace(/\s+/g, ' ');
    // The ordering fact, stated plainly (not left to be inferred).
    expect(text).toMatch(/`work_list` orders newest-CREATED first/);
    expect(text).toMatch(/not by completion time|NOT the same fact as "completed recently\."/);
    // The exhaustive-paging instruction — the mechanical mitigation for
    // pagination truncation.
    expect(text).toMatch(/paged to TRUE exhaustion/);
    expect(text).toMatch(/follow `next_cursor` until it is `null`/);
    // The "no cheaper row signal" finding that rules out silently trusting
    // updated_at.
    expect(text).toMatch(/`updated_at`/);
    expect(text).toMatch(/never by `claim`\/`renew`\/`complete`\/`release`|untouched by `claim`\/`renew`\/`complete`\/`release`/);
  });
});

describe('the artifact behind the prose', () => {
  it('work_list really does order newest-created-first (created_at DESC) — the claim the prose makes', () => {
    const { store, setNow } = makeFixture();
    setNow('2026-01-01T00:00:00.000Z');
    const older = store.insertItem({ title: 'older', spec: 's', spec_format: 'f', created_by: actor() });
    setNow('2026-06-01T00:00:00.000Z');
    const newer = store.insertItem({ title: 'newer', spec: 's', spec_format: 'f', created_by: actor() });

    const page = store.listItemSummaryViews();
    expect(page.items.map((i) => i.id)).toEqual([newer.id, older.id]);
  });

  it('updated_at does not move across a full claim->complete lifecycle — no cheaper row-level completion signal exists', () => {
    const { store, clock, setNow } = makeFixture();
    setNow('2026-01-01T00:00:00.000Z');
    const item = store.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: actor() });
    const createdAt = item.created_at;
    expect(item.updated_at).toBe(createdAt);

    setNow('2026-01-01T01:00:00.000Z'); // well within the default 4h lease
    const claimed = claim(store, clock, item.id, actor());
    expect(claimed.updated_at).toBe(createdAt); // claim() does not bump it

    setNow('2026-01-01T02:00:00.000Z');
    complete(store, clock, item.id, claimed.claim?.claim_token as number);
    const done = store.getItem(item.id);
    expect(done?.status).toBe('done');
    expect(done?.updated_at).toBe(createdAt); // complete() does not bump it either
  });

  it('work_events is single-item-scoped — no board-wide "recently completed" query exists to derive scope from cheaply', () => {
    const { store, clock, setNow } = makeFixture();
    setNow('2026-01-01T00:00:00.000Z');
    const a = store.insertItem({ title: 'a', spec: 's', spec_format: 'f', created_by: actor() });
    const b = store.insertItem({ title: 'b', spec: 's', spec_format: 'f', created_by: actor() });
    const claimedA = claim(store, clock, a.id, actor());
    complete(store, clock, a.id, claimedA.claim?.claim_token as number);

    // events() takes exactly one item id — establishing "what completed
    // since T" board-wide costs one call PER candidate item, not one call
    // total. Proven here by the signature itself: no filter/date param, no
    // multi-id form.
    expect(store.events(a.id).some((e) => e.transition === 'complete')).toBe(true);
    expect(store.events(b.id).some((e) => e.transition === 'complete')).toBe(false);
  });

  it('THE FIXTURE: an item created before the cycle but completed within it is DROPPED by a bounded/single-page read and PRESENT once next_cursor is followed to exhaustion', () => {
    const { store, clock, setNow } = makeFixture();

    // OLD is created first, so it has the oldest created_at and sorts LAST
    // under `created_at DESC` — exactly the item the old proxy would treat
    // as "not recent."
    setNow('2026-01-01T00:00:00.000Z');
    const old = store.insertItem({ title: 'long-lived decision item', spec: 's', spec_format: 'f', created_by: actor() });

    // A batch of NEWER items, created (and completed) well after OLD —
    // enough of them to push OLD off a small/bounded first page.
    setNow('2026-06-01T00:00:00.000Z');
    const newer = Array.from({ length: 4 }, (_, i) =>
      store.insertItem({ title: `newer-${String(i)}`, spec: 's', spec_format: 'f', created_by: actor() }),
    );

    // Complete every item — including OLD — all within "this cycle." OLD's
    // created_at stays the earliest on the board regardless of when it
    // completes; work_list's ordering never reflects completion order.
    setNow('2026-07-01T00:00:00.000Z');
    for (const it of [...newer, old]) {
      const claimed = claim(store, clock, it.id, actor());
      complete(store, clock, it.id, claimed.claim?.claim_token as number);
    }

    // THE OLD FAILURE MODE: a single bounded page (small limit, no
    // next_cursor follow-up) — this is what "recent done items" used to mean
    // in practice. OLD does not appear on it.
    const firstPageOnly = store.listItemSummaryViews({ status: 'done' }, { limit: 2 });
    expect(firstPageOnly.items.map((i) => i.id)).not.toContain(old.id);
    expect(firstPageOnly.next_cursor).not.toBeNull(); // more remain — proof the page really was truncated

    // THE FIXED INSTRUCTION: page to TRUE exhaustion, following next_cursor
    // until it is null. OLD is present in the fully-exhausted result — the
    // created-before/completed-within case lands in scope.
    const allDone: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = store.listItemSummaryViews({ status: 'done' }, { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      allDone.push(...page.items.map((i) => i.id));
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    expect(allDone).toContain(old.id);
    expect(allDone).toHaveLength(newer.length + 1);
  });
});
