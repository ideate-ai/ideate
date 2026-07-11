/** Injected clock (same shape as telemetry's — see telemetry/counters.ts). */
export type Clock = () => Date;
/** A ULID is always exactly 26 Crockford-base32 characters. */
export declare const ULID_LENGTH = 26;
/**
 * A per-instance ULID generator. Construct one per store instance/session;
 * each call mints a fresh, sortable, collision-safe record ID.
 */
export type UlidGenerator = () => string;
/**
 * Create a ULID generator with per-instance entropy.
 *
 * - The 80-bit random component is drawn fresh from the CSPRNG for every new
 *   millisecond — this is the collision-safety requirement.
 * - Within the same millisecond (per this instance), the random component is
 *   incremented instead, so IDs minted by one instance are strictly
 *   monotonic — the sortability nice-to-have.
 */
export declare function createUlidGenerator(clock: Clock): UlidGenerator;
/** True iff `value` is a well-formed ULID (uppercase canonical form). */
export declare function isUlid(value: string): boolean;
/**
 * Decode the timestamp a ULID was minted at. The store derives the record's
 * `YYYY/MM` shard from this, so the shard is a pure function of the filename
 * stem. Throws RangeError on a malformed ULID.
 */
export declare function parseUlidTimestamp(ulid: string): Date;
//# sourceMappingURL=id.d.ts.map