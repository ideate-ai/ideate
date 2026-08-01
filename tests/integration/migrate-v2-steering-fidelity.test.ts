// plugin/tests/integration/migrate-v2-steering-fidelity.test.ts — proves the
// migrate-v2 fix against a COPY of a genuinely lossy v2 project.
//
// scripts/migrate-v2/migrate.mjs:269-286 used to know only the OLDEST v2
// field name per kind (`name`+`description` for principles, `title`+`rule`
// for policies). Every fixture YAML file below is a VERBATIM copy — byte for
// byte, not paraphrased — of a real file from one of the six projects the
// defect measurably degraded (hamlet) or from this project's own pre-v3
// archive (the `title`+`body` principle/constraint drift hamlet never
// exhibited but this project did). Each one reproduces a DIFFERENT field-name
// generation the old migrator could not read:
//   P-01  policy, description-only (no title, no rule)   -> old: EMPTY
//   P-16  policy, title + body                            -> old: TITLE-ONLY
//   P-22  policy, title + statement                        -> old: TITLE-ONLY
//   P-25  policy, title + policy (rare 5th field name)     -> old: TITLE-ONLY
//   GP-01 principle, name + description (multi-line block) -> old: correct
//         already (kept as a control: the old code DID handle this pair)
//   GP-20 principle, title + body                          -> old: EMPTY
//   C-01  constraint, category + description                -> old: correct
//         already (control)
//   C-23  constraint, category + body                        -> old: EMPTY
//
// The oracle for "did the fix actually restore the text" is NOT a re-derived
// join expression — it is an INDEPENDENT read of the same on-disk YAML fixture
// (js-yaml, imported here, never migrate.mjs's code) asserting the exact
// operative-field string is a substring of what got persisted (P-40: exercise
// the failure path, assert against an independent oracle, the v2 YAML source).
//
// All work happens in a mkdtemp project root; the real .ideate/ is never
// touched, and the six real external projects are never read from at test
// time (the fixtures are frozen copies, so this test is hermetic).

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSteeringItem } from '../../src/steering/schema.js';

const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url));
const MIGRATE_V2_DIR = join(PLUGIN_DIR, 'scripts', 'migrate-v2');
const MIGRATE_SCRIPT = join(MIGRATE_V2_DIR, 'migrate.mjs');
const DIST_STORE = join(PLUGIN_DIR, 'dist', 'record', 'store.js');

// The oracle parser: migrate-v2's OWN js-yaml (a dependency of that workspace
// member, not of the plugin — importing it here rather than adding a new
// plugin dependency), loaded dynamically since this file is a .ts module and
// js-yaml is not on the plugin's own import graph. Resolved via Node's own
// CJS resolution algorithm anchored at MIGRATE_V2_DIR (createRequire), the
// same walk-up-through-node_modules that migrate.mjs's own bare `import
// yaml from 'js-yaml'` relies on — NOT a hardcoded
// `scripts/migrate-v2/node_modules/js-yaml/...` path. That matters because
// where js-yaml physically lands differs by package manager now that
// scripts/migrate-v2 is a workspace member: pnpm's default strict linking
// nests it under scripts/migrate-v2/node_modules, npm's default hoisting
// puts it at the plugin's own top-level node_modules instead. Anchoring the
// resolution at MIGRATE_V2_DIR (rather than importing a bare 'js-yaml'
// specifier from this file's own location in tests/) finds it correctly
// either way, exactly like a real consumer of that package would.
let yamlLoad: (raw: string) => unknown;

// -- fixtures: verbatim byte copies of real v2 YAML (see header) -----------

const FIXTURES: Record<'principles' | 'constraints' | 'policies', Record<string, string>> = {
  policies: {
    'P-01.yaml': `id: P-01
type: domain_policy
domain: visualization
status: active
derived_from: []
established: planning phase
amended: null
description: "Agents are \`@\` characters. Colors indicate type (researcher=cyan, coder=yellow, architect=magenta, tester=blue, general=white). Terrain uses standard roguelike symbols (\`.\` floor, \`#\` wall)."
cycle_created: 1
cycle_modified: null
content_hash: "5e3830469457c69135e5bc1c95ac99060bedf7dd2b008fb4ca177ac7726a85b0"
token_count: 107
file_path: .ideate/policies/P-01.yaml
`,
    'P-16.yaml': `id: P-16
type: domain_policy
designation: P-16
domain: data-model
title: Village centers must be on passable terrain
body: Any code path that sets or updates \`village.center\` must verify the position is passable terrain before accepting it. \`_recalculate_village_center\` computes the floor-division centroid of structure positions — this centroid is not guaranteed to land on a passable cell. Before assigning the centroid, check \`self._terrain_grid.is_passable(new_center)\` and keep the existing center if the centroid is impassable. This applies to \`_recalculate_village_center\`, the fallback \`Position(0, 0)\` in \`_find_village_position\`, and any future center-update path.
citation: Cycle 1 code-reviewer C1; journal-keeper Q1
cycle_modified: null
content_hash: 25ace2372b00e20a11797f61548f5dbb2dceff5289ae8d54c971abbdb10103b0
token_count: 187
`,
    'P-22.yaml': `id: P-22
type: domain_policy
title: Stage advancement must happen in exactly one place
statement: Stage-advancement logic (threshold check, work_units reset, stage increment) must live exclusively in StructureUpdater.update_structures. add_work_units must only accumulate work units and must never advance stage.
rationale: Duplicate advancement in both add_work_units and StructureUpdater.update_structures causes the branching code path to be unreachable. add_work_units advances stage 2->3 on the PostToolUse event; by the next simulation tick StructureUpdater sees stage>=3 and skips advancement entirely, so branching logic in StructureUpdater (if new_stage==3 and branches) never fires.
domain: stage-progression
citations:
  - cycle 2 code-quality C1
  - cycle 2 gap-analysis EC1
cycle_created: 2
status: active
cycle_modified: 1
content_hash: e3debc10ce4f61f25dc8e9efcfa412cf4063dcb69a5a0d35badc6a254f2102b8
token_count: 209
`,
    'P-25.yaml': `id: P-25
type: domain_policy
domain: review-infrastructure
title: Review subagent environment must include ripgrep
policy: Review subagents (spec-reviewer, gap-analyst, code-reviewer) require ripgrep (rg) to be available in their execution environment. Ripgrep absence silently degrades the review by preventing two of three reviewers from executing.
derived_from: D-44
cycle_established: 1
status: active
cycle_modified: 1
content_hash: e34fd8799bd42c06385015fdc24735b2e4151e219654c0f69d0ec64cee3649f0
token_count: 106
`,
  },
  principles: {
    'GP-01.yaml': `id: GP-01
type: guiding_principle
name: Visual Interest Over Accuracy
status: active
description: |
  The primary goal is a fun, visually engaging idle game. Agent activity should produce frenetic, interesting visuals. Debounce similar actions to prevent visual spam, but otherwise allow high event throughput to create activity. When in doubt, choose the option that makes the screen more interesting to watch.

  **Why:** User explicitly stated "more work in claude code to yield a more visually interesting and frenetic screen." The idle game is the primary interface; observability is a future benefit.

  **How to apply:** When designing event handling, prefer real-time visual feedback over queued/aggregate display. When mapping tools to actions, prioritize visual variety over semantic precision.
amendment_history: []
cycle_created: 1
cycle_modified: null
content_hash: "2273c19866f1f101d01bebe7b57bdd3b7b1c800a78cf214ccb9371beb92d7083"
token_count: 231
file_path: .ideate/principles/GP-01.yaml
`,
    'GP-20.yaml': `id: GP-20
type: guiding_principle
designation: GP-20
title: Datastore as Standalone Entity
status: active
cycle_created: 5
body: "The datastores ideate OWNS — the append-only process RECORD and the work-state BOARD — are first-class, legible data products, not app-private persistence behind an interface. Implications: (1) their on-disk / in-DB representation is itself a contract."
rationale: Stated by SME 2026-07-01 during the edges-first-class refinement.
amendment_history: []
cycle_modified: 16
content_hash: 92f94471b46d0e2703e56cbcb6929a21f694381139ac2a5d8f7616bda8920e60
token_count: 503
`,
  },
  constraints: {
    'C-01.yaml': `id: C-01
type: constraint
category: scope
status: active
description: MVP focus. The first iteration must be usable and demonstrate core functionality. Visual polish and iteration are expected, but the foundation must work.
cycle_created: 1
cycle_modified: null
content_hash: "0b5f1cc7c7bc49ce71a25f3616a3164f1eb54d04b7f1798f140edfbb7b203e17"
token_count: 81
file_path: .ideate/constraints/C-01.yaml
`,
    'C-23.yaml': `id: C-23
type: constraint
designation: C-23
category: design
status: deprecated
cycle_created: 5
body: "Bounded graph retrieval. Every edge- or graph-retrieval API in the Backend contract MUST carry result-size limits and pagination (limit + cursor)."
rationale: "SME directive 2026-07-01."
cycle_modified: 16
content_hash: 18ab2bfeb180635f9af5a8775b669b3026d9850a24aefe7b6e8ac79517ee45d5
token_count: 353
`,
  },
};

let projectRoot: string;
const extraRoots: string[] = [];

function readSteeringItems(root: string): Map<string, ReturnType<typeof parseSteeringItem>> {
  const dir = join(root, '.ideate', 'steering');
  const out = new Map<string, ReturnType<typeof parseSteeringItem>>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const item = parseSteeringItem(readFileSync(join(dir, name), 'utf8'));
    out.set(item.id, item);
  }
  return out;
}

/** Independent oracle: read the raw operative field straight off the fixture
 *  YAML on disk, via js-yaml — never via migrate.mjs's own logic. */
function sourceField(root: string, subdir: string, file: string, field: string): string {
  const raw = readFileSync(join(root, '.ideate', subdir, file), 'utf8');
  const parsed = yamlLoad(raw) as Record<string, unknown>;
  const v = parsed[field];
  if (typeof v !== 'string') throw new Error(`fixture ${subdir}/${file} has no string field "${field}"`);
  return v.trim();
}

describe('migrate-v2 steering fix: run against a copy of a lossy v2 project, diff against its YAML sources', () => {
  beforeAll(async () => {
    if (!existsSync(DIST_STORE)) {
      execFileSync(join(PLUGIN_DIR, 'node_modules', '.bin', 'tsc'), ['-b'], { cwd: PLUGIN_DIR, stdio: 'pipe' });
    }
    const migrateV2Require = createRequire(join(MIGRATE_V2_DIR, 'package.json'));
    const jsYamlDir = dirname(migrateV2Require.resolve('js-yaml/package.json'));
    const yamlModule = (await import(pathToFileURL(join(jsYamlDir, 'dist', 'js-yaml.mjs')).href)) as {
      load: (raw: string) => unknown;
    };
    yamlLoad = yamlModule.load;
    projectRoot = mkdtempSync(join(tmpdir(), 'ideate-migrate-v2-fidelity-'));
    extraRoots.push(projectRoot);
    for (const [subdir, files] of Object.entries(FIXTURES)) {
      const dir = join(projectRoot, '.ideate', subdir);
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    }
  });

  afterAll(() => {
    while (extraRoots.length > 0) {
      const dir = extraRoots.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates every fixture cleanly (exit 0, zero errors)', () => {
    const res = spawnSync('node', [MIGRATE_SCRIPT, projectRoot], { encoding: 'utf8' });
    expect(res.status, `stderr: ${res.stderr}\nstdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).not.toMatch(/ERRORS/);
    expect(res.stdout).toContain('steering: 8');
  });

  it('P-01 (description-only, no title/rule): old migrator produced EMPTY — fixed produces the full description', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('P-01');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement.trim().length).toBeGreaterThan(0);
    expect(item.statement).toContain(sourceField(projectRoot, 'policies', 'P-01.yaml', 'description'));
    expect(item.domain).toBe('visualization');
    expect(item.status).toBe('active');
  });

  it('P-16 (title + body): old migrator produced TITLE-ONLY — fixed carries the full body, not just the title', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('P-16');
    expect(item).toBeDefined();
    if (item === undefined) return;
    const title = 'Village centers must be on passable terrain';
    expect(item.statement).not.toBe(title);
    expect(item.statement).toContain(sourceField(projectRoot, 'policies', 'P-16.yaml', 'body'));
  });

  it('P-22 (title + statement): fixed migrator reads the `statement` field, not just the title', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('P-22');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement).toContain(sourceField(projectRoot, 'policies', 'P-22.yaml', 'statement'));
  });

  it('P-25 (title + the rare `policy` field): fixed migrator reads it too — not in the spec\'s literal field list, found by enumerating real data', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('P-25');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement).toContain(sourceField(projectRoot, 'policies', 'P-25.yaml', 'policy'));
  });

  it('GP-01 (name + description, multi-line block): the pair the OLD migrator already handled — still correct (control)', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('GP-01');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement).toContain(sourceField(projectRoot, 'principles', 'GP-01.yaml', 'description'));
    expect(item.statement.startsWith('Visual Interest Over Accuracy:')).toBe(true);
  });

  it('GP-20 (title + body, principle): old migrator produced EMPTY (name+description lookup both missed) — fixed restores the body', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('GP-20');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement.trim().length).toBeGreaterThan(0);
    expect(item.statement).toContain(sourceField(projectRoot, 'principles', 'GP-20.yaml', 'body'));
  });

  it('C-01 (category + description): the pair the OLD migrator already handled — still correct (control)', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('C-01');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement).toBe(sourceField(projectRoot, 'constraints', 'C-01.yaml', 'description'));
    expect(item.domain).toBe('scope');
  });

  it('C-23 (category + body, constraint): old migrator produced EMPTY — fixed restores the body', () => {
    const items = readSteeringItems(projectRoot);
    const item = items.get('C-23');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(item.statement.trim().length).toBeGreaterThan(0);
    expect(item.statement).toBe(sourceField(projectRoot, 'constraints', 'C-23.yaml', 'body'));
    expect(item.status).toBe('deprecated');
  });
});

describe('migrate-v2 steering fix: loud failure when NO operative field is present', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ideate-migrate-v2-no-field-'));
    extraRoots.push(root);
    mkdirSync(join(root, '.ideate', 'policies'), { recursive: true });
    // Synthetic: a policy with a title but NONE of the five known operative
    // field names — the case the old code would have silently reduced to the
    // bare title, and the fixed code must refuse to write at all.
    writeFileSync(
      join(root, '.ideate', 'policies', 'P-99.yaml'),
      'id: P-99\ntype: domain_policy\ntitle: Orphaned policy with no operative text field\nstatus: active\n',
    );
  });

  it('skips the item, reports it loudly as an error, and never writes it (not even title-only)', () => {
    const res = spawnSync('node', [MIGRATE_SCRIPT, root], { encoding: 'utf8' });
    expect(res.status).toBe(0); // migration itself still completes for the rest of the project
    expect(res.stderr).toContain('P-99');
    expect(res.stderr).toContain('no operative text field found');
    expect(res.stdout).toMatch(/ERRORS: 1/);
    const items = readSteeringItems(root);
    expect(items.has('P-99')).toBe(false);
  });
});
