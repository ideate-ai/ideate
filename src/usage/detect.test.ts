// plugin/src/usage/detect.test.ts — tests for the mechanical citation
// detector. Pins the token-boundary rule that keeps a delivered id from being
// "cited" by a longer, different id, and the determinism/stability guarantees.

import { describe, expect, it } from 'vitest';

import { containsToken, detectCitedIds } from './detect.js';

describe('containsToken — alphanumeric-boundary matching', () => {
  it('matches an id flanked by whitespace / punctuation / string edges', () => {
    expect(containsToken('as decided, see T-381.', 'T-381')).toBe(true);
    expect(containsToken('T-381', 'T-381')).toBe(true);
    expect(containsToken('(T-381)', 'T-381')).toBe(true);
    expect(containsToken('prefix\nT-381\nsuffix', 'T-381')).toBe(true);
  });

  it('does NOT match a prefix of a longer id (T-38 inside T-381)', () => {
    expect(containsToken('resolved by T-381', 'T-38')).toBe(false);
  });

  it('does NOT match when a trailing alphanumeric extends the id (T-381 vs T-3812)', () => {
    expect(containsToken('see T-3812 for detail', 'T-381')).toBe(false);
  });

  it('matches a ULID token bounded by non-alphanumerics', () => {
    const ulid = '01KXKEGNSAK4MCZA3GER8NNS21';
    expect(containsToken(`used ${ulid} here`, ulid)).toBe(true);
    expect(containsToken(`used ${ulid}X here`, ulid)).toBe(false);
  });

  it('returns false for an empty token or an absent token', () => {
    expect(containsToken('anything', '')).toBe(false);
    expect(containsToken('no ids here', 'T-999')).toBe(false);
  });
});

describe('detectCitedIds — mechanical, stable, deduped', () => {
  it('returns exactly the delivered ids present in the text', () => {
    const text = 'I relied on T-381 and policy P-12, but not the others.';
    expect(detectCitedIds(text, ['T-381', 'T-380', 'P-12', 'P-120'])).toEqual(['T-381', 'P-12']);
  });

  it('preserves candidate order and de-duplicates', () => {
    const text = 'T-2 then T-1 then T-2 again';
    expect(detectCitedIds(text, ['T-1', 'T-2', 'T-2'])).toEqual(['T-1', 'T-2']);
  });

  it('is deterministic: same inputs, same output (GP-24)', () => {
    const text = 'cites T-7, GP-24, and record 01KXKEGVPX65FSRWVCHS9QZYCX';
    const delivered = ['T-7', 'GP-24', '01KXKEGVPX65FSRWVCHS9QZYCX', 'T-70'];
    const first = detectCitedIds(text, delivered);
    const second = detectCitedIds(text, delivered);
    expect(first).toEqual(second);
    expect(first).toEqual(['T-7', 'GP-24', '01KXKEGVPX65FSRWVCHS9QZYCX']);
  });

  it('returns [] when nothing delivered was cited', () => {
    expect(detectCitedIds('a task with no citations', ['T-1', 'T-2'])).toEqual([]);
  });
});
