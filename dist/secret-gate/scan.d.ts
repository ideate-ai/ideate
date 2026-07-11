/**
 * Injected redaction observer. Invoked once per pattern that matched, with
 * that pattern's match count for this scan. WI-271 wires this to the capture
 * telemetry so every redaction event is logged and counted (amendment I);
 * this module stays telemetry-agnostic.
 */
export type OnRedaction = (patternName: string, count: number) => void;
/**
 * Tuning knobs ONLY. This options surface must never grow an
 * enable/disable/skip switch — the gate is mechanical per GP-22 and runs on
 * every call, unconditionally. scan.test.ts asserts the key set is exactly
 * { onRedaction, entropyThreshold }.
 */
export interface ScanOptions {
    /** Redaction observer — see {@link OnRedaction}. */
    onRedaction?: OnRedaction;
    /**
     * Entropy threshold (bits/char) for the high-entropy heuristic ONLY;
     * shape-specific patterns always run regardless. Must be a finite number.
     * Defaults to {@link DEFAULT_ENTROPY_THRESHOLD}.
     */
    entropyThreshold?: number;
}
/** One registry pattern's redaction tally for a scan. */
export interface Redaction {
    pattern: string;
    count: number;
}
/** Result of a scan: masked content plus the per-pattern redaction tally. */
export interface ScanResult {
    content: string;
    redactions: Redaction[];
}
/**
 * Scan `content` against the known-pattern registry and mask every match in
 * place as `[REDACTED:pattern-name]`.
 *
 * - Non-matching content is returned byte-identical (same string reference).
 * - Already-masked content is a fixed point: rescanning output yields the
 *   same content, zero redactions, and zero callback invocations.
 * - `options.onRedaction` is invoked once per matched pattern with its
 *   count, in registry order, mirroring the returned `redactions` array.
 * - There is no way to skip the scan. Unknown extra properties on `options`
 *   are ignored; no falsy/truthy option value disables scanning.
 */
export declare function scanAndMask(content: string, options?: ScanOptions): ScanResult;
//# sourceMappingURL=scan.d.ts.map