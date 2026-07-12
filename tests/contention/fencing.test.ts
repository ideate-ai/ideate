// plugin/tests/contention/fencing.test.ts — WI-304 falsifiability evidence
// for §3.2 rule 3 (docs/spikes/v3-work-delegation.md): "A worker whose lease
// expired and was reclaimed by someone else holds a stale token and is
// rejected — preventing the classic delayed-writer bug (Kleppmann)."
//
// The FULL delayed-writer sequence, ACROSS PROCESSES:
//   1. Process A claims the item (short lease) — token TA.
//   2. TA's lease expires (real wall-clock wait, bounded).
//   3. Process B reclaims the item (its own `claim()` call runs the lazy
//      expiry check first, then wins the CAS) — token TB, strictly > TA.
//   4. Process A, STILL HOLDING its now-stale TA, attempts renew, complete,
//      and release: all three must be rejected, typed (INVALID_CLAIM).
//   5. Process B's own subsequent `complete(TB)` must succeed.
//
// Ordering across the two real OS processes is enforced with two
// file-barriers (not the readiness-handshake barrier — this scenario is
// intentionally SEQUENTIAL, not simultaneous: B must finish reclaiming
// before A is released to attempt its stale-token calls, and A's attempts
// must finish before B is released to complete). Every contended call goes
// through claims.ts's own exported functions — no raw SQL in this file,
// including the post-hoc final-state read.

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupTempDirs,
  distUrl,
  ensureBuilt,
  makeTempDir,
  releaseBarrier,
  runNodeScript,
  sleep,
  stillAlivePids,
  writeChildScript,
} from './helpers.js';
import type { WorkStateStore as WorkStateStoreClass } from '../../src/work-state/store.js';
import type { WorkStateVerbs as WorkStateVerbsClass } from '../../src/work-state/verbs.js';

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
    `fencing.test.ts: spawned ${String(allSpawnedPids.length)} child process(es); ` +
      `${String(alive.length)} still alive after the suite (expect 0): ${JSON.stringify(alive)}`,
  );
  expect(alive).toEqual([]);
});

const STORE_URL = distUrl('work-state/store.js');
const VERBS_URL = distUrl('work-state/verbs.js');
const CLAIMS_URL = distUrl('work-state/claims.js');

const LEASE_MS = 150;
const PAST_EXPIRY_MARGIN_MS = 150;

function delayedWriterChildSource(): string {
  return [
    `import { existsSync } from 'node:fs';`,
    `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
    `import { claim, renew, complete, release } from ${JSON.stringify(CLAIMS_URL)};`,
    ``,
    `const [dbPath, itemId, human, leaseMsArg, barrierFile] = process.argv.slice(2);`,
    `const store = new WorkStateStore(dbPath, () => new Date());`,
    `const clock = () => new Date();`,
    `const item = claim(store, clock, itemId, { human }, { leaseMs: Number(leaseMsArg) });`,
    `const token = item.claim.claim_token;`,
    `process.stdout.write('CLAIMED ' + String(token) + '\\n');`,
    ``,
    `const __deadline = Date.now() + 10000;`,
    `while (!existsSync(barrierFile)) {`,
    `  if (Date.now() > __deadline) {`,
    `    process.stderr.write('barrier timeout: barrier file never appeared\\n');`,
    `    process.exit(97);`,
    `  }`,
    `}`,
    ``,
    `function attempt(name, fn) {`,
    `  try {`,
    `    fn();`,
    `    return { call: name, outcome: 'ok' };`,
    `  } catch (err) {`,
    `    return { call: name, outcome: 'err', name: err && err.name, code: err && err.code };`,
    `  }`,
    `}`,
    ``,
    `const results = [`,
    `  attempt('renew', () => renew(store, clock, itemId, token)),`,
    `  attempt('complete', () => complete(store, clock, itemId, token)),`,
    `  attempt('release', () => release(store, clock, itemId, token)),`,
    `];`,
    `process.stdout.write('RESULTS ' + JSON.stringify(results) + '\\n');`,
    `process.exit(0);`,
    ``,
  ].join('\n');
}

function reclaimerChildSource(): string {
  return [
    `import { existsSync } from 'node:fs';`,
    `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
    `import { claim, complete } from ${JSON.stringify(CLAIMS_URL)};`,
    ``,
    `const [dbPath, itemId, human, barrierFile] = process.argv.slice(2);`,
    `const store = new WorkStateStore(dbPath, () => new Date());`,
    `const clock = () => new Date();`,
    `const item = claim(store, clock, itemId, { human });`,
    `const token = item.claim.claim_token;`,
    `process.stdout.write('CLAIMED ' + String(token) + '\\n');`,
    ``,
    `const __deadline = Date.now() + 10000;`,
    `while (!existsSync(barrierFile)) {`,
    `  if (Date.now() > __deadline) {`,
    `    process.stderr.write('barrier timeout: barrier file never appeared\\n');`,
    `    process.exit(97);`,
    `  }`,
    `}`,
    ``,
    `try {`,
    `  const completed = complete(store, clock, itemId, token);`,
    `  process.stdout.write('COMPLETED ok ' + completed.status + '\\n');`,
    `  process.exit(0);`,
    `} catch (err) {`,
    `  process.stdout.write('COMPLETED err ' + String(err && err.code) + '\\n');`,
    `  process.exit(1);`,
    `}`,
    ``,
  ].join('\n');
}

interface AttemptResult {
  call: 'renew' | 'complete' | 'release';
  outcome: 'ok' | 'err';
  name?: string;
  code?: string;
}

async function seedItem(dbPath: string): Promise<string> {
  const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
  const store = new WorkStateStore(dbPath, () => new Date());
  const verbs = new (((await import(VERBS_URL)) as VerbsModule).WorkStateVerbs)(store, () => new Date());
  const item = verbs.create({
    title: 'fencing target',
    spec: '{}',
    spec_format: 'test/fencing',
    created_by: { human: 'seed-creator' },
  });
  return item.id;
}

describe('fencing — §3.2 rule 3, the Kleppmann delayed-writer sequence, across processes', () => {
  it(
    "A's stale-token renew/complete/release all reject typed after B reclaims; B's complete succeeds",
    async () => {
      const root = makeTempDir('ideate-contention-fencing-');
      const dbPath = `${root}/board.db`;
      const itemId = await seedItem(dbPath);

      // 1. Process A claims (short lease).
      const barrierA = `${root}/release-a`;
      const scriptA = writeChildScript(root, 'delayed-writer.mjs', delayedWriterChildSource());
      const childA = runNodeScript(scriptA, [dbPath, itemId, 'delayed-writer', String(LEASE_MS), barrierA]);
      allSpawnedPids.push(childA.pid);
      const claimedALine = await childA.waitForLine((line) => line.startsWith('CLAIMED '));
      const tokenA = Number(claimedALine.slice('CLAIMED '.length));

      // 2. Real wall-clock wait past TA's lease expiry — the only sleep in
      // this scenario, bounded per the suite's own "leases of ~100-500ms"
      // discipline.
      await sleep(LEASE_MS + PAST_EXPIRY_MARGIN_MS);

      // 3. Process B reclaims — its own claim() runs the lazy expiry check
      // first (voiding TA), then wins the CAS with a strictly greater token.
      const barrierB = `${root}/release-b`;
      const scriptB = writeChildScript(root, 'reclaimer.mjs', reclaimerChildSource());
      const childB = runNodeScript(scriptB, [dbPath, itemId, 'reclaimer', barrierB]);
      allSpawnedPids.push(childB.pid);
      const claimedBLine = await childB.waitForLine((line) => line.startsWith('CLAIMED '));
      const tokenB = Number(claimedBLine.slice('CLAIMED '.length));

      expect(tokenB).toBeGreaterThan(tokenA);

      // 4. Release A: it attempts renew/complete/release with its STALE
      // token TA, while B still holds the item in_progress under TB.
      releaseBarrier(barrierA);
      const resultsLine = await childA.waitForLine((line) => line.startsWith('RESULTS '));
      const attemptResults = JSON.parse(resultsLine.slice('RESULTS '.length)) as AttemptResult[];
      expect(attemptResults).toHaveLength(3);
      for (const r of attemptResults) {
        expect(r, `A's stale-token ${r.call} unexpectedly ${r.outcome}: ${JSON.stringify(r)}`).toMatchObject({
          outcome: 'err',
          name: 'ClaimEngineError',
          code: 'INVALID_CLAIM',
        });
      }
      const settledA = await childA.result;
      expect(settledA, `A stderr: ${settledA.stderr}`).toMatchObject({ code: 0 });

      // 5. Release B: its OWN complete(TB) must now succeed.
      releaseBarrier(barrierB);
      const completedLine = await childB.waitForLine((line) => line.startsWith('COMPLETED '));
      expect(completedLine.startsWith('COMPLETED ok')).toBe(true);
      const settledB = await childB.result;
      expect(settledB, `B stderr: ${settledB.stderr}`).toMatchObject({ code: 0 });

      // Post-hoc board-state check via the contract's own reader.
      const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
      const store = new WorkStateStore(dbPath, () => new Date());
      const finalItem = store.getItem(itemId);
      expect(finalItem?.status).toBe('done');
      expect(finalItem?.claim).toBeNull();

      const events = store.events(itemId);
      const transitions = events.map((e) => e.transition);
      // create -> claim(A, TA) -> orphan-recovery(voids TA, from B's own
      // claim() lazy check) -> claim(B, TB) -> complete(B, TB). None of A's
      // three rejected attempts append an event (a thrown ClaimEngineError
      // means the whole CAS transaction rolled back — claims.ts's own
      // documented contract).
      expect(transitions).toEqual(['create', 'claim', 'orphan-recovery', 'claim', 'complete']);
      const completeEvent = events[events.length - 1];
      expect(completeEvent?.claim_token).toBe(tokenB);
      expect(completeEvent?.actor.human).toBe('reclaimer');
    },
    20_000,
  );
});
