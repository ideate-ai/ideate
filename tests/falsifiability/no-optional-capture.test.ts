// plugin/tests/falsifiability/no-optional-capture.test.ts — WI-276 source-
// inspection suite: the grep-falsifiability standard, executed as tests.
//
// Spec: docs/spikes/v3-boundary-contract.md §2 — for every capture point the
// record-write call sits UNCONDITIONALLY inside the state transition; no
// capture is reachable only via an optional call. docs/design/
// v3-composable-surface.md §2.1/§2.2 — the check is grep-shaped by design:
// an implementation review greps each Tier-A handler for the append call and
// finds it unguarded.
//
// These tests read the .ts sources AS TEXT at test time (paths resolved
// relative to this file) and fail the build on drift:
//   1. tools.ts's shared write path (`writeRecord`) contains the single
//      `.append(` call site, and nothing conditions it — no `if`, and the
//      call IS the return expression.
//   2. No optionality vocabulary (skip/disable/enabled/dryRun/optOut/…)
//      exists anywhere in tools.ts code.
//   3. Both write verbs (record_append, record_decision) route through the
//      one shared `writeRecord`; record_read touches neither.
//   4. scan.ts's ScanOptions declares EXACTLY the two documented keys
//      (onRedaction, entropyThreshold) — no skip/disable key can appear
//      without failing this suite (source-text complement to the type-level
//      pin in scan.test.ts).
//
// Each structural check is implemented as a pure function over source text,
// and every check is ALSO exercised against a deliberately-broken in-memory
// mutant of the real source, proving the check actually fails on drift
// (the acceptance criterion: "verify by temporarily breaking a copy
// in-memory").

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TOOLS_TS = fileURLToPath(new URL('../../src/record/tools.ts', import.meta.url));
const SCAN_TS = fileURLToPath(new URL('../../src/secret-gate/scan.ts', import.meta.url));

const toolsSource = readFileSync(TOOLS_TS, 'utf8');
const scanSource = readFileSync(SCAN_TS, 'utf8');

// ---------------------------------------------------------------------------
// Source-analysis helpers (pure text functions — testable against mutants)
// ---------------------------------------------------------------------------

/** Strip block and line comments. The sources under test carry no `//` or
 * `/*` inside string literals (asserted implicitly: the structural checks
 * below would fail loudly if stripping ever ate live code). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Extract a `{...}` block: finds `marker`, then brace-matches from the first
 * `{` at/after it. Naive counter — valid for these sources, whose string and
 * template literals carry only balanced braces.
 */
function extractBlock(source: string, marker: string): string {
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`source drift: marker not found: ${marker}`);
  const open = source.indexOf('{', at);
  if (open === -1) throw new Error(`source drift: no block opens after marker: ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`source drift: unbalanced braces after marker: ${marker}`);
}

/** All indices of `needle` occurrences in `haystack`. */
function indicesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/** The optionality vocabulary no capture path may mention (boundary §2). */
const OPTIONALITY = /\b(skip|skipped|disable|disabled|enable|enabled|dry[_-]?run|dryrun|opt[_-]?out|optout|no[_-]?capture)\b/i;

interface WritePathAnalysis {
  /** `.append(` call-site count in comment-stripped code. Must be exactly 1. */
  appendCallSites: number;
  /** The single call site sits inside writeRecord's body. */
  appendInsideWriteRecord: boolean;
  /** writeRecord's body contains an `if (`. Must be false. */
  writeRecordHasIf: boolean;
  /** The append call IS the unconditional return expression. */
  appendIsReturnExpression: boolean;
  /** First optionality-vocabulary hit anywhere in the code, or null. */
  optionalityHit: string | null;
}

/** Structural analysis of tools.ts's shared write path. */
function analyzeWritePath(source: string): WritePathAnalysis {
  const code = stripComments(source);
  const body = extractBlock(code, 'function writeRecord(');
  const sites = indicesOf(code, '.append(');
  const bodyStart = code.indexOf(body);
  const match = OPTIONALITY.exec(code);
  return {
    appendCallSites: sites.length,
    appendInsideWriteRecord: sites.every((i) => i > bodyStart && i < bodyStart + body.length),
    writeRecordHasIf: /\bif\s*\(/.test(body),
    appendIsReturnExpression: /^\s*return\s+ctx\.store\.append\(/.test(body),
    optionalityHit: match === null ? null : match[0],
  };
}

/** Split tools.ts into per-verb registration segments, keyed by tool name. */
function registrationSegments(source: string): Map<string, string> {
  const code = stripComments(source);
  const parts = code.split('server.registerTool(');
  const out = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const name = /^\s*'([\w-]+)'/.exec(part)?.[1];
    if (name !== undefined) out.set(name, part);
  }
  return out;
}

/** Declared property keys of an exported interface, in order. */
function interfaceKeys(source: string, interfaceName: string): string[] {
  const block = stripComments(extractBlock(source, `export interface ${interfaceName}`));
  return [...block.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// 1. The shared write path: one unconditional `.append(` call site
// ---------------------------------------------------------------------------

describe('tools.ts: the capture write is unconditional (boundary contract §2, surface §2.1)', () => {
  const analysis = analyzeWritePath(toolsSource);

  it('has exactly one `.append(` call site in the whole module — no second write path', () => {
    expect(analysis.appendCallSites).toBe(1);
  });

  it('the single call site lives inside writeRecord, the shared write path', () => {
    expect(analysis.appendInsideWriteRecord).toBe(true);
  });

  it('no `if` guards anything in writeRecord — the body is branch-free', () => {
    expect(analysis.writeRecordHasIf).toBe(false);
  });

  it('the append call IS the return expression: `return ctx.store.append(...)`', () => {
    expect(analysis.appendIsReturnExpression).toBe(true);
  });

  it('no optionality vocabulary (skip/disable/enabled/dryRun/optOut/noCapture) exists in the code', () => {
    expect(analysis.optionalityHit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Both write verbs route through the one shared function
// ---------------------------------------------------------------------------

describe('tools.ts: both write verbs share the single writeRecord path (§2 row 4)', () => {
  const segments = registrationSegments(toolsSource);

  it('registers exactly the three ratified verbs', () => {
    expect([...segments.keys()].sort()).toEqual(['record_append', 'record_decision', 'record_read']);
  });

  it('record_append calls writeRecord', () => {
    expect(segments.get('record_append')).toContain('writeRecord(');
  });

  it('record_decision calls writeRecord — the sugar is the same code path', () => {
    expect(segments.get('record_decision')).toContain('writeRecord(');
  });

  it('record_read (up to the next registration) never writes: no writeRecord, no .append(', () => {
    // The record_read segment ends where record_decision's registration
    // begins, so this asserts the READ verb's own handler is write-free.
    const readSegment = segments.get('record_read') ?? '';
    const upToNext = readSegment.split('record_decision')[0] ?? readSegment;
    expect(upToNext).not.toContain('writeRecord(');
    expect(upToNext).not.toContain('.append(');
  });

  it('writeRecord is invoked from exactly two call sites (the two write verbs)', () => {
    const code = stripComments(toolsSource);
    // `writeRecord(ctx,` matches only CALL sites — the definition's parameter
    // list reads `(ctx: ToolContext`, comma-free after `ctx`.
    const calls = indicesOf(code, 'writeRecord(ctx,');
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. scan.ts admits no skip: ScanOptions is exactly the two documented keys
// ---------------------------------------------------------------------------

describe('scan.ts: ScanOptions declares exactly the two documented keys (amendment I: no exempt path)', () => {
  it('the declared keys are exactly onRedaction and entropyThreshold', () => {
    expect(interfaceKeys(scanSource, 'ScanOptions').sort()).toEqual(['entropyThreshold', 'onRedaction']);
  });

  it('scan.ts code carries no enable/disable/skip vocabulary', () => {
    // The gate itself must admit no off switch, in any spelling.
    expect(OPTIONALITY.exec(stripComments(scanSource))?.[0] ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Falsifiability of the checks themselves: they FAIL on broken mutants
// ---------------------------------------------------------------------------

describe('the checks fail on drift (in-memory mutants of the real source)', () => {
  it('detects an if-guard smuggled around the append call', () => {
    const mutant = toolsSource.replace(
      'return ctx.store.append({',
      'if ((params as { dryRun?: boolean }).dryRun !== true) return ctx.store.append({',
    );
    expect(mutant).not.toBe(toolsSource); // the mutation actually applied
    const analysis = analyzeWritePath(mutant);
    // The mutant trips MULTIPLE tripwires — belt and suspenders.
    expect(analysis.writeRecordHasIf).toBe(true);
    expect(analysis.appendIsReturnExpression).toBe(false);
    expect(analysis.optionalityHit).not.toBeNull();
  });

  it('detects a second .append( call site (a bypass write path)', () => {
    const mutant = toolsSource.replace(
      'function composeDecisionContent',
      'function sideDoor(ctx: ToolContext): void { ctx.store.append(undefined as never); }\nfunction composeDecisionContent',
    );
    expect(mutant).not.toBe(toolsSource);
    expect(analyzeWritePath(mutant).appendCallSites).toBe(2);
  });

  it('detects a skip key grafted onto ScanOptions', () => {
    const mutant = scanSource.replace(
      'export interface ScanOptions {',
      'export interface ScanOptions {\n  disabled?: boolean;',
    );
    expect(mutant).not.toBe(scanSource);
    // Both tripwires fire: the exact-keys pin AND the vocabulary sweep.
    expect(interfaceKeys(mutant, 'ScanOptions')).toHaveLength(3);
    expect(OPTIONALITY.exec(stripComments(mutant))?.[0] ?? null).not.toBeNull();
  });
});
