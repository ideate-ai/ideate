// plugin/src/transport/keyset-page.ts — the SHAPE of a bounded, resumable
// read: one page of rows plus the opaque boundary to resume from.
//
// This module is deliberately NEUTRAL — it belongs to no store. The
// delegation board (work-state/), the process record (record/) and steering
// (steering/) are separate stores that share no schema (GP-26: narrow seams),
// yet every one of them faces the same transport-level problem: an
// unbounded read that must be handed to a caller a page at a time. The page
// envelope and the cursor ENCODING are the part of that problem that has
// nothing to do with any store's rows, so they live here, where any transport
// can import them without importing another seam's storage layer.
//
// Zero dependencies beyond `node:buffer` by construction: anything that
// imports this module must not, by doing so, drag in SQLite, a schema, or a
// store's typed error taxonomy.
//
// Cursor DECODING is deliberately SPLIT rather than parked whole on either
// side. The mechanical half — canonical base64url + JSON — is identical for
// every seam and is {@link parseListCursorPayload} below, which RETURNS a
// result and never throws. The half that cannot live here is the FAILURE: a
// malformed cursor has to surface as the OWNING seam's typed error with that
// seam's own message (steering must not raise a `WorkStateError`, GP-26), and
// so does the seam-specific shape check — the board and the process record
// encode `(created_at, id)` while steering encodes `(updated_at, id)` and the
// process record encodes `(id)` alone, and only the seam knows which. So every
// seam's decoder — work-state/store.ts's `decodeListCursor`, steering/store.ts's
// `decodeSteeringCursor`, record/read-page.ts's — is a thin shape check plus
// its own typed error over THIS one mechanical parser, and keyset-page.test.ts
// holds that "exactly one round-trip guard" claim mechanically.

import { Buffer } from 'node:buffer';

/** One page of a keyset read: the rows, plus the boundary to resume from
 *  (`null` when this page is the last one). */
export interface ListItemsPage<T> {
  items: T[];
  /** Opaque to callers: they pass it back verbatim and never construct or
   *  parse one (minted by {@link encodeListCursor}). */
  next_cursor: string | null;
}

/**
 * Encode a page boundary as `base64url(JSON.stringify([created_at, id]))`.
 * The encoder is `node:buffer`'s own base64url (C-13: no hand-rolled
 * serialization — no delimiter concatenation, no manual escaping), so a
 * timestamp containing a delimiter-shaped character can never split a cursor.
 * The RESULT is opaque at the contract level: callers pass it back verbatim
 * and never construct or parse one.
 *
 * `(created_at, id)` is the boundary every ideate store can offer — both the
 * board and the process record order by creation time with a ULID tiebreak —
 * which is why the encoder is neutral rather than board-owned.
 */
export function encodeListCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

/**
 * Encode a page boundary that is an id ALONE:
 * `base64url(JSON.stringify([id]))` — the same `node:buffer` base64url and the
 * same JSON envelope as {@link encodeListCursor}, one element instead of two.
 *
 * WHY a second encoder rather than `encodeListCursor(something, id)`: the
 * process record's ULID `id` is BY CONSTRUCTION a total order over the store
 * (the id embeds its own mint time, and the shard directory is derived from
 * that same embedded time — record/store.ts), so `id < cursor` is the whole
 * predicate and a second key would be a decorative field a reader could
 * mistake for load-bearing. Encoding one element also makes the seam's shape
 * check exact: a record cursor has EXACTLY one element, so a board or steering
 * cursor pasted into a record read is rejected as malformed instead of
 * half-understood.
 *
 * The result is opaque at the contract level, exactly like the pair form:
 * callers pass it back verbatim and never construct or parse one.
 */
export function encodeIdCursor(id: string): string {
  return Buffer.from(JSON.stringify([id]), 'utf8').toString('base64url');
}

/**
 * Why a string is not one of {@link encodeListCursor}'s cursors — the two
 * MECHANICAL ways to fail, which are the same for every seam:
 *   - `not-canonical-base64url`: the input does not survive a decode/re-encode
 *     round trip, so it is not the exact text this module would have minted;
 *   - `not-json`: it decoded, but the bytes are not JSON.
 * The seam-specific third way — "JSON, but not the tuple THIS seam encodes" —
 * is deliberately absent: only the owning seam knows its own boundary shape
 * (see {@link parseListCursorPayload}).
 */
export type ListCursorProblem = 'not-canonical-base64url' | 'not-json';

/** The outcome of {@link parseListCursorPayload}: the decoded JSON value, or
 *  which mechanical check rejected the input. Never an exception. */
export type ListCursorParse = { ok: true; value: unknown } | { ok: false; problem: ListCursorProblem };

/**
 * Decode a cursor's ENCODING — canonical base64url, then JSON — and RETURN the
 * outcome. This function never throws, because throwing would mean choosing a
 * seam's error type, and this module belongs to no seam: each transport takes
 * the `{ok: false}` result and raises ITS OWN typed error (steering's
 * `SteeringSchemaError`, the board's `WorkStateError`), with its own message.
 *
 * THE GUARD THAT MATTERS is the canonical round trip. `Buffer.from(x,
 * 'base64url')` is LENIENT: verified empirically, it silently accepts padded
 * input, characters outside the base64url alphabet (which it drops), a short
 * final group, and a non-canonical tail (bits past the last full byte), all of
 * which decode to *something*. Without the round-trip comparison an
 * attacker-supplied or truncated cursor would decode to a plausible boundary
 * and quietly select nothing — an empty page a caller reads as "the store
 * ended", which is the silent-truncation failure paging exists to avoid. Re-
 * encoding the decoded bytes and demanding the EXACT input back closes all
 * four shapes at once, which is why this check lives in ONE place rather than
 * being hand-copied per seam.
 *
 * What is NOT checked here: the VALUE. `[]`, `{}`, `["", ""]` and
 * `["a","b","c"]` all parse fine and come back as `value` — the seam decides
 * whether the shape is its own boundary (steering: exactly two strings), and a
 * well-formed cursor naming a boundary no row ever had legitimately selects
 * nothing.
 *
 * The offending value is deliberately never part of a result the caller can
 * echo: this returns only a problem TAG, so no seam can accidentally reflect
 * attacker-supplied text into an error surface that does not gate free text
 * (P-24).
 */
export function parseListCursorPayload(cursor: string): ListCursorParse {
  const bytes = Buffer.from(cursor, 'base64url');
  if (bytes.toString('base64url') !== cursor) return { ok: false, problem: 'not-canonical-base64url' };
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false, problem: 'not-json' };
  }
}
