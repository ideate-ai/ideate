// plugin/src/work-state/completion-record.ts — the completion-record
// composer + writer seam (WI-306), wiring claims.ts's `complete()` to the v3
// process record store (closes capstone GAP-1 / boundary contract capture
// point 1 for the work-state board).
//
// Spec: docs/spikes/v3-boundary-contract.md §2 row 1 ("Task (work item)
// completion" — one discovery-candidate record per completed work item,
// content mechanism amended 2026-07-09/C1/Q-34: the completion note IS the
// content carrier; absent, structural extraction is the floor) and
// docs/spikes/v3-work-delegation.md §3.2 rule 3 / §3.5 (the `note` parameter
// this module reads its content from). Pre-made design decisions (WI-306
// brief — implemented here, not re-litigated):
//
//   - `kind: 'work-completion'`.
//   - `claim`: item title + the completion note when one is supplied;
//     item title + transition metadata (the §3.2 amendment's structural
//     fallback) when it is not.
//   - `verification_anchor`: `board:<item-id>#complete@<event-at>`.
//   - `scope`: `<tenant_id>/<item-id>`.
//   - No dedup with the board's own `complete` event — the board event and
//     this record serve different consumers (process-state authority vs.
//     knowledge capture), so both persist independently.
//
// ORDERING/FAILURE SEMANTICS (GP-21: the board is the state authority, the
// record is capture only). `runCompletionRecordHook` — the single function
// claims.ts's `complete()` calls — is invoked ONLY after that function's own
// CAS + audit event have already committed (claims.ts's own call site proves
// this: the hook fires after `db.close()`, using the already-returned,
// already-persisted `WorkItem`). A record-write failure of ANY kind — a
// typed `AppendResult` failure from the real writer (unwritable record dir,
// schema rejection) or an injected/override writer that throws outright —
// NEVER un-completes the claim and NEVER escapes this module: it is surfaced
// loudly (a `process.stderr.write` diagnostic, so the CLI transport's
// operator sees it in the moment) and counted (the existing
// `capture_write_failed` telemetry counter, point 'work-completion' — see
// telemetry/counters.ts), but `runCompletionRecordHook` itself never throws.
//
// Both transports (work-state/tools.ts's `work_complete` MCP handler and
// cli/ideate-work.ts's `complete` subcommand) inject a `CompletionRecordConfig`
// built from the SAME project root, telemetry sink, and session id their own
// composition edge already constructed for every other verb — see each
// transport's own call site for the exact wiring.

import { loadConfig } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import type { AppendResult } from '../record/store.js';
import type { TelemetryCounters } from '../telemetry/counters.js';
import type { ActorRef, WorkItem } from './types.js';

/** The record's `kind` (WI-306 pre-made decision). */
export const COMPLETION_RECORD_KIND = 'work-completion';

/**
 * The capture point stamped on `source.capture_point` — also the value
 * `RecordStore.append` uses as its own telemetry `point` argument (it derives
 * that argument directly from `source.capture_point`; see record/store.ts's
 * `append`), so this one constant is structurally what ties the record's
 * provenance and the failure counter together — they can never drift apart.
 */
export const COMPLETION_CAPTURE_POINT = 'work-completion';

/**
 * Everything the composer needs, gathered by claims.ts's `complete()` AFTER
 * its own transaction has already committed.
 */
export interface CompletionRecordFacts {
  /** The completed item, post-commit (status 'done', claim cleared). */
  item: WorkItem;
  /** The completion note, verbatim — absent triggers the structural fallback
   *  (§3.2 rule 3 amendment). An empty string is treated the same as absent:
   *  there is no content to carry. */
  note: string | undefined;
  /** The actor the completion was attributed to — the claim's own holder
   *  (claims.ts never accepts a caller-supplied actor for `complete`). */
  completedBy: ActorRef;
  /** The fencing token the completion succeeded under. */
  claimToken: number;
  /** The completion event's own timestamp (the same instant as the board's
   *  `complete` audit event) — this is the `@<event-at>` half of the
   *  verification anchor. */
  completedAt: string;
  /** Stamped onto the record's `source.session_id`. */
  sessionId: string;
}

/**
 * A record writer: given the facts, attempt to persist one 'work-completion'
 * record and report the outcome. Never expected to throw for an ordinary
 * `AppendResult` failure (record/store.ts's own `append` returns failures,
 * never throws them) — but `runCompletionRecordHook` tolerates a writer that
 * throws anyway (the test/override seam), which is exactly how the
 * "injected failing writer" acceptance case is exercised.
 */
export type CompletionRecordWriter = (facts: CompletionRecordFacts) => AppendResult;

/**
 * Dependencies `complete()`'s post-commit hook needs, injected by whichever
 * transport is calling it. Both work-state/tools.ts and cli/ideate-work.ts
 * already construct a project root, a `TelemetryCounters` instance, and a
 * session id for their own composition edge (every other verb on that
 * transport uses the same three) — this config type exists so `complete()`
 * reuses those SAME instances rather than minting new ones per call.
 */
export interface CompletionRecordConfig {
  /** The project root the record store resolves under — the SAME root the
   *  calling transport's own work-state store/config were built from. */
  projectRoot: string;
  /** The telemetry sink `capture_write_failed` counts through — the SAME
   *  instance the calling transport already constructed, so a completion
   *  record failure lands on the identical dashboard as every other capture
   *  write failure (never a private, second counter). */
  telemetry: TelemetryCounters;
  /** Stamped onto the record's `source.session_id`. */
  sessionId: string;
  /**
   * Test/override seam: replace the real writer outright — e.g. to inject a
   * writer that throws (proving the non-blocking failure contract without
   * touching the filesystem), or to capture the exact composed facts a
   * caller would otherwise only observe as a file on disk. Both real
   * transports build the real writer ONCE (via
   * {@link createRealCompletionRecordWriter}) at their own composition edge
   * and pass it here, so `.ideate.json` is not re-read on every completion;
   * when absent, `runCompletionRecordHook` builds the real writer inline
   * from `projectRoot`/`telemetry` — correct, just less efficient across
   * many calls.
   */
  recordWriter?: CompletionRecordWriter;
}

/**
 * Compose the record's `claim` field (contract field 1): title + note when a
 * note is supplied, or the structural fallback (title + transition metadata)
 * when it is not — the §3.2 amendment's own floor. An empty-string note is
 * treated as absent: there is no prose to carry.
 */
export function composeCompletionClaim(
  facts: Pick<CompletionRecordFacts, 'item' | 'note' | 'completedBy' | 'completedAt'>,
): string {
  if (facts.note !== undefined && facts.note.length > 0) {
    return `${facts.item.title} — ${facts.note}`;
  }
  const agentSuffix = facts.completedBy.agent === undefined ? '' : ` (${facts.completedBy.agent})`;
  return (
    `${facts.item.title} — completed by ${facts.completedBy.human}${agentSuffix} at ${facts.completedAt} ` +
    '(no completion note provided; structural fallback per v3-work-delegation.md §3.2 rule 3 amendment)'
  );
}

/**
 * Compose the record's `verification_anchor` (contract field 2): the board
 * item id plus the completion event reference (WI-306 brief).
 */
export function composeCompletionAnchor(itemId: string, completedAt: string): string {
  return `board:${itemId}#complete@${completedAt}`;
}

/** Compose the record's `scope` (contract field 3): tenant/item. */
export function composeCompletionScope(tenantId: string, itemId: string): string {
  return `${tenantId}/${itemId}`;
}

/**
 * Compose the record's prose `content`: the note verbatim when present, or
 * the same structural-fallback sentence the `claim` field carries — the
 * boundary contract's §6.2 recall-shaped body, never empty even on the
 * fallback path.
 */
export function composeCompletionContent(
  facts: Pick<CompletionRecordFacts, 'item' | 'note' | 'completedBy' | 'completedAt'>,
): string {
  if (facts.note !== undefined && facts.note.length > 0) return facts.note;
  return composeCompletionClaim(facts);
}

/**
 * Build the real writer: resolves the project's config + record store from
 * `projectRoot` (the SAME resolver every other record writer in this repo
 * uses — config/ideate-config.ts's `loadConfig`), then persists through
 * `RecordStore.append` — the identical gated write path record/tools.ts's
 * MCP verbs use (secret-gate-before-persist, append-only, no second write
 * path). `RecordStore`'s constructor touches no filesystem itself (only
 * `.append()` does), so building this eagerly at a transport's own
 * composition edge is cheap.
 */
export function createRealCompletionRecordWriter(
  projectRoot: string,
  telemetry: TelemetryCounters,
  clock: Clock,
): CompletionRecordWriter {
  const config = loadConfig(projectRoot);
  const store = new RecordStore(config, projectRoot, telemetry, clock);
  return (facts: CompletionRecordFacts): AppendResult =>
    store.append({
      kind: COMPLETION_RECORD_KIND,
      claim: composeCompletionClaim(facts),
      verification_anchor: composeCompletionAnchor(facts.item.id, facts.completedAt),
      scope: composeCompletionScope(facts.item.tenant_id, facts.item.id),
      source: {
        capture_point: COMPLETION_CAPTURE_POINT,
        session_id: facts.sessionId,
        task_id: facts.item.id,
        timestamp: facts.completedAt,
      },
      content: composeCompletionContent(facts),
    });
}

/**
 * The post-commit hook claims.ts's `complete()` calls, unconditionally
 * whenever a transport supplies a {@link CompletionRecordConfig}, once its
 * own CAS + event have already committed (GP-21 — this function must never
 * influence whether the claim stays completed).
 *
 * NEVER throws. Two distinct failure modes are both loud + counted, never
 * re-thrown:
 *   1. The writer returns a typed `AppendResult` failure (e.g. the real
 *      writer's `RecordStore.append` hit an unwritable record directory).
 *      `RecordStore.append` ALREADY incremented `capture_write_failed` for
 *      point 'work-completion' internally (its `source.capture_point` IS
 *      this module's `COMPLETION_CAPTURE_POINT`) — this function adds only
 *      the loud stderr line, never a second increment.
 *   2. The writer (necessarily an injected/override one — the real writer
 *      never throws) throws outright. This function's own `catch` logs the
 *      stderr line AND increments `capture_write_failed` itself, since
 *      nothing else in that path ever would.
 */
export function runCompletionRecordHook(facts: CompletionRecordFacts, config: CompletionRecordConfig, clock: Clock): void {
  try {
    const writer = config.recordWriter ?? createRealCompletionRecordWriter(config.projectRoot, config.telemetry, clock);
    const result = writer(facts);
    if (!result.ok) {
      process.stderr.write(
        `ideate work-state: completion-record write FAILED for item ${facts.item.id} (${result.code}: ${result.reason}) — ` +
          `the claim remains completed; capture_write_failed already incremented for point ${COMPLETION_CAPTURE_POINT}\n`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `ideate work-state: completion-record write THREW for item ${facts.item.id} (${message}) — ` +
        'the claim remains completed; not re-thrown\n',
    );
    try {
      config.telemetry.captureWriteFailed(COMPLETION_CAPTURE_POINT, facts.sessionId, message);
    } catch {
      // Telemetry itself must never escalate a capture failure into a second one.
    }
  }
}
