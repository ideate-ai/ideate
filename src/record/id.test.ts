// plugin/src/record/id.test.ts — WI-271 ULID acceptance tests.
//
// Pins architecture §2.1's ID properties: lexicographic sortability by
// construction (timestamp-prefixed Crockford base32), collision-safety
// across independently-seeded instances (per-session entropy), and the
// parse/validate helpers the store's sharding depends on.

import { describe, expect, it } from 'vitest';

import { ULID_LENGTH, createUlidGenerator, isUlid, parseUlidTimestamp } from './id.js';
import type { Clock } from './id.js';

const FIXED_MS = Date.UTC(2026, 6, 9, 12, 0, 0, 0); // 2026-07-09T12:00:00Z
const fixedClock: Clock = () => new Date(FIXED_MS);

describe('shape', () => {
  it('generates 26-char uppercase Crockford base32 ULIDs', () => {
    const next = createUlidGenerator(fixedClock);
    const id = next();
    expect(id).toHaveLength(ULID_LENGTH);
    expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(isUlid(id)).toBe(true);
  });

  it('validates and rejects malformed candidates', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('I'.repeat(26))).toBe(false); // excluded letter, and > max time
    expect(isUlid('0'.repeat(25))).toBe(false); // too short
    expect(isUlid('0'.repeat(27))).toBe(false); // too long
    expect(isUlid('8' + '0'.repeat(25))).toBe(false); // over the 48-bit time cap
    expect(isUlid('0'.repeat(26))).toBe(true);
    expect(() => parseUlidTimestamp('nope')).toThrow(RangeError);
  });
});

describe('sortability by construction', () => {
  it('later clock readings produce lexicographically greater IDs', () => {
    let t = FIXED_MS;
    const steppingClock: Clock = () => new Date(t);
    const next = createUlidGenerator(steppingClock);

    const minted: string[] = [];
    for (let i = 0; i < 200; i++) {
      minted.push(next());
      t += 7; // strictly advancing clock
    }
    const sorted = [...minted].sort();
    expect(sorted).toEqual(minted); // lexicographic order IS mint order
  });

  it('is monotonic within one instance even when the clock stands still', () => {
    const next = createUlidGenerator(fixedClock);
    const minted: string[] = [];
    for (let i = 0; i < 500; i++) minted.push(next());
    for (let i = 1; i < minted.length; i++) {
      expect(minted[i]! > minted[i - 1]!).toBe(true);
    }
  });
});

describe('collision safety with per-instance entropy', () => {
  it('two interleaved instances mint 10k IDs with zero collisions', () => {
    // Two store instances ("two contributors on two branches"), same frozen
    // clock — the worst case: only the 80-bit per-instance entropy separates
    // them. 10,000 interleaved mints must all be distinct.
    const a = createUlidGenerator(fixedClock);
    const b = createUlidGenerator(fixedClock);

    const seen = new Set<string>();
    for (let i = 0; i < 5_000; i++) {
      seen.add(a());
      seen.add(b());
    }
    expect(seen.size).toBe(10_000);
  });
});

describe('timestamp round trip', () => {
  it('decodes the injected clock time back out of the ID', () => {
    const next = createUlidGenerator(fixedClock);
    expect(parseUlidTimestamp(next()).getTime()).toBe(FIXED_MS);
  });

  it('round-trips arbitrary timestamps', () => {
    for (const ms of [0, 1, Date.UTC(1999, 11, 31), Date.UTC(2077, 0, 1, 23, 59, 59, 999)]) {
      const next = createUlidGenerator(() => new Date(ms));
      expect(parseUlidTimestamp(next()).getTime()).toBe(ms);
    }
  });
});

describe('append-only API surface', () => {
  it('exports no update/delete/rank/score verb', async () => {
    const mod = await import('./id.js');
    for (const name of Object.keys(mod)) {
      expect(name).not.toMatch(/update|delete|remove|rank|score/i);
    }
  });
});
