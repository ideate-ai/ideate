// plugin/src/context/assemble-prototype.test.ts — verification for the
// flag-gated assemble-context PROTOTYPE.
//
// Pins the three prototype guarantees, exercised against
// a TEMP record + board + steering fixture (the live .ideate-work/ / .ideate/
// are never touched — all filesystem work is in mkdtemp dirs):
//   (i)   the briefing NEVER exceeds the token budget (density pack + skip-
//         don't-truncate + final re-measure trim);
//   (ii)  the briefing spans all three seams — ≥1 record AND ≥1 board AND ≥1
//         steering item (composition across the v3 surface, NOT board-blind);
//   (iii) provenance is emitted on every item (record ULIDs / work ids /
//         steering ids, each with an inclusion-reason).
// Plus: density ordering (small strong item beats big weak one), per-source
// caps, superseded steering never presented as live, and the emit-only
// confidence signal.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import { SteeringStore } from '../steering/store.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { WorkStateStore } from '../work-state/store.js';
import { WorkStateVerbs } from '../work-state/verbs.js';
import { assembleContext, estimateTokens } from './assemble-prototype.js';
import type { AssembleDeps, AssembleOptions } from './assemble-prototype.js';

const FIXED_ISO = '2026-07-16T12:00:00.000Z';
const ACTOR = { human: 'dan' };

/**
 * A generous budget + high per-source caps so SUPERSESSION is the only skip
 * reason in the stickiness fixtures — nothing is crowded out by budget or cap,
 * which would muddy the visibility assertions with unrelated skips.
 */
const STICKY_OPTIONS: AssembleOptions = {
  tokenBudget: 8000,
  perSourceCaps: { board: 50, steering: 50, record: 50 },
};

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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
  deps: AssembleDeps;
  seed: string;
  upstreamId: string;
}

/** A rich temp fixture: a claimed seed with an upstream dependency and a
 *  downstream dependant, an applicable domain policy + a guiding principle + a
 *  deprecated policy, and two scope-matched process records. */
function makeFixture(): Fixture {
  const projectRoot = makeTempDir('ideate-assemble-proto-root-');
  const telemetryDir = makeTempDir('ideate-assemble-proto-telemetry-');
  const clock: Clock = () => new Date(FIXED_ISO);

  // Board (temp SQLite).
  const board = new WorkStateStore(join(projectRoot, 'work-state', 'board.db'), clock);
  const verbs = new WorkStateVerbs(board, clock);
  const upstream = board.insertItem({
    title: 'Build the steering store',
    spec: 'Ship the light steering store beside record/ and work-state/ (auth domain groundwork).',
    spec_format: 'ideate/work-item',
    created_by: ACTOR,
  });
  const seed = board.insertItem({
    title: 'Assemble-context prototype for the auth flow',
    spec: 'Given a claimed work item and a token budget, build a budgeted briefing across record, steering, and board. Auth domain.',
    spec_format: 'ideate/work-item',
    depends_on: [upstream.id],
    created_by: ACTOR,
  });
  // A downstream dependant (reverse depends_on edge — must be discovered).
  board.insertItem({
    title: 'Wire the assembler into primeOnClaim',
    spec: 'Gate the assembler behind work_state.claim_priming.',
    spec_format: 'ideate/work-item',
    depends_on: [seed.id],
    created_by: ACTOR,
  });

  // Steering (temp Markdown/YAML).
  const steering = new SteeringStore(projectRoot, clock);
  steering.put({
    id: 'POL-auth-1',
    kind: 'policy',
    domain: 'auth',
    statement: 'All auth flows must gate every secret-bearing field through the secret gate before persist.',
  });
  steering.put({ id: 'GP-23', kind: 'guiding-principle', domain: '', statement: 'Nothing that shapes what a model attends to ships ahead of the eval that measures it.' });
  const deprecated = steering.put({ id: 'POL-auth-legacy', kind: 'policy', domain: 'auth', statement: 'Legacy: store auth tokens in plaintext.' });
  if (!deprecated.ok) throw new Error('fixture: failed to seed deprecated policy');
  steering.put({ id: 'POL-auth-legacy', kind: 'policy', domain: 'auth', status: 'deprecated', statement: 'Legacy: store auth tokens in plaintext.' });

  // Record (temp Markdown, ULID-sharded). Scope selection matches on the seed id.
  const config: IdeateConfigV3 = { schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' };
  const records = new RecordStore(config, projectRoot, new TelemetryCounters(telemetryDir, clock), clock);
  const r1 = records.append({
    kind: 'decision',
    claim: 'The assembler packs by density (score/token), not recency.',
    verification_anchor: 'assemble-prototype.ts density sort',
    scope: `auth ${seed.id} context assembly`,
    source: { capture_point: 'design', session_id: 's1', task_id: seed.id },
    content: 'Density ordering keeps one big weak item from crowding out several small strong ones.',
  });
  if (!r1.ok) throw new Error('fixture: failed to append record r1');
  const r2 = records.append({
    kind: 'finding',
    claim: 'Board reverse-edges must be discovered so the assembler is not board-blind.',
    verification_anchor: 'board-blindness',
    scope: `auth ${seed.id} board`,
    source: { capture_point: 'review', session_id: 's1', task_id: seed.id },
    content: 'v2 PPR traversed only the node graph and under-counted board items.',
  });
  if (!r2.ok) throw new Error('fixture: failed to append record r2');

  return { deps: { records, steering, board: verbs }, seed: seed.id, upstreamId: upstream.id };
}

describe('assembleContext prototype', () => {
  it('(i) never exceeds the token budget, at generous and tight budgets', () => {
    const { deps, seed } = makeFixture();
    for (const tokenBudget of [2000, 400, 200, 80]) {
      const { briefing, manifest } = assembleContext(seed, deps, { tokenBudget });
      expect(estimateTokens(briefing)).toBeLessThanOrEqual(tokenBudget);
      expect(manifest.tokensUsed).toBeLessThanOrEqual(tokenBudget);
    }
  });

  it('(ii) spans all three seams — ≥1 record, ≥1 board, ≥1 steering', () => {
    const { deps, seed } = makeFixture();
    const { manifest } = assembleContext(seed, deps, { tokenBudget: 2000 });
    const bySource = (s: string): number => manifest.included.filter((i) => i.source === s).length;
    expect(bySource('board')).toBeGreaterThanOrEqual(1);
    expect(bySource('steering')).toBeGreaterThanOrEqual(1);
    expect(bySource('record')).toBeGreaterThanOrEqual(1);
  });

  it('(iii) emits provenance on every included item — record ULIDs / work ids / steering ids + inclusion reasons', () => {
    const { deps, seed, upstreamId } = makeFixture();
    const { manifest } = assembleContext(seed, deps, { tokenBudget: 2000 });

    for (const item of manifest.included) {
      expect(item.sourceId.length).toBeGreaterThan(0);
      expect(item.inclusionReason.length).toBeGreaterThan(0);
      expect(item.stateAtTime.length).toBeGreaterThan(0);
    }
    const ids = manifest.included.map((i) => i.sourceId);
    // The seed and its explicit upstream edge are both present, with the edge
    // path recorded as the inclusion reason (NOT board-blind).
    expect(ids).toContain(seed);
    expect(ids).toContain(upstreamId);
    const seedItem = manifest.included.find((i) => i.sourceId === seed);
    expect(seedItem?.inclusionReason).toMatch(/seed/);
    const upstreamItem = manifest.included.find((i) => i.sourceId === upstreamId);
    expect(upstreamItem?.inclusionReason).toContain(`depends_on → ${upstreamId}`);
    // A steering id and a record ULID both appear in the briefing text.
    expect(ids).toContain('POL-auth-1');
    expect(manifest.included.some((i) => i.source === 'record')).toBe(true);
  });

  it('discovers the downstream (reverse depends_on) edge — corrects board-blindness', () => {
    const { deps, seed } = makeFixture();
    const { manifest } = assembleContext(seed, deps, { tokenBudget: 2000 });
    const downstream = manifest.included.find((i) => i.inclusionReason.startsWith('blocks (downstream)'));
    expect(downstream).toBeDefined();
  });

  it('never presents a superseded/deprecated steering item as live', () => {
    const { deps, seed } = makeFixture();
    const { manifest, briefing } = assembleContext(seed, deps, { tokenBudget: 2000 });
    expect(manifest.included.some((i) => i.sourceId === 'POL-auth-legacy')).toBe(false);
    const legacySkip = manifest.skipped.find((i) => i.sourceId === 'POL-auth-legacy');
    expect(legacySkip?.skipReason).toBe('superseded');
    expect(briefing).not.toContain('plaintext');
  });

  it('surfaces a typed-edge (cross-item) superseded steering item — skipped with the replacement named', () => {
    const { deps, seed } = makeFixture();
    // POL-auth-2 replaces POL-auth-1 via a typed `references` forward edge.
    // POL-auth-1's status stays `active` — the supersession lives ONLY on the
    // derived `referenced_by` backlink.
    const replacement = deps.steering.put({
      id: 'POL-auth-2',
      kind: 'policy',
      domain: 'auth',
      statement: 'All auth flows must route token storage through the vault.',
      references: [{ rel: 'supersedes', id: 'POL-auth-1' }],
    });
    if (!replacement.ok) throw new Error('fixture: failed to seed replacement policy');

    const { manifest, briefing } = assembleContext(seed, deps, { tokenBudget: 2000 });

    // The replaced item is skipped exactly like a status-superseded one, with
    // the replacement named in the reason — never presented as live.
    expect(manifest.included.some((i) => i.sourceId === 'POL-auth-1')).toBe(false);
    const typedSkip = manifest.skipped.find((i) => i.sourceId === 'POL-auth-1');
    expect(typedSkip?.skipReason).toBe('superseded');
    expect(typedSkip?.inclusionReason).toContain('POL-auth-2');
    expect(briefing).not.toContain('gate every secret-bearing field');

    // The replacement itself is a live active item and IS delivered.
    expect(manifest.included.some((i) => i.sourceId === 'POL-auth-2')).toBe(true);

    // The status-superseded item is still handled as before, and an unaffected
    // item (GP-23) is still included.
    const legacySkip = manifest.skipped.find((i) => i.sourceId === 'POL-auth-legacy');
    expect(legacySkip?.skipReason).toBe('superseded');
    expect(legacySkip?.inclusionReason).toContain('deprecated');
    expect(manifest.included.some((i) => i.sourceId === 'GP-23')).toBe(true);
  });

  it('surfaces a typed-edge (cross-item) superseded BOARD item — skipped with the replacement named; the seed is never skipped', () => {
    const { deps, seed, upstreamId } = makeFixture();
    // A new work item supersedes the seed's upstream dependency via a typed
    // `references` forward edge. The upstream has no lifecycle status that
    // maps to supersession — the typed-edge backlink is the ONLY skip path.
    const replacement = deps.board.create({
      title: 'Build the steering store v2',
      spec: 'Ship the light steering store, second generation.',
      spec_format: 'ideate/work-item',
      references: [{ rel: 'supersedes', id: upstreamId }],
      created_by: ACTOR,
    });

    // Separately, another item supersedes the SEED itself — the seed is the
    // claimed work item and must still be delivered (a claimed item is by
    // definition the live frontier; supersession of the seed is out of scope).
    deps.board.create({
      title: 'Replace the assembler seed',
      spec: 'A would-be replacement for the seed.',
      spec_format: 'ideate/work-item',
      references: [{ rel: 'supersedes', id: seed }],
      created_by: ACTOR,
    });

    const { manifest, briefing } = assembleContext(seed, deps, { tokenBudget: 2000 });

    // The superseded upstream is skipped exactly like a status-superseded
    // steering item, with the replacement named in the reason — never
    // presented as live.
    expect(manifest.included.some((i) => i.sourceId === upstreamId)).toBe(false);
    const typedSkip = manifest.skipped.find((i) => i.sourceId === upstreamId);
    expect(typedSkip?.skipReason).toBe('superseded');
    expect(typedSkip?.source).toBe('board');
    expect(typedSkip?.inclusionReason).toContain(replacement.id);
    expect(briefing).not.toContain('Ship the light steering store beside record/');

    // The seed itself is still delivered even though it carries a supersedes
    // backlink — the seed is the live frontier, never skipped for supersession.
    expect(manifest.included.some((i) => i.sourceId === seed)).toBe(true);
    const seedSkip = manifest.skipped.find((i) => i.sourceId === seed && i.skipReason === 'superseded');
    expect(seedSkip).toBeUndefined();
  });

  it('names EVERY replacer when a board item is superseded by multiple replacements', () => {
    const { deps, seed, upstreamId } = makeFixture();
    // Two distinct replacements both supersede the same upstream via typed
    // `references` edges. Acceptance criterion 1 says "EACH replacement id
    // named in the inclusion reason" — exercise the join, not just one replacer.
    const replA = deps.board.create({
      title: 'Build the steering store v2 (a)',
      spec: 'Replacement a.',
      spec_format: 'ideate/work-item',
      references: [{ rel: 'supersedes', id: upstreamId }],
      created_by: ACTOR,
    });
    const replB = deps.board.create({
      title: 'Build the steering store v2 (b)',
      spec: 'Replacement b.',
      spec_format: 'ideate/work-item',
      references: [{ rel: 'supersedes', id: upstreamId }],
      created_by: ACTOR,
    });

    const { manifest } = assembleContext(seed, deps, { tokenBudget: 2000 });

    expect(manifest.included.some((i) => i.sourceId === upstreamId)).toBe(false);
    const typedSkip = manifest.skipped.find((i) => i.sourceId === upstreamId);
    expect(typedSkip?.skipReason).toBe('superseded');
    expect(typedSkip?.source).toBe('board');
    // BOTH replacement ids are named — the "each" in the acceptance criterion.
    expect(typedSkip?.inclusionReason).toContain(replA.id);
    expect(typedSkip?.inclusionReason).toContain(replB.id);
  });

  it('skips a superseded board item on the containment (child) path, not just depends_on', () => {
    const { deps, seed } = makeFixture();
    // A CHILD of the seed (parent_id = seed) is gathered via the reverse-edge
    // containment sweep, not the depends_on path. Acceptance criterion 1 says
    // "every gathered NON-seed board item" — prove the skip covers children too.
    const child = deps.board.create({
      title: 'A child sub-task of the seed',
      spec: 'Child scope under the seed.',
      spec_format: 'ideate/work-item',
      parent_id: seed,
      created_by: ACTOR,
    });
    deps.board.create({
      title: 'Replacement for the child',
      spec: 'Replaces the child sub-task.',
      spec_format: 'ideate/work-item',
      references: [{ rel: 'supersedes', id: child.id }],
      created_by: ACTOR,
    });

    const { manifest } = assembleContext(seed, deps, { tokenBudget: 2000 });

    // The superseded child is skipped on the containment path, not delivered.
    expect(manifest.included.some((i) => i.sourceId === child.id)).toBe(false);
    const typedSkip = manifest.skipped.find((i) => i.sourceId === child.id);
    expect(typedSkip?.skipReason).toBe('superseded');
    expect(typedSkip?.source).toBe('board');
    // The child would normally be gathered with a 'contains (child)' reason;
    // the supersession skip overrides it and names the replacement.
    expect(typedSkip?.inclusionReason).toMatch(/^superseded by /);
  });

  it('surfaces a typed-edge (cross-item) superseded RECORD — skipped with the replacement named', () => {
    const { deps, seed } = makeFixture();
    // Pick one of the fixture's scope-matched records to supersede. Records are
    // immutable events with no lifecycle status — the typed-edge backlink is
    // the ONLY supersession path.
    const existing = deps.records.read({ scope: seed, limit: 32 });
    if (existing.length === 0) throw new Error('fixture: no scope-matched record to supersede');
    const supersededId = existing[0]!.id;

    const replacement = deps.records.append({
      kind: 'decision',
      claim: 'The superseding record replaces an earlier decision.',
      verification_anchor: 'typed-edge supersession',
      scope: `auth ${seed} context assembly`,
      source: { capture_point: 'design', session_id: 's2', task_id: seed },
      content: 'This record supersedes the earlier decision via a typed references edge.',
      references: [{ rel: 'supersedes', id: supersededId }],
    });
    if (!replacement.ok) throw new Error('fixture: failed to seed superseding record');

    const { manifest, briefing } = assembleContext(seed, deps, { tokenBudget: 2000 });

    // The superseded record is skipped exactly like a superseded steering
    // item, with the replacement named in the reason — never presented as live.
    expect(manifest.included.some((i) => i.sourceId === supersededId)).toBe(false);
    const typedSkip = manifest.skipped.find((i) => i.sourceId === supersededId);
    expect(typedSkip?.skipReason).toBe('superseded');
    expect(typedSkip?.source).toBe('record');
    expect(typedSkip?.inclusionReason).toContain(replacement.record.id);
    // The superseded record's claim text does not appear in the live briefing.
    // Non-null: `existing` was already asserted non-empty above.
    const supersededClaim = existing[0]!.claim;
    expect(briefing).not.toContain(supersededClaim);

    // The superseding record itself IS delivered (it is live, scope-matched).
    expect(manifest.included.some((i) => i.sourceId === replacement.record.id)).toBe(true);
  });

  it('enforces per-source caps — skips capped items rather than truncating', () => {
    const { deps, seed } = makeFixture();
    const { manifest } = assembleContext(seed, deps, { tokenBudget: 4000, perSourceCaps: { record: 1 } });
    expect(manifest.included.filter((i) => i.source === 'record').length).toBeLessThanOrEqual(1);
    const cappedRecordSkip = manifest.skipped.find((i) => i.source === 'record' && i.skipReason === 'per-source-cap');
    expect(cappedRecordSkip).toBeDefined();
  });

  it('packs by density — the seed (highest score) survives a tight budget and crowds out weaker items', () => {
    const { deps, seed } = makeFixture();
    // A budget large enough for only a couple of provenance-framed entries: the
    // densest survivor (the highest-scoring seed) must be one of them, and the
    // pack must have skipped weaker candidates rather than truncating them.
    const { manifest } = assembleContext(seed, deps, { tokenBudget: 300 });
    expect(manifest.included.length).toBeGreaterThanOrEqual(1);
    expect(manifest.included.map((i) => i.sourceId)).toContain(seed);
    expect(manifest.skipped.some((i) => i.skipReason === 'over-budget')).toBe(true);
  });

  it('emits an advisory confidence signal without ever blocking', () => {
    const { deps, seed } = makeFixture();
    const rich = assembleContext(seed, deps, { tokenBudget: 2000 });
    expect(['high', 'low']).toContain(rich.manifest.confidence);
    // A near-zero budget yields a thin, low-confidence briefing — but STILL a
    // briefing (emit-only: never refuses, never throws).
    const thin = assembleContext(seed, deps, { tokenBudget: 40 });
    expect(thin.manifest.confidence).toBe('low');
    expect(thin.manifest.confidenceReasons.length).toBeGreaterThan(0);
    expect(typeof thin.briefing).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Supersession STICKINESS — the transitive chain, pinned in code (board 01KYX9FTZN).
  //
  // Decided with Dan 2026-08-01 (decision 01KZ006528WP4KATWKPG3N07QR): a replaced
  // rule STAYS hidden when its replacement is later retired. No resurrection, no
  // new visibility in the assembler. Intentionally retiring a rule is
  // recoverable out-of-band — curation / refinement recreates or revives a rule
  // that becomes relevant again; the assembler does not second-guess a deliberate
  // supersession by resurrecting the original when its replacement dies. This
  // resolves finding 01KYH1HTZH7ZEDQWXF0WZMEZPB, which flagged the stickiness
  // posture as prose-only.
  //
  // Two facets, mapped to the seam where each is NATIVE:
  //   (1) TRANSITIVE LIVE-TIP — A←B←C with C live: A and B both hidden, C
  //       delivered. Exercised on ALL THREE seams (steering, board, record) —
  //       this is the chain the finding named, and P-40's sibling-parity clause
  //       makes a partial-seam pin the unguarded case. Pins against a mutation
  //       that resurrects an original whose REPLACEMENT is itself superseded.
  //   (2) DEAD-TIP — B supersedes A, then B is RETIRED (status `deprecated`):
  //       A stays hidden. Exercised on the STEERING seam only, where
  //       `deprecated` is the native retirement lifecycle. Board items have no
  //       `deprecated` status (cancellation is a work status, not a steering
  //       retirement) and records are immutable events with no lifecycle at
  //       all — so retirement is not a native state on those two seams, and the
  //       live-tip chain is their pin. This is Dan's sharpening ("if 2
  //       supersedes 1 and 2 is retired, don't bring 1 back"). Pins against a
  //       mutation that resurrects an original whose replacement is inactive.
  //
  // Each test is mutation-proven (P-35): the resurrection mutation that turns
  // it red is named below, run against the source, and the result reported in
  // the item's completion note. A green test whose pinning logic could be
  // deleted without going red does not pin the property.
  // -------------------------------------------------------------------------

  it('STEERING transitive stickiness (A←B←C, C live): A and B hidden, C delivered — no resurrection', () => {
    const { deps, seed } = makeFixture();
    // C replaces B replaces A. All three are active; all are gathered
    // (readViews returns every item, so no structural edge to the seed is
    // needed for gathering — domain only affects the inclusion reason/score).
    deps.steering.put({ id: 'POL-stk-a', kind: 'policy', domain: 'auth', statement: 'Stickiness A — the original rule.' });
    deps.steering.put({ id: 'POL-stk-b', kind: 'policy', domain: 'auth', statement: 'Stickiness B — replaces A.', references: [{ rel: 'supersedes', id: 'POL-stk-a' }] });
    deps.steering.put({ id: 'POL-stk-c', kind: 'policy', domain: 'auth', statement: 'Stickiness C — replaces B.', references: [{ rel: 'supersedes', id: 'POL-stk-b' }] });

    const { manifest, briefing } = assembleContext(seed, deps, STICKY_OPTIONS);

    // A is hidden by B's forward edge — even though B is itself superseded by C.
    expect(manifest.included.some((i) => i.sourceId === 'POL-stk-a')).toBe(false);
    const skipA = manifest.skipped.find((i) => i.sourceId === 'POL-stk-a');
    expect(skipA?.skipReason).toBe('superseded');
    expect(skipA?.inclusionReason).toContain('POL-stk-b');
    // B is hidden by C's forward edge.
    expect(manifest.included.some((i) => i.sourceId === 'POL-stk-b')).toBe(false);
    const skipB = manifest.skipped.find((i) => i.sourceId === 'POL-stk-b');
    expect(skipB?.skipReason).toBe('superseded');
    expect(skipB?.inclusionReason).toContain('POL-stk-c');
    // C is the live tip — no supersedes backlink — and is delivered.
    expect(manifest.included.some((i) => i.sourceId === 'POL-stk-c')).toBe(true);
    expect(briefing).toContain('Stickiness C');
    expect(briefing).not.toContain('Stickiness A');
    expect(briefing).not.toContain('Stickiness B');
    // MUTATION (R2): skip an item only if its replacement is NOT itself
    // superseded. Under R2, A's replacement B carries a backlink from C, so A
    // is no longer suppressed and RESURRECTS — this test turns red. (B stays
    // hidden under R2 because its replacement C is live.)
  });

  it('STEERING dead-replacement stickiness (B supersedes A, B then deprecated): A stays hidden — no resurrection', () => {
    const { deps, seed } = makeFixture();
    deps.steering.put({ id: 'POL-stk-d-a', kind: 'policy', domain: 'auth', statement: 'Dead-tip A — the original rule.' });
    deps.steering.put({ id: 'POL-stk-d-b', kind: 'policy', domain: 'auth', statement: 'Dead-tip B — replaces A.', references: [{ rel: 'supersedes', id: 'POL-stk-d-a' }] });
    // B is RETIRED. No `references` field on the amend, so the supersedes edge
    // to A PERSISTS (SteeringPutInput: absent-on-amend = carry the prior edge
    // list). This is the heart of the decision: the edge survives retirement.
    const retired = deps.steering.put({ id: 'POL-stk-d-b', kind: 'policy', domain: 'auth', status: 'deprecated', statement: 'Dead-tip B — now retired.' });
    if (!retired.ok) throw new Error('fixture: failed to retire B');

    const { manifest, briefing } = assembleContext(seed, deps, STICKY_OPTIONS);

    // A stays hidden: retiring its replacement is not evidence A is valid again.
    expect(manifest.included.some((i) => i.sourceId === 'POL-stk-d-a')).toBe(false);
    const skipA = manifest.skipped.find((i) => i.sourceId === 'POL-stk-d-a');
    expect(skipA?.skipReason).toBe('superseded');
    expect(skipA?.inclusionReason).toContain('POL-stk-d-b');
    // B is hidden by its own deprecated status — a SEPARATE skip path from A's
    // typed-edge skip, but the same `superseded` reason literal. Asserting the
    // reason text pins WHICH path caught B, so a reorder of the two checks in
    // gatherSteering cannot silently change B's skip path.
    const skipB = manifest.skipped.find((i) => i.sourceId === 'POL-stk-d-b');
    expect(skipB?.skipReason).toBe('superseded');
    expect(skipB?.inclusionReason).toContain('deprecated');
    expect(briefing).not.toContain('Dead-tip A');
    expect(briefing).not.toContain('Dead-tip B');
    // MUTATION (R1): suppress an item only if at least one of its replacements
    // is still `active`. Under R1, A's sole replacement B is deprecated, so A
    // is no longer suppressed and RESURRECTS — this test turns red. This is the
    // decision's exact sharpening ("don't bring it back").
  });

  it('BOARD transitive stickiness (A←B←C, C live): A and B hidden, C delivered — no resurrection', () => {
    const { deps, seed } = makeFixture();
    // All three depend_on the seed, so the reverse-edge sweep gathers each
    // (a supersession edge does NOT pull the replacement in — only structural
    // edges do). Board items have no `deprecated` lifecycle; the live-tip
    // chain is this seam's native pin.
    const a = deps.board.create({ title: 'Stk board A', spec: 'Original downstream of the seed.', spec_format: 'ideate/work-item', depends_on: [seed], created_by: ACTOR });
    const b = deps.board.create({ title: 'Stk board B', spec: 'Replaces A, downstream of the seed.', spec_format: 'ideate/work-item', depends_on: [seed], references: [{ rel: 'supersedes', id: a.id }], created_by: ACTOR });
    const c = deps.board.create({ title: 'Stk board C', spec: 'Replaces B, downstream of the seed.', spec_format: 'ideate/work-item', depends_on: [seed], references: [{ rel: 'supersedes', id: b.id }], created_by: ACTOR });

    const { manifest, briefing } = assembleContext(seed, deps, STICKY_OPTIONS);

    expect(manifest.included.some((i) => i.sourceId === a.id)).toBe(false);
    const skipA = manifest.skipped.find((i) => i.sourceId === a.id);
    expect(skipA?.skipReason).toBe('superseded');
    expect(skipA?.source).toBe('board');
    expect(skipA?.inclusionReason).toContain(b.id);
    expect(manifest.included.some((i) => i.sourceId === b.id)).toBe(false);
    const skipB = manifest.skipped.find((i) => i.sourceId === b.id);
    expect(skipB?.skipReason).toBe('superseded');
    expect(skipB?.inclusionReason).toContain(c.id);
    // C is the live tip: no supersedes backlink, so it is delivered.
    expect(manifest.included.some((i) => i.sourceId === c.id)).toBe(true);
    expect(briefing).toContain('Stk board C');
    expect(briefing).not.toContain('Stk board A');
    expect(briefing).not.toContain('Stk board B');
    // MUTATION (R2): skip a non-seed item only if its replacement is NOT itself
    // superseded. Under R2, A's replacement B carries a backlink from C, so A
    // RESURRECTS — this test turns red.
  });

  it('RECORD transitive stickiness (A←B←C, C live): A and B hidden, C delivered — no resurrection', () => {
    const { deps, seed } = makeFixture();
    // All three scope-matched to the seed. Records are immutable events with no
    // lifecycle status — the typed-edge backlink is the ONLY supersession path,
    // and there is no dead-tip (a record cannot be 'retired'). The live-tip
    // chain is this seam's native pin.
    const ra = deps.records.append({ kind: 'decision', claim: 'Stk record A — original decision.', verification_anchor: 'stickiness-record-a', scope: `auth ${seed} context assembly`, source: { capture_point: 'design', session_id: 's-stk', task_id: seed }, content: 'A is the original decision in the chain.' });
    if (!ra.ok) throw new Error('fixture: failed to append record A');
    const rb = deps.records.append({ kind: 'decision', claim: 'Stk record B — replaces A.', verification_anchor: 'stickiness-record-b', scope: `auth ${seed} context assembly`, source: { capture_point: 'design', session_id: 's-stk', task_id: seed }, content: 'B supersedes A via a typed edge.', references: [{ rel: 'supersedes', id: ra.record.id }] });
    if (!rb.ok) throw new Error('fixture: failed to append record B');
    const rc = deps.records.append({ kind: 'decision', claim: 'Stk record C — replaces B.', verification_anchor: 'stickiness-record-c', scope: `auth ${seed} context assembly`, source: { capture_point: 'design', session_id: 's-stk', task_id: seed }, content: 'C supersedes B via a typed edge.', references: [{ rel: 'supersedes', id: rb.record.id }] });
    if (!rc.ok) throw new Error('fixture: failed to append record C');

    const { manifest, briefing } = assembleContext(seed, deps, STICKY_OPTIONS);

    expect(manifest.included.some((i) => i.sourceId === ra.record.id)).toBe(false);
    const skipA = manifest.skipped.find((i) => i.sourceId === ra.record.id);
    expect(skipA?.skipReason).toBe('superseded');
    expect(skipA?.source).toBe('record');
    expect(skipA?.inclusionReason).toContain(rb.record.id);
    expect(manifest.included.some((i) => i.sourceId === rb.record.id)).toBe(false);
    const skipB = manifest.skipped.find((i) => i.sourceId === rb.record.id);
    expect(skipB?.skipReason).toBe('superseded');
    expect(skipB?.inclusionReason).toContain(rc.record.id);
    expect(manifest.included.some((i) => i.sourceId === rc.record.id)).toBe(true);
    expect(briefing).toContain('Stk record C');
    expect(briefing).not.toContain('Stk record A');
    expect(briefing).not.toContain('Stk record B');
    // MUTATION (R2): skip a record only if its replacement is NOT itself
    // superseded. Under R2, A's replacement B carries a backlink from C, so A
    // RESURRECTS — this test turns red.
  });
});
