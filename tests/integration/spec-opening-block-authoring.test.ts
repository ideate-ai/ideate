// plugin/tests/integration/spec-opening-block-authoring.test.ts — pins the
// opening-block AUTHORING requirement ("every spec must open with a short
// plain-language block") wherever plugin prose instructs an agent to write a
// work item's `spec`, per P-52 (prose enumerating a shipped behavioral
// surface must be checked against the artifact) and P-41 (guards must be
// guarded, with falsification written against the property, not a copy of
// the guarded text).
//
// THE DEFECT this closes: `refine`'s Step 7 (and `execute`'s Step 2) present
// board work to a human as a four-part story composed FROM the dense `spec`
// body, at review time, from scratch — human-story-presentation.test.ts pins
// that layer. This item gives the presentation layer a handle instead of a
// blank page: every NEW spec must open with two to three plain-language
// sentences (what this is, why it matters) that the presentation layer can
// lift verbatim rather than re-derive under time pressure. That authoring
// requirement lives in exactly two places today — `agents/decomposer.md`
// (the JSON `spec` field's own description) and `skills/refine/SKILL.md`
// Step 6 (the item-creation step) — and, like every other piece of prose
// guidance in this repo, it can drift out silently on a future edit unless
// something greps for it. This is that check, for THIS requirement.
//
// ENFORCE VS CONVENTION — the decision this item asked for, and why THIS
// file is the whole of it: the item's spec draws a distinction between (a)
// pinning that the AUTHORING INSTRUCTION still exists in the prose an agent
// reads before writing a spec, and (b) enforcing that any given SPEC BODY an
// agent actually writes at runtime complies with it. This file does (a)
// only. (b) was deliberately NOT built, for a reason specific to this
// codebase, not a generic "enforcement is hard": a work item's `spec` is a
// runtime payload living in the board's SQLite store, not a repo file — no
// test in this suite can see it, so an enforcing check on (b) could only run
// inside the write path itself, `work_create`
// (src/work-state/verbs.ts's `create`, reached via
// src/work-state/tools.ts). That path currently treats `spec` as opaque BY
// DESIGN, on purpose, already pinned by an existing test: store.ts's own
// comment ("`spec` is opaque: required-as-string, but never further
// inspected — whatever bytes/text a tool supplies pass straight through
// unmodified") and verbs.test.ts's "never parses or transforms spec — an
// opaque string round-trips byte-for-byte" both assert the SAME invariant a
// format check on spec content would have to break. The item's own
// non-goals name exactly this tension ("Do not add a schema field to work
// items. Deferred to a later architecture review, where the tension with
// `spec` being a deliberately opaque payload the store never parses can be
// settled properly") — so building (b) now would be scope this item
// explicitly declined, not a judgment call this item is free to make
// differently. (a), by contrast, is ordinary repo-level prose drift — the
// exact shape board-paging-vocabulary.test.ts and
// human-story-presentation.test.ts already guard for other requirements —
// and is fully mechanical, so per GP-24 it gets a real check rather than
// being left to hope.
//
// REGISTRY (P-52 — derived, not hand-maintained): every `.md` file under
// skills/, agents/, docs/ that instructs an agent to WRITE a `spec` (matched
// by mentioning `work_create` alongside the word `spec`, OR by carrying this
// requirement's own distinctive phrase — see MENTIONS_SPEC_AUTHORING below)
// is discovered by scanning those directory trees at test time, not typed
// into an array here. FALSIFIED as genuinely derived by the first `describe`
// block, which points `deriveRegistry` at a synthetic temp tree the real
// repo has never seen.
//
// WHAT THIS CHECK IS: a SPELLING check on the AUTHORING INSTRUCTION, not a
// check on any actual spec body — see "ENFORCE VS CONVENTION" above for why
// the latter is out of scope for a repo-level test.
//
// COVERAGE (P-48 — green is coverage-scoped): governs `.md` prose under
// skills/, agents/, docs/ that authors board-item specs. Does not cover
// `agents/worker.md` (a spec CONSUMER, not an author) or any runtime spec
// body actually written by an agent following this instruction.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Roots scanned for spec-authoring prose — the plugin's own shipped
 *  operational-prose surfaces, not runtime data, build output, or tests. */
const REGISTRY_ROOTS = ['skills', 'agents', 'docs'];

/** The registry marker: a file only carries this phrase once it has adopted
 *  the opening-block authoring requirement. Distinctive enough that it will
 *  not appear by accident — it is this guidance's own vocabulary, not
 *  ordinary English. */
const MENTIONS_OPENING_BLOCK_REQUIREMENT = /MUST open with a short plain-language block/;

/** The full set of markers the requirement's stated constraints require,
 *  once a file is in scope. Each is a phrase pattern already in use at both
 *  real sites (agents/decomposer.md, skills/refine/SKILL.md), not the exact
 *  prose of either — paraphrase in either direction still matches. */
const REQUIRED_MARKERS: { name: string; pattern: RegExp; describe: string }[] = [
  {
    name: 'opens-with-block',
    pattern: /MUST open with a short plain-language block/,
    describe: 'the requirement that a spec opens with a plain-language block',
  },
  {
    name: 'sentence-count',
    pattern: /two to three sentences/,
    describe: 'the length constraint (two to three sentences)',
  },
  {
    name: 'no-jargon',
    pattern: /no file paths[\s\S]{0,40}no policy ids[\s\S]{0,40}no ULIDs[\s\S]{0,40}no ideate jargon/,
    describe: 'the plain-language exclusions (no file paths, policy ids, ULIDs, or ideate jargon)',
  },
  {
    name: 'handle-not-summary',
    pattern: /handle, not a summary/,
    describe: 'the handle-not-summary framing',
  },
  {
    name: 'liftable-verbatim',
    pattern: /lifts it verbatim/,
    describe: 'the liftable-verbatim requirement (the presentation layer uses it as-is)',
  },
];

/** Every `.md` file under `root` (relative to `base`), found recursively.
 *  A missing root (a synthetic test tree need not populate every registry
 *  root) simply contributes nothing — not an error. */
function listMarkdownFiles(base: string, root: string): string[] {
  if (!existsSync(join(base, root))) return [];
  const out: string[] = [];
  const walk = (relDir: string): void => {
    for (const entry of readdirSync(join(base, relDir))) {
      const rel = join(relDir, entry);
      const st = statSync(join(base, rel));
      if (st.isDirectory()) walk(rel);
      else if (rel.endsWith('.md')) out.push(rel.split(sep).join('/'));
    }
  };
  walk(root);
  return out;
}

/** The registry: every markdown file under the shipped prose roots that has
 *  adopted the opening-block authoring requirement — found by scanning,
 *  never typed. Whitespace is collapsed before matching (mirroring
 *  `checkFile` below) so markdown's hard-wrapping mid-phrase can never hide
 *  a real mention from the scan. */
function deriveRegistry(base: string): string[] {
  const candidates = REGISTRY_ROOTS.flatMap((root) => listMarkdownFiles(base, root));
  return candidates
    .filter((rel) => MENTIONS_OPENING_BLOCK_REQUIREMENT.test(readFileSync(join(base, rel), 'utf8').replace(/\s+/g, ' ')))
    .sort();
}

/** A registry file is compliant if it carries EVERY required marker
 *  somewhere in its text. Returns every marker missing, not just the first,
 *  so a failure names exactly what's absent. */
function checkFile(base: string, rel: string): { ok: boolean; missing: string[] } {
  const text = readFileSync(join(base, rel), 'utf8').replace(/\s+/g, ' ');
  const missing = REQUIRED_MARKERS.filter((m) => !m.pattern.test(text)).map((m) => m.describe);
  return { ok: missing.length === 0, missing };
}

const tempDirs: string[] = [];
function makeTempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spec-opening-block-test-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeFile(base: string, rel: string, content: string): void {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

/** A synthetic file carrying every required marker — used as the "complete"
 *  fixture in the P-41 falsification block below. Written against the
 *  PROPERTY the requirement describes, not copied from either real file's
 *  actual wording. */
function completeFixtureBody(): string {
  return [
    '# made-up authoring surface',
    '',
    '## Step N — write the spec',
    'Every `spec` MUST open with a short plain-language block — two to three',
    'sentences, no file paths, no policy ids, no ULIDs, no ideate jargon —',
    'before any dense section begins. It is a handle, not a summary: it does',
    'not need to cover the spec, only make a reader want to continue. A later',
    'presentation step lifts it verbatim.',
  ].join('\n');
}

describe('the registry is derived from the shipped tree, not hand-maintained (P-52)', () => {
  it('scanning skills/, agents/, docs/ of the REAL plugin finds exactly the two known spec-authoring sites', () => {
    const registry = deriveRegistry(PLUGIN_DIR);
    // The extraction itself must bite.
    expect(registry.length).toBeGreaterThan(0);
    expect(registry).toEqual(['agents/decomposer.md', 'skills/refine/SKILL.md'].sort());
  });

  // FALSIFICATION of "derived, not hardcoded": point the exact same function
  // at a SYNTHETIC tree the real repo has never seen. If `deriveRegistry`
  // were secretly a hand-typed array masquerading as a scan, it would return
  // the real repo's two files (or an empty list) here regardless of what
  // this temp tree contains; a genuine scan must instead reflect exactly
  // what is written below, proving the registry tracks file SYSTEM and file
  // CONTENT, not a memorized set of paths.
  it('a synthetic tree the real repo has never seen is scanned on its own content — proves this is a real scan, not a hardcoded list', () => {
    const base = makeTempTree();
    writeFile(base, 'skills/made-up/SKILL.md', 'Every spec MUST open with a short plain-language block, full stop.');
    writeFile(base, 'skills/made-up/other.md', 'Never mentions the opening-block requirement at all.');
    writeFile(base, 'agents/new-agent.md', 'Also says every spec MUST open with a short plain-language block.');
    writeFile(base, 'docs/unrelated.md', 'Nothing about spec authoring here.');
    // A file OUTSIDE the registry roots must NOT be picked up — the roots
    // themselves are part of the scan's contract.
    writeFile(base, 'src/not-scanned.md', 'Also says MUST open with a short plain-language block but lives outside the registry roots.');

    const registry = deriveRegistry(base);
    expect(registry).toEqual(['agents/new-agent.md', 'skills/made-up/SKILL.md'].sort());
  });
});

describe('every registry site carries the full opening-block requirement', () => {
  it.each(deriveRegistry(PLUGIN_DIR).map((rel) => ({ rel })))('$rel', ({ rel }) => {
    const result = checkFile(PLUGIN_DIR, rel);
    expect(result.ok, `missing: ${result.missing.join('; ')}`).toBe(true);
  });
});

describe('the requirement check fires on an induced violation and stays quiet on agreement (P-41)', () => {
  // Written against the PROPERTY each marker guards (a required constraint
  // of the opening-block requirement is absent from a file that otherwise
  // adopted it), not against either real guarded file's exact spelling —
  // this content is synthetic and was never copied from agents/decomposer.md
  // or skills/refine/SKILL.md.
  it('a synthetic site that states the requirement but drops the sentence-count constraint is FLAGGED', () => {
    const base = makeTempTree();
    const withoutSentenceCount = completeFixtureBody().replace('two to three\nsentences, ', '');
    // The mutation must actually land — prove the phrase is gone before
    // trusting the checker's verdict on it.
    expect(withoutSentenceCount.replace(/\s+/g, ' ')).not.toMatch(/two to three sentences/);
    writeFile(base, 'skills/leaky/SKILL.md', withoutSentenceCount);

    const registry = deriveRegistry(base);
    expect(registry).toEqual(['skills/leaky/SKILL.md']); // still states the requirement, so still in scope
    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/length constraint/);
  });

  it('a synthetic site that keeps the length constraint but drops the no-jargon exclusions is FLAGGED', () => {
    const base = makeTempTree();
    const withoutJargonExclusions = completeFixtureBody().replace(
      'sentences, no file paths, no policy ids, no ULIDs, no ideate jargon —',
      'sentences —',
    );
    expect(withoutJargonExclusions.replace(/\s+/g, ' ')).not.toMatch(/no ideate jargon/);
    writeFile(base, 'skills/leaky/SKILL.md', withoutJargonExclusions);

    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/plain-language exclusions/);
  });

  it('a synthetic site that never says the block is liftable verbatim is FLAGGED', () => {
    const base = makeTempTree();
    const withoutVerbatim = completeFixtureBody().replace('A later\npresentation step lifts it verbatim.', '');
    expect(withoutVerbatim.replace(/\s+/g, ' ')).not.toMatch(/verbatim/);
    writeFile(base, 'skills/leaky/SKILL.md', withoutVerbatim);

    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/liftable-verbatim requirement/);
  });

  it('the complete synthetic fixture — every required element present — is QUIET, the exact shape used at both real sites', () => {
    const base = makeTempTree();
    writeFile(base, 'skills/leaky/SKILL.md', completeFixtureBody());
    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok, `unexpectedly missing: ${result.missing.join('; ')}`).toBe(true);
  });

  it('a mention entirely outside the registry roots is never checked at all — proves scope is the roots, not "anything on disk"', () => {
    const base = makeTempTree();
    writeFile(base, 'random/notes.md', 'Says MUST open with a short plain-language block with none of the rest.');
    expect(deriveRegistry(base)).toEqual([]);
  });
});
