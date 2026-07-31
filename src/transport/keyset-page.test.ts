// plugin/src/transport/keyset-page.test.ts — acceptance tests for the neutral
// page envelope: the cursor ENCODERS and the one mechanical cursor PARSER.
//
// Pins the guard that is easy to believe and easy to get wrong:
// `Buffer.from(x, 'base64url')` is LENIENT — it accepts padded input,
// characters outside the alphabet, a short final group and a non-canonical
// tail, decoding each to *something*. Without a canonical round-trip check a
// malformed cursor decodes to a plausible boundary and selects nothing, and an
// empty page reads to a caller as "the store ended" — silent truncation, which
// is the exact failure paging exists to prevent. Each of those four shapes is
// exercised here against the real Node decoder, not asserted in prose.
//
// …and mechanically: that guard is written ONCE package-wide. Every seam's
// decoder (work-state's `decodeListCursor`, steering's
// `decodeSteeringCursor`, the record's) is a shape check plus its own typed
// error over this parser, so the four lenient shapes cannot be closed in one
// door and left open in another (GP-24: a grep-falsifiable promise about code
// shape).

import { readFileSync, readdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { encodeIdCursor, encodeListCursor, parseListCursorPayload } from './keyset-page.js';

describe('cursor encoding and the one mechanical parser', () => {
  it('round-trips both cursor shapes: what an encoder mints, the parser reads back exactly', () => {
    const pair = encodeListCursor('2026-07-16T12:00:00.000Z', 'GP-21');
    expect(parseListCursorPayload(pair)).toEqual({ ok: true, value: ['2026-07-16T12:00:00.000Z', 'GP-21'] });

    const single = encodeIdCursor('01JZM8Z0000000000000000000');
    expect(parseListCursorPayload(single)).toEqual({ ok: true, value: ['01JZM8Z0000000000000000000'] });

    // Content that would break a delimiter-concatenated cursor survives intact.
    const hostile = encodeListCursor('2026-07-16T12:00:00.000Z|":,]', 'GP-21');
    expect(parseListCursorPayload(hostile)).toEqual({ ok: true, value: ['2026-07-16T12:00:00.000Z|":,]', 'GP-21'] });
  });

  it('rejects every shape node’s base64url decoder is LENIENT about — the canonical round-trip guard', () => {
    const valid = encodeListCursor('2026-07-16T12:00:00.000Z', 'GP-21');
    // A tuple whose base64 form really does carry `=` padding (base64url never
    // does) — asserted, so the fixture cannot silently stop being padded.
    const paddedForm = Buffer.from(JSON.stringify(['2026-07-16T12:00:00.000Z', 'GP-211']), 'utf8').toString('base64');
    expect(paddedForm.endsWith('=')).toBe(true);

    const lenient: Array<[string, string]> = [
      // 1. PADDED: base64 (not -url) padding is silently accepted by the decoder.
      ['padded (base64 form)', paddedForm],
      ['padded (a cursor with padding appended)', `${valid}=`],
      // 2. WRONG ALPHABET: characters outside base64url are silently dropped.
      ['wrong alphabet', `${valid.slice(0, 8)}!!${valid.slice(8)}`],
      // 3. SHORT FINAL GROUP: a trailing group with too few characters.
      ['short final group', 'AAAAA'],
      // 4. NON-CANONICAL TAIL: bits past the last whole byte, which re-encode
      //    to a DIFFERENT string ('QR' decodes to the same byte as 'QQ').
      ['non-canonical tail', 'QR'],
    ];
    for (const [why, cursor] of lenient) {
      // The leniency is real, not hypothetical: each of these DOES decode.
      expect(Buffer.from(cursor, 'base64url').length, why).toBeGreaterThan(0);
      expect(parseListCursorPayload(cursor), why).toEqual({ ok: false, problem: 'not-canonical-base64url' });
    }
  });

  it('separates "not canonical base64url" from "not JSON", and never throws', () => {
    expect(parseListCursorPayload(Buffer.from('nonsense bytes', 'utf8').toString('base64url'))).toEqual({ ok: false, problem: 'not-json' });
    expect(parseListCursorPayload('')).toEqual({ ok: false, problem: 'not-json' });
    // Well-formed ENCODING, wrong VALUE: the parser passes it through — the
    // seam owns the shape check, because only it knows its own boundary tuple.
    for (const value of [[], {}, ['a', 'b', 'c'], [1, 2], 'plain'] as const) {
      const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
      expect(parseListCursorPayload(encoded)).toEqual({ ok: true, value });
    }
  });

  it('the canonical round-trip guard is written exactly ONCE package-wide (every seam decodes through it)', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const parserModule = join(srcRoot, 'transport', 'keyset-page.ts');
    // The guard IS this comparison: decode, re-encode, demand the input back.
    const ROUND_TRIP_GUARD = /toString\('base64url'\)\s*!==/;

    const guards: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        if (ROUND_TRIP_GUARD.test(readFileSync(full, 'utf8'))) guards.push(full);
      }
    };
    walk(srcRoot);

    // STRICT: a second copy anywhere is a door that can drift open.
    expect(guards).toEqual([parserModule]);
  });
});
