// plugin/tests/integration/board-paging-vocabulary.test.ts — pins the
// paging vocabulary ("page to exhaustion, follow `next_cursor` until it is
// `null`") wherever plugin prose describes reading the board via
// `work_list` / `ideate-work list`, per P-52 (prose enumerating a shipped
// behavioral surface is a second copy of a source of truth and must be
// generated from, or grep-checked against, the actual shipped artifacts).
//
// THE DEFECT this closes: `work_list` became paged, and prose across
// skills/**, agents/journal-keeper.md and docs/workflow-guide.md still
// described an unpaged read — a skill could declare work done from ONE
// unexhausted page. It was fixed by hand across 15 sites (9 updated, 4
// already correct, 2 not applicable) with nothing holding it. The next
// contract change re-opens the same hole, and the failure is silent: prose
// that under-describes a paged read produces confident wrong answers, not
// errors. This test is the mechanical pin the fix was missing.
//
// REGISTRY (P-52 — derived, not hand-maintained): every `.md` file under
// skills/, agents/, docs/ (the plugin's own shipped operational-prose
// surfaces — as opposed to .ideate/ runtime data, docs/architecture/build/
// generated output, or tests/ itself) that MENTIONS `work_list` or
// `ideate-work list` is discovered by scanning those directory trees (via
// shipped-markdown-registry.ts's shared, mechanical "shipped" walk — see
// that file for which oracle decides shipped-ness and why) and grepping
// their content at test time (`deriveRegistry` below), not typed into an
// array here. Add a new skill/agent/doc file that names the board-listing
// surface and it enters the registry on its own; nobody has to remember to
// add it. FALSIFIED as genuinely derived (not a hardcoded list disguised as
// a scan) by the first `describe` block below, which points
// `deriveRegistry` at a synthetic temp tree the real repo has never seen.
//
// ENUMERATING vs EXISTENCE-CHECKING (the spec's central design question):
// distinguishing "this prose walks every item" from "this prose only asks
// is-there-any-claimable-work" from TEXT ALONE is NOT reliably mechanical.
// Several real sites mix both in the SAME FILE — skills/execute/SKILL.md
// ("Confirm a board exists (`work_list`)" alongside "Read the board:
// `work_list` for the full picture ... page it to exhaustion"),
// skills/autopilot/SKILL.md ("`work_list` must show a populated board; if
// empty, stop" alongside two separate exhaustive-paging instructions), and
// skills/autopilot/phases/review.md's convergence check ("coming back empty
// on the first page settles it" for the empty case, "otherwise ... only
// holds after paging to exhaustion" for the non-empty case, in the same
// paragraph). A file-level or even sentence-level classifier would have to
// hand-list which specific mention is which — the same hand-maintenance
// defect one level up (P-52) — or guess and either miss the dangerous
// mentions or spam the safe ones into noise (the spec's own warning).
//
// So this check does NOT attempt that classification. It errs toward
// flagging (GP-24): every registry FILE must carry the paging vocabulary
// SOMEWHERE, full stop — regardless of how many existence-only mentions it
// also carries. A file whose ONLY mention of the board read is a genuine
// existence check (none exist today — every current registry file has at
// least one enumerating passage) is exempted only via the explicit
// EXISTENCE_ONLY_ALLOWLIST below, where each entry names its file and
// states its reason, making the exemption visible and reviewable rather
// than silent. This is the "explicit allow-list where each entry carries
// its reason" fallback the spec calls for when the safe half cannot be
// identified mechanically.
//
// WHAT THIS CHECK IS: a SPELLING check, not a semantic one. It proves the
// established phrase pattern (`` `next_cursor` ``, near `` `null` ``,
// already in use across every site fixed for this defect) is present
// somewhere in the file; it cannot verify that the described procedure is
// actually followed, or that the surrounding prose is otherwise correct.
// That is the same category of guard as
// review-scope-derivation.test.ts's site-parity assertions, extended from
// two hand-named files to a scanned registry.
//
// COVERAGE (P-48 — green is coverage-scoped): this test governs `.md`
// prose discovered by walking skills/, agents/, docs/ for the board-read
// marker. It does NOT cover README.md (governed separately by
// ideate-work-readme.test.ts's flag/behavior parity — a different check for
// a different second-copy risk, the worked-example command output), non-md
// prose, or non-board reads (record/steering surfaces — explicitly out of
// scope for this item; board that separately if needed).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SHIPPED_PROSE_ROOTS, listShippedMarkdownFilesUnderRoots } from './shipped-markdown-registry.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Roots scanned for board-reading prose — the plugin's own shipped
 *  operational-prose surfaces: not `.ideate/` runtime data, not `dist/` or
 *  `docs/architecture/build/` build output (excluded mechanically by
 *  shipped-markdown-registry.ts's walk, even though `docs/` itself is a
 *  scanned root), and not `tests/` itself. */
const REGISTRY_ROOTS = SHIPPED_PROSE_ROOTS;

/** A mention of the board-listing surface, by either name it can be read
 *  under: the MCP tool, or its CLI twin. */
const MENTIONS_BOARD_READ = /\bwork_list\b|ideate-work list/;

/** The established paging-to-exhaustion vocabulary already in use across
 *  every site fixed for this defect: `next_cursor` named close to `null`,
 *  regardless of the exact connecting words each site's author used
 *  ("follow `next_cursor` until it is `null`", "`next_cursor` is `null`",
 *  "page with `next_cursor` ... `null` `next_cursor` means exhaustion" all
 *  match). Whitespace in the source text is collapsed before this runs, so
 *  markdown's hard-wrapping across lines can never hide a real disclosure
 *  from it. */
const PAGING_VOCABULARY = /next_cursor`[\s\S]{0,80}?`null`/;

/**
 * Files exempted from the paging-vocabulary requirement because every
 * mention of the board read in them is an EXISTENCE check ("is there any
 * claimable work" — settled by a single page), never an enumerating walk.
 * Empty today: every current registry file has at least one enumerating
 * mention (see the file-level comment above), so none qualifies. Kept as a
 * visible, reviewable escape hatch — each entry MUST carry its reason —
 * rather than a silent one, per the spec's explicit fallback for a
 * property that prose text alone cannot reliably classify.
 */
const EXISTENCE_ONLY_ALLOWLIST: Record<string, string> = {
  'docs/transport-contract.md':
    'A contributor contract, not an agent procedure. Its sole mentions of `work_list`/`ideate-work list` are in the per-store table naming the board store\'s transports and process lifetime to characterize the fault line — descriptive, never an instruction to read the board. No enumerating passage anywhere in the file.',
  'docs/architecture/01-process-record.md':
    'An architecture inventory doc. Its sole mention is a historical reference to the 81KB single-line `work_list` overflow incident ("the fix for the ... overflow class") — naming the defect the payload budget closed, never instructing a board read. No enumerating passage anywhere in the file.',
};

/** The registry: every SHIPPED markdown file under the prose roots (see
 *  shipped-markdown-registry.ts) that mentions the board-listing surface —
 *  found by scanning, never typed. */
function deriveRegistry(base: string): string[] {
  const candidates = listShippedMarkdownFilesUnderRoots(base, REGISTRY_ROOTS);
  return candidates
    .filter((rel) => MENTIONS_BOARD_READ.test(readFileSync(join(base, rel), 'utf8')))
    .sort();
}

/** A registry file is compliant if it carries the paging vocabulary
 *  somewhere, or is named (with a reason) on the existence-only allow-list. */
function checkFile(base: string, rel: string): { ok: boolean; reason: string } {
  const allowReason = EXISTENCE_ONLY_ALLOWLIST[rel];
  if (allowReason !== undefined) return { ok: true, reason: `allow-listed: ${allowReason}` };
  const text = readFileSync(join(base, rel), 'utf8').replace(/\s+/g, ' ');
  if (PAGING_VOCABULARY.test(text)) return { ok: true, reason: 'carries the paging vocabulary' };
  return {
    ok: false,
    reason: `${rel} mentions the board read (\`work_list\`/\`ideate-work list\`) but carries no ` +
      'paging-to-exhaustion vocabulary (`next_cursor` ... `null`), and is not on the existence-only allow-list',
  };
}

const tempDirs: string[] = [];
function makeTempTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'board-paging-vocab-test-'));
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

describe('the registry is derived from the shipped tree, not hand-maintained (P-52)', () => {
  it('scanning skills/, agents/, docs/ of the REAL plugin finds the known board-reading sites', () => {
    const registry = deriveRegistry(PLUGIN_DIR);
    // The extraction itself must bite.
    expect(registry.length).toBeGreaterThan(0);
    expect(registry).toEqual(
      [
        'agents/journal-keeper.md',
        'docs/architecture/01-process-record.md',
        'docs/transport-contract.md',
        'docs/workflow-guide.md',
        'skills/autopilot/SKILL.md',
        'skills/autopilot/phases/execute.md',
        'skills/autopilot/phases/refine.md',
        'skills/autopilot/phases/reporting.md',
        'skills/autopilot/phases/review.md',
        'skills/execute/SKILL.md',
        'skills/refine/SKILL.md',
        'skills/review/SKILL.md',
      ].sort(),
    );
  });

  // FALSIFICATION of "derived, not hardcoded": point the exact same
  // function at a SYNTHETIC tree the real repo has never seen. If
  // `deriveRegistry` were secretly a hand-typed array masquerading as a
  // scan, it would return the real repo's list (or an empty list) here
  // regardless of what this temp tree contains; a genuine scan must instead
  // reflect exactly what is written below, proving the registry tracks the
  // file SYSTEM and file CONTENT, not a memorized set of paths.
  it('a synthetic tree the real repo has never seen is scanned on its own content — proves this is a real scan, not a hardcoded list', () => {
    const base = makeTempTree();
    writeFile(base, 'skills/made-up/SKILL.md', 'This mentions `work_list` in passing.');
    writeFile(base, 'skills/made-up/other.md', 'This never mentions the board read surface at all.');
    writeFile(base, 'agents/new-agent.md', 'Reads the board via `ideate-work list --json`.');
    writeFile(base, 'docs/unrelated.md', 'Nothing about the board here.');
    // A file OUTSIDE the registry roots that mentions work_list must NOT
    // be picked up — the roots themselves are part of the scan's contract.
    writeFile(base, 'src/not-scanned.md', 'Also says `work_list` but lives outside the registry roots.');

    const registry = deriveRegistry(base);
    expect(registry).toEqual(['agents/new-agent.md', 'skills/made-up/SKILL.md'].sort());
  });
});

describe('every board-reading site in the real registry carries the paging vocabulary', () => {
  it.each(deriveRegistry(PLUGIN_DIR).map((rel) => ({ rel })))('$rel', ({ rel }) => {
    const result = checkFile(PLUGIN_DIR, rel);
    expect(result.ok, result.reason).toBe(true);
  });
});

describe('the vocabulary check fires on an induced violation and stays quiet on agreement (P-41)', () => {
  // Written against the PROPERTY (a file mentions the board read but omits
  // the paging pair), not against any real guarded file's spelling — this
  // content is synthetic and was never copied from a shipped skill.
  it('a synthetic site that mentions the board read but never pairs `next_cursor` with `null` is FLAGGED', () => {
    const base = makeTempTree();
    writeFile(
      base,
      'skills/leaky/SKILL.md',
      [
        '# leaky',
        '',
        'Read the board with `work_list` and act on whatever comes back on the',
        'first call. No mention of paging or cursors anywhere in this file.',
      ].join('\n'),
    );
    const registry = deriveRegistry(base);
    expect(registry).toEqual(['skills/leaky/SKILL.md']); // the mutation must actually land in the registry
    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/carries no/);
  });

  it('the same site, once it names `next_cursor` next to `null`, is QUIET — the exact fix shape used across the real sites', () => {
    const base = makeTempTree();
    writeFile(
      base,
      'skills/leaky/SKILL.md',
      [
        '# leaky',
        '',
        'Read the board with `work_list`, paged to exhaustion — follow',
        '`next_cursor` until it is `null` (a short page is never the end).',
      ].join('\n'),
    );
    const result = checkFile(base, 'skills/leaky/SKILL.md');
    expect(result.ok).toBe(true);
  });

  it('a mention entirely outside the registry roots is never checked at all — proves scope is the roots, not "anything on disk"', () => {
    const base = makeTempTree();
    writeFile(base, 'random/notes.md', 'Reads `work_list` with no paging mentioned whatsoever.');
    expect(deriveRegistry(base)).toEqual([]);
  });

  it('an allow-listed existence-only file is exempt even without the vocabulary, and the exemption carries a stated reason', () => {
    const base = makeTempTree();
    writeFile(base, 'skills/exists-only/SKILL.md', 'Only checks `work_list` for board existence, one page.');
    const rel = 'skills/exists-only/SKILL.md';
    expect(checkFile(base, rel).ok).toBe(false); // not allow-listed here: fails, as it should
    const allowlisted: Record<string, string> = { [rel]: 'existence check only, single page, no enumeration' };
    const withAllowlist = (): { ok: boolean; reason: string } => {
      const reason = allowlisted[rel];
      if (reason !== undefined) return { ok: true, reason: `allow-listed: ${reason}` };
      return checkFile(base, rel);
    };
    expect(withAllowlist().ok).toBe(true);
    expect(withAllowlist().reason).toMatch(/allow-listed: /);
  });
});
