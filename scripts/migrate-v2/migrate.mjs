#!/usr/bin/env node
// migrate.mjs — ephemeral one-shot migrator from the ideate v2 `.ideate/` YAML
// store to the v3 stores (process record + work board + steering).
//
// Posture:
//   - NON-DESTRUCTIVE: reads the v2 `.ideate/` artifacts, writes NEW v3 stores
//     alongside (.ideate/record/, .ideate/steering/, .ideate-work/board.db).
//     It never edits or deletes a v2 file. Reversible: delete the v3 output.
//   - ONE-SHOT: drops a `.ideate/.migrated-to-v3.json` sentinel; re-running is
//     refused unless --force (records/board are append/insert, so a second run
//     would duplicate them).
//   - TIMESTAMP-FAITHFUL: each store is built with a clock pinned to the source
//     artifact's own time (its `date` field, else the file mtime), so ULID time
//     bits and created_at/updated_at/timestamp reflect the original.
//
// Usage:
//   node migrate.mjs <projectRoot> [<projectRoot> ...] [--dry-run] [--force]
//
// Mapping:
//   principles/GP-*      -> steering guiding-principle
//   constraints/C-*      -> steering constraint
//   policies/P-*         -> steering policy
//   work-items (pending) -> board items (topo-ordered; phases become parents)
//   work-items (done)    -> record kind=task-completion
//   decisions/D-*        -> record kind=decision
//   questions/Q-*        -> record kind=question
//   cycles/*/findings    -> record kind=finding
//   cycles/*/journal     -> record kind=journal
//   cycles/*/summary + review files -> record kind=cycle-summary
//   modules/, plan/, projects/, orphan phases/ -> record kind=design
//   interviews/          -> record kind=interview
//   steering/research/   -> record kind=research
//   index.db, autopilot_state, domains/index -> skipped (derived / transient)

import fs from 'node:fs';
import { join, resolve, basename, dirname, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

import { RecordStore } from '../../dist/record/store.js';
import { TelemetryCounters } from '../../dist/telemetry/counters.js';
import { WorkStateStore } from '../../dist/work-state/store.js';
import { WorkStateVerbs } from '../../dist/work-state/verbs.js';
import { SteeringStore } from '../../dist/steering/store.js';

// --------------------------------------------------------------------------
// args
// --------------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const roots = argv.filter((a) => !a.startsWith('--')).map((a) => resolve(a));
if (roots.length === 0) {
  console.error('usage: node migrate.mjs <projectRoot> [<projectRoot> ...] [--dry-run] [--force]');
  process.exit(2);
}

const DONE_STATUSES = new Set(['done', 'obsolete', 'complete', 'completed', 'cancelled', 'canceled', 'settled', 'resolved']);
const SENTINEL = '.migrated-to-v3.json';

// --------------------------------------------------------------------------
// small helpers
// --------------------------------------------------------------------------
const isYaml = (f) => extname(f) === '.yaml' || extname(f) === '.yml';
const listYaml = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(isYaml).map((f) => join(dir, f)) : []);
const base = (f) => basename(f).replace(/\.[^.]+$/, '');

// Parse-failure sink: any file that fails to parse is captured here (with its
// raw text) and salvaged into a record at the end, so malformed source YAML
// never means silent data loss. Set per-project before any parse.
let currentFailures = null;

function readYaml(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return yaml.load(raw) ?? null;
  } catch (err) {
    // PyYAML (which wrote the v2 files) is lenient; js-yaml is spec-strict. The
    // common breakage: a plain scalar value that STARTS with a reserved
    // indicator — backtick or @ (e.g. `title: `fn()` ...`) — which the YAML
    // spec forbids. Quote those mapping values and retry before giving up.
    try {
      const fixed = raw
        .split('\n')
        .map((line) => {
          // `key: `value`  — mapping value starting with an indicator a plain
          // scalar may not begin with: backtick, @, or `- ` (a dash+space is
          // the block-sequence indicator, so `desc: - foo` is really a scalar).
          let m = line.match(/^(\s*[\w.-]+:)[ \t]+((?:[`@]|-[ \t]).*)$/);
          if (m) return `${m[1]} ${JSON.stringify(m[2])}`;
          // `- `value`     (sequence entry starting with a reserved indicator)
          m = line.match(/^(\s*-)[ \t]+([`@].*)$/);
          if (m) return `${m[1]} ${JSON.stringify(m[2])}`;
          return line;
        })
        .join('\n');
      const val = yaml.load(fixed);
      if (val != null) return val;
    } catch {
      /* fall through to salvage */
    }
    console.error(`  ! could not parse ${file}: ${err.message} (salvaging raw)`);
    if (currentFailures) currentFailures.push({ file, raw });
    return null;
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtime;
  } catch {
    return new Date();
  }
}

/** Source timestamp: an explicit date-ish field if valid, else the file mtime. */
function tsOf(obj, file) {
  for (const key of ['date', 'established', 'started_date', 'completed_date']) {
    const v = obj?.[key];
    if (typeof v === 'string' || v instanceof Date) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return mtimeOf(file);
}

/** Coerce a v2 status onto the v3 steering status set. */
function steeringStatus(s) {
  const v = String(s ?? '').toLowerCase();
  if (v === 'deprecated') return 'deprecated';
  if (v === 'superseded') return 'superseded';
  return 'active';
}

/** Make a steering id filename-safe: [A-Za-z0-9][A-Za-z0-9._-]* */
function safeId(id, fallback) {
  let s = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
  if (!/^[A-Za-z0-9]/.test(s)) s = `x-${s}`;
  return s.length > 0 ? s : fallback;
}

/** Render an object's meaningful fields as YAML, dropping v2 bookkeeping noise. */
function renderYaml(obj) {
  const drop = new Set(['content_hash', 'token_count', 'cycle_created', 'cycle_modified']);
  const clean = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (!drop.has(k)) clean[k] = v;
  return yaml.dump(clean, { lineWidth: 100, noRefs: true }).trimEnd();
}

const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
const clamp = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

// --------------------------------------------------------------------------
// per-project migration
// --------------------------------------------------------------------------
function migrateProject(root) {
  const v2 = join(root, '.ideate');
  console.log(`\n=== ${root} ===`);
  if (!fs.existsSync(v2)) {
    console.log('  no .ideate/ — skipping');
    return;
  }
  const sentinelPath = join(v2, SENTINEL);
  if (fs.existsSync(sentinelPath) && !FORCE) {
    console.log(`  already migrated (${SENTINEL} present) — use --force to re-run`);
    return;
  }

  // Resolve v3 target paths, honoring an existing .ideate.json if present.
  let recordRel = '.ideate/record/';
  let workRel = '.ideate-work/';
  const cfgFile = join(root, '.ideate.json');
  if (fs.existsSync(cfgFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      if (c?.record?.path) recordRel = c.record.path;
      if (c?.work_state?.path) workRel = c.work_state.path;
    } catch {
      /* fall back to defaults */
    }
  }
  const config = { schema_version: 10, record: { path: recordRel }, work_state: { path: workRel }, backend: 'local' };
  const boardDbPath = join(resolve(root, workRel), 'board.db');
  const telemetry = new TelemetryCounters(join(root, '.ideate-telemetry'), () => new Date());

  let actor = { human: 'migration' };
  try {
    const name = execFileSync('git', ['-C', root, 'config', 'user.name'], { encoding: 'utf8' }).trim();
    if (name) actor = { human: name };
  } catch {
    /* keep default */
  }

  const counts = { steering: 0, board: 0, records: {}, errors: 0 };
  const failures = [];
  currentFailures = failures;
  const bump = (bucket, kind) => {
    if (bucket === 'records') counts.records[kind] = (counts.records[kind] ?? 0) + 1;
    else counts[bucket] += 1;
  };

  // -- store factories, each clock-pinned to a source timestamp --
  const recStore = (ts) => new RecordStore(config, root, telemetry, () => new Date(ts));
  const steerStore = (ts) => new SteeringStore(root, () => new Date(ts));
  const boardVerbs = (ts) => new WorkStateVerbs(new WorkStateStore(boardDbPath, () => new Date(ts)), () => new Date(ts));

  const appendRecord = ({ kind, claim = '', anchor = '', scope = '', content = '', ts, taskId, references = [] }) => {
    bump('records', kind);
    if (DRY) return;
    const res = recStore(ts).append({
      kind,
      claim: String(claim ?? ''),
      verification_anchor: String(anchor ?? ''),
      scope: String(scope ?? ''),
      source: {
        capture_point: 'migration:v2->v3',
        session_id: 'migrate-v2v3',
        ...(taskId ? { task_id: String(taskId) } : {}),
        timestamp: new Date(ts).toISOString(),
      },
      references,
      content: String(content ?? ''),
    });
    if (!res.ok) {
      console.error(`  ! record[${kind}] failed: ${res.reason}`);
      counts.errors += 1;
    }
  };

  const putSteering = ({ id, kind, statement = '', domain = '', status = 'active', ts }) => {
    bump('steering');
    if (DRY) return;
    const res = steerStore(ts).put({ id: safeId(id, kind), kind, statement: String(statement ?? ''), domain: String(domain ?? ''), status });
    if (!res.ok) {
      console.error(`  ! steering[${id}] failed: ${res.reason}`);
      counts.errors += 1;
    }
  };

  const createItem = ({ title, spec, spec_format = 'ideate-v2/work-item', depends_on = [], parent_id = null, ts }) => {
    if (DRY) {
      counts.board += 1;
      return { id: `DRY-${counts.board}` };
    }
    try {
      const item = boardVerbs(ts).create({
        title: title && title.length > 0 ? title : '(untitled)',
        spec: spec && spec.length > 0 ? spec : '(no spec)',
        spec_format,
        depends_on,
        parent_id: parent_id ?? null,
        created_by: actor,
      });
      counts.board += 1;
      return item;
    } catch (err) {
      console.error(`  ! board create "${clamp(title ?? '', 60)}" failed: ${err.message}`);
      counts.errors += 1;
      return null;
    }
  };

  // ---- 1. steering: principles / constraints / policies ----
  //
  // The v2 YAML schema drifted across cycles and projects — the SAME logical
  // field ("the rule/principle's operative prose") shipped under different
  // key names at different times. The sets below are ENUMERATED from the v2
  // YAML actually observed across every migrated project (this project's own
  // pre-v3 archive plus hamlet, context-coop, outpost, ideate-infra,
  // guardrail, moodring), not guessed:
  //   - principles/constraints label: `name` (oldest) | `title` (newer)
  //   - principles/constraints body:  `description` (oldest) | `body` (newer)
  //   - policies label:               `title` (common) | `name` (rare)
  //   - policies body:                `rule` (oldest) | `statement` |
  //                                    `body` | `description` | `policy`
  // A prior version of this migrator knew only the OLDEST name in each pair
  // (`name`/`description` for principles, `title`/`rule` for policies) — any
  // item written under a newer name silently produced an empty or
  // title-only statement, which the store accepted without complaint. That
  // defect emptied 21 of 63 active steering items in this project alone.
  //
  // firstNonEmpty never falls back to a title/label as if it were the body —
  // that would silently rename the defect (title-only) rather than fix it.
  // No operative field found is now a LOUD, itemized failure: the item is
  // skipped (not written with empty/title-only text) and counted as an
  // error, so a migration that hits this can never look silently clean.
  const firstNonEmpty = (o, keys) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim().length > 0) return v;
    }
    return null;
  };
  const PRINCIPLE_BODY_FIELDS = ['description', 'body'];
  const CONSTRAINT_BODY_FIELDS = ['description', 'body'];
  const POLICY_BODY_FIELDS = ['rule', 'statement', 'body', 'description', 'policy'];

  for (const f of listYaml(join(v2, 'principles'))) {
    const o = readYaml(f);
    if (!o) continue;
    const id = o.id ?? base(f);
    const label = o.name ?? o.title ?? '';
    const body = firstNonEmpty(o, PRINCIPLE_BODY_FIELDS);
    if (body === null) {
      console.error(`  ! principle ${id}: no operative text field found (checked ${PRINCIPLE_BODY_FIELDS.join(', ')}) — skipping, NOT writing an empty/title-only statement`);
      counts.errors += 1;
      continue;
    }
    const statement = [label, body].filter(Boolean).join(': ');
    putSteering({ id, kind: 'guiding-principle', statement, domain: '', status: steeringStatus(o.status), ts: tsOf(o, f) });
  }
  for (const f of listYaml(join(v2, 'constraints'))) {
    const o = readYaml(f);
    if (!o) continue;
    const id = o.id ?? base(f);
    const body = firstNonEmpty(o, CONSTRAINT_BODY_FIELDS);
    if (body === null) {
      console.error(`  ! constraint ${id}: no operative text field found (checked ${CONSTRAINT_BODY_FIELDS.join(', ')}) — skipping, NOT writing an empty statement`);
      counts.errors += 1;
      continue;
    }
    putSteering({ id, kind: 'constraint', statement: body, domain: o.category ?? '', status: steeringStatus(o.status), ts: tsOf(o, f) });
  }
  for (const f of listYaml(join(v2, 'policies'))) {
    const o = readYaml(f);
    if (!o) continue;
    const id = o.id ?? base(f);
    const label = o.title ?? o.name ?? '';
    const body = firstNonEmpty(o, POLICY_BODY_FIELDS);
    if (body === null) {
      console.error(`  ! policy ${id}: no operative text field found (checked ${POLICY_BODY_FIELDS.join(', ')}) — skipping, NOT writing an empty/title-only statement`);
      counts.errors += 1;
      continue;
    }
    const statement = [label, body].filter(Boolean).join(': ');
    putSteering({ id, kind: 'policy', statement, domain: o.domain ?? '', status: steeringStatus(o.status), ts: tsOf(o, f) });
  }

  // ---- 2. decisions / questions ----
  for (const f of listYaml(join(v2, 'decisions'))) {
    const o = readYaml(f);
    if (!o) continue;
    const content = [
      `Decision: ${o.decision ?? o.title ?? ''}`,
      o.rationale ? `\nRationale: ${o.rationale}` : '',
      o.domain ? `\nDomain: ${o.domain}` : '',
      o.source ? `\nSource: ${o.source}` : '',
      o.supersedes ? `\nSupersedes (v2): ${o.supersedes}` : '',
      o.status ? `\nStatus: ${o.status}` : '',
    ].join('');
    appendRecord({ kind: 'decision', claim: firstLine(o.decision ?? o.title ?? o.id), anchor: o.source ?? '', scope: o.domain ?? '', content, ts: tsOf(o, f) });
  }
  for (const f of listYaml(join(v2, 'questions'))) {
    const o = readYaml(f);
    if (!o) continue;
    const content = [
      `Question: ${o.question ?? o.title ?? ''}`,
      o.impact ? `\nImpact: ${o.impact}` : '',
      o.status ? `\nStatus: ${o.status}` : '',
      o.resolution_note ? `\nResolution: ${o.resolution_note}` : '',
      Array.isArray(o.addressed_by) && o.addressed_by.length ? `\nAddressed by: ${o.addressed_by.join(', ')}` : '',
    ].join('');
    appendRecord({ kind: 'question', claim: firstLine(o.question ?? o.title ?? o.id), scope: o.domain ?? '', content, ts: tsOf(o, f) });
  }

  // ---- 3. cycles: summaries / review files / findings / journal ----
  const cyclesDir = join(v2, 'cycles');
  if (fs.existsSync(cyclesDir)) {
    for (const cyc of fs.readdirSync(cyclesDir).sort()) {
      const cdir = join(cyclesDir, cyc);
      if (!fs.statSync(cdir).isDirectory()) continue;
      const cycleScope = `cycle-${cyc}`;
      // top-level cycle-summary + review files (all type cycle_summary in v2)
      for (const name of ['summary', 'code-quality', 'spec-adherence', 'gap-analysis', 'decision-log', 'review-manifest']) {
        const f = join(cdir, `${name}.yaml`);
        if (!fs.existsSync(f)) continue;
        const o = readYaml(f);
        if (!o) continue;
        appendRecord({
          kind: 'cycle-summary',
          claim: `${name} (cycle ${o.cycle ?? cyc})`,
          anchor: o.reviewer ? `reviewer:${o.reviewer}${o.verdict ? `; verdict:${o.verdict}` : ''}` : o.verdict ? `verdict:${o.verdict}` : '',
          scope: cycleScope,
          content: o.content ?? renderYaml(o),
          ts: tsOf(o, f),
        });
      }
      for (const f of listYaml(join(cdir, 'findings'))) {
        const o = readYaml(f);
        if (!o) continue;
        appendRecord({
          kind: 'finding',
          claim: firstLine(o.content) || o.id || base(f),
          anchor: [o.verdict ? `verdict:${o.verdict}` : '', o.reviewer ? `reviewer:${o.reviewer}` : ''].filter(Boolean).join('; '),
          scope: o.work_item ?? cycleScope,
          content: o.content ?? renderYaml(o),
          taskId: o.work_item,
          ts: tsOf(o, f),
        });
      }
      for (const f of listYaml(join(cdir, 'journal'))) {
        const o = readYaml(f);
        if (!o) continue;
        appendRecord({ kind: 'journal', claim: firstLine(o.title) || base(f), scope: cycleScope, content: o.content ?? renderYaml(o), ts: tsOf(o, f) });
      }
    }
  }

  // ---- 4. design-ish artifacts: modules / plan / projects / research / interviews ----
  for (const f of listYaml(join(v2, 'modules'))) {
    const o = readYaml(f);
    if (!o) continue;
    appendRecord({ kind: 'design', claim: `Module: ${o.name ?? base(f)}`, scope: o.package ?? '', content: renderYaml(o), ts: tsOf(o, f) });
  }
  const planDir = join(v2, 'plan');
  for (const f of listYaml(planDir)) {
    const o = readYaml(f);
    if (!o) continue;
    appendRecord({ kind: 'design', claim: `Plan: ${o.name ?? o.id ?? base(f)}`, content: o.summary ? `${o.summary}\n\n${renderYaml(o)}` : renderYaml(o), ts: tsOf(o, f) });
  }
  for (const f of listYaml(join(v2, 'projects'))) {
    const o = readYaml(f);
    if (!o) continue;
    appendRecord({ kind: 'design', claim: `Project: ${o.name ?? base(f)}`, scope: 'project', content: renderYaml(o), ts: tsOf(o, f) });
  }
  for (const f of listYaml(join(v2, 'steering', 'research'))) {
    const o = readYaml(f);
    if (!o) continue;
    appendRecord({ kind: 'research', claim: o.title ?? o.topic ?? base(f), content: renderYaml(o), ts: tsOf(o, f) });
  }
  for (const f of listYaml(join(v2, 'interviews'))) {
    const o = readYaml(f);
    if (!o) continue;
    appendRecord({ kind: 'interview', claim: `Interview (${o.phase ?? '?'}) ${o.date ?? ''}`.trim(), content: renderYaml(o), ts: tsOf(o, f) });
  }

  // ---- 5. work items -> board (pending) or record (done) ----
  const wiFiles = listYaml(join(v2, 'work-items'));
  const wis = wiFiles.map((f) => ({ f, o: readYaml(f) })).filter((x) => x.o && x.o.id);
  const phaseFiles = listYaml(join(v2, 'phases'));
  const phases = new Map(); // PH-id -> { o, f }
  for (const f of phaseFiles) {
    const o = readYaml(f);
    if (o && o.id) phases.set(o.id, { o, f });
  }

  const isDone = (o) => DONE_STATUSES.has(String(o.status ?? '').toLowerCase());
  const pending = wis.filter((x) => !isDone(x.o));
  const done = wis.filter((x) => isDone(x.o));
  const pendingIds = new Set(pending.map((x) => x.o.id));

  // Dependency edges vary by project: some use `depends[]`, some encode the
  // inverse `blocks[]` (X blocks Y  =>  Y depends on X), and ids may be bare
  // numbers (`002`) rather than full stems (`WI-002`). Normalize both, and
  // fold `blocks` back into a prerequisite map so no DAG is silently lost.
  const allIds = new Set(wis.map((x) => x.o.id));
  const normId = (x) => {
    const s = String(x);
    if (allIds.has(s)) return s;
    if (/^\d+$/.test(s)) {
      // Bare number (YAML parsed `002` as 2): resolve against real ids, which
      // are usually zero-padded (WI-002). Try common pad widths.
      for (const cand of [`WI-${s}`, `WI-${s.padStart(2, '0')}`, `WI-${s.padStart(3, '0')}`, `WI-${s.padStart(4, '0')}`]) {
        if (allIds.has(cand)) return cand;
      }
      return `WI-${s.padStart(3, '0')}`;
    }
    return s;
  };
  const invDeps = new Map(); // wiId -> Set(prerequisite wiIds)
  for (const { o } of wis) {
    for (const b of o.blocks ?? []) {
      const target = normId(b);
      if (!invDeps.has(target)) invDeps.set(target, new Set());
      invDeps.get(target).add(o.id);
    }
  }
  const effDeps = (o) => {
    const s = new Set();
    for (const d of o.depends ?? []) s.add(normId(d));
    for (const p of invDeps.get(o.id) ?? []) s.add(p);
    return [...s];
  };

  const composeWiSpec = (o) => {
    const parts = [`# ${o.title ?? o.id}`, ''];
    const meta = [o.work_item_type && `type: ${o.work_item_type}`, o.complexity && `complexity: ${o.complexity}`, o.domain && `domain: ${o.domain}`].filter(Boolean);
    if (meta.length) parts.push(meta.join(' | '), '');
    if (Array.isArray(o.criteria) && o.criteria.length) parts.push('## Acceptance criteria', ...o.criteria.map((c) => `- ${c}`), '');
    if (Array.isArray(o.scope) && o.scope.length) parts.push('## Scope', ...o.scope.map((s) => `- ${s.op ?? ''} ${s.path ?? s}`.trim()), '');
    if (o.notes) parts.push('## Notes', String(o.notes), '');
    if (o.resolution) parts.push('## Resolution', String(o.resolution), '');
    parts.push(`_(migrated from v2 ${o.id})_`);
    return parts.join('\n');
  };

  // done work -> task-completion records
  for (const { f, o } of done) {
    appendRecord({ kind: 'task-completion', claim: firstLine(o.title) || o.id, scope: o.domain ?? '', content: composeWiSpec(o), taskId: o.id, ts: tsOf(o, f) });
  }

  // pending work -> board, topologically ordered (deps among pending only)
  const byId = new Map(pending.map((x) => [x.o.id, x]));
  const oldToNew = new Map(); // WI-id -> new ULID
  const phaseParent = new Map(); // PH-id -> new ULID (created lazily)
  const usedPhases = new Set();

  const order = [];
  const seen = new Set();
  const temp = new Set();
  const visit = (id) => {
    if (seen.has(id) || !byId.has(id)) return;
    if (temp.has(id)) return; // cycle guard: treat as already-placed
    temp.add(id);
    for (const dep of effDeps(byId.get(id).o)) if (pendingIds.has(dep)) visit(dep);
    temp.delete(id);
    seen.add(id);
    order.push(byId.get(id));
  };
  for (const x of pending) visit(x.o.id);

  for (const { f, o } of order) {
    // ensure the phase container exists as a board parent
    let parentUlid = null;
    if (o.phase && phases.has(o.phase)) {
      if (!phaseParent.has(o.phase)) {
        const { o: po, f: pf } = phases.get(o.phase);
        const created = createItem({ title: po.title ?? po.id, spec: po.description ?? po.title ?? po.id, spec_format: 'ideate-v2/phase', ts: tsOf(po, pf) });
        if (created) phaseParent.set(o.phase, created.id);
        usedPhases.add(o.phase);
      }
      parentUlid = phaseParent.get(o.phase) ?? null;
    }
    const depends_on = effDeps(o).filter((d) => oldToNew.has(d)).map((d) => oldToNew.get(d));
    const item = createItem({ title: o.title ?? o.id, spec: composeWiSpec(o), depends_on, parent_id: parentUlid, ts: tsOf(o, f) });
    if (item) oldToNew.set(o.id, item.id);
  }

  // phases that never became a board parent (no pending children) -> design records
  for (const [id, { o, f }] of phases) {
    if (usedPhases.has(id)) continue;
    appendRecord({ kind: 'design', claim: `Phase: ${o.title ?? id}`, scope: 'phase', content: renderYaml(o), ts: tsOf(o, f) });
  }

  // ---- salvage: any file that failed to parse, preserved verbatim ----
  for (const { file, raw } of failures) {
    appendRecord({
      kind: 'salvage',
      claim: `unparseable v2 artifact: ${basename(file)}`,
      anchor: file,
      scope: basename(dirname(file)),
      content: raw,
      ts: mtimeOf(file),
    });
  }

  // ---- summary + sentinel ----
  const recTotal = Object.values(counts.records).reduce((a, b) => a + b, 0);
  const recBreak = Object.entries(counts.records).map(([k, v]) => `${k}:${v}`).join(', ');
  console.log(`  steering: ${counts.steering} | board: ${counts.board} | records: ${recTotal} (${recBreak})${counts.errors ? ` | ERRORS: ${counts.errors}` : ''}`);
  if (DRY) {
    console.log('  (dry-run — nothing written)');
    return;
  }
  fs.writeFileSync(
    sentinelPath,
    `${JSON.stringify({ migrated_at: new Date().toISOString(), tool: 'migrate-v2v3', steering: counts.steering, board: counts.board, records: counts.records, errors: counts.errors }, null, 2)}\n`,
  );
  console.log(`  wrote ${SENTINEL}`);
}

for (const root of roots) {
  try {
    migrateProject(root);
  } catch (err) {
    console.error(`  !! ${root}: ${err.stack ?? err.message}`);
  }
}
console.log('\ndone.');
