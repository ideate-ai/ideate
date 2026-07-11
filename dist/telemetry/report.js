// plugin/src/telemetry/report.ts — fold-on-read for the six native
// telemetry counters (WI-262; sixth counter WI-281, cycle-9 amendment;
// docs/design/v3-architecture.md §3.5).
//
// The state is an append-only NDJSON event stream (counters.ts). This module
// reads it and folds it into totals plus per-point / per-session / per-source
// breakdowns — the "dashboard read". A torn final line (a process killed
// mid-append) is tolerated: unparseable lines are skipped and *counted*, so
// the CLI can surface them on stderr rather than silently swallowing them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TELEMETRY_FILE } from './counters.js';
const EMPTY_FRONTIER = { samples: 0, min: null, max: null, mean: null, last: null };
/** A report with every counter present and zero. Valid before any event fires. */
export function emptyReport() {
    return {
        captureFired: { total: 0, byPoint: {}, bySession: {}, byPointBySession: {} },
        priming: {
            requested: { total: 0, bySource: {}, bySession: {} },
            usefulness: { recorded: 0, signals: [] },
        },
        kgUnreachable: { total: 0, bySession: {} },
        frontierSize: { overall: { ...EMPTY_FRONTIER }, bySession: {} },
        captureWriteFailed: { total: 0, byPoint: {}, bySession: {}, byReason: {} },
        redactions: { total: 0, events: 0, byPattern: {}, bySession: {} },
    };
}
/** Parse one NDJSON line into a validated event, or null if malformed. */
export function parseEventLine(line) {
    let raw;
    try {
        raw = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return null;
    const e = raw;
    if (typeof e.sessionId !== 'string' || typeof e.at !== 'string')
        return null;
    const sessionId = e.sessionId;
    const at = e.at;
    switch (e.counter) {
        case 'capture_fired':
            if (typeof e.point !== 'string')
                return null;
            return { counter: 'capture_fired', point: e.point, sessionId, at };
        case 'capture_write_failed': {
            if (typeof e.point !== 'string')
                return null;
            if (e.reason !== undefined && typeof e.reason !== 'string')
                return null;
            return e.reason === undefined
                ? { counter: 'capture_write_failed', point: e.point, sessionId, at }
                : { counter: 'capture_write_failed', point: e.point, reason: e.reason, sessionId, at };
        }
        case 'priming':
            if (e.kind === 'requested') {
                if (typeof e.source !== 'string')
                    return null;
                return { counter: 'priming', kind: 'requested', source: e.source, sessionId, at };
            }
            if (e.kind === 'usefulness') {
                return { counter: 'priming', kind: 'usefulness', signal: e.signal, sessionId, at };
            }
            return null;
        case 'kg_unreachable':
            return { counter: 'kg_unreachable', sessionId, at };
        case 'frontier_size':
            if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0)
                return null;
            return { counter: 'frontier_size', size: e.size, sessionId, at };
        case 'redactions':
            if (typeof e.pattern !== 'string')
                return null;
            if (typeof e.count !== 'number' || !Number.isInteger(e.count) || e.count < 1)
                return null;
            return { counter: 'redactions', pattern: e.pattern, count: e.count, sessionId, at };
        default:
            return null;
    }
}
/**
 * Read all events from a state directory. A missing state file is an empty
 * stream (telemetry that never fired is a valid, all-zero dashboard).
 * `skippedLines` counts unparseable lines (e.g. a torn final line).
 */
export function readTelemetryEvents(stateDir) {
    const file = join(stateDir, TELEMETRY_FILE);
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            return { events: [], skippedLines: 0 };
        }
        throw err;
    }
    const events = [];
    let skippedLines = 0;
    for (const line of text.split('\n')) {
        if (line.trim() === '')
            continue;
        const event = parseEventLine(line);
        if (event === null) {
            skippedLines += 1;
        }
        else {
            events.push(event);
        }
    }
    return { events, skippedLines };
}
function bump(rec, key) {
    rec[key] = (rec[key] ?? 0) + 1;
}
function accFrontier(acc, size) {
    if (acc === undefined) {
        return { samples: 1, min: size, max: size, sum: size, last: size };
    }
    acc.samples += 1;
    acc.min = Math.min(acc.min, size);
    acc.max = Math.max(acc.max, size);
    acc.sum += size;
    acc.last = size;
    return acc;
}
function frontierStats(acc) {
    if (acc === undefined || acc.samples === 0)
        return { ...EMPTY_FRONTIER };
    return {
        samples: acc.samples,
        min: acc.min,
        max: acc.max,
        mean: acc.sum / acc.samples,
        last: acc.last,
    };
}
/** Fold an event stream into the six-counter report. */
export function foldReport(events) {
    const report = emptyReport();
    let frontierAll;
    const frontierBySession = new Map();
    for (const event of events) {
        switch (event.counter) {
            case 'capture_fired': {
                const c = report.captureFired;
                c.total += 1;
                bump(c.byPoint, event.point);
                bump(c.bySession, event.sessionId);
                const perPoint = (c.byPointBySession[event.point] ??= {});
                bump(perPoint, event.sessionId);
                break;
            }
            case 'priming': {
                if (event.kind === 'requested') {
                    const r = report.priming.requested;
                    r.total += 1;
                    bump(r.bySource, event.source);
                    bump(r.bySession, event.sessionId);
                }
                else {
                    const u = report.priming.usefulness;
                    u.recorded += 1;
                    u.signals.push({ sessionId: event.sessionId, signal: event.signal, at: event.at });
                }
                break;
            }
            case 'kg_unreachable': {
                report.kgUnreachable.total += 1;
                bump(report.kgUnreachable.bySession, event.sessionId);
                break;
            }
            case 'frontier_size': {
                frontierAll = accFrontier(frontierAll, event.size);
                frontierBySession.set(event.sessionId, accFrontier(frontierBySession.get(event.sessionId), event.size));
                break;
            }
            case 'capture_write_failed': {
                const f = report.captureWriteFailed;
                f.total += 1;
                bump(f.byPoint, event.point);
                bump(f.bySession, event.sessionId);
                bump(f.byReason, event.reason ?? '(unspecified)');
                break;
            }
            case 'redactions': {
                const r = report.redactions;
                // Totals SUM the per-event match counts; `events` counts the events.
                r.total += event.count;
                r.events += 1;
                r.byPattern[event.pattern] = (r.byPattern[event.pattern] ?? 0) + event.count;
                r.bySession[event.sessionId] = (r.bySession[event.sessionId] ?? 0) + event.count;
                break;
            }
        }
    }
    report.frontierSize.overall = frontierStats(frontierAll);
    for (const [sessionId, acc] of frontierBySession) {
        report.frontierSize.bySession[sessionId] = frontierStats(acc);
    }
    return report;
}
/** One-call dashboard read: fold everything under a state directory. */
export function reportFromDir(stateDir) {
    const { events, skippedLines } = readTelemetryEvents(stateDir);
    return { report: foldReport(events), skippedLines };
}
//# sourceMappingURL=report.js.map