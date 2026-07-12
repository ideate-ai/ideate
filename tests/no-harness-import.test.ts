import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ideate/plugin — CI-enforced no-harness-import invariant (WI-299,
// capstone-9 S2). Public-repo counterpart of
// harness/src/no-plugin-import.test.ts (which this file's approach is
// ported from — same character-level, string/template-literal-aware
// comment stripper, same non-heuristic mechanical check). Where the
// harness->plugin direction is an internal layering violation, the
// plugin->harness direction is worse: this package ships in the public
// ideate-ai/ideate repo, so a leaked harness import/path here is a P-39
// exposure, not just a coupling smell.
//
// FORBIDDEN patterns (checked against every non-comment line of every
// .ts/.mjs file under plugin/src, plugin/tests, plugin/hooks, and
// plugin/scripts, this file itself excluded by resolved absolute path —
// see below): '../harness', 'harness/src', '@ideate/harness'.
//
// Comments are stripped first (both `//` and `/* */`) via a small
// character-level scanner that also respects string/template literal
// boundaries, so prose that mentions "the harness" or "eval harness" in a
// comment (e.g. plugin/src/telemetry/counters.ts, plugin/src/cli/
// ideate-record.ts) does not trip the check — only literal import-shaped
// references to the harness package/path do.
//
// This file is EXCLUDED from its own scan: it necessarily contains the
// forbidden strings as literal pattern definitions above, and the
// falsification proof for this test (WI-299's completion report) inserts a
// violating probe file elsewhere under plugin/src, not into this file's own
// scanned set — scanning the detector for its own detection strings would
// be circular, not a real coupling check.

const FORBIDDEN_PATTERNS = ['../harness', 'harness/src', '@ideate/harness'];

const THIS_FILE = fileURLToPath(import.meta.url);
const TESTS_DIR = dirname(THIS_FILE); // .../plugin/tests
const PLUGIN_ROOT = join(TESTS_DIR, '..'); // .../plugin

const SCAN_DIRS = ['src', 'tests', 'hooks', 'scripts'];
const SCAN_EXTENSIONS = ['.ts', '.mjs'];
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext)) &&
      full !== THIS_FILE
    ) {
      out.push(full);
    }
  }
  return out;
}

function listAllFiles(): string[] {
  const out: string[] = [];
  for (const dirName of SCAN_DIRS) {
    const full = join(PLUGIN_ROOT, dirName);
    if (!existsSync(full)) continue;
    out.push(...listSourceFiles(full));
  }
  return out;
}

/**
 * Strip `//` line comments and `/* *‍/` block comments from source, character
 * by character, respecting single/double/backtick string boundaries (so a
 * literal inside a string is never mistaken for a comment marker). Newlines
 * are preserved so reported line numbers stay meaningful. Mechanical only —
 * no awareness of imports, syntax, or semantics beyond comment/string
 * boundaries. Ported from harness/src/no-plugin-import.test.ts.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // String / template literal: copy verbatim until the matching
    // unescaped closing quote.
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        const c = source[i];
        out += c;
        if (c === '\\') {
          i++;
          if (i < n) {
            out += source[i];
            i++;
          }
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }

    // Line comment: drop everything up to (not including) the newline.
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment: drop everything up to and including the closing `*/`,
    // but preserve newlines so line numbers stay aligned.
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

describe('no-harness-import invariant (WI-299)', () => {
  const files = listAllFiles();

  it('scans at least one plugin source file', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('contains no non-comment reference to the harness package', () => {
    const violations: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const stripped = stripComments(source);
      const lines = stripped.split('\n');
      lines.forEach((line, idx) => {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (line.includes(pattern)) {
            violations.push(
              `${relative(PLUGIN_ROOT, file)}:${idx + 1}: contains "${pattern}"`
            );
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
