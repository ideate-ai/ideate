// plugin/tests/contention/claim-races.test.ts — WI-304 falsifiability
// evidence for the spec's §5 "duplicate-work rate" criterion and §3.2 rule 1
// (docs/spikes/v3-work-delegation.md): "with >=2 ICs on one board... zero
// instances of two ICs completing the same item under valid claims."
//
// Two scenarios, both REAL, separate OS processes (child_process.spawn
// against process.execPath — never worker_threads, never a vitest fork),
// racing through the BUILT dist modules (P-34):
//
//   1. N-way claim() race on ONE item (criterion 1): exactly one winner,
//      n-1 typed NOT_CLAIMABLE losers, run at N=2 and N=6.
//   2. Cross-verb TOCTOU race (criterion 4, carried from F-302-001):
//      cancel() vs complete() on the same in_progress item, 20 iterations,
//      exactly one transition wins every time.
//
// Every contended call goes through claims.ts/verbs.ts's own exported
// functions (claim/complete, WorkStateVerbs.cancel) — no raw SQL anywhere in
// this file, including the post-hoc read of the item's final state
// (WorkStateStore.getItem/events — the contract's own reader).

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupTempDirs,
  distUrl,
  ensureBuilt,
  makeTempDir,
  runNodeScript,
  stillAlivePids,
  synchronizeAndRelease,
  writeChildScript,
  type ChildResult,
} from './helpers.js';
// Type-only imports (erased at build time — see tsconfig's own `.test.ts`
// exclude): the RUNTIME value in this file always comes from a dynamic
// `import(distUrl(...))` against the BUILT dist module (P-34); these give
// that dynamic import's result a real shape to check against instead of
// `any`.
import type { claim as ClaimFn, complete as CompleteFn } from '../../src/work-state/claims.js';
import type { WorkStateStore as WorkStateStoreClass } from '../../src/work-state/store.js';
import type { WorkStateVerbs as WorkStateVerbsClass } from '../../src/work-state/verbs.js';

interface StoreModule {
  WorkStateStore: typeof WorkStateStoreClass;
}
interface VerbsModule {
  WorkStateVerbs: typeof WorkStateVerbsClass;
}
interface ClaimsModule {
  claim: typeof ClaimFn;
  complete: typeof CompleteFn;
}

ensureBuilt();

const allSpawnedPids: number[] = [];

afterAll(() => {
  cleanupTempDirs();
  const alive = stillAlivePids(allSpawnedPids);
  // Report (criterion 7): every pid this file ever spawned, and which (if
  // any) are still alive after the suite finished.
  // eslint-disable-next-line no-console
  console.log(
    `claim-races.test.ts: spawned ${String(allSpawnedPids.length)} child process(es); ` +
      `${String(alive.length)} still alive after the suite (expect 0): ${JSON.stringify(alive)}`,
  );
  expect(alive).toEqual([]);
});

const STORE_URL = distUrl('work-state/store.js');
const CLAIMS_URL = distUrl('work-state/claims.js');
const VERBS_URL = distUrl('work-state/verbs.js');

// ---------------------------------------------------------------------------
// Scenario 1: N-way claim() race (criterion 1)
// ---------------------------------------------------------------------------

function claimRaceChildSource(): string {
  return [
    `import { existsSync } from 'node:fs';`,
    `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
    `import { claim } from ${JSON.stringify(CLAIMS_URL)};`,
    ``,
    `const [dbPath, itemId, human, goFile] = process.argv.slice(2);`,
    `const store = new WorkStateStore(dbPath, () => new Date());`,
    `// Warm-up read: forces node:sqlite's native binding + this connection's`,
    `// own module graph to finish loading BEFORE we signal readiness, so the`,
    `// only work left after the barrier releases is the contended CAS itself.`,
    `store.getItem(itemId);`,
    `process.stdout.write('READY\\n');`,
    ``,
    `const __barrierDeadline = Date.now() + 10000;`,
    `while (!existsSync(goFile)) {`,
    `  if (Date.now() > __barrierDeadline) {`,
    `    process.stderr.write('barrier timeout: go file never appeared\\n');`,
    `    process.exit(97);`,
    `  }`,
    `}`,
    ``,
    `try {`,
    `  const item = claim(store, () => new Date(), itemId, { human });`,
    `  process.stdout.write(JSON.stringify({ outcome: 'won', human, token: item.claim.claim_token }) + '\\n');`,
    `  process.exit(0);`,
    `} catch (err) {`,
    `  if (err && err.name === 'ClaimEngineError' && err.code === 'NOT_CLAIMABLE') {`,
    `    process.stdout.write(JSON.stringify({ outcome: 'lost', human, code: err.code }) + '\\n');`,
    `    process.exit(0);`,
    `  }`,
    `  process.stderr.write('unexpected error: ' + (err && err.stack ? err.stack : String(err)) + '\\n');`,
    `  process.exit(1);`,
    `}`,
    ``,
  ].join('\n');
}

interface RaceOutcome {
  outcome: 'won' | 'lost';
  human: string;
  token?: number;
  code?: string;
}

async function seedItem(dbPath: string): Promise<string> {
  const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
  const { WorkStateVerbs } = (await import(VERBS_URL)) as VerbsModule;
  const store = new WorkStateStore(dbPath, () => new Date());
  const verbs = new WorkStateVerbs(store, () => new Date());
  const item = verbs.create({
    title: 'claim-race target',
    spec: '{}',
    spec_format: 'test/claim-race',
    created_by: { human: 'seed-creator' },
  });
  return item.id;
}

async function runClaimRace(n: number): Promise<void> {
  const root = makeTempDir(`ideate-contention-claim-race-${String(n)}-`);
  const dbPath = `${root}/board.db`;
  const itemId = await seedItem(dbPath);
  const goFile = `${root}/go`;
  const scriptPath = writeChildScript(root, 'child.mjs', claimRaceChildSource());

  const children = Array.from({ length: n }, (_v, i) => runNodeScript(scriptPath, [dbPath, itemId, `actor-${String(i)}`, goFile]));
  for (const c of children) allSpawnedPids.push(c.pid);

  await synchronizeAndRelease(children, goFile);

  const results: ChildResult[] = await Promise.all(children.map((c) => c.result));
  for (const r of results) {
    expect(r, `child stderr: ${r.stderr}`).toMatchObject({ code: 0 });
  }

  const outcomes: RaceOutcome[] = results.map((r) => JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as RaceOutcome);
  const winners = outcomes.filter((o) => o.outcome === 'won');
  const losers = outcomes.filter((o) => o.outcome === 'lost');

  expect(winners, `outcomes: ${JSON.stringify(outcomes)}`).toHaveLength(1);
  expect(losers, `outcomes: ${JSON.stringify(outcomes)}`).toHaveLength(n - 1);
  for (const loser of losers) {
    expect(loser.code).toBe('NOT_CLAIMABLE');
  }

  // Post-hoc board-state check via the contract interface (F-304-001 M1:
  // the oracle uses verbs.get with the default no-op expiry check — an
  // oracle must never mutate the state it observes).
  const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
  const { WorkStateVerbs } = (await import(VERBS_URL)) as VerbsModule;
  const store = new WorkStateStore(dbPath, () => new Date());
  const finalItem = new WorkStateVerbs(store, () => new Date()).get(itemId);
  expect(finalItem?.status).toBe('in_progress');
  expect(finalItem?.claim?.holder.human).toBe(winners[0]?.human);
  expect(finalItem?.claim?.claim_token).toBe(winners[0]?.token);
}

describe('N-way claim() race — §5 duplicate-work-rate falsifiability, §3.2 rule 1', () => {
  it(
    '2-way: exactly one winner, one typed NOT_CLAIMABLE loser',
    async () => {
      await runClaimRace(2);
    },
    20_000,
  );

  it(
    '6-way: exactly one winner, five typed NOT_CLAIMABLE losers',
    async () => {
      await runClaimRace(6);
    },
    20_000,
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: cross-verb TOCTOU race — cancel() vs complete() (criterion 4,
// carried from F-302-001)
// ---------------------------------------------------------------------------

function cancelChildSource(): string {
  return [
    `import { existsSync } from 'node:fs';`,
    `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
    `import { WorkStateVerbs } from ${JSON.stringify(VERBS_URL)};`,
    ``,
    `const [dbPath, itemId, human, goFile] = process.argv.slice(2);`,
    `const store = new WorkStateStore(dbPath, () => new Date());`,
    `const verbs = new WorkStateVerbs(store, () => new Date());`,
    `store.getItem(itemId);`,
    `process.stdout.write('READY\\n');`,
    ``,
    `const __barrierDeadline = Date.now() + 10000;`,
    `while (!existsSync(goFile)) {`,
    `  if (Date.now() > __barrierDeadline) {`,
    `    process.stderr.write('barrier timeout: go file never appeared\\n');`,
    `    process.exit(97);`,
    `  }`,
    `}`,
    ``,
    `try {`,
    `  const item = verbs.cancel(itemId, { human });`,
    `  process.stdout.write(JSON.stringify({ verb: 'cancel', outcome: 'ok', status: item.status }) + '\\n');`,
    `  process.exit(0);`,
    `} catch (err) {`,
    `  if (err && err.name === 'VerbError' && err.code === 'INVALID_TRANSITION') {`,
    `    process.stdout.write(JSON.stringify({ verb: 'cancel', outcome: 'err', name: err.name, code: err.code }) + '\\n');`,
    `    process.exit(0);`,
    `  }`,
    `  process.stderr.write('unexpected cancel error: ' + (err && err.stack ? err.stack : String(err)) + '\\n');`,
    `  process.exit(1);`,
    `}`,
    ``,
  ].join('\n');
}

function completeChildSource(): string {
  return [
    `import { existsSync } from 'node:fs';`,
    `import { WorkStateStore } from ${JSON.stringify(STORE_URL)};`,
    `import { complete } from ${JSON.stringify(CLAIMS_URL)};`,
    ``,
    `const [dbPath, itemId, tokenArg, goFile] = process.argv.slice(2);`,
    `const token = Number(tokenArg);`,
    `const store = new WorkStateStore(dbPath, () => new Date());`,
    `store.getItem(itemId);`,
    `process.stdout.write('READY\\n');`,
    ``,
    `const __barrierDeadline = Date.now() + 10000;`,
    `while (!existsSync(goFile)) {`,
    `  if (Date.now() > __barrierDeadline) {`,
    `    process.stderr.write('barrier timeout: go file never appeared\\n');`,
    `    process.exit(97);`,
    `  }`,
    `}`,
    ``,
    `try {`,
    `  const item = complete(store, () => new Date(), itemId, token);`,
    `  process.stdout.write(JSON.stringify({ verb: 'complete', outcome: 'ok', status: item.status }) + '\\n');`,
    `  process.exit(0);`,
    `} catch (err) {`,
    `  if (err && err.name === 'ClaimEngineError' && err.code === 'INVALID_CLAIM') {`,
    `    process.stdout.write(JSON.stringify({ verb: 'complete', outcome: 'err', name: err.name, code: err.code }) + '\\n');`,
    `    process.exit(0);`,
    `  }`,
    `  process.stderr.write('unexpected complete error: ' + (err && err.stack ? err.stack : String(err)) + '\\n');`,
    `  process.exit(1);`,
    `}`,
    ``,
  ].join('\n');
}

interface VerbOutcome {
  verb: 'cancel' | 'complete';
  outcome: 'ok' | 'err';
  status?: string;
  name?: string;
  code?: string;
}

async function runOneToctouIteration(iteration: number): Promise<void> {
  const root = makeTempDir(`ideate-contention-toctou-${String(iteration)}-`);
  const dbPath = `${root}/board.db`;

  const { WorkStateStore } = (await import(STORE_URL)) as StoreModule;
  const { claim } = (await import(CLAIMS_URL)) as ClaimsModule;
  const store = new WorkStateStore(dbPath, () => new Date());
  const created = store.insertItem({
    title: `toctou target ${String(iteration)}`,
    spec: '{}',
    spec_format: 'test/toctou',
    created_by: { human: 'seed-creator' },
  });
  const claimed = claim(store, () => new Date(), created.id, { human: 'worker' });
  const token = claimed.claim?.claim_token;
  expect(token).toBeDefined();

  const goFile = `${root}/go`;
  const cancelScript = writeChildScript(root, 'cancel.mjs', cancelChildSource());
  const completeScript = writeChildScript(root, 'complete.mjs', completeChildSource());

  const cancelChild = runNodeScript(cancelScript, [dbPath, created.id, 'canceller', goFile]);
  const completeChild = runNodeScript(completeScript, [dbPath, created.id, String(token), goFile]);
  allSpawnedPids.push(cancelChild.pid, completeChild.pid);

  await synchronizeAndRelease([cancelChild, completeChild], goFile);

  const [cancelResult, completeResult] = await Promise.all([cancelChild.result, completeChild.result]);
  expect(cancelResult, `cancel stderr: ${cancelResult.stderr}`).toMatchObject({ code: 0 });
  expect(completeResult, `complete stderr: ${completeResult.stderr}`).toMatchObject({ code: 0 });

  const cancelOutcome = JSON.parse(cancelResult.stdout.trim().split('\n').pop() ?? '') as VerbOutcome;
  const completeOutcome = JSON.parse(completeResult.stdout.trim().split('\n').pop() ?? '') as VerbOutcome;

  const oks = [cancelOutcome, completeOutcome].filter((o) => o.outcome === 'ok');
  const errs = [cancelOutcome, completeOutcome].filter((o) => o.outcome === 'err');
  expect(oks, `iteration ${String(iteration)}: ${JSON.stringify({ cancelOutcome, completeOutcome })}`).toHaveLength(1);
  expect(errs, `iteration ${String(iteration)}: ${JSON.stringify({ cancelOutcome, completeOutcome })}`).toHaveLength(1);

  const finalItem = store.getItem(created.id);
  expect(finalItem?.status === 'done' || finalItem?.status === 'cancelled').toBe(true);
  expect(finalItem?.status).toBe(oks[0]?.status);

  const events = store.events(created.id);
  const matchingTransitionEvents = events.filter((e) => e.transition === (finalItem?.status === 'done' ? 'complete' : 'cancel'));
  expect(matchingTransitionEvents, `events: ${JSON.stringify(events)}`).toHaveLength(1);
  const otherTransitionEvents = events.filter((e) => e.transition === (finalItem?.status === 'done' ? 'cancel' : 'complete'));
  expect(otherTransitionEvents, `events: ${JSON.stringify(events)}`).toHaveLength(0);
}

describe('cross-verb TOCTOU race: cancel() vs complete() (criterion 4, F-302-001)', () => {
  it(
    '20 iterations — exactly one transition wins every time, invariant holds every run',
    async () => {
      for (let i = 0; i < 20; i += 1) {
        await runOneToctouIteration(i);
      }
    },
    30_000,
  );
});
