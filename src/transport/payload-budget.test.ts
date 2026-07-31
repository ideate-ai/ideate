// plugin/src/transport/payload-budget.test.ts — acceptance tests for the
// shared payload budget every bounded read enforces.
//
// Pins: the per-item measures match what each transport ACTUALLY writes
// (compact for MCP, 2-space-indented for the CLI's `list --json`); the budget
// is a bound on real output that still walks every row exactly once and never
// drops an oversized row (LIVENESS); and — mechanically — the constant and
// its implementation are defined in EXACTLY ONE file package-wide, imported
// only by the transports listed below. That last test is the guard that keeps
// the budget from quietly forking into two divergent copies (GP-24:
// grep-falsifiable promises about code shape), which is the failure mode the
// module exists to prevent.
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
 * Every transport PERMITTED to import the budget, and the per-item measure
 * each one must use. This list is the ONE thing a new bounded read extends —
 * add a row (record_read, steering_read, usage_query) and the drift test below
 * keeps working unchanged. What it may NOT do is grow a second DEFINITION:
 * the "defined exactly once" half of the test takes no list and admits no
 * exceptions.
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
];

/** A file "reaches for" the budget if it names either symbol at all — an
 *  import, a re-export, or a hand-rolled copy all trip this. */
const MENTIONS_BUDGET = /\bLIST_PAYLOAD_BUDGET_CHARS\b|\bapplyListPayloadBudget\b/;

/** …and the only legitimate way to reach for it: importing from THE module.
 *  `[^}]*` cannot cross a closing brace, so each match is one import
 *  statement (it does span newlines, which is how a multi-line import of the
 *  same specifier still matches). */
const IMPORTS_FROM_BUDGET_MODULE =
  /import\s*\{[^}]*\b(?:LIST_PAYLOAD_BUDGET_CHARS|applyListPayloadBudget)\b[^}]*\}\s*from\s*'[^']*transport\/payload-budget\.js'/;

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

  it('the budget is DEFINED exactly once package-wide, and only the permitted transports reach for it (mechanical, so they cannot desynchronize)', () => {
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const budgetModule = join(srcRoot, 'transport', 'payload-budget.ts');
    const permitted = PERMITTED_IMPORTERS.map((t) => ({ path: join(srcRoot, ...t.segments), measure: t.measure }));

    // Every file that DEFINES the constant or the helper, and every OTHER
    // file that so much as names one — package-wide.
    const constantDefiners: string[] = [];
    const helperDefiners: string[] = [];
    const reachers: string[] = [];
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
        if (/^export function applyListPayloadBudget\b/m.test(source)) helperDefiners.push(full);
        if (full !== budgetModule && MENTIONS_BUDGET.test(source)) reachers.push(full);
      }
    };
    walk(srcRoot);

    // STRICT, and deliberately not parameterized by any list: a second
    // definition ANYWHERE is the drift this module exists to prevent.
    expect(constantDefiners).toEqual([budgetModule]);
    expect(helperDefiners).toEqual([budgetModule]);

    // …and the set of files reaching for it is exactly the permitted set —
    // no unlisted file may, and a listed one that stopped is stale bookkeeping
    // that should be removed from the list.
    expect(reachers.sort()).toEqual(permitted.map((t) => t.path).sort());

    for (const transport of permitted) {
      const source = readFileSync(transport.path, 'utf8');
      // It reaches for it by IMPORTING the one module — never by copying it.
      expect(source, transport.path).toMatch(IMPORTS_FROM_BUDGET_MODULE);
      // The one thing the doors deliberately DO NOT share: the per-item
      // measure, because they do not write the same bytes (compact tool
      // result vs 2-space-indented stdout).
      expect(source, transport.path).toContain(transport.measure);
    }
  });
});
