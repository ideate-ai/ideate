// plugin/tests/composition/readme-transcripts.test.ts — the README's worked
// examples, REPLAYED against the shipped CLIs.
//
// WHY this file exists: flag-set parity (src/cli/*-readme.test.ts) compares
// FLAG SETS, so it structurally cannot see an output-shape claim. The README
// showed `ideate-record read --scope <item-id> --json` returning a bare array
// long after the CLI started writing `{"records": […], "next_cursor": …}`, and
// anyone following it with `jq '.[]'` got nothing and read it as an empty
// record. This suite closes that one field over: it takes every `$ …`
// transcript out of the README, RUNS the same command against a scratch
// project root, and checks the documented output against what the CLI really
// emitted — keys at every depth, plus the values that are stable enough to
// assert (ids, timestamps and elided text are exempt; `"status":"open"` is
// not).
//
// The commands are not typed here. They are parsed out of the README, so
// editing a transcript changes what runs, and a transcript that documents a
// command the CLI cannot run fails on the spot.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const README = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
const DIST_DIR = join(PLUGIN_DIR, 'dist', 'cli');

/** The CLIs a README transcript may invoke, by the name it types. */
const BINS: Readonly<Record<string, string>> = {
  'ideate-work': join(PLUGIN_DIR, 'bin', 'ideate-work'),
  'ideate-record': join(PLUGIN_DIR, 'bin', 'ideate-record'),
};

interface Transcript {
  /** The command as the README types it (one logical line). */
  command: string;
  /** The output the README shows for it, verbatim ('' when it shows none). */
  documented: string;
}

interface Replay extends Transcript {
  /** What the shipped CLI actually wrote to stdout. */
  actual: string;
}

// ---------------------------------------------------------------------------
// Reading the transcripts out of the README
// ---------------------------------------------------------------------------

/** Every `$ command` + its shown output, in README order, from fenced blocks. */
function readmeTranscripts(): Transcript[] {
  const transcripts: Transcript[] = [];
  for (const block of [...README.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1] as string)) {
    const lines = block.split('\n');
    let current: Transcript | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      if (line.startsWith('$ ')) {
        let command = line.slice(2).trimEnd();
        while (command.endsWith('\\')) {
          i += 1;
          command = `${command.slice(0, -1).trimEnd()} ${(lines[i] ?? '').trim()}`;
        }
        current = { command, documented: '' };
        transcripts.push(current);
        continue;
      }
      // A shell comment or a blank line ends the output of the command above
      // it (the lifecycle trace narrates between steps).
      if (current === undefined || line.trim() === '' || line.trimStart().startsWith('#')) {
        current = undefined;
        continue;
      }
      current.documented = current.documented === '' ? line : `${current.documented}\n${line}`;
    }
  }
  return transcripts;
}

/** Split a command into argv, honouring double quotes. */
function tokenize(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => (m[1] ?? m[2]) as string);
}

// ---------------------------------------------------------------------------
// Comparing a documented output to a real one
// ---------------------------------------------------------------------------

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;
/** The elision mark the README uses for "…and the rest of the fields". */
const ELISION = '…';

/** Documented JSON, with its elisions removed so it parses. */
function parseDocumentedJson(text: string, command: string): unknown {
  const sanitized = text.replace(new RegExp(`,\\s*${ELISION}(?=\\s*[}\\]])`, 'g'), '');
  try {
    return JSON.parse(sanitized);
  } catch (err) {
    throw new Error(
      `README transcript for \`${command}\` is not JSON even after removing elisions ` +
        `(mark trimmed fields with \`,${ELISION}\` before the closing brace): ${(err as Error).message}`,
    );
  }
}

/** A documented scalar worth asserting: not an id, a wall-clock stamp, or elided text. */
function isCheckableScalar(value: unknown): boolean {
  if (typeof value !== 'string') return true; // numbers, booleans, null
  return !value.includes(ELISION) && !ULID.test(value) && !ISO.test(value);
}

/** Every key the README shows must exist in what the CLI emits, at every
 *  depth; every stable value it shows must be the value the CLI emits. */
function assertDocumentedShape(doc: unknown, actual: unknown, path: string): void {
  if (Array.isArray(doc)) {
    expect(Array.isArray(actual), `${path}: the README shows an array`).toBe(true);
    const rows = actual as unknown[];
    if (doc.length > 0) {
      expect(rows.length, `${path}: the README shows rows, the CLI emitted none`).toBeGreaterThan(0);
      assertDocumentedShape(doc[0], rows[0], `${path}[0]`);
    }
    return;
  }
  if (doc !== null && typeof doc === 'object') {
    expect(
      actual !== null && typeof actual === 'object' && !Array.isArray(actual),
      `${path}: the README shows an object, the CLI emitted ${JSON.stringify(actual)}`,
    ).toBe(true);
    const actualObject = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(doc)) {
      expect(Object.keys(actualObject), `${path}.${key}: documented key the CLI does not emit`).toContain(key);
      assertDocumentedShape(value, actualObject[key], `${path}.${key}`);
    }
    return;
  }
  if (isCheckableScalar(doc)) expect(actual, `${path}: documented value`).toEqual(doc);
}

/** A line-oriented output reduced to its FORMAT: ids, timestamps and quoted
 *  text stand in for themselves, everything else — including spacing — must
 *  match what the CLI writes. */
function skeleton(text: string): string {
  return text
    .replace(/"[^"]*"/g, '<Q>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<T>')
    .replace(new RegExp(`[0-9A-HJKMNP-TV-Z]{6,}${ELISION}|[0-9A-HJKMNP-TV-Z]{26}`, 'g'), '<ID>')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

let projectRoot: string;
const replays: Replay[] = [];

beforeAll(() => {
  if (!existsSync(join(DIST_DIR, 'ideate-work.js'))) {
    execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
  }
  // A scratch cwd = the project root the transcripts run against: the board
  // and the record dir are lazily created here, never in the repository.
  projectRoot = mkdtempSync(join(tmpdir(), 'ideate-readme-transcripts-'));

  // The transcripts are a TRACE: they run in README order and the later ones
  // address the item the earlier ones created.
  let lastItemId: string | undefined;
  for (const transcript of readmeTranscripts()) {
    const [program, ...rest] = tokenize(transcript.command);
    const bin = BINS[program as string];
    expect(bin, `README transcript invokes an unknown program: ${String(program)}`).toBeDefined();
    const argv = rest.map((token) => {
      // The README elides real ids (`01KXBQDD7P…`) and uses `<item-id>` as a
      // placeholder; both mean "the item this trace is about".
      if (!token.includes(ELISION) && token !== '<item-id>') return token;
      if (lastItemId === undefined) throw new Error(`transcript needs an item id before one was created: ${transcript.command}`);
      return lastItemId;
    });
    const actual = execFileSync(process.execPath, [bin as string, ...argv], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    replays.push({ ...transcript, actual });
    // Carry the created item's id forward for the transcripts that address it.
    try {
      const parsed = JSON.parse(actual) as { id?: unknown };
      if (typeof parsed.id === 'string' && ULID.test(parsed.id)) lastItemId = parsed.id;
    } catch {
      /* not a JSON output — nothing to carry */
    }
  }
}, 180_000);

afterAll(() => {
  if (projectRoot !== undefined) rmSync(projectRoot, { recursive: true, force: true });
});

describe("the README's worked examples match what the CLIs emit", () => {
  it('the README still carries worked transcripts to check', () => {
    expect(replays.length).toBeGreaterThan(0);
    for (const replay of replays) expect(replay.actual.length, `\`${replay.command}\` printed nothing`).toBeGreaterThan(0);
  });

  it('every documented output agrees with the shipped one', () => {
    let checked = 0;
    for (const { command, documented, actual } of replays) {
      if (documented === '') continue;
      checked += 1;
      const first = documented.trimStart()[0] as string;
      if (first === '{' || first === '[') {
        assertDocumentedShape(parseDocumentedJson(documented, command), JSON.parse(actual), `\`${command}\``);
      } else {
        expect(skeleton(documented), `\`${command}\`: documented output format`).toBe(skeleton(actual));
      }
    }
    expect(checked, 'no README transcript showed an output to check').toBeGreaterThan(0);
  });
});
