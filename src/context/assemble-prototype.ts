// plugin/src/context/assemble-prototype.ts — the flag-gated assemble-context
// PROTOTYPE on the plugin surface.
//
// This is a PROTOTYPE — it proves the budgeted, density-packed,
// provenance-bearing briefing is BUILDABLE by composing the three real stores,
// and that it produces a plausible high-signal briefing. It is deliberately
// NOT the shipped tool surface: there is no MCP handler, no primeOnClaim
// wiring, no config plumbing here (those are the shipped mechanism's scope,
// gated OFF until the eval that measures it). This module composes, read-only,
// across:
//
//   - Seam 1, the RECORD (record/store.ts RecordStore.read) — SELECTION only:
//     the assembler asks the record store for a scope-selected set and never
//     asks it to rank. Ranking/packing happens HERE, over the selected set.
//   - Seam 2, the BOARD (work-state/verbs.ts WorkStateVerbs) — NOT board-blind:
//     the seed work item, its EXPLICIT edges
//     (depends_on upstream, reverse-depends_on downstream, parent/child
//     containment) are first-class structural sources, read straight off the
//     authoritative work-state, not a parallel node graph.
//   - The light STEERING store (steering/store.ts SteeringStore.read) —
//     SELECTION only, same posture as the record seam.
//
// The KG augment (Seam 3) is out of this prototype's scope — local SQLite-only
// assembly is the whole surface here (behavioral parity: the prototype
// assembles identically with no KG present).
//
// Algorithm:
//   1/2. Structure-first seeding from the claimed work item's EXPLICIT edges
//        (bounded ~1 hop). No full-graph BFS/PPR (dropped as primary — the
//        explicit edges are the ~2 lookups that matter versus a ~117-lookup
//        full traversal). No semantic seed in this prototype (that is the
//        parked hybrid-seed direction).
//   3.  Gather candidates by source (board / steering / record), unfolding
//        CONTAINER→CONTENT: bodies, not titles.
//   4.  Pack by DENSITY (score / token) so one big weak item cannot crowd out
//        several small strong ones.
//   5.  SKIP — don't truncate. Per-source caps so no source monopolizes.
//   7.  PROVENANCE / inclusion-reason on EVERY item (edge path / applicable-by-
//        domain / scope-match) + state-at-time.
//   8.  EMIT-ONLY confidence signal — never refuses, never blocks.
//   9.  STATE-AT-TIME awareness — a deprecated/superseded steering item is
//        never presented as live; it is skipped with reason `superseded`.
//
// Budget: estimateTokens = floor(len / 4),
// explicitly NOT load-bearing for correctness (±30% ASCII, ±50% multi-byte).
// SKIP-don't-truncate + per-source caps keep the output safe even when the
// estimate is off. As a hard guarantee for the prototype, the final assembled
// briefing is re-measured and the lowest-density item trimmed until its
// estimate fits the budget — so the emitted briefing NEVER exceeds the budget.

import type { RecordStore } from '../record/store.js';
import type { SteeringStore } from '../steering/store.js';
import type { SteeringItem } from '../steering/schema.js';
import type { WorkStateVerbs } from '../work-state/verbs.js';
import type { WorkItem } from '../work-state/types.js';

/** The three composed sources. */
export type SourceKind = 'board' | 'steering' | 'record';

/** Provenance carried on EVERY item — included or skipped (step 7/9). */
export interface InclusionProvenance {
  /** The delivered item's own id (work id / steering id / record ULID). */
  sourceId: string;
  /** Which of the three seams it came from. */
  source: SourceKind;
  /** WHY it was included — an edge path (`depends_on → WI-x`), applicable-by-
   *  domain, or a record scope-match. Never empty. */
  inclusionReason: string;
  /** State-at-time marker (a work status, a steering lifecycle status, or the
   *  immutable `recorded` marker for a process record). */
  stateAtTime: string;
}

/** One item that made it into the briefing. */
export interface BriefingItem extends InclusionProvenance {
  /** estimateTokens over this item's rendered block. */
  estimatedTokens: number;
  /** The emit-only relevance score used for density ordering. */
  score: number;
}

/** One candidate that was gathered but NOT delivered, and why. */
export interface SkippedItem extends InclusionProvenance {
  estimatedTokens: number;
  score: number;
  /** `over-budget` (would not fit the remaining budget), `per-source-cap` (the
   *  source's cap was already full), or `superseded` (a non-active steering
   *  item — never presented as live, step 9). */
  skipReason: 'over-budget' | 'per-source-cap' | 'superseded';
}

/** The emit-only confidence signal (step 8) — advisory, never blocks. */
export type ConfidenceSignal = 'high' | 'low';

/** The structured record the quality metric scores against (Outputs). */
export interface AssembleManifest {
  seed: string;
  tokenBudget: number;
  /** estimateTokens over the FINAL assembled briefing string (≤ tokenBudget). */
  tokensUsed: number;
  included: BriefingItem[];
  skipped: SkippedItem[];
  /** Emit-only advisory signal — the worker decides what to do with it. */
  confidence: ConfidenceSignal;
  /** Human-readable reasons the signal is `low` (empty when `high`). */
  confidenceReasons: string[];
  /** The per-source caps in effect for this assembly. */
  perSourceCaps: Record<SourceKind, number>;
}

/** The two outputs: the briefing string + the manifest. */
export interface Briefing {
  /** The assembled markdown briefing — the SessionStart/SubagentStart surface. */
  briefing: string;
  manifest: AssembleManifest;
}

/** The three composed stores. Injected so the prototype stays decoupled and
 *  testable against temp-dir fixtures — it constructs none of them itself. */
export interface AssembleDeps {
  records: RecordStore;
  steering: SteeringStore;
  board: WorkStateVerbs;
}

/** Assembly options. `tokenBudget` is the soft cap; caps default per source. */
export interface AssembleOptions {
  tokenBudget: number;
  /** Override any per-source cap (defaults: board 6, steering 5, record 5). */
  perSourceCaps?: Partial<Record<SourceKind, number>>;
  /** Record selection scope (design Seam 1). Defaults to the seed id, so a
   *  record whose `source.task_id`/`scope` names the seed is selected. */
  recordScope?: string;
}

const DEFAULT_CAPS: Record<SourceKind, number> = { board: 6, steering: 5, record: 5 };

/** The cheap char/4 heuristic (deliberately NOT load-bearing). */
export function estimateTokens(text: string): number {
  return Math.floor(text.length / 4);
}

/** Relevance scores by structural proximity / applicability. Emit-only —
 *  scoring is advisory, not a gate (step 8). */
const SCORE = {
  seed: 100,
  dependsOnUpstream: 70,
  downstream: 55,
  parent: 60,
  child: 50,
  guidingPrinciple: 50,
  policyDomainMatch: 55,
  policyActive: 20,
  record: 40,
} as const;

/** An internal, fully-rendered candidate awaiting the density pack. */
interface Candidate {
  provenance: InclusionProvenance;
  score: number;
  /** The FULL rendered briefing entry — its provenance heading AND its body
   *  (bodies, not titles — step 6). Budgeting is over this whole
   *  entry, exactly what gets emitted, so the density pack is honest about the
   *  provenance framing's own cost. */
  entry: string;
  tokens: number;
  /** A non-active steering item: gathered for the manifest, never delivered. */
  supersededSkip: boolean;
}

/**
 * Assemble a budgeted briefing for a claimed work item, composing the record,
 * steering, and board seams. Read-only across all three stores. Returns the
 * briefing string plus the manifest the quality metric scores against.
 */
export function assembleContext(seed: string, deps: AssembleDeps, options: AssembleOptions): Briefing {
  const caps: Record<SourceKind, number> = { ...DEFAULT_CAPS, ...options.perSourceCaps };
  const budget = options.tokenBudget;

  const seedItem = deps.board.get(seed);
  const candidates: Candidate[] = [
    ...gatherBoard(seed, seedItem, deps.board),
    ...gatherSteering(seedItem, deps.steering),
    ...gatherRecords(options.recordScope ?? seed, deps.records),
  ];

  // Density order: score-per-token descending, so a small strong item beats a
  // big weak one (step 4). Deterministic tie-breaks.
  const qualified = candidates.filter((c) => !c.supersededSkip);
  qualified.sort((a, b) => {
    const da = a.score / Math.max(a.tokens, 1);
    const db = b.score / Math.max(b.tokens, 1);
    if (da !== db) return db - da;
    if (a.score !== b.score) return b.score - a.score;
    return a.provenance.sourceId.localeCompare(b.provenance.sourceId);
  });

  // Greedy pack: per-source caps + running token budget. SKIP-don't-truncate —
  // an over-budget or capped item is recorded in `skipped`, never chopped.
  const included: Candidate[] = [];
  const skipped: SkippedItem[] = [];
  const perSourceCount: Record<SourceKind, number> = { board: 0, steering: 0, record: 0 };
  // Reserve headroom for the fixed framing the entries themselves don't carry:
  // the header, the (up to three) section headers, and the LONGEST possible
  // confidence footer. Kept tight so it never starves the seed at a small
  // budget; the final re-measure + trim below is the hard cap.
  const overheadReserve =
    estimateTokens(renderHeader(seed, budget)) + estimateTokens(ALL_SECTION_HEADERS) + estimateTokens(MAX_FOOTER);
  let runningTokens = overheadReserve;

  for (const cand of qualified) {
    const kind = cand.provenance.source;
    if (perSourceCount[kind] >= caps[kind]) {
      skipped.push(toSkipped(cand, 'per-source-cap'));
      continue;
    }
    if (runningTokens + cand.tokens > budget) {
      skipped.push(toSkipped(cand, 'over-budget'));
      continue;
    }
    included.push(cand);
    perSourceCount[kind] += 1;
    runningTokens += cand.tokens;
  }

  // Non-active steering items are never presented as live (step 9).
  for (const cand of candidates) {
    if (cand.supersededSkip) skipped.push(toSkipped(cand, 'superseded'));
  }

  // Confidence is emit-only (step 8): compute, attach, never block.
  const { confidence, confidenceReasons } = assessConfidence(included, runningTokens, budget);

  // Render, then HARD-guarantee the budget: re-measure the real string and drop
  // the lowest-density included item until the estimate fits. char/4 summed per
  // block can under-count the whole string by a rounding margin, so this final
  // trim is what makes "never exceeds budget" a guarantee, not a hope.
  let briefing = renderBriefing(seed, budget, included, confidence, confidenceReasons);
  while (included.length > 0 && estimateTokens(briefing) > budget) {
    const dropped = included.pop();
    if (dropped !== undefined) skipped.push(toSkipped(dropped, 'over-budget'));
    const reassessed = assessConfidence(included, tokenSum(included, overheadReserve), budget);
    briefing = renderBriefing(seed, budget, included, reassessed.confidence, reassessed.confidenceReasons);
  }

  const finalConf = assessConfidence(included, estimateTokens(briefing), budget);
  briefing = renderBriefing(seed, budget, included, finalConf.confidence, finalConf.confidenceReasons);

  const manifest: AssembleManifest = {
    seed,
    tokenBudget: budget,
    tokensUsed: estimateTokens(briefing),
    included: included.map((c) => ({ ...c.provenance, estimatedTokens: c.tokens, score: c.score })),
    skipped,
    confidence: finalConf.confidence,
    confidenceReasons: finalConf.confidenceReasons,
    perSourceCaps: caps,
  };
  return { briefing, manifest };
}

// ---------------------------------------------------------------------------
// Seam 2 — the BOARD (NOT board-blind): seed + explicit edges, one hop.
// ---------------------------------------------------------------------------

function gatherBoard(seed: string, seedItem: WorkItem | null, board: WorkStateVerbs): Candidate[] {
  if (seedItem === null) return [];
  const out: Candidate[] = [];
  const seen = new Set<string>();

  const push = (item: WorkItem, reason: string, score: number): void => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    out.push(makeCandidate('board', item.id, reason, item.status, score, renderWorkItem(item)));
  };

  // The seed itself — the claim's own body + acceptance criteria/scope (spec).
  push(seedItem, 'seed (claimed work item)', SCORE.seed);

  // Upstream: depends_on (what must be done first — sequencing edge).
  for (const depId of seedItem.depends_on) {
    const dep = board.get(depId);
    if (dep !== null) push(dep, `depends_on → ${depId}`, SCORE.dependsOnUpstream);
  }

  // Containment: the parent this item belongs to.
  if (seedItem.parent_id !== null) {
    const parent = board.get(seedItem.parent_id);
    if (parent !== null) push(parent, `belongs_to (parent) → ${seedItem.parent_id}`, SCORE.parent);
  }

  // Reverse edges — downstream (items that depend_on the seed) and children
  // (items whose parent is the seed). One board.list() sweep, filtered here.
  for (const item of board.list()) {
    if (item.id === seed) continue;
    if (item.depends_on.includes(seed)) push(item, `blocks (downstream) ← ${item.id} depends_on seed`, SCORE.downstream);
    if (item.parent_id === seed) push(item, `contains (child) ← ${item.id}`, SCORE.child);
  }

  return out;
}

function renderWorkItem(item: WorkItem): string {
  const lines = [
    `**${item.title}**  _(status: ${item.status}${item.claim === null ? '' : `, claimed by ${item.claim.holder.human}`})_`,
    '',
    item.spec,
  ];
  if (item.depends_on.length > 0) lines.push('', `_depends_on: ${item.depends_on.join(', ')}_`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Steering — SELECTION only; applicability + state-at-time decided HERE.
// ---------------------------------------------------------------------------

function gatherSteering(seedItem: WorkItem | null, steering: SteeringStore): Candidate[] {
  const seedText = seedItem === null ? '' : `${seedItem.title}\n${seedItem.spec}`.toLowerCase();
  const out: Candidate[] = [];

  for (const item of steering.read()) {
    // State-at-time (step 9): a non-active item is never live.
    if (item.status !== 'active') {
      out.push(makeSupersededCandidate(item));
      continue;
    }
    const isGP = item.kind.toLowerCase().includes('principle');
    const domainMatch = item.domain.length > 0 && seedText.includes(item.domain.toLowerCase());

    let reason: string;
    let score: number;
    if (isGP) {
      reason = 'guiding-principle (project-level steering)';
      score = SCORE.guidingPrinciple;
    } else if (domainMatch) {
      reason = `applicable-by-domain: ${item.domain}`;
      score = SCORE.policyDomainMatch;
    } else {
      reason = `policy (active${item.domain.length > 0 ? `, domain ${item.domain}` : ''})`;
      score = SCORE.policyActive;
    }
    out.push(makeCandidate('steering', item.id, reason, item.status, score, renderSteering(item)));
  }

  return out;
}

function renderSteering(item: SteeringItem): string {
  const label = item.domain.length > 0 ? `${item.kind} · ${item.domain}` : item.kind;
  return [`**${item.id}** _(${label})_`, '', item.statement].join('\n');
}

// ---------------------------------------------------------------------------
// Seam 1 — the RECORD (SELECTION only): scope-selected, unranked, ranked HERE.
// ---------------------------------------------------------------------------

function gatherRecords(scope: string, records: RecordStore): Candidate[] {
  const out: Candidate[] = [];
  // Over-select relative to the cap; the density pack trims. `read` is
  // selection-only — no ranking verb is asked of the record store.
  for (const rec of records.read({ scope, limit: 32 })) {
    const reason = `record scope-match: ${scope} (kind ${rec.kind})`;
    out.push(makeCandidate('record', rec.id, reason, 'recorded', SCORE.record, renderRecord(rec)));
  }
  return out;
}

function renderRecord(rec: { id: string; kind: string; claim: string; content: string }): string {
  const lines = [`**${rec.kind}**`];
  if (rec.claim.length > 0) lines.push('', `_claim:_ ${rec.claim}`);
  if (rec.content.length > 0) lines.push('', rec.content);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Candidate + skip helpers.
// ---------------------------------------------------------------------------

function makeCandidate(
  source: SourceKind,
  sourceId: string,
  inclusionReason: string,
  stateAtTime: string,
  score: number,
  body: string,
): Candidate {
  const provenance: InclusionProvenance = { sourceId, source, inclusionReason, stateAtTime };
  const entry = renderEntry(provenance, score, body);
  return { provenance, score, entry, tokens: estimateTokens(entry), supersededSkip: false };
}

function makeSupersededCandidate(item: SteeringItem): Candidate {
  const provenance: InclusionProvenance = {
    sourceId: item.id,
    source: 'steering',
    inclusionReason: `steering ${item.status} — not presented as live`,
    stateAtTime: item.status,
  };
  const entry = renderEntry(provenance, 0, renderSteering(item));
  return { provenance, score: 0, entry, tokens: estimateTokens(entry), supersededSkip: true };
}

/** One briefing entry: its provenance heading (step 7 — source id,
 *  inclusion reason, state-at-time) followed by the unfolded body. */
function renderEntry(p: InclusionProvenance, score: number, body: string): string {
  const bodyTokens = estimateTokens(body);
  return (
    `### [${p.source}] ${p.sourceId} — ${p.inclusionReason}\n` +
    `_(state: ${p.stateAtTime} · ~${bodyTokens} tok · score ${score})_\n\n` +
    body
  );
}

function toSkipped(cand: Candidate, skipReason: SkippedItem['skipReason']): SkippedItem {
  return { ...cand.provenance, estimatedTokens: cand.tokens, score: cand.score, skipReason };
}

function tokenSum(included: Candidate[], overheadReserve: number): number {
  return included.reduce((sum, c) => sum + c.tokens, overheadReserve);
}

// ---------------------------------------------------------------------------
// Confidence (emit-only) + rendering.
// ---------------------------------------------------------------------------

const CONFIDENCE_REASON = {
  budgetUnused: 'budget mostly unused (< 25%)',
  fewItems: 'few high-signal items assembled (< 3)',
  noPolicy: 'no policy applicable to the seed domain',
} as const;

/** The longest footer any assembly can emit — used to reserve budget headroom. */
const MAX_FOOTER = `> confidence: low — ${Object.values(CONFIDENCE_REASON).join('; ')}`;

function assessConfidence(
  included: Candidate[],
  tokensUsed: number,
  budget: number,
): { confidence: ConfidenceSignal; confidenceReasons: string[] } {
  const reasons: string[] = [];
  if (budget > 0 && tokensUsed < budget * 0.25) reasons.push(CONFIDENCE_REASON.budgetUnused);
  if (included.length < 3) reasons.push(CONFIDENCE_REASON.fewItems);
  const hasApplicablePolicy = included.some(
    (c) => c.provenance.source === 'steering' && c.provenance.inclusionReason.startsWith('applicable-by-domain'),
  );
  if (!hasApplicablePolicy) reasons.push(CONFIDENCE_REASON.noPolicy);
  return { confidence: reasons.length > 0 ? 'low' : 'high', confidenceReasons: reasons };
}

const SECTION_HEADERS: Record<SourceKind, string> = {
  board: '## Board (structural expansion from the seed)',
  steering: '## Steering (applicable principles & policies)',
  record: '## Process record (scope-selected)',
};

/** All section headers concatenated — the fixed framing overhead to reserve. */
const ALL_SECTION_HEADERS = Object.values(SECTION_HEADERS).join('\n\n');

function renderHeader(seed: string, budget: number): string {
  return `# Task briefing — ${seed}\n\n_Budgeted assembly (~${budget} tokens, char/4 estimate — soft cap)._\n`;
}

function renderBriefing(
  seed: string,
  budget: number,
  included: Candidate[],
  confidence: ConfidenceSignal,
  confidenceReasons: string[],
): string {
  const parts: string[] = [renderHeader(seed, budget)];

  for (const source of ['board', 'steering', 'record'] as const) {
    const items = included.filter((c) => c.provenance.source === source);
    if (items.length === 0) continue;
    parts.push(SECTION_HEADERS[source]);
    for (const c of items) parts.push(c.entry);
  }

  const footer =
    confidence === 'high' ? '> confidence: high' : `> confidence: low — ${confidenceReasons.join('; ')}`;
  parts.push(footer);

  return parts.join('\n\n') + '\n';
}
