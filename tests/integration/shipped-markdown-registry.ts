// plugin/tests/integration/shipped-markdown-registry.ts — the ONE shared
// notion of "shipped" used by every operational-prose scanner that walks
// skills/, agents/, docs/ (board-paging-vocabulary.test.ts,
// human-addressing-surfaces.test.ts, human-story-presentation.test.ts,
// spec-opening-block-authoring.test.ts).
//
// THE DEFECT this closes: all four scanners walked those three roots with an
// unfiltered recursive directory listing, then filtered by content pattern.
// None of them excluded anything by PATH. `docs/architecture/render.sh`
// writes mermaid-processed copies of six source docs plus a concatenated
// `combined.md` into `docs/architecture/build/` — gitignored, generated,
// never shipped — and the walk picked the copies up anyway, failing them on
// rules the source documents already satisfied (board-paging-vocabulary and
// human-addressing-surfaces both did, live, before this fix). Three of the
// four scanners carried a header comment claiming the walk already excluded
// "runtime data, build output, or tests" — a claim none of them implemented.
// This module is the mechanical exclusion that makes that claim true, shared
// so a fifth scanner (or a change to what "shipped" means) has one place to
// look, not four copies to keep in sync (P-40: a guarantee guarded on some
// of a class but not all of it is unguarded — sibling parity applies to the
// exclusion mechanism itself, not just to each scanner's own check).
//
// THE ORACLE THIS USES, AND WHY (a real decision, not a detail):
// "Shipped" is defined here as "not matched by the ignore rules already in
// force" (`git check-ignore`, run against the ACTUAL .gitignore files on
// disk — `docs/architecture/.gitignore`'s `build/` entry is exactly the rule
// that already encodes "this is generated, do not treat it as a source
// surface"). The alternative — deriving membership from `git ls-files`
// (tracked-only) — is STRICTER and was rejected: it would also exclude any
// legitimately untracked NEW document, which is exactly what happened here
// while the architecture docs themselves were still untracked (see the
// EXEMPTIONS/allowlist entries this change removes below) — a scanner that
// cannot see a real shipped surface until someone remembers to `git add` it
// is the opposite failure, and worse, because it fails silent (green,
// wrongly) rather than loud (red, wrongly, on generated output). Ignore
// rules already distinguish "never meant to ship" (build output) from
// "shipped but not yet committed" (a new source doc) — which is exactly the
// distinction this module needs and `git ls-files` cannot draw.
//
// Trade-off accepted: this makes the scanners depend on `git` being present.
// The scanned tree is NOT always inside a work tree — a real checkout of
// this plugin is, but `scripts/fresh-copy-check.mjs` proves the package
// stands alone by copying it to a temp directory with `.git` stripped
// (see that script for why), and that copy is exactly the case this module
// must still govern correctly. `fresh-copy-check.mjs` handles this by
// `git init`-ing a throwaway, self-contained repository in the copy before
// running the suite there, so the oracle has authority in every tree this
// module is actually asked to scan. The ONLY place "no work tree" is
// expected AND accepted is a synthetic temp tree built by a test fixture
// (as every scanner's own falsification suite, and this module's own test,
// does) — there this module treats it as "nothing excluded", which matches
// every existing synthetic-tree test's expectation (those fixtures never
// construct a `build/`-shaped exclusion in the first place). Anything else
// that keeps git from answering — the binary missing entirely, a corrupt
// repository, an unreadable ignore file, an unsupported git version — is
// NOT the same case and must not collapse into it: this module reports
// those loudly (throws) rather than silently widening what it governs,
// because a guard that switches itself off when its oracle is unavailable,
// silently, is precisely the failure this project's fail-loud rule exists
// to prevent.
//
// FALSIFIED (not just asserted) by
// shipped-markdown-registry.test.ts, which builds a REAL, isolated git
// repository under a temp directory — with its OWN `.gitignore` and its own
// `git init` — and proves this module's `isShippedPath` / `listShippedMarkdownFiles`
// against it: a generated file under an ignored path is excluded, a genuine
// new (untracked, not ignored) document is included. That repo is
// independent of docs/architecture/build — proving the ignore-rule PROPERTY,
// not the specific paths this repo happens to ignore today.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/** The roots every operational-prose scanner walks — the plugin's own
 *  shipped surfaces, as opposed to runtime data, build output, or tests. */
export const SHIPPED_PROSE_ROOTS = ['skills', 'agents', 'docs'];

/** The stderr git prints for `rev-parse --is-inside-work-tree` when `base`
 *  is genuinely outside any git repository — the ONE failure this module
 *  treats as legitimate and quiet. Matched narrowly on git's FULL phrasing
 *  for that specific case, "(or any of the parent directories)" included,
 *  not merely "not a git repository": git also uses that shorter phrase for
 *  a CORRUPT repository (e.g. a gitlink `.git` file pointing at a gitdir
 *  that does not exist — `fatal: not a git repository: /path/that/is/gone`,
 *  with no "(or any of the parent directories)" suffix), and that case must
 *  NOT be mistaken for "legitimately no work tree here" (repair for the
 *  Andon: those must be reported, not swallowed — see below). */
const NOT_A_REPO_PATTERN = /not a git repository \(or any of the parent directories\)/;

/** Environment for every git invocation in this module. Pins the locale to
 *  `C` because {@link NOT_A_REPO_PATTERN} matches git's ENGLISH stderr, and
 *  a git built with national-language support running under, say,
 *  `LANG=fr_FR.UTF-8` prints that same exit-128 case translated — at which
 *  point the pattern misses, and the legitimate "no work tree here" case is
 *  reported as an unexpected failure. That direction is the safe one (loud,
 *  not silently permissive), but it would break this module's own synthetic
 *  temp-tree fixtures on any developer machine with a localized git. The
 *  contract being matched is English, so the contract is requested in
 *  English rather than left to the ambient environment. */
const GIT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

/** True iff `base` is itself inside a git work tree — the precondition for
 *  the ignore-rule oracle to mean anything. Synthetic test trees built under
 *  `os.tmpdir()` are not, by construction (verified once, at module load, by
 *  this module's own test); a real checkout of this plugin always is, and so
 *  is the throwaway repository `scripts/fresh-copy-check.mjs` `git init`s
 *  into its stripped-`.git` copy before running this suite there. Any OTHER
 *  reason git cannot answer — the binary missing (`ENOENT`), a corrupt
 *  repository, an unreadable ignore file, an unsupported git version — is
 *  reported loudly (throws) rather than silently treated as "no work tree
 *  here", because collapsing every failure into the same quiet fallback is
 *  the exact defect this module exists to remove from the scanners it
 *  serves. */
function isInsideGitWorkTree(base: string): boolean {
  try {
    execFileSync('git', ['-C', base, 'rev-parse', '--is-inside-work-tree'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: GIT_ENV,
    });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '');
    if (status === 128 && NOT_A_REPO_PATTERN.test(stderr)) return false;
    const message = (err as { message?: string }).message ?? String(err);
    throw new Error(
      `shipped-markdown-registry: \`git rev-parse --is-inside-work-tree\` failed unexpectedly for "${base}" ` +
        `(status ${String(status)}): ${stderr || message}. This is not the "outside any work tree" case — ` +
        'the ignore-rule oracle this module depends on could not answer at all (git missing, a corrupt ' +
        'repository, or an unreadable ignore file), so the scanners built on this module cannot say what is ' +
        'shipped. Fix git\'s availability/state rather than treating this as "nothing excluded".',
    );
  }
}

/**
 * The set of `relPaths` (forward-slash, relative to `base`) that git's
 * ignore rules — the ones actually in force on disk, `.gitignore` files
 * included — currently match. Returns an empty set when `base` is not
 * inside a git work tree at all: there is no oracle to consult, so nothing
 * is excluded (see the trade-off note at the top of this file).
 *
 * Uses NUL-delimited input AND output (`-z`) rather than newline-delimited,
 * on both sides: `git check-ignore --stdin` C-quotes any path containing
 * non-ASCII bytes in its default (newline-delimited) mode — a file under
 * `café/` comes back as `"caf\303\251/copy.md"`, which then fails to match
 * this module's own unquoted, unescaped relative paths from `listAllMarkdownFiles`,
 * so a genuinely-ignored non-ASCII path would be wrongly kept as "shipped".
 * `-z` disables that quoting on the way out (and expects NUL, not newline,
 * as the separator on the way in), so round-tripping is byte-exact for any
 * path, ASCII or not.
 */
function gitIgnoredPaths(base: string, relPaths: string[]): Set<string> {
  if (relPaths.length === 0 || !isInsideGitWorkTree(base)) return new Set();
  try {
    const input = relPaths.map((rel) => rel + '\0').join('');
    const out = execFileSync('git', ['-C', base, 'check-ignore', '-z', '--stdin'], {
      input,
      encoding: 'utf8',
      env: GIT_ENV,
    });
    return new Set(out.split('\0').filter((entry) => entry.length > 0));
  } catch (err) {
    // `git check-ignore` exits 1 (an "error" to execFileSync) when NONE of
    // the given paths are ignored — that is a normal, meaningful result, not
    // a failure, and its stdout (empty) is still authoritative. Any OTHER
    // exit (a corrupt repository, an unreadable ignore file, an unsupported
    // git version, etc.) means the oracle could not answer at all, and must
    // be reported rather than silently treated as "nothing excluded" — the
    // same fail-loud narrowing as `isInsideGitWorkTree` above.
    const status = (err as { status?: number }).status;
    const stdout = (err as { stdout?: string }).stdout;
    if (status === 1) return new Set(String(stdout ?? '').split('\0').filter((entry) => entry.length > 0));
    const stderr = String((err as { stderr?: Buffer | string }).stderr ?? '');
    const message = (err as { message?: string }).message ?? String(err);
    throw new Error(
      `shipped-markdown-registry: \`git check-ignore -z --stdin\` failed unexpectedly for "${base}" ` +
        `(status ${String(status)}): ${stderr || message}. The ignore-rule oracle could not answer, so the ` +
        'scanners built on this module cannot say what is shipped; this is reported rather than silently ' +
        'excluding nothing.',
    );
  }
}

/** Every `.md` file under `root` (relative to `base`), found recursively,
 *  as forward-slash relative paths. A missing root (a synthetic test tree
 *  need not populate every scanned root) simply contributes nothing — not
 *  an error. */
function listAllMarkdownFiles(base: string, root: string): string[] {
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

/**
 * Every `.md` file under `root` (relative to `base`) that is actually
 * SHIPPED — found recursively, then mechanically excluded by the ignore-rule
 * oracle above. This is the one walk every operational-prose scanner in this
 * suite is built on; scanner-specific content filtering (which surfaces
 * MENTION a given marker) happens on top of this, never instead of it.
 */
export function listShippedMarkdownFiles(base: string, root: string): string[] {
  const all = listAllMarkdownFiles(base, root);
  const ignored = gitIgnoredPaths(base, all);
  return all.filter((rel) => !ignored.has(rel));
}

/**
 * Every `.md` file under any of `roots` (relative to `base`) that is
 * shipped — the convenience form every scanner's `deriveRegistry` calls
 * before applying its own content filter.
 */
export function listShippedMarkdownFilesUnderRoots(base: string, roots: readonly string[]): string[] {
  return roots.flatMap((root) => listShippedMarkdownFiles(base, root));
}
