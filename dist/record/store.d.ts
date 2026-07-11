import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { Redaction } from '../secret-gate/scan.js';
import type { TelemetryCounters } from '../telemetry/counters.js';
import type { Clock } from './id.js';
import type { ProcessRecord } from './schema.js';
/**
 * Record-ish append input. The store assigns `id` when absent and stamps
 * `source.timestamp` from the injected clock when absent; every other field
 * must be PRESENT (empty string is a valid value — absence is a schema
 * error, per boundary contract §6.2).
 */
export interface RecordInput {
    /** Optional pre-minted ULID (e.g. from the other capture transport). */
    id?: string;
    kind: string;
    claim: string;
    verification_anchor: string;
    scope: string;
    source: {
        capture_point: string;
        session_id: string;
        task_id?: string;
        /** Defaults to the store clock's current time (ISO-8601). */
        timestamp?: string;
    };
    content: string;
}
/** Typed append failure classes. */
export type AppendErrorCode = 
/** The input is missing a required field or carries a malformed id. */
'SCHEMA'
/** The filesystem write (mkdir or file create) failed. */
 | 'WRITE';
/**
 * Append outcome. Failures are RETURNED, never thrown: capture must not
 * become a workflow failure for the host (mirrors telemetry's posture).
 */
export type AppendResult = {
    ok: true;
    /** The record exactly as persisted (post-gate, id/timestamp assigned). */
    record: ProcessRecord;
    /** Absolute path of the written file. */
    path: string;
    /** Secret-gate tally for this record (see redaction routing note). */
    redactions: Redaction[];
} | {
    ok: false;
    code: AppendErrorCode;
    reason: string;
};
/** Selection options for {@link RecordStore.read} — selection, not ranking. */
export interface ReadOptions {
    /**
     * Case-insensitive substring matched against each record's `scope`,
     * `kind`, and `source` fields (capture_point, session_id, task_id). A
     * record is selected when ANY of them matches. No scoring of any kind.
     */
    scope?: string;
    /** Maximum number of records returned (newest first). */
    limit?: number;
}
/**
 * The v3 process-record store. One instance per session/process; its ULID
 * generator carries the per-session entropy of architecture §2.1.
 *
 * The exported API is append + read. There is deliberately NO update, NO
 * delete, and NO rank — see the three-property guard note above.
 */
export declare class RecordStore {
    #private;
    constructor(config: IdeateConfigV3, projectRoot: string, telemetry: TelemetryCounters, clock: Clock);
    /** The resolved record directory — always via config's single resolver. */
    get recordDir(): string;
    /**
     * Gate, then persist, one record. Runs scanAndMask over ALL text fields
     * before any filesystem write; assigns the id if absent; writes to the
     * `YYYY/MM` shard derived from the id's own timestamp (so the shard is a
     * pure function of the filename stem); fires `capture_fired` on success.
     * On ANY failure fires `capture_write_failed` and RETURNS a typed failure.
     */
    append(input: RecordInput): AppendResult;
    /**
     * Read records straight off the sharded files, newest first — no index,
     * no cache (architecture §2.2). The date sharding plus ULID filename sort
     * give reverse-chronological order for free: walk year dirs descending,
     * month dirs descending, filenames descending.
     *
     * `scope` is a SELECTION filter (simple substring match against scope /
     * kind / source fields), never a ranking; `limit` caps the count. Files
     * that fail to parse are skipped with a warning — a stray file must not
     * poison every read.
     */
    read(options?: ReadOptions): ProcessRecord[];
}
//# sourceMappingURL=store.d.ts.map