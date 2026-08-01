// plugin/src/transport/id-lint.test.ts — acceptance tests for the pure
// ULID-shaped-token scan (id-lint.ts).
//
// Pins: candidate extraction (boundary discipline — a prefix of a longer
// alnum run, or a hyphenated UUID, must never match); resolution routing
// (resolved / unresolved / unknown, and an ABSENT resolver behaves exactly
// like every candidate resolving 'unknown' — P-45, never silently 'fine');
// dedup across and within fields, first-seen order.

import { describe, expect, it } from 'vitest';

import { extractCandidateIds, lintFreeText } from './id-lint.js';
import type { IdResolution, IdResolver } from './id-lint.js';

// Two real, well-formed ULIDs (record/id.ts's own alphabet: no I/L/O/U;
// first char <= 7).
const ULID_A = '01KYTM4XXR3FGWQY8HB3RGPT4M';
const ULID_B = '01KYTQZXDGVPJRBNY64JJ4YNV1';

describe('extractCandidateIds — pure extraction, no resolution', () => {
  it('finds a bare ULID-shaped token', () => {
    expect(extractCandidateIds(`see ${ULID_A} for detail`)).toEqual([ULID_A]);
  });

  it('finds a token bounded by punctuation (the verification-anchor shape: board:ID#complete@...)', () => {
    const text = `verify: board:${ULID_A}#complete@2026-08-01T01:26:45.052Z`;
    expect(extractCandidateIds(text)).toEqual([ULID_A]);
  });

  it('finds a token inside a record file path (.ideate-record/YYYY/MM/{ULID}.md)', () => {
    const text = `see .ideate-record/2026/07/${ULID_A}.md`;
    expect(extractCandidateIds(text)).toEqual([ULID_A]);
  });

  it('does NOT slice a 26-char prefix out of a longer alphanumeric run', () => {
    // A 40-character uppercase-ish run whose first 26 characters would
    // otherwise be a syntactically valid ULID shape. The boundary lookahead
    // must reject this: character 27 is alnum, so the 26-char window is not
    // a MAXIMAL run.
    const longRun = '01KYTM4XXR3FGWQY8HB3RGPT4MABCDEFGHIJKLMN';
    expect(extractCandidateIds(longRun)).toEqual([]);
  });

  it('does NOT match a hyphenated UUID (hyphens break the 26-char contiguous run, and the run either side is short)', () => {
    expect(extractCandidateIds('550e8400-e29b-41d4-a716-446655440000')).toEqual([]);
  });

  it('does NOT match a lowercase git SHA (wrong alphabet: only 0-9A-Z is matched, and git SHAs are lowercase hex)', () => {
    expect(extractCandidateIds('commit 1b2b7ca468889db07cc31926bbb3024870692728')).toEqual([]);
  });

  it('does NOT match a random 26-char alnum run containing an excluded Crockford letter (I/L/O/U) or a first char > 7', () => {
    // Exactly 26 chars, bounded, but 'I' is not in the Crockford alphabet.
    expect(extractCandidateIds('ABIDEFGHJKMNPQRSTVWXYZ0123')).toEqual([]);
    // Exactly 26 chars, Crockford-valid alphabet, but first char '9' > '7'
    // (would overflow the 48-bit timestamp field) — isUlid rejects it.
    expect(extractCandidateIds('99999999999999999999999999'.slice(0, 26))).toEqual([]);
  });

  it('a ULID-shaped token glued to an ULID-shaped-by-construction session id prefix ("mcp-<ULID>") still extracts the ULID (boundary is the hyphen)', () => {
    // This is the extraction behavior; id-lint's FIELD SCOPE (which strings
    // ever reach this function) is what actually prevents the false
    // positive in production — see record/store.test.ts.
    expect(extractCandidateIds(`session mcp-${ULID_A} started`)).toEqual([ULID_A]);
  });

  it('dedupes within one string, first-seen order', () => {
    expect(extractCandidateIds(`${ULID_B} ... ${ULID_A} ... ${ULID_B}`)).toEqual([ULID_B, ULID_A]);
  });

  it('empty and id-free text find nothing', () => {
    expect(extractCandidateIds('')).toEqual([]);
    expect(extractCandidateIds('plain prose with no ids at all')).toEqual([]);
  });
});

describe('lintFreeText — resolution routing', () => {
  function resolverFor(resolved: ReadonlySet<string>): IdResolver {
    return (id) => (resolved.has(id) ? 'resolved' : 'unresolved');
  }

  it('an id the resolver reports resolved is not reported', () => {
    expect(lintFreeText([ULID_A], resolverFor(new Set([ULID_A])))).toEqual([]);
  });

  it('an id the resolver reports unresolved IS reported, with resolution "unresolved"', () => {
    expect(lintFreeText([ULID_A], resolverFor(new Set()))).toEqual([{ id: ULID_A, resolution: 'unresolved' }]);
  });

  it('a resolver that itself reports "unknown" is passed through as "unknown", never silently dropped or upgraded to resolved', () => {
    const resolver: IdResolver = (): IdResolution => 'unknown';
    expect(lintFreeText([ULID_A], resolver)).toEqual([{ id: ULID_A, resolution: 'unknown' }]);
  });

  it('an ABSENT resolver behaves exactly like every candidate resolving "unknown" (P-45: never conflated with resolved)', () => {
    expect(lintFreeText([ULID_A], undefined)).toEqual([{ id: ULID_A, resolution: 'unknown' }]);
  });

  it('text with no ULID-shaped token never calls the resolver and reports nothing', () => {
    let calls = 0;
    const resolver: IdResolver = () => {
      calls += 1;
      return 'unresolved';
    };
    expect(lintFreeText(['plain prose', 'more prose'], resolver)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('dedupes across MULTIPLE fields, first-seen order, and resolves each candidate exactly once', () => {
    let calls = 0;
    const resolver: IdResolver = () => {
      calls += 1;
      return 'unresolved';
    };
    const result = lintFreeText([`claim cites ${ULID_A}`, `content also cites ${ULID_A} and ${ULID_B}`], resolver);
    expect(result).toEqual([
      { id: ULID_A, resolution: 'unresolved' },
      { id: ULID_B, resolution: 'unresolved' },
    ]);
    expect(calls).toBe(2); // never re-resolves ULID_A for the second field
  });

  it('a mix of resolved and unresolved candidates: only the unresolved ones are reported, in first-seen order', () => {
    const result = lintFreeText([`${ULID_A} then ${ULID_B}`], resolverFor(new Set([ULID_B])));
    expect(result).toEqual([{ id: ULID_A, resolution: 'unresolved' }]);
  });
});
