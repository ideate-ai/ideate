// plugin/src/transport/payload-budget.test.ts — acceptance tests for the
// shared payload budget every bounded read enforces.
//
// Pins: the per-item measures match what each transport ACTUALLY writes
// (compact for MCP, 2-space-indented for the CLI's `list --json`); the budget
// is a bound on real output that still walks every row exactly once and never
// drops an oversized row (LIVENESS); and — mechanically — the constant and
// both implementations are defined in EXACTLY ONE file package-wide, no SECOND
// budget-sized number is declared anywhere, and the files that IMPORT this
// module are exactly the ones listed below. That last test is the guard that
// keeps the budget from quietly forking into two divergent copies (GP-24:
// grep-falsifiable promises about code shape), which is the failure mode the
// module exists to prevent.
//
// It keys on the IMPORT PATH and on the SIZE of a declared number, never on
// this module's symbol SPELLINGS. A matcher spelled out of the symbols it
// happens to remember is blind twice over: it misses the files that use the
// symbol it forgot (`fitToListPayloadBudget`, the door record/read-page.ts
// goes through), and it misses a fork outright, because a fork picks its OWN
// names — a planted `STEERING_PAYLOAD_BUDGET = 30_000` beside a hand-copied
// prefix loop is exactly the drift this file exists to catch and exactly
// what a symbol-name matcher cannot see.
//
// Lives beside the module rather than in any store's test file: the budget
// belongs to no seam (see payload-budget.ts's header), so neither the board's
// nor the record's test file is its home.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  LIST_PAYLOAD_BUDGET_CHARS,
  applyListPayloadBudget,
  measureCompactItemChars,
  measurePrettyItemChars,
} from './payload-budget.js';

/**
 * Every file PERMITTED to import the budget module, and the per-item measure
 * each one names. This list is the ONE thing a new bounded read extends — add
 * a row (record_read, steering_read) and the drift test below keeps working
 * unchanged. What it may NOT do is grow a second DEFINITION or a second
 * budget-sized NUMBER: those halves of the test take no list and admit no
 * exceptions.
 *
 * `measure` is the symbol the file must name. A transport that WRITES bytes
 * names the concrete measure matching its own writer (compact vs pretty); a
 * shared page-shaper that writes nothing names the `ListItemMeasure` type,
 * because it takes its caller's measure and forwards it rather than choosing
 * one. Either way the row states, checkably, which side of that split the file
 * is on — the one thing the doors deliberately do NOT share.
 */
const PERMITTED_IMPORTERS: readonly { readonly segments: readonly string[]; readonly measure: string }[] = [
  // The MCP `work_list` tool — the SDK writes a tool result compactly.
  { segments: ['work-state', 'tools.ts'], measure: 'measureCompactItemChars' },
  // The `ideate-work list --json` CLI — pretty-prints at 2-space indent.
  { segments: ['cli', 'ideate-work.ts'], measure: 'measurePrettyItemChars' },
  // The MCP `steering_read` tool — same compact tool-result writer as the
  // board's, over a page keyed on `updated_at` rather than `created_at`.
  { segments: ['steering', 'tools.ts'], measure: 'measureCompactItemChars' },
  // The MCP `record_read` tool — likewise a compactly-written tool result.
  { segments: ['record', 'tools.ts'], measure: 'measureCompactItemChars' },
  // The `ideate-record read --json` CLI — likewise 2-space indented.
  { segments: ['cli', 'ideate-record.ts'], measure: 'measurePrettyItemChars' },
  // The process record's shared page-shaper (`boundRecordPage`), which BOTH
  // record transports go through. It reaches the budget by way of
  // `fitToListPayloadBudget` — the prefix rule without the cursor re-mint,
  // because the record's cursor is an id alone — and takes its caller's
  // measure rather than writing bytes itself.
  { segments: ['record', 'read-page.ts'], measure: 'ListItemMeasure' },
];

/**
 * A file REACHES FOR the budget iff it IMPORTS THE MODULE — which is the
 * property this test is actually about, and the reason it is not keyed on any
 * symbol NAME. Value imports, `import type` imports and re-exports all trip it,
 * whatever is inside the braces, so a transport that reaches through
 * `fitToListPayloadBudget` is as visible as one that reaches through
 * `applyListPayloadBudget`. Either quote style matches; the specifier itself is
 * the thing a reach cannot be spelled without.
 */
const IMPORTS_BUDGET_MODULE = /\bfrom\s*(['"])[^'"]*transport\/payload-budget\.js\1/;

/** The floor at which a bare number in this package is a PAYLOAD bound rather
 *  than a count, a timeout or a page size (the largest of those is
 *  work-state/schema.ts's `BUSY_TIMEOUT_MS = 5000`). Anything at or above it is
 *  budget-class and must be THE budget. */
const BUDGET_CLASS_MIN = 10_000;

/** Any declaration binding a bare numeric literal, whatever it is called. A
 *  fork picks its own name — the demonstrated one was
 *  `STEERING_PAYLOAD_BUDGET = 30_000` — but it cannot avoid writing down a
 *  number of this SIZE, so the size is what the scan keys on. Global: a file
 *  may declare many. */
const NUMERIC_DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(\d[\d_]*)\b/g;

/** The ONLY budget-class number this package may declare. A genuinely
 *  unrelated large constant is added here WITH its reason, which is the point:
 *  landing a second one is a decision someone states out loud. */
const PERMITTED_BUDGET_CLASS_NUMBERS: readonly { readonly segments: readonly string[]; readonly name: string }[] = [
  { segments: ['transport', 'payload-budget.ts'], name: 'LIST_PAYLOAD_BUDGET_CHARS' },
];

describe('list payload budget — ONE budget and ONE implementation, shared by every bounded read', () => {
  /** A summary-shaped row: only `id`/`created_at` are load-bearing for the
   *  budget helper, the rest is realistic bulk. */
  function row(n: number, spec: string): { id: string; created_at: string; title: string; status: string; spec: string } {
    return { id: `id-${String(n)}`, created_at: `2026-07-11T12:00:${String(n).padStart(2, '0')}.000Z`, title: `item ${String(n)}`, status: 'open', spec };
  }

  it('measurePrettyItemChars measures what the CLI actually WRITES (the indented envelope), not the compact form the MCP path writes', () => {
    const items = [row(1, 'x'.repeat(50)), row(2, 'y'.repeat(80)), row(3, 'z')];
    // Exactly what cli/ideate-work.ts's `list --json` emits, and the same
    // envelope with NO rows — the difference between the two is the items
    // region the measure is supposed to be counting.
    const emitted = JSON.stringify({ items, next_cursor: 'CURSOR' }, null, 2);
    const framing = JSON.stringify({ items: [], next_cursor: 'CURSOR' }, null, 2);
    const region = emitted.length - framing.length;

    const pretty = items.reduce((total, item) => total + measurePrettyItemChars(item), 0);
    const compact = items.reduce((total, item) => total + measureCompactItemChars(item), 0);

    // The pretty measure never UNDER-counts the region (that is what makes it
    // a bound on real output) and over-counts by only a few characters per
    // page — the last row's separator, which it charges but never pays, and
    // the array's own two line breaks.
    expect(pretty).toBeLessThanOrEqual(region);
    expect(pretty).toBeGreaterThanOrEqual(region - 6);
    // …whereas the compact measure — correct for the MCP transport, whose SDK
    // writes `JSON.stringify(body)` with no indent — under-counts this stream
    // badly. Budgeting the compact form here would let the CLI write far more
    // than the budget allows, which is the whole reason the measure is
    // injected rather than hard-coded.
    expect(compact).toBeLessThan(pretty * 0.8);
  });

  it('the budget is a bound on real output: a walk of budget-closed pages covers every row exactly once, and an oversized row still ships ALONE', () => {
    // Each row is ~1/8 of the budget under the pretty measure, so a page
    // closes well before the 12 rows are exhausted.
    const fat = Array.from({ length: 12 }, (_, i) => row(i, 'x'.repeat(4_000)));
    const seen: string[] = [];
    let remaining = fat;
    for (;;) {
      const page = applyListPayloadBudget({ items: remaining, next_cursor: remaining.length > 0 ? 'raw' : null }, measurePrettyItemChars);
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.reduce((t, i) => t + measurePrettyItemChars(i), 0)).toBeLessThanOrEqual(LIST_PAYLOAD_BUDGET_CHARS);
      seen.push(...page.items.map((i) => i.id));
      remaining = remaining.slice(page.items.length);
      if (remaining.length === 0) break;
      expect(page.next_cursor).toBeTypeOf('string');
    }
    expect(seen).toEqual(fat.map((i) => i.id));
    expect(new Set(seen).size).toBe(fat.length);

    // LIVENESS: a row larger than the WHOLE budget is returned alone with a
    // cursor — never dropped, never an empty page that stalls the walk.
    const oversized = applyListPayloadBudget(
      { items: [row(99, 'x'.repeat(LIST_PAYLOAD_BUDGET_CHARS * 2)), row(100, 'small')], next_cursor: null },
      measurePrettyItemChars,
    );
    expect(oversized.items.map((i) => i.id)).toEqual(['id-99']);
    expect(oversized.next_cursor).toBeTypeOf('string');
  });

  it('the budget is DEFINED exactly once package-wide, no SECOND budget-sized number is declared anywhere, and exactly the permitted files import the module', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const budgetModule = join(srcRoot, 'transport', 'payload-budget.ts');
    const permitted = PERMITTED_IMPORTERS.map((t) => ({ path: join(srcRoot, ...t.segments), measure: t.measure }));
    const permittedNumbers = PERMITTED_BUDGET_CLASS_NUMBERS.map((n) => `${join(srcRoot, ...n.segments)}:${n.name}`);

    // Every file that DEFINES the constant or either implementation, every
    // file that declares a budget-CLASS number under any name, and every file
    // that IMPORTS the module — package-wide.
    const constantDefiners: string[] = [];
    const prefixRuleDefiners: string[] = [];
    const pageCloserDefiners: string[] = [];
    const budgetClassNumbers: string[] = [];
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
          continue;
        }
        if (!entry.isFile() || !full.endsWith('.ts') || full.endsWith('.test.ts')) continue;
        const source = readFileSync(full, 'utf8');
        if (/^export const LIST_PAYLOAD_BUDGET_CHARS\s*=/m.test(source)) constantDefiners.push(full);
        if (/^export function fitToListPayloadBudget\b/m.test(source)) prefixRuleDefiners.push(full);
        if (/^export function applyListPayloadBudget\b/m.test(source)) pageCloserDefiners.push(full);
        for (const [, name = '', literal = ''] of source.matchAll(NUMERIC_DECLARATION)) {
          if (Number(literal.replaceAll('_', '')) >= BUDGET_CLASS_MIN) budgetClassNumbers.push(`${full}:${name}`);
        }
        if (full !== budgetModule && IMPORTS_BUDGET_MODULE.test(source)) importers.push(full);
      }
    };
    walk(srcRoot);

    // STRICT, and deliberately not parameterized by any list: a second
    // definition ANYWHERE is the drift this module exists to prevent.
    expect(constantDefiners).toEqual([budgetModule]);
    expect(prefixRuleDefiners).toEqual([budgetModule]);
    expect(pageCloserDefiners).toEqual([budgetModule]);

    // …and a second budget by any OTHER name is the same drift wearing a
    // disguise: a fork does not reuse this module's spellings, but it does
    // have to write down a number this large.
    expect(budgetClassNumbers.sort()).toEqual([...permittedNumbers].sort());

    // …and the set of files importing the module is exactly the permitted set
    // — no unlisted file may, and a listed one that stopped is stale
    // bookkeeping that should be removed from the list.
    expect(importers.sort()).toEqual(permitted.map((t) => t.path).sort());

    for (const transport of permitted) {
      const source = readFileSync(transport.path, 'utf8');
      // The one thing the doors deliberately DO NOT share: the per-item
      // measure, because they do not write the same bytes (compact tool
      // result vs 2-space-indented stdout) — or, for a shared page-shaper,
      // because it writes none and takes its caller's.
      expect(source, transport.path).toContain(transport.measure);
    }
  });
});
