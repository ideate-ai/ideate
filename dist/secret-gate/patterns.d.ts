/** One entry in the known-pattern registry. */
export interface SecretPattern {
    /** Registry name — becomes the mask text `[REDACTED:<name>]`. */
    readonly name: string;
    /**
     * Global regex locating candidate secrets. Patterns that need surrounding
     * context to be precise (e.g. `aws_secret_access_key = <40 base64 chars>`)
     * capture the non-secret context in groups so `redact` can re-emit it.
     */
    readonly regex: RegExp;
    /**
     * Build the masked replacement for ONE regex match. Must embed `marker`
     * and may re-emit captured non-secret context (e.g. `scheme://user:` and
     * `@` for connection strings) so surrounding text is preserved. It never
     * re-emits the secret itself.
     */
    readonly redact: (marker: string, match: string, groups: readonly (string | undefined)[]) => string;
    /**
     * Optional per-match guard (used by the high-entropy heuristic). When
     * present, a regex match is masked only if this returns true.
     */
    readonly accepts?: (match: string, context: {
        entropyThreshold: number;
    }) => boolean;
}
/** The in-place mask text for a pattern: `[REDACTED:<pattern-name>]`. */
export declare function redactionMarker(patternName: string): string;
/** Shannon entropy of a token in bits per character (empirical, base 2). */
export declare function shannonEntropy(token: string): number;
/** Minimum candidate length for the high-entropy heuristic. ULIDs (26 chars) sit below it. */
export declare const ENTROPY_MIN_LENGTH = 32;
/**
 * Default entropy threshold in bits/char. Hex strings (git SHA-1, SHA-256)
 * are mathematically capped at 4.0 and can never reach it.
 */
export declare const DEFAULT_ENTROPY_THRESHOLD = 4.3;
/**
 * The known-pattern registry, applied IN ORDER by scan.ts. Order matters:
 * PEM blocks go first (their base64 body must be consumed as a single block
 * before any token-level pattern sees it), shape-specific patterns next
 * (most-specific first — e.g. anthropic-api-key before openai-api-key, jwt
 * before bearer-token), and the high-entropy catch-all last so it only sees
 * content no named shape claimed.
 */
export declare const SECRET_PATTERNS: readonly SecretPattern[];
//# sourceMappingURL=patterns.d.ts.map