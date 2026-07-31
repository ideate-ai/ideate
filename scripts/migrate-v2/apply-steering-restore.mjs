#!/usr/bin/env node
// apply-steering-restore.mjs — the RECOMMENDED mechanism for part 3 of
// WI 01KYV4VR8WSR70F1M5KZ8Y5EQ2 (restoring the six other projects' degraded
// steering items). NOT RUN AGAINST ANY REAL PROJECT during that work item —
// prepared and dry-run-verified against a throwaway COPY only. Executing this
// for real against hamlet / context-coop / outpost / ideate-infra / guardrail
// / moodring is a SEPARATE, explicitly-authorized action.
//
// WHY THIS MECHANISM: there is no steering CLI, and MCP tools are
// session-scoped to the project the session is running in, so a live session
// cannot call steering_put against another project's store. The steering
// store IS a directory of *.md files with YAML frontmatter, so writing them
// directly is physically possible — but that bypasses the store's own
// validation (schema.ts), its amendment-history append (store.ts's put),
// and the secret-scanning gate-before-persist. This script instead imports
// the BUILT store module (dist/steering/store.js — the exact class the MCP
// tool and the CLI both construct) and calls its ONE mutable verb, `put()`,
// with `projectRoot` pointed at the TARGET project. That is the store's own
// write chokepoint, driven programmatically — not a new write path, not a
// bypass: every restore write gets the real gate, the real schema
// validation, and the real amendment-history append (so the prior
// empty/title-only statement is preserved in `history`, not erased — the
// restoration is itself an auditable amendment, never a silent rewrite).
//
// USAGE (uses restore-data-6-projects.json, prepared and verified by the
// work item's data-preparation phase):
//   node apply-steering-restore.mjs <projectSlug> --dry-run   (default; prints what WOULD happen)
//   node apply-steering-restore.mjs <projectSlug> --confirm   (actually writes — requires --confirm)
//   node apply-steering-restore.mjs --all --dry-run
//
// <projectSlug> must be one of the six keys in the data file, OR a
// --root=<path> override (used by this script's own dry-run self-test
// against a throwaway copy — never a real project path unless the operator
// supplies one deliberately).

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SteeringStore } from '../../dist/steering/store.js';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const DATA_FILE = join(SCRIPT_DIR, 'restore-data-6-projects.json');

const PROJECT_ROOTS = {
  hamlet: '/Users/dan/code/hamlet',
  'context-coop': '/Users/dan/code/context-coop',
  outpost: '/Users/dan/code/outpost',
  'ideate-infra': '/Users/dan/code/ideate-infra',
  guardrail: '/Users/dan/code/guardrail',
  moodring: '/Users/dan/code/moodring',
};

const argv = process.argv.slice(2);
const CONFIRM = argv.includes('--confirm');
const ALL = argv.includes('--all');
const rootOverrideArg = argv.find((a) => a.startsWith('--root='));
const rootOverride = rootOverrideArg ? rootOverrideArg.slice('--root='.length) : null;
const slugArg = argv.find((a) => !a.startsWith('--'));

if (!existsSync(DATA_FILE)) {
  console.error(`missing ${DATA_FILE} — run the data-preparation step first`);
  process.exit(2);
}
const data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));

function applyProject(slug, root) {
  const project = data[slug];
  if (!project || !Array.isArray(project.restore_items)) {
    console.log(`  ${slug}: no prepared restore data — skipping`);
    return { applied: 0, failed: 0 };
  }
  console.log(`\n=== ${slug} (${root}) — ${project.restore_items.length} item(s) prepared ===`);
  const store = new SteeringStore(root, () => new Date());
  let applied = 0;
  let failed = 0;
  for (const item of project.restore_items) {
    if (!CONFIRM) {
      console.log(`  [dry-run] would restore ${item.id} (${item.kind}): "${item.previously_shipped_statement}" -> ${item.restored_statement.length} chars from ${item.source_yaml_file}`);
      continue;
    }
    const res = store.put({
      id: item.id,
      kind: item.kind,
      statement: item.restored_statement,
      domain: item.domain,
      status: item.status,
    });
    if (res.ok) {
      applied += 1;
      console.log(`  restored ${item.id} (amended: ${res.amended}, history entries: ${res.item.history.length})`);
    } else {
      failed += 1;
      console.error(`  ! ${item.id} FAILED: ${res.code} ${res.reason}`);
    }
  }
  return { applied, failed };
}

const targets = ALL ? Object.keys(PROJECT_ROOTS) : slugArg ? [slugArg] : [];
if (targets.length === 0) {
  console.error('usage: node apply-steering-restore.mjs <projectSlug|--all> [--confirm] [--root=<path>]');
  process.exit(2);
}
if (!CONFIRM) console.log('DRY RUN (pass --confirm to actually write) —');

let totalApplied = 0;
let totalFailed = 0;
for (const slug of targets) {
  const root = rootOverride ?? PROJECT_ROOTS[slug];
  if (!root) {
    console.error(`  unknown project slug: ${slug}`);
    continue;
  }
  const { applied, failed } = applyProject(slug, root);
  totalApplied += applied;
  totalFailed += failed;
}
console.log(`\ndone. applied=${totalApplied} failed=${totalFailed}${CONFIRM ? '' : ' (dry run — nothing written)'}`);
