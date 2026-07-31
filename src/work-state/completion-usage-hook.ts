// plugin/src/work-state/completion-usage-hook.ts — the `work_complete`
// post-commit USAGE-CAPTURE hook: mechanically detects whether a completed
// item's own explicit structural neighbours were CITED in its completion
// note. This is the wiring for the ratified decision (01KYTYVV2142JDEJ1P0QFDZZ9E)
// that the usage surface (usage/capture.ts, usage/store.ts) gets WIRED rather
// than left eval-only.
//
// THE INTEGRATION-POINT CHOICE, condensed (full analysis in the work item's
// completion report):
//
//   "Delivered" needs a source that is HONEST, not a convenient guess. The
//   candidate that measures the (currently gated-off, unshipped) context-
//   assembler's ranked/budgeted manifest was rejected: context/assemble-
//   prototype.ts has "no MCP handler, no primeOnClaim wiring" per its own
//   header, and work-state/priming-hook.ts's `primeOnClaim` — the seam that
//   WOULD deliver an assembled briefing at claim time — is mechanically
//   gated off and, even when the flag is flipped on, throws
//   `NOT_IMPLEMENTED` and delivers NOTHING (see that module's header). Wiring
//   capture to a manifest that is never produced would satisfy "fires
//   mechanically" while recording a delivered set that never happens in
//   production — exactly the "fires reliably but records the wrong thing"
//   trap the work item warns against.
//
//   What DOES exist, unconditionally, on every read of a work item, is its
//   own explicit structural edges: `depends_on`, `parent_id`, `references`.
//   types.ts's own contract says it plainly — "Always present on a read...
//   `[]` when absent" — these ids are returned verbatim in the JSON payload
//   of `work_claim`/`work_get`/`work_complete` itself. A worker who claims or
//   reads this item necessarily has these ids in front of them, with zero
//   selection algorithm involved. This is a FLOOR definition of "delivered":
//   not the assembler's ranked briefing, but a real, always-on, honestly
//   observable one. (The usage schema's own `item_id` doc explicitly allows
//   a work-item id as a valid citable artifact, and its `manifest_id` doc
//   explicitly anticipates a citation captured "where no manifest is in
//   scope" — this is exactly that case.)
//
//   "Used" is the completion `note` — free prose the completing actor writes
//   BECAUSE they are completing the item, never because anything told them to
//   record usage (GP-22: no agent-discretion path). It is scanned by the same
//   mechanical, non-LLM string-match detector (usage/detect.ts) the
//   eval/replay harness uses.
//
//   Both sides are known SIMULTANEOUSLY, from data this hook already holds —
//   the post-commit `WorkItem` and the `note` argument `complete()` already
//   received — with NO cross-process correlation, no assumption about host
//   hook-payload semantics, and no new persisted state. That is what makes
//   this integration point safe to wire NOW instead of guessing.
//
//   TRADE-OFF, stated plainly: this measures whether a worker cites the
//   board's own always-shown structural neighbours, NOT whether a ranked/
//   budgeted context assembly is effective (that question stays unanswerable
//   until the assembler itself ships and is wired to `primeOnClaim`). It is a
//   narrower, honest floor signal — real production rows through the
//   pipe — not a stand-in for the eventual recall@budget metric.
//
// Ordering/failure semantics mirror completion-record.ts's post-commit hook
// EXACTLY: fires strictly AFTER the CAS + event have already committed (this
// module never influences whether the claim stays completed), and NEVER
// throws — a write failure is loud (stderr) and counted
// (`capture_write_failed`, point {@link USAGE_CAPTURE_POINT}), never
// re-thrown.

import { join } from 'node:path';

import type { Clock } from '../record/id.js';
import type { TelemetryCounters } from '../telemetry/counters.js';
import { captureCitedContext } from '../usage/capture.js';
import type { UsageSignal } from '../usage/schema.js';
import { UsageStore } from '../usage/store.js';
import { DEFAULT_USAGE_DIR } from '../usage/tools.js';
import type { WorkItem } from './types.js';

/** The capture point stamped on `source.capture_point` and passed as the
 *  telemetry `point` on a write failure — one constant ties both together,
 *  mirroring completion-record.ts's `COMPLETION_CAPTURE_POINT`. */
export const USAGE_CAPTURE_POINT = 'work_complete:structural-edges';

/**
 * The delivered set for this integration point: every id the completed
 * item's OWN payload always carries — `depends_on`, `parent_id` (when
 * present), and `references[].id`. De-duplicated; order is not significant
 * (usage/detect.ts scans text for each, independent of list order).
 */
export function deliveredIdsFor(item: Pick<WorkItem, 'depends_on' | 'parent_id' | 'references'>): string[] {
  const ids = new Set<string>();
  for (const id of item.depends_on) ids.add(id);
  if (item.parent_id !== null) ids.add(item.parent_id);
  for (const ref of item.references) ids.add(ref.id);
  return [...ids];
}

/** Everything the hook needs, gathered by claims.ts's `complete()` AFTER its
 *  own transaction has already committed — mirrors completion-record.ts's
 *  `CompletionRecordFacts` shape. */
export interface UsageCaptureFacts {
  /** The completed item, post-commit — its OWN depends_on/parent_id/references
   *  are the delivered set (see {@link deliveredIdsFor}). */
  item: WorkItem;
  /** The completion note, verbatim — the text scanned for citations. Absent
   *  or empty writes zero signals (nothing to scan), never an error. */
  note: string | undefined;
  /** Stamped onto every signal's `source.session_id`. */
  sessionId: string;
}

/** A usage writer: given the facts, detect + append. Returns the signals
 *  written (possibly empty). Never expected to throw for a well-formed
 *  `UsageStore` (only a filesystem failure would) — but
 *  `runUsageCaptureHook` tolerates a writer that throws anyway (the
 *  test/override seam). */
export type UsageCaptureWriter = (facts: UsageCaptureFacts) => UsageSignal[];

/**
 * Dependencies `complete()`'s post-commit hook needs, injected by whichever
 * transport is calling it (mirrors completion-record.ts's
 * `CompletionRecordConfig`).
 */
export interface UsageCaptureConfig {
  /** The project root the usage store resolves under — the SAME root the
   *  calling transport's own work-state store/config were built from. */
  projectRoot: string;
  /** Usage store directory override (tests). Default:
   *  `<projectRoot>/.ideate/usage` — the SAME default usage/tools.ts's MCP
   *  registrar uses, so a `usage_query` call over the default path sees
   *  what this hook wrote. */
  usageDir?: string;
  /** The telemetry sink `capture_write_failed` counts through on a write
   *  failure — the SAME instance the calling transport already constructed. */
  telemetry: TelemetryCounters;
  /** Stamped onto every signal's `source.session_id` — the SAME session id
   *  the calling transport already resolved for its other verbs. */
  sessionId: string;
  /** Test/override seam: replace the real writer outright. When absent,
   *  `runUsageCaptureHook` builds the real writer inline from
   *  `projectRoot`/`usageDir` — correct, just less efficient across many
   *  calls (both real transports build it ONCE via
   *  {@link createRealUsageCaptureWriter} and pass it here). */
  usageWriter?: UsageCaptureWriter;
}

/**
 * Build the real writer: resolves the usage store from `projectRoot`/
 * `usageDir` (the SAME default `usage/tools.ts`'s MCP registrar resolves),
 * then detects + appends through `captureCitedContext` — the identical
 * mechanical, non-LLM detection path the eval/replay harness and the
 * `usage_capture` MCP verb both use. Building this eagerly at a transport's
 * own composition edge is cheap (the store's constructor touches no
 * filesystem itself — only `.record()` does).
 */
/**
 * GATED OFF (2026-07-31). The plumbing below is correct and reviewed; the
 * SIGNAL it would record is not honest, so no transport writes rows today.
 *
 * Why: this hook detects citations in the completion NOTE. In every shipped
 * orchestration path that note is written by the COORDINATOR, never by the
 * agent that did the work — `agents/worker.md` ("You do not claim, complete,
 * or release"), `skills/execute/SKILL.md` ("You do the board/record writes;
 * workers and reviewers only build and report"), and the identical shape in
 * `skills/autopilot/phases/execute.md`. Worse, the coordinator has held the
 * delivered ids verbatim since it pasted their spec bodies into the worker's
 * prompt BEFORE work began, so citing them costs zero retrieval and evidences
 * zero reuse. GP-23 wants "did agent B avoid re-working what agent A
 * discovered"; this would capture orchestrator narration.
 *
 * That is worse than capturing nothing. An empty store is visibly empty; a
 * store full of narration-generated rows LOOKS healthy and would be read as
 * evidence of context reuse — on the very instrument GP-23 designates as the
 * gate for downstream intelligence machinery (GP-24: a bad mechanical proxy
 * fails silently and confidently). It is also reflexively gameable: a prose
 * edit to a skill could drive it to 100% with no behavioural change.
 *
 * Kept rather than deleted because everything AROUND the signal survived
 * review and an honest source would reuse it unchanged: GP-22 compliance is
 * pinned (no skill/agent prose invokes usage_capture), both transports are
 * exercised through the shipped path per P-50, and a capture failure provably
 * cannot un-complete a claim. Flip {@link USAGE_CAPTURE_ENABLED} when an
 * integration point that observes genuine USE exists — see finding
 * 01KYWK5A05EJ8HW5ESTC8ASXQZ and the re-planning of 01KYV2J81NAW1G08S24SV4GHKF.
 */
export const USAGE_CAPTURE_ENABLED = false;

/**
 * What the transports actually inject. Returns a provable no-op while
 * {@link USAGE_CAPTURE_ENABLED} is false — the hook still runs end to end, so
 * the ordering and failure-isolation contract stays exercised in production,
 * but no row is ever written and no UsageStore is ever constructed.
 */
export function createGatedUsageCaptureWriter(projectRoot: string, usageDir: string | undefined, clock: Clock): UsageCaptureWriter {
  if (!USAGE_CAPTURE_ENABLED) return (): UsageSignal[] => [];
  return createRealUsageCaptureWriter(projectRoot, usageDir, clock);
}

export function createRealUsageCaptureWriter(projectRoot: string, usageDir: string | undefined, clock: Clock): UsageCaptureWriter {
  const dir = usageDir ?? join(projectRoot, DEFAULT_USAGE_DIR);
  const store = new UsageStore(dir, clock);
  return (facts: UsageCaptureFacts): UsageSignal[] => {
    const delivered = deliveredIdsFor(facts.item);
    // No structural neighbours and/or no note: nothing could possibly be
    // cited — a fast, honest no-op rather than a wasted detection pass.
    if (delivered.length === 0 || facts.note === undefined || facts.note.length === 0) return [];
    return captureCitedContext(store, {
      text: facts.note,
      delivered,
      seed_id: facts.item.id,
      source: {
        capture_point: USAGE_CAPTURE_POINT,
        session_id: facts.sessionId,
        task_id: facts.item.id,
      },
    });
  };
}

/**
 * The post-commit hook claims.ts's `complete()` calls, unconditionally
 * whenever a transport supplies a {@link UsageCaptureConfig}, AFTER its own
 * CAS + event (and, when present, the completion-record hook) have already
 * committed. NEVER throws — see the file header for the full ordering/
 * failure contract.
 */
export function runUsageCaptureHook(facts: UsageCaptureFacts, config: UsageCaptureConfig, clock: Clock): void {
  try {
    const writer = config.usageWriter ?? createRealUsageCaptureWriter(config.projectRoot, config.usageDir, clock);
    writer(facts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `ideate work-state: usage-capture write THREW for item ${facts.item.id} (${message}) — ` +
        'the claim remains completed; not re-thrown\n',
    );
    try {
      config.telemetry.captureWriteFailed(USAGE_CAPTURE_POINT, facts.sessionId, message);
    } catch {
      // Telemetry itself must never escalate a capture failure into a second one.
    }
  }
}
