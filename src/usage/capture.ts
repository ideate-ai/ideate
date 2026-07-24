// plugin/src/usage/capture.ts — the mechanical capture ORCHESTRATION.
//
// This is the seam a caller invokes to turn "the worker wrote this text, and
// the assembler delivered these items" into persisted usage signals. It does
// exactly two things and nothing else:
//   1. detect (usage/detect.ts) — which delivered ids appear in the text,
//      by pure string match (no LLM);
//   2. record (usage/store.ts) — one append-only signal per detected id.
//
// Intended MECHANICAL callers (none wired here yet — the assembler and its
// manifest live in the still-gated context/ module):
//   - the eval/replay harness, feeding a past task's captured worker
//     output + that task's delivered manifest ids to form the ground-truth
//     "used" set;
//   - later, a mechanical hook/record capture point that already holds the
//     worker's emitted text and the claim-time manifest.
// Because the delivered set is always supplied by the caller (from the
// authoritative manifest, never from agent opinion), the capture stays
// mechanical end-to-end: the worker never decides what counts as "used."

import { detectCitedIds } from './detect.js';
import type { UsageSignal } from './schema.js';
import { USAGE_KIND_USED_CONTEXT } from './schema.js';
import type { UsageStore } from './store.js';

/** Input to {@link captureCitedContext}. */
export interface CaptureCitedContextInput {
  /** The captured worker text scanned for citations (a record body, a
   *  completion note, replayed agent output). Never persisted here — only the
   *  detected ids are, so no free-text secret can leak through this path. */
  text: string;
  /** The authoritative delivered set: the item ids the assembler offered (the
   *  manifest's ids). Detection is scoped to exactly these. */
  delivered: readonly string[];
  /** Provenance stamped onto every signal written for this capture. */
  source: {
    capture_point: string;
    session_id: string;
    task_id?: string;
    timestamp?: string;
  };
  /** The seed the assembly was for (usually the claimed work item). */
  seed_id?: string;
  /** The assembly manifest the items were delivered in. */
  manifest_id?: string;
  /** The usage kind. Defaults to {@link USAGE_KIND_USED_CONTEXT}. */
  kind?: string;
}

/**
 * Detect which delivered ids the text cites and append one usage signal per
 * hit. Returns the signals written, in detection order (possibly empty — a
 * text that cites nothing writes nothing). Deterministic given its inputs and
 * the store's id/clock.
 */
export function captureCitedContext(store: UsageStore, input: CaptureCitedContextInput): UsageSignal[] {
  const cited = detectCitedIds(input.text, input.delivered);
  return cited.map((itemId) =>
    store.record({
      kind: input.kind ?? USAGE_KIND_USED_CONTEXT,
      item_id: itemId,
      ...(input.seed_id === undefined ? {} : { seed_id: input.seed_id }),
      ...(input.manifest_id === undefined ? {} : { manifest_id: input.manifest_id }),
      source: {
        capture_point: input.source.capture_point,
        session_id: input.source.session_id,
        ...(input.source.task_id === undefined ? {} : { task_id: input.source.task_id }),
        ...(input.source.timestamp === undefined ? {} : { timestamp: input.source.timestamp }),
      },
    }),
  );
}
