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
// shape). That check keys on the base64url CODEC — the thing no restatement of
// the property can avoid calling — rather than on the punctuation of one
// comparison, which a copy escapes by swapping its operands.

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

    // KEYED ON THE CODEC, not on the shape of one comparison. The property is
    // "decode a cursor, re-encode it, demand the input back", and NOTHING can
    // restate it — in either comparison direction, with either quote style,
    // under any variable names — without invoking node's base64url codec. So
    // the scan is for the codec CALL itself: every base64url decode and every
    // base64url re-encode in the package, which must all be in this one module.
    // A matcher shaped like `toString('base64url') !==` is escaped by writing
    // the operands the other way round, or by using double quotes; this one is
    // not, and it also catches a second DECODER that carries no guard at all —
    // the strictly worse copy.
    const BASE64URL_CODEC = /Buffer\.from\s*\([^)]*,\s*(['"])base64url\1\s*\)|\.toString\s*\(\s*(['"])base64url\2\s*\)/;
    // The guard itself, in EITHER direction and with either quote style, so
    // that deleting it from the one module is red too — the scan above proves
    // uniqueness, this proves existence.
    const ROUND_TRIP_COMPARISON =
      /\.toString\s*\(\s*(['"])base64url\1\s*\)\s*[!=]==|[!=]==\s*[\w$.]*\.toString\s*\(\s*(['"])base64url\2\s*\)/;
    // A comment can quote the codec while executing nothing (several seams'
    // headers explain the leniency this guard closes, and record/read-page.ts
    // and work-state/store.ts both spell `Buffer.from(…, 'base64url')` in
    // prose). Skip comment lines so the scan sees CODE.
    const isComment = (line: string): boolean => /^\s*(?:\/\/|\/?\*)/.test(line);

    const codecUsers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        const code = readFileSync(full, 'utf8').split('\n').filter((line) => !isComment(line));
        if (code.some((line) => BASE64URL_CODEC.test(line))) codecUsers.push(full);
      }
    };
    walk(srcRoot);

    // STRICT: a second copy anywhere is a door that can drift open.
    expect(codecUsers).toEqual([parserModule]);
    expect(readFileSync(parserModule, 'utf8')).toMatch(ROUND_TRIP_COMPARISON);
  });
});
