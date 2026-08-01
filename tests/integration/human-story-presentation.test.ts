// plugin/tests/integration/human-story-presentation.test.ts — pins the
// human-facing presentation guidance in `execute` Step 2 and `refine` Step 7
// against silent drift, per P-52 (prose enumerating a shipped behavioral
// surface must be checked against the artifact, not hand-maintained free of
// any check) and P-41 (guards must be guarded, with falsification fixtures
// written against the property, not a copy of the guarded text).
//
// THE DEFECT this closes: when ideate asks a human to approve board work, the
// only document it has is the item's `spec` — written dense, on purpose, for
// a worker agent to build from with no other context (file paths, policy
// ids, record ULIDs). Presented as-is to a human reviewer, that density is
// unreadable in that role. `execute` Step 2 and `refine` Step 7 both said
// WHAT to show (frontier, item count, mode / case, items created) but never
// HOW, and never mentioned the human's comprehension — so a worker payload
// went to the human lightly reformatted. This item adds presentation
// guidance — a four-part story (Background you need / The problem / The
// work / How we know it's done), reference expansion at the boundary,
// progressive disclosure, coverage of confirm-question option text, and a
// reframing of the confirmation gate from "approve" to "review — objections
// and redesigns are cheaper now than after the build." Prose guidance in
// this repo has a track record of silently drifting (the board-paging-
// vocabulary defect this test's sibling closes is the precedent) — this is
// the mechanical pin so a future edit cannot quietly drop it.
//
// WHAT THIS CHECK IS: a SPELLING check, not a semantic one. It proves the
// guidance's established phrases are present in the registry files; it
// cannot verify that any given presentation actually produced a good story,
// that the reference expansions chosen were the right ones, or that a human
// reviewer found the result clear. Composing a good story is a judgment
// task (that is the whole argument in the item spec for why this is prose,
// not generated code, despite GP-24's mechanical preference) — what can be
// pinned mechanically is only that the instruction to do so still exists.
// Same category of guard as review-scope-derivation.test.ts's site-parity
// assertions and board-paging-vocabulary.test.ts's scanned registry,
// applied to a new surface.
//
// REGISTRY (P-52 — derived, not hand-maintained): every `.md` file under
// skills/, agents/, docs/ that MENTIONS the four-part story's first header
// ("Background you need") is discovered by scanning those directory trees
// and grepping their content at test time (`deriveRegistry` below), not
// typed into an array here. A file only ever gains that phrase by adopting
// this presentation convention, so the registry is exactly "files that have
// started telling the story" — and every one of them must carry the REST of
// the guidance too, or this suite catches the gap. Add a third human-facing
// confirmation gate later (in a new skill, or an existing one) and it enters
// the registry the moment it adopts the same opening header; nobody has to
// remember to add it here. FALSIFIED as genuinely derived (not a hardcoded
// list disguised as a scan) by the first `describe` block below, which
// points `deriveRegistry` at a synthetic temp tree the real repo has never
// seen.
//
// COVERAGE (P-48 — green is coverage-scoped): this governs `.md` prose
// discovered by walking skills/, agents/, docs/ for the story-opening
// marker. It does not cover `agents/worker.md` or anything the worker
// reads (out of scope by the item spec's own non-goals — the worker keeps
// the dense payload), non-md prose, or whether a presentation actually
// produced good output for a real human (unverifiable mechanically — see
// "WHAT THIS CHECK IS" above).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Roots scanned for human-presentation prose — the plugin's own shipped
 *  operational-prose surfaces, not runtime data, build output, or tests. */
const REGISTRY_ROOTS = ['skills', 'agents', 'docs'];

/** The registry marker: a file only carries this phrase once it has adopted
 *  the four-part story's opening header. Distinctive enough that it will not
 *  appear by accident — it is not ordinary English, it is this guidance's
 *  own vocabulary. */
const MENTIONS_STORY_OPENING = /\*\*Background you need\*\*/;

/** The full set of markers the guidance requires, once a file is in scope.
 *  Each is a phrase pattern already in use at both real sites (execute Step
 *  2, refine Step 7), not the exact prose of either — a paraphrase in either
 *  direction still matches, the way board-paging-vocabulary.test.ts's
 *  PAGING_VOCABULARY tolerates connecting-word variation. */
const REQUIRED_MARKERS: { name: string; pattern: RegExp; describe: string }[] = [
  {
    name: 'story-background',
    pattern: /\*\*Background you need\*\*/,
    describe: 'the four-part story\'s first header, "Background you need"',
  },
  {
    name: 'story-problem',
    pattern: /\*\*The problem\*\*/,
    describe: 'the four-part story\'s second header, "The problem"',
  },
  {
    name: 'story-work',
    pattern: /\*\*The work\*\*/,
    describe: 'the four-part story\'s third header, "The work"',
  },
  {
    name: 'story-done',
    pattern: /\*\*How we know it's done\*\*/,
    describe: 'the four-part story\'s fourth header, "How we know it\'s done"',
  },
  {
    name: 'never-spec-bodies',
    pattern: /never present( the)? spec bodies/i,
    describe: 'the never-present-spec-bodies rule',
  },
  {
    name: 'reference-expansion',
    pattern: /inline (the|what)[\s\S]{0,60}means?[\s\S]{0,300}parenthes/i,
    describe: 'reference-expansion guidance (inline the meaning, bare id in parentheses at most)',
  },
  {
    name: 'progressive-disclosure',
    pattern: /title[\s\S]{0,60}one-line[\s\S]{0,150}(full story|four-part story)[\s\S]{0,150}raw spec/i,
    describe: 'progressive-disclosure guidance (title → one-line → full story → raw spec)',
  },
  {
    name: 'confirm-question-option-text',
    pattern: /(confirm-question|option text)[\s\S]{0,400}enumerat|enumerat[\s\S]{0,400}(confirm-question|option text)/i,
    describe: 'coverage of confirm-question option text, requiring options to be enumerated',
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
 *  adopted the four-part story's opening header — found by scanning, never
 *  typed. */
function deriveRegistry(base: string): string[] {
  const candidates = REGISTRY_ROOTS.flatMap((root) => listMarkdownFiles(base, root));
  return candidates
    .filter((rel) => MENTIONS_STORY_OPENING.test(readFileSync(join(base, rel), 'utf8')))
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
  const dir = mkdtempSync(join(tmpdir(), 'human-story-presentation-test-'));
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
 *  PROPERTY the guidance describes, not copied from either real skill
 *  file's actual wording. */
function completeFixtureBody(): string {
  return [
    '# made-up skill',
    '',
    '## Step N — present and confirm',
    'Never present spec bodies for review. Tell the story instead:',
    '- **Background you need** — orientation for a newcomer.',
    '- **The problem** — why this matters.',
    '- **The work** — what will happen, in plain language.',
    "- **How we know it's done** — the bar.",
    '',
    'Inline what a reference means rather than citing it bare, keeping the id',
    'in parentheses at most.',
    '',
    'Default to progressive disclosure: title, then a one-line summary, then',
    'the full four-part story, then the raw spec, deepest last.',
    '',
    'This also governs confirm-question option text: enumerate the actual',
    'options in plain language rather than leaving them implied.',
  ].join('\n');
}

describe('the registry is derived from the shipped tree, not hand-maintained (P-52)', () => {
  it('scanning skills/, agents/, docs/ of the REAL plugin finds exactly the two known presentation gates', () => {
    const registry = deriveRegistry(PLUGIN_DIR);
    // The extraction itself must bite.
    expect(registry.length).toBeGreaterThan(0);
    expect(registry).toEqual(['skills/execute/SKILL.md', 'skills/refine/SKILL.md'].sort());
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
    writeFile(base, 'skills/made-up/SKILL.md', 'Opens with **Background you need** and nothing else.');
    writeFile(base, 'skills/made-up/other.md', 'Never mentions the story-opening marker at all.');
    writeFile(base, 'agents/new-agent.md', 'Also says **Background you need** somewhere in its prose.');
    writeFile(base, 'docs/unrelated.md', 'Nothing about presentation here.');
    // A file OUTSIDE the registry roots must NOT be picked up — the roots
    // themselves are part of the scan's contract.
    writeFile(base, 'src/not-scanned.md', 'Also says **Background you need** but lives outside the registry roots.');

    const registry = deriveRegistry(base);
    expect(registry).toEqual(['agents/new-agent.md', 'skills/made-up/SKILL.md'].sort());
  });
});

describe('every registry site carries the full guidance', () => {
  it.each(deriveRegistry(PLUGIN_DIR).map((rel) => ({ rel })))('$rel', ({ rel }) => {
    const result = checkFile(PLUGIN_DIR, rel);
    expect(result.ok, `missing: ${result.missing.join('; ')}`).toBe(true);
  });
});

describe('the reframed confirmation gate ("review" not "approve") is present at the literal gate — skills/execute/SKILL.md', () => {
  it('Step 2 frames the check as review-with-objections-invited, not bare approval', () => {
    const text = readFileSync(join(PLUGIN_DIR, 'skills', 'execute', 'SKILL.md'), 'utf8').replace(/\s+/g, ' ');
    expect(text).toMatch(/review, not approval/i);
    expect(text).toMatch(/objections and redesigns are cheaper now/i);
  });
});

describe('the guidance check fires on an induced violation and stays quiet on agreement (P-41)', () => {
  // Written against the PROPERTY each marker guards (a required element of
  // the guidance is absent from a file that otherwise adopted the
  // convention), not against any real guarded file's exact spelling — this
  // content is synthetic and was never copied from skills/execute/SKILL.md
  // or skills/refine/SKILL.md.
  it('a synthetic site that opens the story but drops the "how we know it\'s done" header is FLAGGED', () => {
    const base = makeTempTree();
    const withoutDoneHeader = completeFixtureBody().replace("- **How we know it's done** — the bar.\n", '');
    // The mutation must actually land — prove the header string is gone
    // before trusting the checker's verdict on it.
    expect(withoutDoneHeader).not.toMatch(/How we know it's done/);
    writeFile(base, 'skills/leaky/SKILL.md', withoutDoneHeader);

    const registry = deriveRegistry(base);
    expect(registry).toEqual(['skills/leaky/SKILL.md']); // still opens the story, so still in scope
    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/fourth header/);
  });

  it('a synthetic site that keeps every header but drops the never-present-spec-bodies rule is FLAGGED', () => {
    const base = makeTempTree();
    const withoutSpecBodiesRule = completeFixtureBody().replace('Never present spec bodies for review. ', '');
    expect(withoutSpecBodiesRule).not.toMatch(/never present/i);
    writeFile(base, 'skills/leaky/SKILL.md', withoutSpecBodiesRule);

    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/never-present-spec-bodies/);
  });

  it('a synthetic site that never mentions confirm-question option text is FLAGGED', () => {
    const base = makeTempTree();
    const withoutOptionCoverage = completeFixtureBody().split('\n\n').slice(0, -1).join('\n\n');
    expect(withoutOptionCoverage).not.toMatch(/confirm-question|option text/i);
    writeFile(base, 'skills/leaky/SKILL.md', withoutOptionCoverage);

    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.missing.join(' ')).toMatch(/confirm-question option text/);
  });

  it('the complete synthetic fixture — every required element present — is QUIET, the exact shape used at both real sites', () => {
    const base = makeTempTree();
    writeFile(base, 'skills/leaky/SKILL.md', completeFixtureBody());
    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok, `unexpectedly missing: ${result.missing.join('; ')}`).toBe(true);
  });

  it('a mention entirely outside the registry roots is never checked at all — proves scope is the roots, not "anything on disk"', () => {
    const base = makeTempTree();
    writeFile(base, 'random/notes.md', 'Says **Background you need** with none of the rest of the guidance.');
    expect(deriveRegistry(base)).toEqual([]);
  });
});
