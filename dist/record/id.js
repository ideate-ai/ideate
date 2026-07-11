// plugin/src/record/id.ts — ULID record identifiers (WI-271).
//
// Spec: docs/design/v3-architecture.md §2.1 — "Record IDs are ULIDs,
// generated with per-session entropy." The ULID is the record's filename
// stem (`record.path/YYYY/MM/{id}.md`) and the stable ID the KG's sourceUri
// scheme embeds (`ideate:{project}/{record-id}`). Two properties are
// load-bearing:
//
// - SORTABLE BY CONSTRUCTION. The first 10 characters encode a 48-bit
//   millisecond timestamp in Crockford base32, most-significant first, so
//   lexicographic order over ULIDs is chronological order. The date-sharded
//   browse order and the store's cheap reverse-chronological read both rest
//   on this.
// - COLLISION-SAFE WITHOUT A SERVER. 80 bits of randomness per ULID, seeded
//   per generator instance ("per-session entropy"), keeps two contributors
//   minting records on two branches birthday-bound safe at any plausible
//   record volume. No central authority, no coordination.
//
// Hand-rolled on node:crypto — zero runtime dependencies (repo posture; see
// secret-gate/patterns.ts for the same stance). The clock is injected (repo
// convention — no wall clock in library logic paths); monotonicity within an
// instance is provided as a nice-to-have, collision-safety is the
// requirement.
import { randomBytes } from 'node:crypto';
/** Crockford base32 alphabet (no I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LOOKUP = new Map([...ENCODING].map((c, i) => [c, i]));
/** A ULID is always exactly 26 Crockford-base32 characters. */
export const ULID_LENGTH = 26;
const TIME_CHARS = 10; // 48-bit timestamp → 10 chars (top 2 bits always 0)
const RANDOM_CHARS = 16; // 80 bits randomness → 16 chars exactly
const RANDOM_BYTES = 10; // 80 bits
/** Largest timestamp 48 bits can carry (year ~10889). */
const MAX_TIME = 2 ** 48 - 1;
/** Uppercase Crockford base32, 26 chars, first char ≤ '7' (48-bit time cap). */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** Encode a 48-bit millisecond timestamp as 10 Crockford-base32 chars. */
function encodeTime(timeMs) {
    if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME) {
        throw new RangeError(`ulid: timestamp out of 48-bit range: ${String(timeMs)}`);
    }
    let out = '';
    let remaining = timeMs;
    for (let i = 0; i < TIME_CHARS; i++) {
        out = ENCODING[remaining % 32] + out;
        remaining = Math.floor(remaining / 32);
    }
    return out;
}
/** Encode 10 random bytes (80 bits) as 16 Crockford-base32 chars. */
function encodeRandom(bytes) {
    // 80 bits pack exactly into 16 × 5-bit groups; BigInt keeps this simple
    // and dependency-free.
    let value = 0n;
    for (const byte of bytes)
        value = (value << 8n) | BigInt(byte);
    let out = '';
    for (let i = 0; i < RANDOM_CHARS; i++) {
        out = ENCODING[Number(value & 31n)] + out;
        value >>= 5n;
    }
    return out;
}
/** Increment an 80-bit byte buffer in place (carry-propagating). */
function incrementBytes(bytes) {
    for (let i = bytes.length - 1; i >= 0; i--) {
        const current = bytes[i] ?? 0;
        if (current < 0xff) {
            bytes[i] = current + 1;
            return;
        }
        bytes[i] = 0;
    }
    // Full 80-bit wraparound: astronomically unlikely (2^80 increments within
    // one millisecond). Reseed rather than silently reuse.
    randomBytes(RANDOM_BYTES).copy(bytes);
}
/**
 * Create a ULID generator with per-instance entropy.
 *
 * - The 80-bit random component is drawn fresh from the CSPRNG for every new
 *   millisecond — this is the collision-safety requirement.
 * - Within the same millisecond (per this instance), the random component is
 *   incremented instead, so IDs minted by one instance are strictly
 *   monotonic — the sortability nice-to-have.
 */
export function createUlidGenerator(clock) {
    // Per-session entropy: each generator instance owns its own entropy state,
    // seeded independently at construction.
    let lastTime = -1;
    let lastRandom = randomBytes(RANDOM_BYTES);
    return function generateUlid() {
        const now = clock().getTime();
        if (now > lastTime) {
            lastTime = now;
            lastRandom = randomBytes(RANDOM_BYTES);
        }
        else {
            // Same (or rewound) millisecond: keep the encoded time monotonic and
            // bump the random component so this instance never repeats itself.
            incrementBytes(lastRandom);
        }
        return encodeTime(lastTime) + encodeRandom(lastRandom);
    };
}
/** True iff `value` is a well-formed ULID (uppercase canonical form). */
export function isUlid(value) {
    return value.length === ULID_LENGTH && ULID_PATTERN.test(value);
}
/**
 * Decode the timestamp a ULID was minted at. The store derives the record's
 * `YYYY/MM` shard from this, so the shard is a pure function of the filename
 * stem. Throws RangeError on a malformed ULID.
 */
export function parseUlidTimestamp(ulid) {
    if (!isUlid(ulid)) {
        throw new RangeError(`ulid: not a well-formed ULID: ${JSON.stringify(ulid)}`);
    }
    let timeMs = 0;
    for (let i = 0; i < TIME_CHARS; i++) {
        const digit = ENCODING_LOOKUP.get(ulid[i]);
        if (digit === undefined) {
            throw new RangeError(`ulid: invalid character at position ${String(i)}`);
        }
        timeMs = timeMs * 32 + digit;
    }
    return new Date(timeMs);
}
//# sourceMappingURL=id.js.map