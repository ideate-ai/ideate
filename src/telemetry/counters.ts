// plugin/src/telemetry/counters.ts — native telemetry counters (WI-262).
//
// Spec: docs/design/v3-architecture.md §3.5 — "native telemetry from day
// one". v2's instrumentation failure was *forensic to discover*; v3 builds
// the counters in from the start, ON BY DEFAULT (no opt-in flag exists in
// this API), so the same facts are a dashboard read, not an investigation.
//
// Exactly seven counters — a closed set (COUNTER_NAMES):
//   1. capture_fired        — capture-point firing counts (per point, per session)
//   2. priming              — priming requests and their usefulness signals
//   3. kg_unreachable       — KG unreachability rate (fail-open degradation, measured)
//   4. frontier_size        — claim-time frontier size samples (the number that
//                             decides whether reserved `rank` ever gets built)
//   5. capture_write_failed — capture-write failure rate (a nonzero rate is an
//                             ideate bug surfaced on the dashboard)
//   6. redactions           — secret-gate masking events (per pattern, per
//                             session; added 2026-07-09, cycle-9 amendment,
//                             closes cycle-7 S1/Q-44 per Dan's ratified
//                             decision — see §3.5)
//   7. work_claims          — work-state claim-lifecycle events (added
//                             2026-07-11, WI-303: the future claim-time
//                             priming eval's denominator — every
//                             `work_claim` fires this, whether or not
//                             claim-time priming is enabled; see
//                             work-state/priming-hook.ts)
//
// `kg_unreachable` and `frontier_size` have no live firing site in this phase
// — deliberate; their call sites arrive with Layer-1/KG integration.
//
// Persistence: append-only NDJSON, one JSON event per line, folded on read
// (report.ts). Appends are single atomic O_APPEND writes, so two concurrent
// processes never corrupt the state — which is why this is NOT a
// read-modify-write JSON document.
//
// No wall clock in library logic paths: the clock is injected (repo
// convention — see harness/src/runner/results.ts). Only the outermost CLI
// edge defaults it to `() => new Date()`.
//
// The state directory is injected too: WI-270 owns the config module and runs
// concurrently, so this library accepts a directory parameter instead of
// importing config. The integrator (WI-271) wires the config-owned data dir in.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Injected clock. The composition root (CLI edge) passes `() => new Date()`. */
export type Clock = () => Date;

/**
 * The seven counters — a closed set. The set grew from five to six on
 * 2026-07-09 (cycle-9 amendment; architecture §3.5): cycle-7 finding S1/Q-44
 * corroborated that secret-gate redactions were UNOBSERVABLE — a successful
 * gate action that never appeared on the telemetry dashboard and whose only
 * signals (a process warning + the AppendResult tally) were discarded in
 * transit on the hook transport. Dan ratified a dedicated sixth counter as
 * the fix. A redaction is a successful gate action, NOT a capture failure,
 * so it gets its own counter rather than polluting `capture_fired` or
 * `capture_write_failed`.
 *
 * Grew from six to seven on 2026-07-11 (WI-303): the work-state board's
 * claim-lifecycle needs its own denominator for the future claim-time
 * priming eval (GP-23 — priming behavior itself stays mechanically gated
 * off until that eval exists; see work-state/priming-hook.ts). `work_claims`
 * fires on every successful `work_claim`, independent of whether priming is
 * enabled.
 */
export const COUNTER_NAMES = [
  'capture_fired',
  'priming',
  'kg_unreachable',
  'frontier_size',
  'capture_write_failed',
  'redactions',
  'work_claims',
] as const;

export type CounterName = (typeof COUNTER_NAMES)[number];

/** Basename of the append-only NDJSON state file inside the state directory. */
export const TELEMETRY_FILE = 'telemetry.ndjson';

/**
 * One appended telemetry event. `at` is an ISO-8601 timestamp from the
 * injected clock. The `priming` counter carries two event kinds: `requested`
 * (a priming injection fired) and `usefulness` (a later-arriving signal about
 * whether primed material was used — stored verbatim, semantics deferred to
 * the eval work behind gate G3).
 */
export type TelemetryEvent =
  | { counter: 'capture_fired'; point: string; sessionId: string; at: string }
  | {
      counter: 'capture_write_failed';
      point: string;
      reason?: string;
      sessionId: string;
      at: string;
    }
  | { counter: 'priming'; kind: 'requested'; source: string; sessionId: string; at: string }
  | { counter: 'priming'; kind: 'usefulness'; signal: unknown; sessionId: string; at: string }
  | { counter: 'kg_unreachable'; sessionId: string; at: string }
  | { counter: 'frontier_size'; size: number; sessionId: string; at: string }
  | { counter: 'redactions'; pattern: string; count: number; sessionId: string; at: string }
  | { counter: 'work_claims'; itemId: string; sessionId: string; at: string };

/**
 * The counter library. Constructing it is enabling it: the state directory is
 * created immediately and every increment appends straight to disk. There is
 * deliberately no enable/disable/opt-in flag anywhere in this API (§3.5:
 * "on by default and read continuously, not a --trace flag nobody set").
 *
 * Telemetry must never block the host: if an append fails (disk full,
 * permissions), a process warning is emitted and the increment is dropped —
 * instrumentation failure may not become a workflow failure.
 */
export class TelemetryCounters {
  readonly #file: string;
  readonly #clock: Clock;

  constructor(stateDir: string, clock: Clock) {
    mkdirSync(stateDir, { recursive: true });
    this.#file = join(stateDir, TELEMETRY_FILE);
    this.#clock = clock;
  }

  /** Absolute path of the NDJSON state file this instance appends to. */
  get file(): string {
    return this.#file;
  }

  /** Counter 1 — a capture point fired (per point, per session). */
  captureFired(point: string, sessionId: string): void {
    this.#append({ counter: 'capture_fired', point, sessionId, at: this.#now() });
  }

  /**
   * Counter 5 — a capture write failed. The failed write logs and increments;
   * it never blocks the host. A nonzero rate is an ideate bug.
   */
  captureWriteFailed(point: string, sessionId: string, reason?: string): void {
    const at = this.#now();
    this.#append(
      reason === undefined
        ? { counter: 'capture_write_failed', point, sessionId, at }
        : { counter: 'capture_write_failed', point, reason, sessionId, at },
    );
  }

  /** Counter 2 — a priming request fired from `source` (claim, session-start, …). */
  primingRequested(source: string, sessionId: string): void {
    this.#append({ counter: 'priming', kind: 'requested', source, sessionId, at: this.#now() });
  }

  /**
   * Counter 2, recording slot — a priming-usefulness signal. Usefulness
   * semantics arrive later (gate G3); this accepts and stores the signal
   * verbatim (it must be JSON-serializable) and invents no interpretation.
   */
  primingUsefulness(sessionId: string, signal: unknown): void {
    this.#append({ counter: 'priming', kind: 'usefulness', signal, sessionId, at: this.#now() });
  }

  /**
   * Counter 3 — the KG was unreachable at the boundary. Recorded
   * mechanically so fail-open degradation is a measured quantity, never
   * silently swallowed. (No live firing site until KG integration.)
   */
  kgUnreachable(sessionId: string): void {
    this.#append({ counter: 'kg_unreachable', sessionId, at: this.#now() });
  }

  /**
   * Counter 4 — a claim-time frontier size *sample* (a size-sample recorder,
   * not a monotonic counter). (No live firing site until board integration.)
   */
  frontierSize(size: number, sessionId: string): void {
    if (!Number.isInteger(size) || size < 0) {
      throw new RangeError(
        `frontierSize: size must be a non-negative integer, got ${String(size)}`,
      );
    }
    this.#append({ counter: 'frontier_size', size, sessionId, at: this.#now() });
  }

  /**
   * Counter 6 — the secret gate masked `count` match(es) of `patternName`
   * before a persist (per pattern, per session). A redaction is a SUCCESSFUL
   * gate action; a nonzero rate here means the gate is earning its keep, not
   * that anything failed. (Added 2026-07-09, cycle-9 amendment, closes
   * cycle-7 S1/Q-44.) The signature mirrors the gate's `onRedaction`
   * callback (secret-gate/scan.ts), which only ever fires with count ≥ 1.
   */
  redactionApplied(patternName: string, count: number, sessionId: string): void {
    if (!Number.isInteger(count) || count < 1) {
      throw new RangeError(
        `redactionApplied: count must be a positive integer, got ${String(count)}`,
      );
    }
    this.#append({ counter: 'redactions', pattern: patternName, count, sessionId, at: this.#now() });
  }

  /**
   * Counter 7 — a work-state claim-lifecycle event fired (WI-303). Recorded
   * on every successful `work_claim`, regardless of whether claim-time
   * priming is enabled (work-state/priming-hook.ts) — this is the future
   * eval's denominator, so it must count every claim, not a filtered subset.
   */
  workClaimed(itemId: string, sessionId: string): void {
    this.#append({ counter: 'work_claims', itemId, sessionId, at: this.#now() });
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #append(event: TelemetryEvent): void {
    // JSON.stringify escapes embedded newlines, so one event is always
    // exactly one line — the invariant fold-on-read depends on.
    const line = `${JSON.stringify(event)}\n`;
    try {
      appendFileSync(this.#file, line, 'utf8');
    } catch (err) {
      process.emitWarning(
        `ideate telemetry: dropped ${event.counter} event (${err instanceof Error ? err.message : String(err)})`,
        { code: 'IDEATE_TELEMETRY_APPEND_FAILED' },
      );
    }
  }
}

/** Factory alias; construction alone enables recording. */
export function createTelemetry(stateDir: string, clock: Clock): TelemetryCounters {
  return new TelemetryCounters(stateDir, clock);
}
