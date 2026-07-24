// plugin/src/usage/detect.ts — the MECHANICAL citation detector.
//
// This is the heart of "mechanical, not inferred". Given a piece of
// captured text (what a worker actually wrote/emitted) and the set of ids an
// assembler DELIVERED, it returns exactly the delivered ids that appear in the
// text — by pure token matching, never by asking a model what was "relevant."
// Same text + same delivered set always yields the same result; there is no
// clock, no I/O, no randomness, and no LLM in this file.
//
// Token boundary rule: an id is "cited" only when it occurs flanked by
// non-alphanumeric characters (or a string edge). This is what keeps `ID-38`
// from matching inside `ID-381`, and `ID-381` from matching inside `ID-3812` —
// two distinct ids always differ in an alphanumeric character, so an
// alphanumeric neighbour means we are looking at a DIFFERENT, longer id, not a
// citation of this one. Hyphen and underscore count as boundaries even though
// ids contain hyphens internally (e.g. `ID-381`): the differentiator between
// two ids is never the boundary hyphen, always an interior alphanumeric.

const ALNUM = /[A-Za-z0-9]/;

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && ALNUM.test(ch);
}

/** True iff `token` occurs in `text` bounded by non-alphanumeric chars / edges. */
export function containsToken(text: string, token: string): boolean {
  if (token.length === 0) return false;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(token, from);
    if (idx === -1) return false;
    const before = idx > 0 ? text[idx - 1] : undefined;
    const afterIdx = idx + token.length;
    const after = afterIdx < text.length ? text[afterIdx] : undefined;
    if (!isAlnum(before) && !isAlnum(after)) return true;
    from = idx + 1; // overlapping occurrences are possible; keep scanning
  }
}

/**
 * The delivered ids that are cited in `text`, in the order they appear in
 * `candidateIds` (stable), de-duplicated. Empty candidate ids are ignored.
 *
 * Purely mechanical: this is the ONE function that decides "was a delivered
 * item used," and it decides by string presence alone. Callers supply
 * the authoritative delivered set (the manifest's item ids) — this function
 * never invents ids and never scores.
 */
export function detectCitedIds(text: string, candidateIds: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of candidateIds) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    if (containsToken(text, id)) out.push(id);
  }
  return out;
}
