import type { TelemetryEvent } from './counters.js';
/** A stored priming-usefulness signal, verbatim (semantics deferred; gate G3). */
export interface PrimingUsefulnessRecord {
    sessionId: string;
    signal: unknown;
    at: string;
}
/** Summary statistics over frontier-size samples. All null when no samples. */
export interface FrontierStats {
    samples: number;
    min: number | null;
    max: number | null;
    mean: number | null;
    last: number | null;
}
/** The folded report: exactly the six counters of §3.5, one key each. */
export interface TelemetryReport {
    captureFired: {
        total: number;
        byPoint: Record<string, number>;
        bySession: Record<string, number>;
        byPointBySession: Record<string, Record<string, number>>;
    };
    priming: {
        requested: {
            total: number;
            bySource: Record<string, number>;
            bySession: Record<string, number>;
        };
        usefulness: {
            recorded: number;
            signals: PrimingUsefulnessRecord[];
        };
    };
    kgUnreachable: {
        total: number;
        bySession: Record<string, number>;
    };
    frontierSize: {
        overall: FrontierStats;
        bySession: Record<string, FrontierStats>;
    };
    captureWriteFailed: {
        total: number;
        byPoint: Record<string, number>;
        bySession: Record<string, number>;
        byReason: Record<string, number>;
    };
    redactions: {
        /** Total masked matches (the SUM of per-event counts, not event count). */
        total: number;
        /** Number of redaction events (one per pattern per gated scan). */
        events: number;
        byPattern: Record<string, number>;
        bySession: Record<string, number>;
    };
}
/** A report with every counter present and zero. Valid before any event fires. */
export declare function emptyReport(): TelemetryReport;
/** Parse one NDJSON line into a validated event, or null if malformed. */
export declare function parseEventLine(line: string): TelemetryEvent | null;
/**
 * Read all events from a state directory. A missing state file is an empty
 * stream (telemetry that never fired is a valid, all-zero dashboard).
 * `skippedLines` counts unparseable lines (e.g. a torn final line).
 */
export declare function readTelemetryEvents(stateDir: string): {
    events: TelemetryEvent[];
    skippedLines: number;
};
/** Fold an event stream into the six-counter report. */
export declare function foldReport(events: readonly TelemetryEvent[]): TelemetryReport;
/** One-call dashboard read: fold everything under a state directory. */
export declare function reportFromDir(stateDir: string): {
    report: TelemetryReport;
    skippedLines: number;
};
//# sourceMappingURL=report.d.ts.map