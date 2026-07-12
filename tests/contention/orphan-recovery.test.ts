// plugin/tests/contention/orphan-recovery.test.ts — WI-304 falsifiability
// evidence for the spec's §5 "orphan recovery" criterion
// (docs/spikes/v3-work-delegation.md): "kill a claiming agent mid-task; the
// item must return to `open` within one lease period with no human
// intervention," amended 2026-07-09 (S3/Q-36) into two distinct mechanisms,
// both exercised here against a REAL, killed OS process:
//
//   (a) the LAZY check — recovery on the next board contact by ANOTHER
//       process (a `get()` call, run through the built dist modules).
//   (b) the OPPORTUNISTIC SWEEP — recovery via `sweepBoard` on a board that
//       nothing else has touched since the kill.
//
// Both scenarios use a short lease (150ms) so the whole file stays well
// under the 30s bound with no sleeping beyond that lease window itself.

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupTempDirs,
  distUrl,
  ensureBuilt,
  makeTempDir,
  runNodeScript,
  sleep,
  stillAlivePids,
  writeChildScript,
} from './helpers.js';
import type { WorkStateStore as WorkStateStoreClass } from '../../src/work-state/store.js';
import type { WorkStateVerbs as WorkStateVerbsClass } from '../../src/work-state/verbs.js';

// The parent test process only ever dynamically imports the built
// work-state/store.js module directly (for seeding items and post-hoc
// reads); expiry.ts/verbs.ts are exercised exclusively INSIDE the spawned
// child scripts below (plain JS strings), so no type-only import is needed
// for them here.
interface StoreModule {
  WorkStateStore: typeof WorkStateStoreClass;
}
interface VerbsModule {
  WorkStateVerbs: typeof WorkStateVerbsClass;
}

ensureBuilt();

const allSpawnedPids: number[] = [];

afterAll(() => {
  cleanupTempDirs();
  const alive = stillAlivePids(allSpawnedPids);
  // eslint-disable-next-line no-console
  console.log(
    `orphan-recovery.test.ts: spawned ${String(allSpawnedPids.length)} child process(es); ` +
      `${String(alive.length)} still alive after the suite (expect 0): ${JSON.stringify(alive)}`,
  );
  expect(alive).toEqual([]);
});

const STORE_URL = distUrl('work-state/store.js');
const VERBS_URL = distUrl('work-state/verbs.js');
const CLAIMS_URL = distUrl('work-state/claims.js');

const LEASE_MS = 150;
// Real wall-clock margin past the lease's own expiry — bounded, per the
// acceptance criterion's own "leases of ~100-500ms" instruction.
const PAST_EXPIRY_MARGIN_MS = 150;

/** A child that claims the item with a short lease, prints `CLAIMED
 *  <token>`, then hangs forever (an infinite no-op interval) — simulating a
 *  worker killed mid-task, AFTER acquiring the claim and BEFORE completing. */
function claimAndHangChildSource(): string {
  return [
    `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
    `import { claim } from ${JSON.stringify(CLAIMS_URL)};`,
    ``,
    `const [dbPath, itemId, human, leaseMsArg] = process.argv.slice(2);`,
    `const store = new WorkStateStore(dbPath, () => new Date());`,
    `const item = claim(store, () => new Date(), itemId, { human }, { leaseMs: Number(leaseMsArg) });`,
    `process.stdout.write('CLAIMED ' + String(item.claim.claim_token) + '\\n');`,
    `// Hang until SIGKILLed by the parent — never exits on its own; this is`,
    `// the "killed mid-task" simulation, not a graceful shutdown.`,
    `setInterval(() => {}, 1000);`,
    ``,
  ].join('\n');
}

async function seedItem(dbPath: string, title: string): Promise<string> {
  const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
  const store = new WorkStateStore(dbPath, () => new Date());
  const verbs = new (((await import(VERBS_URL)) as VerbsModule).WorkStateVerbs)(store, () => new Date());
  const item = verbs.create({
    title,
    spec: '{}',
    spec_format: 'test/orphan-recovery',
    created_by: { human: 'seed-creator' },
  });
  return item.id;
}

/** Spawn the claim-and-hang child, wait for its CLAIMED line, then SIGKILL
 *  it — returns the fencing token it briefly held, for assertions. */
async function claimThenKill(root: string, dbPath: string, itemId: string): Promise<number> {
  const scriptPath = writeChildScript(root, 'claim-and-hang.mjs', claimAndHangChildSource());
  const child = runNodeScript(scriptPath, [dbPath, itemId, 'orphaned-worker', String(LEASE_MS)]);
  allSpawnedPids.push(child.pid);

  const claimedLine = await child.waitForLine((line) => line.startsWith('CLAIMED '));
  const token = Number(claimedLine.slice('CLAIMED '.length));
  child.kill('SIGKILL');
  const settled = await child.result;
  expect(settled.signal).toBe('SIGKILL');
  return token;
}

describe('orphan recovery — §5 falsifiability, §3.2 rule 2 hybrid expiry', () => {
  it(
    '(a) lazy check: another REAL process touching the board recovers the item to open',
    async () => {
      const root = makeTempDir('ideate-contention-orphan-lazy-');
      const dbPath = `${root}/board.db`;
      const itemId = await seedItem(dbPath, 'orphan-recovery target (lazy check)');

      const staleToken = await claimThenKill(root, dbPath, itemId);

      // Real wall-clock wait past the (short) lease's own expiry — the ONLY
      // sleep in this scenario, bounded by the acceptance criterion's own
      // "leases of ~100-500ms" instruction.
      await sleep(LEASE_MS + PAST_EXPIRY_MARGIN_MS);

      // A SEPARATE, real OS process makes "the next board contact" — a
      // plain get() through WorkStateVerbs with the real checkExpiry hook
      // wired in exactly as the CLI/MCP transports wire it (verbs.ts's own
      // ExpiryCheck seam), never a raw SQL touch.
      const getScript = writeChildScript(
        root,
        'get-with-expiry.mjs',
        [
          `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
          `import { WorkStateVerbs } from ${JSON.stringify(distUrl('work-state/verbs.js'))};`,
          `import { checkExpiry } from ${JSON.stringify(distUrl('work-state/expiry.js'))};`,
          ``,
          `const [dbPath, itemId] = process.argv.slice(2);`,
          `const clock = () => new Date();`,
          `const store = new WorkStateStore(dbPath, clock);`,
          `const verbs = new WorkStateVerbs(store, clock);`,
          `const item = verbs.get(itemId, (id) => { checkExpiry(store, clock, id); });`,
          `process.stdout.write(JSON.stringify(item) + '\\n');`,
          ``,
        ].join('\n'),
      );
      const getChild = runNodeScript(getScript, [dbPath, itemId]);
      allSpawnedPids.push(getChild.pid);
      const getResult = await getChild.result;
      expect(getResult, `stderr: ${getResult.stderr}`).toMatchObject({ code: 0 });
      const recoveredItem = JSON.parse(getResult.stdout.trim()) as { status: string; claim: unknown };
      expect(recoveredItem.status).toBe('open');
      expect(recoveredItem.claim).toBeNull();

      // No human intervention anywhere above — confirm via the store's own
      // event log that the orphan-recovery event was appended and voided
      // exactly the stale token this process held.
      const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
      const store = new WorkStateStore(dbPath, () => new Date());
      const events = store.events(itemId);
      const recoveryEvents = events.filter((e) => e.transition === 'orphan-recovery');
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]?.claim_token).toBe(staleToken);
      expect(recoveryEvents[0]?.actor.human).toBe('orphaned-worker');
    },
    20_000,
  );

  it(
    '(b) opportunistic sweep: sweepBoard recovers the item on an otherwise-untouched board',
    async () => {
      const root = makeTempDir('ideate-contention-orphan-sweep-');
      const dbPath = `${root}/board.db`;
      const itemId = await seedItem(dbPath, 'orphan-recovery target (sweep)');

      const staleToken = await claimThenKill(root, dbPath, itemId);

      await sleep(LEASE_MS + PAST_EXPIRY_MARGIN_MS);

      // A SEPARATE real OS process runs ONLY sweepBoard — this item is
      // otherwise "untouched" (no get/list/claim call has been made on it
      // since the kill), matching the acceptance criterion's own framing.
      const sweepScript = writeChildScript(
        root,
        'sweep.mjs',
        [
          `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
          `import { sweepBoard } from ${JSON.stringify(distUrl('work-state/expiry.js'))};`,
          ``,
          `const [dbPath] = process.argv.slice(2);`,
          `const clock = () => new Date();`,
          `const store = new WorkStateStore(dbPath, clock);`,
          `const results = sweepBoard(store, clock);`,
          `process.stdout.write(JSON.stringify(results) + '\\n');`,
          ``,
        ].join('\n'),
      );
      const sweepChild = runNodeScript(sweepScript, [dbPath]);
      allSpawnedPids.push(sweepChild.pid);
      const sweepResult = await sweepChild.result;
      expect(sweepResult, `stderr: ${sweepResult.stderr}`).toMatchObject({ code: 0 });
      const results = JSON.parse(sweepResult.stdout.trim()) as { expired: boolean; voidedToken?: number }[];
      const recovered = results.filter((r) => r.expired);
      expect(recovered).toHaveLength(1);
      expect(recovered[0]?.voidedToken).toBe(staleToken);

      // Post-hoc read via the contract's own reader (not raw SQL) — the
      // item is open, unclaimed, no human intervention anywhere above.
      const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
      const store = new WorkStateStore(dbPath, () => new Date());
      const finalItem = store.getItem(itemId);
      expect(finalItem?.status).toBe('open');
      expect(finalItem?.claim).toBeNull();

      const events = store.events(itemId);
      const recoveryEvents = events.filter((e) => e.transition === 'orphan-recovery');
      expect(recoveryEvents).toHaveLength(1);
      expect(recoveryEvents[0]?.claim_token).toBe(staleToken);
    },
    20_000,
  );
});
