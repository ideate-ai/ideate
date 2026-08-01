// plugin/tests/composition/readme-verb-roster.test.ts — the README's MCP verb
// roster, bound to the SHIPPED registrars.
//
// WHY this file exists: two of the sixteen verbs were absent from the README
// entirely (`steering_read`, `steering_put`), and the install section still
// said the server "registers the three record MCP verbs … alongside the
// board verbs". Nothing could disagree with that prose, because the roster
// lived only in the prose.
//
// The answer is NOT typed here. It is derived by applying the composition
// root's own registrars (server.ts's `toolRegistrars`, the exact list
// `dist/server.js` boots with) to a recording stub and collecting the names
// they register — the same source tests/composition/server-boot.test.ts
// asserts against over a real stdio child. Add a verb and this suite fails
// until the README names it; name a verb the server does not register and it
// fails the other way.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { RECORD_TOOL_NAMES } from '../../src/record/tools.js';
import { registerTools } from '../../src/server.js';
import { STEERING_TOOL_NAMES } from '../../src/steering/tools.js';
import { WORK_STATE_TOOL_NAMES } from '../../src/work-state/tools.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const README = readFileSync(join(PLUGIN_DIR, 'README.md'), 'utf8');
const STEERING_TOOLS_SOURCE = readFileSync(join(PLUGIN_DIR, 'src', 'steering', 'tools.ts'), 'utf8');

/**
 * Backticked README spans that are SHAPED like an MCP verb but are not one.
 * Deliberately NOT a verb roster — it is the set of identifiers that share a
 * verb's prefix and shape while naming something else, so the reverse check
 * below can be exhaustive without flagging them.
 */
const NOT_VERBS: ReadonlySet<string> = new Set([
  'work_claims', // a telemetry counter, not a tool
]);

/** Number words, for the counted prose claims ("eleven board verbs"). */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen', 'twenty',
] as const;

function word(count: number): string {
  const w = NUMBER_WORDS[count];
  if (w === undefined) throw new Error(`no number word for ${String(count)} — extend NUMBER_WORDS`);
  return w;
}

/** Every tool name the composition root's registrars actually register. */
function shippedVerbNames(): string[] {
  const names: string[] = [];
  const recorder = {
    registerTool: (name: string): void => {
      names.push(name);
    },
  } as unknown as McpServer;
  registerTools(recorder); // default registrars = server.ts's composition root
  return names.sort();
}

/** Every distinct backticked span in the README that is shaped like a verb.
 *  Fenced blocks are dropped first (their fences would re-pair the inline
 *  backticks around them), and a span may not cross a line, so this reads the
 *  README's PROSE roster — where an integrator actually meets the verbs. */
function verbLikeSpansInReadme(): string[] {
  const prose = README.replace(/```[\s\S]*?```/g, '');
  const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => (m[1] as string).split('(')[0] as string);
  return [...new Set(spans.filter((s) => /^(record|work|steering)_[a-z_]+$/.test(s)))].sort();
}

describe("the README's MCP verb roster matches the shipped registrars", () => {
  const shipped = shippedVerbNames();

  it('the per-seam name arrays are the shipped surface (nothing registered outside them)', () => {
    // Binds the three exported rosters — which the README section headings
    // are counted against below — to what the registrars really do.
    expect(shipped).toEqual(
      [...RECORD_TOOL_NAMES, ...WORK_STATE_TOOL_NAMES, ...STEERING_TOOL_NAMES].sort(),
    );
  });

  it('every shipped verb is named in the README', () => {
    const documented = new Set(verbLikeSpansInReadme());
    const missing = shipped.filter((name) => !documented.has(name));
    expect(missing, `README never names: ${missing.join(', ')}`).toEqual([]);
  });

  it('every verb-shaped name in the README is a shipped verb', () => {
    const shippedSet = new Set<string>(shipped);
    const phantom = verbLikeSpansInReadme().filter((s) => !shippedSet.has(s) && !NOT_VERBS.has(s));
    expect(phantom, `README names verbs the server does not register: ${phantom.join(', ')}`).toEqual([]);
  });

  it('the counted claims in the prose match the shipped counts', () => {
    const claims: [string, number][] = [
      ['MCP verbs', shipped.length],
      ['record verbs', RECORD_TOOL_NAMES.length],
      ['board verbs', WORK_STATE_TOOL_NAMES.length],
      ['steering verbs', STEERING_TOOL_NAMES.length],
    ];
    for (const [label, count] of claims) {
      const phrase = `${word(count)} ${label}`.toLowerCase();
      expect(README.toLowerCase(), `README never says "${phrase}"`).toContain(phrase);
    }
  });

  it("steering's GATED behaviour is documented with the code the verbs actually return", () => {
    // The failure code is read out of steering/tools.ts's own gated marker, so
    // renaming it there fails here rather than silently orphaning the README.
    const code = /code: '([A-Z]+)'/.exec(STEERING_TOOLS_SOURCE)?.[1];
    expect(code).toBe('GATED');
    expect(README).toContain(`"code":"${code as string}"`);
    // …and the flag that opens the gate, read off the same source.
    expect(STEERING_TOOLS_SOURCE).toContain("['steering']");
    expect(README).toContain('steering.enabled');
  });
});
