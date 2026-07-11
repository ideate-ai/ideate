/** Provenance — the fourth contract field (boundary contract §6.2 "Source"). */
export interface RecordSource {
    /** The originating capture point (boundary contract §2, rows 1–6). */
    capture_point: string;
    /** Session that produced the record. */
    session_id: string;
    /** Task / work-item ID, when one is in scope. */
    task_id?: string;
    /** ISO-8601 capture timestamp (from the injected clock). */
    timestamp: string;
}
/**
 * One process record. `kind` is an OPEN vocabulary — decision | finding |
 * session-outcome | subagent-outcome | commit-boundary | task-completion |
 * … — deliberately not a closed union: new capture points must not require
 * a schema change.
 */
export interface ProcessRecord {
    /** ULID — filename stem and the KG sourceUri's record ID (§2.1). */
    id: string;
    kind: string;
    /** Contract field 1 — the candidate discovery statement. May be empty. */
    claim: string;
    /** Contract field 2 — how the claim can be checked. May be empty. */
    verification_anchor: string;
    /** Contract field 3 — what future work the claim is load-bearing for. May be empty. */
    scope: string;
    /** Contract field 4 — provenance. */
    source: RecordSource;
    /** Recall-shaped prose body (boundary contract §6.2). May be empty. */
    content: string;
}
/** Typed schema failure: a required field is ABSENT (emptiness is valid). */
export declare class RecordSchemaError extends Error {
    readonly name = "RecordSchemaError";
    /** Dotted path of the offending field, e.g. `source.session_id`. */
    readonly field: string;
    constructor(field: string, message: string);
}
/**
 * Validate a record-shaped object: every contract field present as a string
 * (empty allowed), `source` present with its required members. Returns the
 * normalized record; throws RecordSchemaError on any absence.
 */
export declare function validateRecord(input: unknown): ProcessRecord;
/**
 * Serialize a record to its on-disk Markdown form: YAML frontmatter carrying
 * id + kind + the four contract fields, then the prose body.
 */
export declare function serializeRecord(record: ProcessRecord): string;
/**
 * Parse the on-disk Markdown form back to a record. Inverse of
 * {@link serializeRecord}; throws RecordSchemaError when a required field is
 * absent or the document is not a frontmatter-bearing record.
 */
export declare function parseRecord(markdown: string): ProcessRecord;
//# sourceMappingURL=schema.d.ts.map