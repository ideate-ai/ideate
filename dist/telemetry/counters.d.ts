/** Injected clock. The composition root (CLI edge) passes `() => new Date()`. */
export type Clock = () => Date;
/**
 * The six counters — a closed set. The set grew from five to six on
 * 2026-07-09 (cycle-9 amendment; architecture §3.5): cycle-7 finding S1/Q-44
 * corroborated that secret-gate redactions were UNOBSERVABLE — a successful
 * gate action that never appeared on the telemetry dashboard and whose only
 * signals (a process warning + the AppendResult tally) were discarded in
 * transit on the hook transport. Dan ratified a dedicated sixth counter as
 * the fix. A redaction is a successful gate action, NOT a capture failure,
 * so it gets its own counter rather than polluting `capture_fired` or
 * `capture_write_failed`.
 */
export declare const COUNTER_NAMES: readonly ["capture_fired", "priming", "kg_unreachable", "frontier_size", "capture_write_failed", "redactions"];
export type CounterName = (typeof COUNTER_NAMES)[number];
/** Basename of the append-only NDJSON state file inside the state directory. */
export declare const TELEMETRY_FILE = "telemetry.ndjson";
/**
 * One appended telemetry event. `at` is an ISO-8601 timestamp from the
 * injected clock. The `priming` counter carries two event kinds: `requested`
 * (a priming injection fired) and `usefulness` (a later-arriving signal about
 * whether primed material was used — stored verbatim, semantics deferred to
 * the eval work behind gate G3).
 */
export type TelemetryEvent = {
    counter: 'capture_fired';
    point: string;
    sessionId: string;
    at: string;
} | {
    counter: 'capture_write_failed';
    point: string;
    reason?: string;
    sessionId: string;
    at: string;
} | {
    counter: 'priming';
    kind: 'requested';
    source: string;
    sessionId: string;
    at: string;
} | {
    counter: 'priming';
    kind: 'usefulness';
    signal: unknown;
    sessionId: string;
    at: string;
} | {
    counter: 'kg_unreachable';
    sessionId: string;
    at: string;
} | {
    counter: 'frontier_size';
    size: number;
    sessionId: string;
    at: string;
} | {
    counter: 'redactions';
    pattern: string;
    count: number;
    sessionId: string;
    at: string;
};
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
export declare class TelemetryCounters {
    #private;
    constructor(stateDir: string, clock: Clock);
    /** Absolute path of the NDJSON state file this instance appends to. */
    get file(): string;
    /** Counter 1 — a capture point fired (per point, per session). */
    captureFired(point: string, sessionId: string): void;
    /**
     * Counter 5 — a capture write failed. The failed write logs and increments;
     * it never blocks the host. A nonzero rate is an ideate bug.
     */
    captureWriteFailed(point: string, sessionId: string, reason?: string): void;
    /** Counter 2 — a priming request fired from `source` (claim, session-start, …). */
    primingRequested(source: string, sessionId: string): void;
    /**
     * Counter 2, recording slot — a priming-usefulness signal. Usefulness
     * semantics arrive later (gate G3); this accepts and stores the signal
     * verbatim (it must be JSON-serializable) and invents no interpretation.
     */
    primingUsefulness(sessionId: string, signal: unknown): void;
    /**
     * Counter 3 — the KG was unreachable at the boundary. Recorded
     * mechanically so fail-open degradation is a measured quantity, never
     * silently swallowed. (No live firing site until KG integration.)
     */
    kgUnreachable(sessionId: string): void;
    /**
     * Counter 4 — a claim-time frontier size *sample* (a size-sample recorder,
     * not a monotonic counter). (No live firing site until board integration.)
     */
    frontierSize(size: number, sessionId: string): void;
    /**
     * Counter 6 — the secret gate masked `count` match(es) of `patternName`
     * before a persist (per pattern, per session). A redaction is a SUCCESSFUL
     * gate action; a nonzero rate here means the gate is earning its keep, not
     * that anything failed. (Added 2026-07-09, cycle-9 amendment, closes
     * cycle-7 S1/Q-44.) The signature mirrors the gate's `onRedaction`
     * callback (secret-gate/scan.ts), which only ever fires with count ≥ 1.
     */
    redactionApplied(patternName: string, count: number, sessionId: string): void;
}
/** Factory alias; construction alone enables recording. */
export declare function createTelemetry(stateDir: string, clock: Clock): TelemetryCounters;
//# sourceMappingURL=counters.d.ts.map