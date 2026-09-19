// plugin/src/cli/stdin-arg.test.ts — falsification tests for the shared
// stdin convention (P-41: these guard the PROPERTY the module claims, built
// from fixtures independent of the implementation, not a spelling check).

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  MultipleStdinRequestsError,
  assertAtMostOneStdinRequest,
  isStdinSentinel,
  readAllStdin,
  resolveStdinArg,
  stdinUsageNote,
} from './stdin-arg.js';

describe('isStdinSentinel', () => {
  it('is true for exactly "-" and false for everything else, including near-misses', () => {
    expect(isStdinSentinel('-')).toBe(true);
    expect(isStdinSentinel('--')).toBe(false);
    expect(isStdinSentinel(' -')).toBe(false);
    expect(isStdinSentinel('- ')).toBe(false);
    expect(isStdinSentinel('')).toBe(false);
    expect(isStdinSentinel(undefined)).toBe(false);
  });
});

describe('resolveStdinArg — the property under guard: "-" means read stdin, nothing else does', () => {
  it('an undefined raw value (flag not passed) stays undefined and never touches stdin', async () => {
    let called = false;
    const result = await resolveStdinArg(undefined, async () => {
      called = true;
      return 'should never be read';
    });
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  it('the literal sentinel "-" resolves to the WHOLE of readStdin(), not the string "-" itself', async () => {
    const body = 'a multi-line body\nwith more than one line\nand a trailing sentence.';
    const result = await resolveStdinArg('-', async () => body);
    expect(result).toBe(body);
    expect(result).not.toBe('-');
  });

  it('ANY other value — including single characters that merely resemble the sentinel — passes through untouched', async () => {
    let called = false;
    const readStdin = async () => {
      called = true;
      return 'STDIN CONTENT';
    };
    expect(await resolveStdinArg('a real spec body', readStdin)).toBe('a real spec body');
    expect(await resolveStdinArg('', readStdin)).toBe('');
    expect(await resolveStdinArg('--', readStdin)).toBe('--');
    expect(called).toBe(false);
  });

  it('the exact reproduction: a large stdin body survives resolution intact (finding 01M2MKGS5PRV7WSD0W4ZQYAG4A)', async () => {
    // Built independently of any call site — the fixture is just "a spec a
    // real coordinator might pipe in", not a copy of production data.
    const largeSpec = Array.from({ length: 4948 }, (_, i) => String(i % 10)).join('');
    const resolved = await resolveStdinArg('-', async () => largeSpec);
    expect(resolved).toHaveLength(4948);
    expect(resolved).toBe(largeSpec);
  });
});

describe('readAllStdin', () => {
  it('drains a real stream to its full text, preserving embedded newlines', async () => {
    const stream = Readable.from(['first chunk\n', 'second chunk\n', 'third']);
    const result = await readAllStdin(stream as NodeJS.ReadableStream & { isTTY?: boolean });
    expect(result).toBe('first chunk\nsecond chunk\nthird');
  });

  it('a TTY stream reads as empty rather than hanging', async () => {
    const stream = Readable.from([]) as NodeJS.ReadableStream & { isTTY?: boolean };
    stream.isTTY = true;
    const result = await readAllStdin(stream);
    expect(result).toBe('');
  });
});

describe('assertAtMostOneStdinRequest — stdin is one stream, so at most one flag may claim it', () => {
  it('throws MultipleStdinRequestsError naming both flags when two request the sentinel', () => {
    const values = new Map([
      ['--claim', '-'],
      ['--content', '-'],
    ]);
    expect(() => assertAtMostOneStdinRequest(values, ['--claim', '--content'])).toThrow(MultipleStdinRequestsError);
    try {
      assertAtMostOneStdinRequest(values, ['--claim', '--content']);
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MultipleStdinRequestsError);
      expect((err as Error).message).toContain('--claim');
      expect((err as Error).message).toContain('--content');
    }
  });

  it('does not fire when only one of the candidate flags requests stdin', () => {
    expect(() =>
      assertAtMostOneStdinRequest(
        new Map([
          ['--claim', '-'],
          ['--content', 'ordinary text'],
        ]),
        ['--claim', '--content'],
      ),
    ).not.toThrow();
  });

  it('does not fire when neither candidate flag requests stdin', () => {
    expect(() =>
      assertAtMostOneStdinRequest(
        new Map([
          ['--claim', 'ordinary claim'],
          ['--content', 'ordinary content'],
        ]),
        ['--claim', '--content'],
      ),
    ).not.toThrow();
  });

  it('does not cry wolf on a flag outside the candidate set, even if it happens to be "-"', () => {
    // A flag never registered as stdin-capable is not this guard's business —
    // its OWN resolution path (if it has none) will treat "-" literally.
    expect(() =>
      assertAtMostOneStdinRequest(
        new Map([
          ['--claim', '-'],
          ['--unrelated-flag', '-'],
        ]),
        ['--claim', '--content'],
      ),
    ).not.toThrow();
  });
});

describe('stdinUsageNote — one template, so both binaries phrase the convention identically', () => {
  it('names the flag, the sentinel, and both "reads" and "from stdin"', () => {
    const note = stdinUsageNote('--spec', 'the spec body');
    expect(note).toContain('--spec -');
    expect(note).toMatch(/reads/);
    expect(note).toMatch(/from stdin/);
    expect(note).toContain('the spec body');
  });

  it('is a pure function: the same inputs always produce the same sentence', () => {
    expect(stdinUsageNote('--note', 'the note')).toBe(stdinUsageNote('--note', 'the note'));
  });
});
