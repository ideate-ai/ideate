// plugin/src/transport/id-lint.ts — the capture-time lint for unresolvable
// ULIDs cited in free text (record/board correction 01KYV387QKRP3V330WAS6DX95K).
//
// WHY this is its own neutral module: mirrors payload-budget.ts's own
// header — a check both the process record and the delegation board must
// apply IDENTICALLY, without either store importing the other (GP-26: narrow
// seams; "wider coupling = monolith regrowth"). record/store.ts and
// work-state/store.ts each call `lintFreeText` below with an INJECTED
// resolver (id-resolver.ts, the one module that legitimately knows about
// both stores) — the store itself never learns what a "record" or a "work
// item" is, only that it was handed a same-shaped `(id) => IdResolution`
// callback, exactly the DI shape record/id.ts's `Clock` already uses.
//
// PURE TRANSFORM, same posture as secret-gate/scan.ts: text (+ an injected
// resolver callback) in, a list of problems out. No I/O, no clock, no store
// import. The resolver itself is where I/O happens — this module never
// touches a filesystem or a database.
//
// WARN, NOT REJECT (the design decision this item asks to be justified,
// pinned by tests in record/store.test.ts and work-state/store.test.ts): a
// correction record's whole JOB is to quote the id it is correcting — see the
// three historical instances in this item's own spec, each of which cites a
// dead id by design. Rejecting the write would block exactly the record that
// repairs the trail. WARN reports the problem without blocking it.
//
// MECHANICAL EXTRACTION, not an id someone already told us about: a ULID is
// any 26-character run drawn from record/id.ts's own Crockford alphabet,
// bounded on both sides by a non-alphanumeric character (or the start/end of
// the string) — `isUlid` (record/id.ts) is the single source of truth for
// what counts, re-used here rather than re-implemented. The boundary
// requirement is what keeps this from mis-slicing a PREFIX of a longer
// alphanumeric run (a 40-character token, a hyphenated UUID, an unrelated
// 30-character identifier) into a false 26-character match; see id-lint.test.ts's
// false-positive fixtures — a hyphenated UUID and a random 30-char alnum
// token both produce nothing, pinned behaviorally, not just asserted by
// inspection of the regex.

import { isUlid } from '../record/id.js';

/**
 * Every 26-character run of ULID-alphabet characters, bounded on both sides
 * by a non-alphanumeric character (lookaround, so overlapping candidates
 * inside a longer run are never sliced out — see this file's header). Matches
 * against the FULL alphanumeric superset (`[0-9A-Za-z]`, not just the
 * Crockford subset) so a candidate immediately followed by, say, a lowercase
 * letter is correctly rejected as "not a maximal 26-character token" rather
 * than accidentally treated as a boundary.
 */
const CANDIDATE_PATTERN = /(?<![0-9A-Za-z])[0-9A-Z]{26}(?![0-9A-Za-z])/g;

/** How a candidate id resolved. `unknown` is P-45's loud non-silent-downgrade
 *  case: the check genuinely could not be answered (no resolver was wired, or
 *  the resolver's own lookup failed) — never conflated with `resolved` (which
 *  would silently hide a real dangling reference) or with `unresolved` (which
 *  would falsely accuse a reference the check simply could not verify). */
export type IdResolution = 'resolved' | 'unresolved' | 'unknown';

/** Injected cross-store resolver — see id-resolver.ts for the real
 *  implementation and why it is the one module allowed to know about both
 *  the record store and the board. */
export type IdResolver = (id: string) => IdResolution;

/** One id this lint could not confirm as resolved, in FIRST-SEEN order. */
export interface UnresolvedId {
  id: string;
  resolution: 'unresolved' | 'unknown';
}

/**
 * Extract every ULID-shaped candidate token from `text`, in order,
 * deduplicated. Pure — no resolution, no I/O. Exported separately from
 * {@link lintFreeText} so a caller (or a test) can inspect exactly what this
 * module considers "ULID-shaped" without also wiring a resolver.
 */
export function extractCandidateIds(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(CANDIDATE_PATTERN)) {
    const candidate = match[0];
    if (!isUlid(candidate)) continue; // Crockford-invalid (I/L/O/U, or first char > 7)
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * Scan every string in `texts` for ULID-shaped tokens and resolve each
 * (deduplicated across ALL of them, first-seen order) against `resolve`.
 * Returns only the ones that did NOT resolve — an empty array is the
 * "everything cited resolves" case callers should treat as silence.
 *
 * `resolve` absent is treated identically to every candidate resolving
 * `'unknown'` — see this file's header and {@link IdResolution}'s own doc
 * comment: absence of a wired resolver is a P-45 capability gap, not
 * evidence the ids are fine.
 */
export function lintFreeText(texts: readonly string[], resolve: IdResolver | undefined): UnresolvedId[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const id of extractCandidateIds(text)) {
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(id);
    }
  }
  const out: UnresolvedId[] = [];
  for (const id of candidates) {
    const resolution = resolve === undefined ? 'unknown' : resolve(id);
    if (resolution === 'resolved') continue;
    out.push({ id, resolution });
  }
  return out;
}
