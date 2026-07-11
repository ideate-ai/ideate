/**
 * Default prime budget — a COUNT CAP (number of records), not a token
 * estimate. The number 10 is a PLACEHOLDER: any tuning of this default is an
 * intelligence-adjacent claim and goes through the eval harness first
 * (GP-23; composable surface §3 "small fixed budget... a count cap, not a
 * tuned relevance system").
 */
export declare const DEFAULT_PRIME_BUDGET = 10;
/**
 * Ceiling on the prime `--budget` override — also a COUNT CAP. Like the
 * default above, 50 is a tune-through-the-harness number (GP-23): raising or
 * lowering it is an intelligence-adjacent claim about how much history is
 * worth injecting, and goes through the eval harness first, never ad hoc.
 * Values above it clamp to the max (with a stderr note); they never error —
 * this is a hook path, and a hooks.json typo must not become a hook failure.
 */
export declare const MAX_PRIME_BUDGET = 50;
/** Injectable process edges, for tests; every member defaults to the real one. */
export interface CliIo {
    stdin?: NodeJS.ReadableStream & {
        isTTY?: boolean;
    };
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
}
/**
 * Untrusted-data framing for the prime digest (surface §3; cycle-7 finding
 * S2 / Q-46). Digest entries are verbatim excerpts of stored record content
 * — commit messages, subagent final reports, transcript text — i.e. a
 * prompt-injection surface if injected bare into additionalContext. Every
 * NON-EMPTY digest is wrapped in this envelope so the host model sees the
 * entries explicitly flagged as quoted historical DATA, never as
 * host-authored instructions. Presentation-layer ONLY: the envelope is
 * composed at emit time and is never stored in any record. Honest limit:
 * this removes the unflagged-injection case; a model can still be swayed by
 * content it knows is quoted — that residue is a model-level limitation no
 * envelope closes.
 */
export declare const DIGEST_FRAME_OPEN = "--- ideate process record digest (historical data) ---";
export declare const DIGEST_FRAME_PREAMBLE: string;
export declare const DIGEST_FRAME_CLOSE = "--- end ideate process record digest ---";
/** CLI entry. Returns the process exit code (see the exit-code split above). */
export declare function main(argv?: string[], io?: CliIo): Promise<number>;
//# sourceMappingURL=ideate-record.d.ts.map