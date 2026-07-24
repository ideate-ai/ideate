// plugin/src/secret-gate/scan.ts — the capture-time secret-scanning gate.
//
// `scanAndMask` is the gate every record write passes its content through
// before the write executes.
//
// Design invariants:
//
// - PURE TRANSFORM. content in, content out. No I/O, no clock, no imports
//   outside the pattern registry. Telemetry integration happens through the
//   injected `onRedaction` callback — this module never imports the
//   telemetry module, so it stays a dependency-free transform.
//
// - MECHANICAL: zero inference. No human in the loop, no agent discretion.
//   The function signature does not admit a skip: ScanOptions can tune the
//   callback and the entropy threshold, but there is deliberately NO
//   enable/disable/skip flag anywhere in this API, and scan.test.ts pins that
//   shut at both the type level and runtime.
//
// - IN-PLACE MASKING. Matches become `[REDACTED:pattern-name]`; all
//   surrounding text is preserved. Content with no matches passes through
//   byte-identical (the very same string reference).
//
// - HONEST LIMIT. Known shapes only (see patterns.ts). Novel secrets are
//   handled by the extraordinary-redaction MANUAL procedure, which is
//   deliberately not automated here.

import { DEFAULT_ENTROPY_THRESHOLD, SECRET_PATTERNS, redactionMarker } from './patterns.js';

/**
 * Injected redaction observer. Invoked once per pattern that matched, with
 * that pattern's match count for this scan. This wires to the capture
 * telemetry so every redaction event is logged and counted;
 * this module stays telemetry-agnostic.
 */
export type OnRedaction = (patternName: string, count: number) => void;

/**
 * Tuning knobs ONLY. This options surface must never grow an
 * enable/disable/skip switch — the gate is mechanical and runs on
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

function resolveEntropyThreshold(raw: unknown): number {
  if (raw === undefined) return DEFAULT_ENTROPY_THRESHOLD;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new RangeError(
      `scanAndMask: entropyThreshold must be a finite number, got ${String(raw)}`,
    );
  }
  return raw;
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
export function scanAndMask(content: string, options?: ScanOptions): ScanResult {
  const entropyThreshold = resolveEntropyThreshold(options?.entropyThreshold);
  const redactions: Redaction[] = [];
  let current = content;

  for (const pattern of SECRET_PATTERNS) {
    const marker = redactionMarker(pattern.name);
    let count = 0;
    const masked = current.replace(pattern.regex, (...args) => {
      const match = args[0] as string;
      // replace() callback args: match, ...captureGroups, offset, whole
      // string[, namedGroups]. The offset is the first numeric argument;
      // everything between the match and it is the capture groups.
      const offsetIndex = args.findIndex((a, i) => i > 0 && typeof a === 'number');
      const groups = args.slice(1, offsetIndex) as (string | undefined)[];
      if (pattern.accepts !== undefined && !pattern.accepts(match, { entropyThreshold })) {
        return match;
      }
      count += 1;
      return pattern.redact(marker, match, groups);
    });
    if (count > 0) {
      current = masked;
      redactions.push({ pattern: pattern.name, count });
      options?.onRedaction?.(pattern.name, count);
    }
  }

  return { content: current, redactions };
}
