// plugin/src/record/store.test.ts — acceptance tests for the record
// store core.
//
// Pins: round-trip serialization; four-contract-fields-always-present
// enforcement; date-sharded config-resolved paths
// with ULID filename stems; the FILE-EXPORT CONTRACT the README states —
// the `YYYY/MM/{id}.md` shard is a pure function of the record id (known
// ULIDs, hand-computed expectations, a clock deliberately in another month)
// and one file holds exactly one record; gate-before-persist with a
// PLANTED SECRET asserted masked in the raw on-disk bytes; the telemetry
// wiring (capture_fired / capture_write_failed, and every
// redaction routed to the dedicated counter); typed no-throw failure on
// an unwritable directory; newest-first scope-filtered limited reads with no
// index — including the store CONTRACT an absent limit carries, "every
// matching record", held against a fixture larger than the transport's default
// page so a default leaking down into this layer fails loudly; and the
// append-only API surface (no update/delete/rank anywhere).
//
// All filesystem work happens in mkdtemp dirs — the real .ideate/ is never
// touched.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION, recordPath } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { reportFromDir } from '../telemetry/report.js';
import type { IdResolver } from '../transport/id-lint.js';
import type { Clock } from './id.js';
import { DEFAULT_RECORD_READ_LIMIT } from './read-page.js';
import { parseRecord, serializeRecord } from './schema.js';
import type { ProcessRecord } from './schema.js';
import { RecordStore } from './store.js';
import type { RecordInput } from './store.js';

const FIXED_ISO = '2026-07-09T12:00:00.000Z';

const tempDirs: string[] = [];
const permRestores: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (permRestores.length > 0) {
    const dir = permRestores.pop();
    if (dir !== undefined) chmodSync(dir, 0o755);
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  store: RecordStore;
  projectRoot: string;
  recordDir: string;
  telemetryDir: string;
  setNow: (iso: string) => void;
}

function makeFixture(resolveId?: IdResolver): Fixture {
  const projectRoot = makeTempDir('ideate-record-store-test-');
  const telemetryDir = makeTempDir('ideate-record-telemetry-test-');
  const config: IdeateConfigV3 = {
    schema_version: V3_SCHEMA_VERSION,
    record: { path: DEFAULT_RECORD_PATH }, // the literal lives in config only
    backend: 'local',
  };
  let nowIso = FIXED_ISO;
  const clock: Clock = () => new Date(nowIso);
  const telemetry = new TelemetryCounters(telemetryDir, clock);
  const store = new RecordStore(config, projectRoot, telemetry, clock, resolveId);
  return {
    store,
    projectRoot,
    recordDir: recordPath(config, projectRoot),
    telemetryDir,
    setNow: (iso) => {
      nowIso = iso;
    },
  };
}

function input(overrides?: Partial<RecordInput>): RecordInput {
  return {
    kind: 'finding',
    claim: 'The vitest fork pool must stay capped at 4 to avoid OOM.',
    verification_anchor: 'vitest.config.ts',
    scope: 'test infrastructure changes',
    source: { capture_point: 'session_end', session_id: 'sess-1', task_id: 'T-271' },
    content: 'Raising maxForks above 4 crashed a 32GB box during v2; the cap is load-bearing.',
    ...overrides,
  };
}

describe('round-trip serialization', () => {
  it('parse(serialize(record)) is identity, including hostile content', () => {
    const record: ProcessRecord = {
      id: '01JZM8Z0000000000000000000',
      kind: 'decision',
      claim: 'contains: colons, "quotes", and\nan embedded newline',
      verification_anchor: 'cmd: pnpm test -- --grep "x: y"',
      scope: '',
      source: {
        capture_point: 'commit_boundary',
        session_id: 'sess-42',
        task_id: 'T-271',
        timestamp: FIXED_ISO,
      },
      references: [],
      content: '\nLeading newline, an embedded fence:\n---\nid: "fake"\n---\nand a trailing newline\n',
    };
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it('round-trips a record with no task_id and empty fields', () => {
    const record: ProcessRecord = {
      id: '01JZM8Z0000000000000000001',
      kind: 'session-outcome',
      claim: '',
      verification_anchor: '',
      scope: '',
      source: { capture_point: 'session_end', session_id: 's', timestamp: FIXED_ISO },
      references: [],
      content: '',
    };
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it('round-trips a record carrying supersedes + a general typed edge', () => {
    const record: ProcessRecord = {
      id: '01JZM8Z0000000000000000009',
      kind: 'decision',
      claim: 'new decision replacing an old one',
      verification_anchor: '',
      scope: '',
      source: { capture_point: 'mcp:record_decision', session_id: 's', timestamp: FIXED_ISO },
      references: [
        { rel: 'supersedes', id: '01JZM8Z0000000000000000000' },
        { rel: 'relates-to', id: '01JZM8Z0000000000000000001' },
      ],
      content: '',
    };
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it('a reference-less record serializes byte-identically to the pre-references format', () => {
    // No `references:` line is emitted when the edge list is empty, so existing
    // on-disk records and reference-less writes are unchanged.
    const record: ProcessRecord = {
      id: '01JZM8Z0000000000000000002',
      kind: 'finding',
      claim: 'c',
      verification_anchor: '',
      scope: '',
      source: { capture_point: 'mcp:record_append', session_id: 's', timestamp: FIXED_ISO },
      references: [],
      content: 'body',
    };
    expect(serializeRecord(record)).not.toContain('references:');
  });

  it('appended records read back identical through the store', () => {
    const { store } = makeFixture();
    const result = store.append(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [read] = store.read();
    expect(read).toEqual(result.record);
  });
});

describe('four contract fields always present', () => {
  it('accepts empty strings — emptiness is a valid record, not a failure', () => {
    const { store } = makeFixture();
    const result = store.append(
      input({ claim: '', verification_anchor: '', scope: '', content: '' }),
    );
    expect(result.ok).toBe(true);
  });

  it.each(['claim', 'verification_anchor', 'scope', 'content', 'kind'] as const)(
    'rejects an input with %s ABSENT as a typed SCHEMA failure',
    (field) => {
      const { store, recordDir } = makeFixture();
      const bad = input() as unknown as Record<string, unknown>;
      delete bad[field];
      const result = store.append(bad as unknown as RecordInput);
      expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
      if (result.ok) return;
      expect(result.reason).toContain(field);
      // Nothing was persisted — the record tree was never even created.
      expect(existsSync(recordDir)).toBe(false);
    },
  );

  it('rejects a source missing its required members', () => {
    const { store } = makeFixture();
    const result = store.append(
      input({ source: { session_id: 'sess-1' } as unknown as RecordInput['source'] }),
    );
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
  });

  it('rejects a provided id that is not a well-formed ULID', () => {
    const { store } = makeFixture();
    const result = store.append(input({ id: 'not-a-ulid' }));
    expect(result).toMatchObject({ ok: false, code: 'SCHEMA' });
  });

  it('a parsed file missing a contract field is a schema error', () => {
    const missingClaim = [
      '---',
      'id: "01JZM8Z0000000000000000000"',
      'kind: "finding"',
      'verification_anchor: ""',
      'scope: ""',
      'source:',
      '  capture_point: "session_end"',
      '  session_id: "s"',
      '  timestamp: "2026-07-09T12:00:00.000Z"',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    expect(() => parseRecord(missingClaim)).toThrow(/claim/);
  });
});

describe('date-sharded config-resolved paths', () => {
  it('writes to record.path/YYYY/MM/{ulid}.md derived from the injected clock', () => {
    const { store, recordDir } = makeFixture();
    const result = store.append(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Fixed clock: 2026-07-09T12:00Z → shard 2026/07; filename stem = ULID.
    expect(result.path).toBe(join(recordDir, '2026', '07', `${result.record.id}.md`));
    expect(readFileSync(result.path, 'utf8')).toContain(`id: ${JSON.stringify(result.record.id)}`);
  });

  it('honors a custom configured record.path via the config resolver', () => {
    const projectRoot = makeTempDir('ideate-record-custompath-test-');
    const telemetryDir = makeTempDir('ideate-record-telemetry-test-');
    const clock: Clock = () => new Date(FIXED_ISO);
    const config: IdeateConfigV3 = {
      schema_version: V3_SCHEMA_VERSION,
      record: { path: 'notes/record/' },
      backend: 'local',
    };
    const store = new RecordStore(config, projectRoot, new TelemetryCounters(telemetryDir, clock), clock);
    const result = store.append(input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(projectRoot, 'notes', 'record', '2026', '07', `${result.record.id}.md`));
  });
});

describe('the file-export contract: the shard path is a pure function of the record id', () => {
  // WHY this block exists: the record FILES — not `record_read` — are the
  // durable export surface an external consumer (e.g. a knowledge-graph
  // ingester) reads WITHOUT ideate running, and the README states that
  // contract in prose. Prose drifts; this pins the behaviour the prose
  // promises: `<record.path>/YYYY/MM/{id}.md`, addressable from the id ALONE
  // (no store, no clock, no index needed to compute where a record lives),
  // one record per file. Change the derivation in store.append and these
  // fail — which is the point.

  /**
   * Known ULIDs with their hand-computed mint dates. The stems are literal on
   * purpose: deriving the expected year/month with parseUlidTimestamp here
   * would just re-run the store's own arithmetic and assert nothing. Every
   * one of these mints in a DIFFERENT month from the fixture clock
   * (2026-07), so a shard taken from the wall clock cannot pass.
   */
  const KNOWN_IDS: readonly { id: string; iso: string; year: string; month: string }[] = [
    { id: '01DRXD2DS0000000000000000A', iso: '2019-11-05T09:07:00.000Z', year: '2019', month: '11' },
    { id: '01DT7KMT20000000000000000B', iso: '2019-11-21T18:30:00.000Z', year: '2019', month: '11' },
    // Just past midnight UTC on New Year: the shard follows the id's UTC
    // instant, so a derivation that used local time would land in 2019/12.
    { id: '01DXF84QT0000000000000000C', iso: '2020-01-01T00:30:00.000Z', year: '2020', month: '01' },
    // Leap day, last millisecond — zero-padded month, no rollover.
    { id: '01HQVMZ0ZZ000000000000000D', iso: '2024-02-29T23:59:59.999Z', year: '2024', month: '02' },
  ];

  it.each(KNOWN_IDS)(
    'id $id (minted $iso) lands at exactly <root>/$year/$month/{id}.md',
    ({ id, year, month }) => {
      const { store, recordDir } = makeFixture(); // clock fixed at 2026-07
      const result = store.append(input({ id }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expected = join(recordDir, year, month, `${id}.md`);
      expect(result.path).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      // The path an external reader would compute from the id alone — with no
      // store instance in the loop — is the path the file is actually at.
      expect(readdirSync(join(recordDir, year, month))).toEqual([`${id}.md`]);
      // …and the shard is the id's month, never the clock's (2026/07).
      expect(existsSync(join(recordDir, '2026'))).toBe(false);
    },
  );

  it('one record per file: a second append writes its OWN file and never touches the first', () => {
    const { store, recordDir } = makeFixture();
    const [a, b] = KNOWN_IDS as unknown as [(typeof KNOWN_IDS)[number], (typeof KNOWN_IDS)[number]];
    const first = store.append(input({ id: a.id, claim: 'the first record' }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstBytes = readFileSync(first.path, 'utf8');

    // Same shard (both mint in 2019-11), so if appends ever concatenated into
    // a shard file rather than one file per record, this is where it shows.
    const second = store.append(input({ id: b.id, claim: 'the second record' }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, 'utf8')).toBe(firstBytes);
    const shard = join(recordDir, a.year, a.month);
    expect(readdirSync(shard).sort()).toEqual([`${a.id}.md`, `${b.id}.md`]);

    // Each file holds EXACTLY one record: it parses whole (a concatenated
    // second record would break the single-frontmatter parse), the parsed id
    // is the filename stem, and only one frontmatter fence opens each file.
    for (const { id, claim } of [
      { id: a.id, claim: 'the first record' },
      { id: b.id, claim: 'the second record' },
    ]) {
      const raw = readFileSync(join(shard, `${id}.md`), 'utf8');
      const parsed = parseRecord(raw);
      expect(parsed.id).toBe(id);
      expect(parsed.claim).toBe(claim);
      expect(raw.split('\n').filter((line) => line === '---')).toHaveLength(2);
    }
  });
});

describe('gate before persist (secret gate wired ahead of any write)', () => {
  it('masks a planted secret in claim and body — the raw file never carries it', () => {
    const { store } = makeFixture();
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const ghToken = `ghp_${'A1b2C3d4'.repeat(5)}`; // ghp_ + 40 alnum chars
    const result = store.append(
      input({
        claim: `Deploy fails unless ${awsKey} is set in the env.`,
        content: `Reproduced with token ${ghToken} against the staging API.`,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = readFileSync(result.path, 'utf8');
    expect(raw).not.toContain(awsKey);
    expect(raw).not.toContain(ghToken);
    expect(raw).toContain('[REDACTED:aws-access-key-id]');
    expect(raw).toContain('[REDACTED:github-token]');
    // Surrounding prose is preserved — masking is in place, not destructive.
    expect(result.record.claim).toBe('Deploy fails unless [REDACTED:aws-access-key-id] is set in the env.');
    // The redaction tally is surfaced on the result (see routing note in store.ts).
    expect(result.redactions).toEqual(
      expect.arrayContaining([
        { pattern: 'aws-access-key-id', count: 1 },
        { pattern: 'github-token', count: 1 },
      ]),
    );
  });

  it('routes every redaction to the sixth telemetry counter (per pattern, per session)', () => {
    const { store, telemetryDir } = makeFixture();
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const ghToken = `ghp_${'A1b2C3d4'.repeat(5)}`;
    const result = store.append(
      input({
        claim: `Deploy fails unless ${awsKey} is set in the env.`,
        content: `Reproduced with token ${ghToken} against the staging API.`,
      }),
    );
    expect(result.ok).toBe(true);

    // The dashboard read observes the redactions.
    const { report } = reportFromDir(telemetryDir);
    expect(report.redactions.total).toBe(2);
    expect(report.redactions.events).toBe(2);
    expect(report.redactions.byPattern).toEqual({ 'aws-access-key-id': 1, 'github-token': 1 });
    expect(report.redactions.bySession).toEqual({ 'sess-1': 2 });
    // A redaction is a successful gate action — it never pollutes the
    // capture counters.
    expect(report.captureFired.total).toBe(1);
    expect(report.captureWriteFailed.total).toBe(0);
  });

  it('a clean append (no secrets) fires no redaction telemetry', () => {
    const { store, telemetryDir } = makeFixture();
    expect(store.append(input()).ok).toBe(true);
    const { report } = reportFromDir(telemetryDir);
    expect(report.redactions.total).toBe(0);
    expect(report.redactions.events).toBe(0);
  });
});

describe('capture-time id-lint for unresolvable ULIDs in free text (correction 01KYV387QKRP3V330WAS6DX95K)', () => {
  const DEAD_ID = '01KYV31MB4BAWG8ZAP2FZDGVGP'; // one of the three real historical dead ids (see below)
  const LIVE_RECORD_ID = '01KYTM4XXR3FGWQY8HB3RGPT4M';
  const LIVE_BOARD_ID = '01KYTQZXDGVPJRBNY64JJ4YNV1';

  /** A resolver that reports exactly the given ids as resolved — the rest
   *  unresolved. Mirrors the real cross-store resolver's contract
   *  (transport/id-resolver.ts) without constructing a WorkStateStore. */
  function resolverFor(resolved: ReadonlySet<string>): IdResolver {
    return (id) => (resolved.has(id) ? 'resolved' : 'unresolved');
  }

  it('a ULID cited in content that resolves NOWHERE is reported: the write still succeeds (WARN, not reject)', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const result = store.append(input({ content: `see ${DEAD_ID} for the prior attempt` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([{ id: DEAD_ID, resolution: 'unresolved' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEAD_ID), expect.objectContaining({ code: 'IDEATE_RECORD_UNRESOLVED_ID' }));
  });

  it('a ULID that resolves as a RECORD produces no report', () => {
    const { store } = makeFixture(resolverFor(new Set([LIVE_RECORD_ID])));
    const result = store.append(input({ claim: `see ${LIVE_RECORD_ID} for context` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([]);
  });

  it('a ULID that resolves as a BOARD ITEM produces no report — the resolver need not distinguish which store answered yes', () => {
    const { store } = makeFixture(resolverFor(new Set([LIVE_BOARD_ID])));
    const result = store.append(input({ verification_anchor: `board:${LIVE_BOARD_ID}#complete@2026-08-01T01:26:45.052Z` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([]);
  });

  it('THE CORRECTION-RECORD CASE: a record whose whole job is to quote a known-dead id succeeds AND is reported — never rejected', () => {
    const { store } = makeFixture(resolverFor(new Set())); // the dead id resolves nowhere, exactly as it would in production
    const result = store.append(
      input({
        kind: 'correction',
        claim: `${DEAD_ID} was minted before the write that assigns it had returned; do not treat it as live.`,
        content: `Corrects a premature citation of ${DEAD_ID}.`,
      }),
    );
    expect(result.ok).toBe(true); // WARN, not reject — this is the case that decides warn-vs-reject
    if (!result.ok) return;
    expect(result.unresolvedIds.map((u) => u.id)).toEqual([DEAD_ID]);
    // And the correction is genuinely ON DISK, exactly as written — nothing
    // rewrote or stripped the quoted dead id (non-goal: report only).
    const raw = readFileSync(result.path, 'utf8');
    expect(raw).toContain(DEAD_ID);
  });

  it('REPLAYING THE THREE REAL HISTORICAL INSTANCES: each would have produced a warning at the time it was written', () => {
    const historical = [
      '01KYTM4XXR3FGWQY8HB3RGPT4M', // corrected by 01KYTMQY03EM38RQDSDSQEASZW
      '01KYTP1H0B2FMFBQ4H9QCXPK2Z', // corrected by 01KYTQZXDGVPJRBNY64JJ4YNV1
      '01KYV31MB4BAWG8ZAP2FZDGVGP', // corrected by 01KYV387QKRP3V330WAS6DX95K
    ];
    for (const deadId of historical) {
      // At the moment of the ORIGINAL (premature) write, neither store had
      // ever heard of `deadId` — it names nothing yet.
      const { store } = makeFixture(resolverFor(new Set()));
      // P-35: this test's own TITLE claims a warning, so it must actually spy
      // on process.emitWarning and assert on it — not just on the returned
      // `unresolvedIds` array, which the id-lint's own header documents as a
      // SEPARATE signal from the warning (both are fired from the same `for`
      // loop in `append`, but nothing before this change proved they stay
      // coupled for exactly these three citations).
      const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      const result = store.append(input({ content: `citing ${deadId} before its write returned` }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.unresolvedIds.map((u) => u.id)).toContain(deadId);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(deadId),
        expect.objectContaining({ code: 'IDEATE_RECORD_UNRESOLVED_ID' }),
      );
      warn.mockRestore();
    }
  });

  it("FALSE POSITIVE: the record's own session_id (ULID-shaped by construction, e.g. mcp-<ULID>) never triggers a report", () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const sessionUlid = '01KYTM4XXR3FGWQY8HB3RGPT4M';
    const result = store.append(
      input({ source: { capture_point: 'mcp:record_append', session_id: `mcp-${sessionUlid}`, task_id: 'T-271' } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('IDEATE_RECORD_UNRESOLVED_ID'), expect.anything());
  });

  it('FALSE POSITIVE: kind and references[].rel (controlled vocabulary) are never scanned even if ULID-shaped', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const shapedAsUlid = '01KYTM4XXR3FGWQY8HB3RGPT4M'; // syntactically valid but absurd as a "kind"
    const result = store.append(input({ kind: shapedAsUlid }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([]);
  });

  it('NON-GOAL: a dangling references[].id is never reported by THIS lint (the ULID-well-formedness check already covers references at the write chokepoint)', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const danglingTarget = '01KYTM4XXR3FGWQY8HB3RGPT4M';
    const result = store.append(input({ references: [{ rel: 'supersedes', id: danglingTarget }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([]);
  });

  it('P-45: an ABSENT resolver reports every ULID-shaped candidate as "unknown", never as clean — and warns with a DISTINCT code', () => {
    const { store } = makeFixture(); // no resolver wired at all
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const result = store.append(input({ content: `see ${DEAD_ID}` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([{ id: DEAD_ID, resolution: 'unknown' }]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(DEAD_ID),
      expect.objectContaining({ code: 'IDEATE_RECORD_ID_LINT_UNAVAILABLE' }),
    );
  });

  it('P-41 FALSIFICATION: the guard fires on an induced violation (a fabricated dangling id planted in content) and stays quiet on agreement (a resolver that reports it live)', () => {
    const inducedId = '01KYTP1H0B2FMFBQ4H9QCXPK2Z';
    // Violation: resolver says the id is nowhere to be found.
    const violating = makeFixture(resolverFor(new Set()));
    const violatingResult = violating.store.append(input({ content: `refer to ${inducedId}` }));
    expect(violatingResult.ok).toBe(true);
    if (violatingResult.ok) expect(violatingResult.unresolvedIds.map((u) => u.id)).toContain(inducedId);
    // Agreement: the SAME id, but the resolver now reports it live — the
    // guard must stay quiet, proving the fixture above genuinely EXERCISED
    // the check rather than always reporting by construction.
    const agreeing = makeFixture(resolverFor(new Set([inducedId])));
    const agreeingResult = agreeing.store.append(input({ content: `refer to ${inducedId}` }));
    expect(agreeingResult.ok).toBe(true);
    if (agreeingResult.ok) expect(agreeingResult.unresolvedIds).toEqual([]);
  });

  it('a task_id citing a nonexistent work item is scanned (task_id is a real citation surface, unlike session_id/capture_point)', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const result = store.append(input({ source: { capture_point: 'session_end', session_id: 'sess-1', task_id: DEAD_ID } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds.map((u) => u.id)).toEqual([DEAD_ID]);
  });

  it('dedupes across fields: the same dead id in both claim and content is reported once', () => {
    const { store } = makeFixture(resolverFor(new Set()));
    const result = store.append(input({ claim: `cites ${DEAD_ID}`, content: `also cites ${DEAD_ID}` }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unresolvedIds).toEqual([{ id: DEAD_ID, resolution: 'unresolved' }]);
  });
});

describe('telemetry wiring', () => {
  it('captureFired increments per successful write, keyed by point and session', () => {
    const { store, telemetryDir } = makeFixture();
    expect(store.append(input()).ok).toBe(true);
    expect(store.append(input()).ok).toBe(true);

    const { report } = reportFromDir(telemetryDir);
    expect(report.captureFired.total).toBe(2);
    expect(report.captureFired.byPoint).toEqual({ session_end: 2 });
    expect(report.captureFired.bySession).toEqual({ 'sess-1': 2 });
    expect(report.captureWriteFailed.total).toBe(0);
  });

  it('an unwritable directory yields a typed WRITE failure, increments captureWriteFailed, and does not throw', () => {
    const { store, recordDir, telemetryDir } = makeFixture();
    mkdirSync(recordDir, { recursive: true });
    chmodSync(recordDir, 0o500); // read+execute only: mkdir of the shard fails
    permRestores.push(recordDir);

    let result: ReturnType<RecordStore['append']> | undefined;
    expect(() => {
      result = store.append(input());
    }).not.toThrow();
    expect(result).toMatchObject({ ok: false, code: 'WRITE' });

    const { report } = reportFromDir(telemetryDir);
    expect(report.captureWriteFailed.total).toBe(1);
    expect(report.captureWriteFailed.byPoint).toEqual({ session_end: 1 });
    expect(report.captureFired.total).toBe(0);
  });

  it('a schema failure also lands in captureWriteFailed — no capture loss is silent', () => {
    const { store, telemetryDir } = makeFixture();
    const bad = input() as unknown as Record<string, unknown>;
    delete bad['claim'];
    expect(store.append(bad as unknown as RecordInput).ok).toBe(false);
    const { report } = reportFromDir(telemetryDir);
    expect(report.captureWriteFailed.total).toBe(1);
  });
});

describe('read: straight off the files, newest first, selection only', () => {
  function seedThree(fx: Fixture): { first: string; second: string; third: string } {
    fx.setNow('2026-05-01T00:00:00.000Z');
    const first = fx.store.append(input({ kind: 'decision', scope: 'auth flow' }));
    fx.setNow('2026-06-15T00:00:00.000Z');
    const second = fx.store.append(input({ kind: 'finding', scope: 'record store internals' }));
    fx.setNow('2026-07-09T00:00:00.000Z');
    const third = fx.store.append(input({ kind: 'task-completion', scope: 'auth flow hardening' }));
    if (!first.ok || !second.ok || !third.ok) throw new Error('seed failed');
    return { first: first.record.id, second: second.record.id, third: third.record.id };
  }

  it('returns records newest-first across month shards', () => {
    const fx = makeFixture();
    const ids = seedThree(fx);
    expect(fx.store.read().map((r) => r.id)).toEqual([ids.third, ids.second, ids.first]);
  });

  it('applies the scope filter as substring selection over scope/kind/source', () => {
    const fx = makeFixture();
    const ids = seedThree(fx);
    // Matches scope text (two records) — selection, in file order, unranked.
    expect(fx.store.read({ scope: 'auth flow' }).map((r) => r.id)).toEqual([ids.third, ids.first]);
    // Matches kind.
    expect(fx.store.read({ scope: 'finding' }).map((r) => r.id)).toEqual([ids.second]);
    // Matches source.task_id.
    expect(fx.store.read({ scope: 't-271' })).toHaveLength(3);
    // No match.
    expect(fx.store.read({ scope: 'nonexistent-vocabulary' })).toEqual([]);
  });

  it('caps results with limit, still newest-first', () => {
    const fx = makeFixture();
    const ids = seedThree(fx);
    expect(fx.store.read({ limit: 2 }).map((r) => r.id)).toEqual([ids.third, ids.second]);
    expect(fx.store.read({ limit: 0 })).toEqual([]);
  });

  it('reads an empty or absent record tree as an empty list', () => {
    const { store } = makeFixture();
    expect(store.read()).toEqual([]);
  });

  it('an ABSENT limit means EVERY matching record, past any page default a transport applies', () => {
    const fx = makeFixture();
    // MORE than the transport's default page (record/read-page.ts's
    // DEFAULT_RECORD_READ_LIMIT), which is the default anyone would actually
    // leak into this layer — a three-record fixture could only catch one
    // below 3. `read`/`readViews` with no limit are what in-repo consumers
    // sweep the store on (context/assemble-prototype.ts self-bounds with its
    // own `{scope, limit}`), so a default parked HERE would silently truncate
    // them and every caller would keep reading a shortened store as the whole
    // store. The default lives at the transport boundary, and this is the test
    // that says so.
    const count = DEFAULT_RECORD_READ_LIMIT + 5;
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      fx.setNow(new Date(Date.parse(FIXED_ISO) + i * 1_000).toISOString());
      const appended = fx.store.append(input({ scope: i % 2 === 0 ? 'even shard' : 'odd shard' }));
      if (!appended.ok) throw new Error('seed failed');
      ids.push(appended.record.id);
    }

    // Every record, newest first — the count AND the identities.
    expect(fx.store.readViews({}).map((r) => r.id)).toEqual([...ids].reverse());
    expect(fx.store.read()).toHaveLength(count);
    // …and under a selection filter, which is the form a sweep actually calls.
    expect(fx.store.readViews({ scope: 'even shard' })).toHaveLength(Math.ceil(count / 2));
    // …while an EXPLICIT limit still bounds it, so the contrast is real.
    expect(fx.store.readViews({ limit: 10 })).toHaveLength(10);
  });
});

describe('readViews: derived backlinks, never stored (append-only reverse edges)', () => {
  it('attaches referenced_by to a superseded record without persisting it', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const a = fx.store.append(input({ kind: 'decision', scope: 'the old choice' }));
    fx.setNow('2026-06-01T00:00:00.000Z');
    if (!a.ok) throw new Error('seed a failed');
    const b = fx.store.append(
      input({ kind: 'decision', scope: 'the new choice', references: [{ rel: 'supersedes', id: a.record.id }] }),
    );
    if (!b.ok) throw new Error('seed b failed');

    const views = fx.store.readViews();
    const viewA = views.find((v) => v.id === a.record.id);
    const viewB = views.find((v) => v.id === b.record.id);
    // A learns it was superseded — the DERIVED reverse edge.
    expect(viewA?.referenced_by).toEqual([{ rel: 'supersedes', id: b.record.id }]);
    // B carries the forward edge and has no backlinks of its own.
    expect(viewB?.references).toEqual([{ rel: 'supersedes', id: a.record.id }]);
    expect(viewB?.referenced_by).toEqual([]);
    // Nothing was written back to A — the on-disk record has no reverse edge.
    expect(fx.store.read().find((r) => r.id === a.record.id)?.references).toEqual([]);
  });

  it('derives the backlink even when the referring record is excluded by the scope filter', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const a = fx.store.append(input({ kind: 'decision', scope: 'target-scope' }));
    fx.setNow('2026-06-01T00:00:00.000Z');
    if (!a.ok) throw new Error('seed a failed');
    const b = fx.store.append(
      input({ kind: 'decision', scope: 'other-scope', references: [{ rel: 'supersedes', id: a.record.id }] }),
    );
    if (!b.ok) throw new Error('seed b failed');

    // The filter selects only A; B (the newer referrer) is scanned but excluded
    // from the result — yet A's backlink still resolves, because the referrer
    // map is built from every scanned record, not just the returned ones.
    const views = fx.store.readViews({ scope: 'target-scope' });
    expect(views.map((v) => v.id)).toEqual([a.record.id]);
    expect(views[0]?.referenced_by).toEqual([{ rel: 'supersedes', id: b.record.id }]);
  });

  it('fan-in: two records superseding one target both surface as backlinks on it', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const target = fx.store.append(input({ kind: 'decision', scope: 'the original' }));
    if (!target.ok) throw new Error('seed target failed');
    fx.setNow('2026-06-01T00:00:00.000Z');
    const b = fx.store.append(
      input({ kind: 'decision', scope: 'replacement one', references: [{ rel: 'supersedes', id: target.record.id }] }),
    );
    if (!b.ok) throw new Error('seed b failed');
    fx.setNow('2026-07-01T00:00:00.000Z');
    const c = fx.store.append(
      input({ kind: 'decision', scope: 'replacement two', references: [{ rel: 'supersedes', id: target.record.id }] }),
    );
    if (!c.ok) throw new Error('seed c failed');

    const views = fx.store.readViews();
    const targetView = views.find((v) => v.id === target.record.id);
    // Both B and C point at the target — newest-first read emits both backlinks.
    expect(targetView?.referenced_by).toEqual([
      { rel: 'supersedes', id: c.record.id },
      { rel: 'supersedes', id: b.record.id },
    ]);
  });

  it('chain: A←B←C — each link surfaces the next as a backlink, C has none', () => {
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const a = fx.store.append(input({ kind: 'decision', scope: 'oldest' }));
    if (!a.ok) throw new Error('seed a failed');
    fx.setNow('2026-06-01T00:00:00.000Z');
    const b = fx.store.append(
      input({ kind: 'decision', scope: 'middle', references: [{ rel: 'supersedes', id: a.record.id }] }),
    );
    if (!b.ok) throw new Error('seed b failed');
    fx.setNow('2026-07-01T00:00:00.000Z');
    const c = fx.store.append(
      input({ kind: 'decision', scope: 'newest', references: [{ rel: 'supersedes', id: b.record.id }] }),
    );
    if (!c.ok) throw new Error('seed c failed');

    const views = fx.store.readViews();
    const viewA = views.find((v) => v.id === a.record.id);
    const viewB = views.find((v) => v.id === b.record.id);
    const viewC = views.find((v) => v.id === c.record.id);
    // A is superseded only by B (C points at B, not A — chains are not transitive).
    expect(viewA?.referenced_by).toEqual([{ rel: 'supersedes', id: b.record.id }]);
    expect(viewB?.referenced_by).toEqual([{ rel: 'supersedes', id: c.record.id }]);
    // C is the newest link — no backlinks of its own.
    expect(viewC?.referenced_by).toEqual([]);
  });
});

describe('id + before_id: exact selection and the keyset boundary (paging is selection, not ranking)', () => {
  /** Five records across two month shards, oldest → newest. */
  function seedFive(fx: Fixture): string[] {
    const ids: string[] = [];
    for (const [i, iso] of [
      '2026-05-01T00:00:00.000Z',
      '2026-05-02T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-06-02T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ].entries()) {
      fx.setNow(iso);
      const result = fx.store.append(input({ claim: `record ${String(i)}` }));
      if (!result.ok) throw new Error('seed failed');
      ids.push(result.record.id);
    }
    return ids;
  }

  it('the ULID id alone is a total order: the newest-first walk is exactly id-descending', () => {
    const fx = makeFixture();
    const ids = seedFive(fx);
    const walked = fx.store.read().map((r) => r.id);
    expect(walked).toEqual([...ids].reverse());
    // …and that order is the same one a plain lexicographic sort produces, which
    // is WHY a single id is a complete page boundary.
    expect(walked).toEqual([...walked].sort().reverse());
  });

  it('id selects exactly that one record — an exact match, never a substring one', () => {
    const fx = makeFixture();
    const ids = seedFive(fx);
    const target = ids[2] as string;
    expect(fx.store.read({ id: target }).map((r) => r.id)).toEqual([target]);
    // A truncated id is not a prefix match: it selects nothing.
    expect(fx.store.read({ id: target.slice(0, 20) })).toEqual([]);
    // …and neither does the scope filter treat an id as a haystack.
    expect(fx.store.read({ scope: target })).toEqual([]);
  });

  it('before_id selects strictly older records, so a walk covers every record exactly once', () => {
    const fx = makeFixture();
    const ids = seedFive(fx);
    const newestFirst = [...ids].reverse();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = fx.store.read({ limit: 2, ...(cursor === undefined ? {} : { before_id: cursor }) });
      if (page.length === 0) break;
      // The boundary is STRICT: the cursor record itself never repeats.
      if (cursor !== undefined) expect(page.map((r) => r.id)).not.toContain(cursor);
      seen.push(...page.map((r) => r.id));
      cursor = page.at(-1)?.id;
    }
    expect(seen).toEqual(newestFirst);
    expect(new Set(seen).size).toBe(ids.length);
  });

  it('the id selector answers from the FILENAME: a file that is not the target is never opened', () => {
    const fx = makeFixture();
    const ids = seedFive(fx);
    // Corrupt the OLDEST record's file in place. Reading it would emit the
    // unparseable-file warning, which is what makes "was it opened?" observable.
    const corrupt = join(fx.recordDir, '2026', '05', `${ids[0] as string}.md`);
    writeFileSync(corrupt, 'not a record at all', 'utf8');
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    // Asking for the NEWEST record by id: every older file is below the target
    // in the walk and can neither be it nor reference it, so none is read.
    expect(fx.store.read({ id: ids[4] as string }).map((r) => r.id)).toEqual([ids[4]]);
    expect(fx.store.readViews({ id: ids[4] as string }).map((r) => r.id)).toEqual([ids[4]]);
    expect(warn).not.toHaveBeenCalled();

    // The same store, walked unfiltered, DOES open it — proving the file was in
    // the walk's path all along and the silence above was the skip, not luck.
    fx.store.read();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping unparseable record file'), expect.anything());
  });

  it('readViews keeps backlinks COMPLETE across a page boundary (a referrer on an earlier page still shows up)', () => {
    const fx = makeFixture();
    // A cross-page edge, built synthetically because no record in the live
    // store carries a typed edge: the OLDEST record is superseded by the
    // NEWEST one, so any page size > 1 puts the two on different pages.
    fx.setNow('2026-05-01T00:00:00.000Z');
    const target = fx.store.append(input({ claim: 'the original' }));
    if (!target.ok) throw new Error('seed failed');
    for (const iso of ['2026-05-02T00:00:00.000Z', '2026-06-01T00:00:00.000Z']) {
      fx.setNow(iso);
      fx.store.append(input({ claim: 'filler' }));
    }
    fx.setNow('2026-07-01T00:00:00.000Z');
    const referrer = fx.store.append(
      input({ claim: 'the replacement', references: [{ rel: 'supersedes', id: target.record.id }] }),
    );
    if (!referrer.ok) throw new Error('seed failed');

    // Page 1 carries the referrer; the target lands on page 2, whose read
    // starts BELOW the referrer's id — and still sees the backlink, because the
    // referrer map is built from every record above the boundary.
    const page1 = fx.store.readViews({ limit: 2 });
    expect(page1.map((v) => v.id)).toEqual([referrer.record.id, page1[1]?.id]);
    const page2 = fx.store.readViews({ limit: 2, before_id: page1.at(-1)?.id as string });
    const targetView = page2.find((v) => v.id === target.record.id);
    expect(targetView?.referenced_by).toEqual([{ rel: 'supersedes', id: referrer.record.id }]);
    // …identical to what the unpaged read reports, which is the whole claim.
    expect(fx.store.readViews().find((v) => v.id === target.record.id)?.referenced_by).toEqual(
      targetView?.referenced_by,
    );
    // The by-id fetch of the same record is equally complete.
    expect(fx.store.readViews({ id: target.record.id })[0]?.referenced_by).toEqual(targetView?.referenced_by);
  });

  it('a write BETWEEN two readViews calls is not lost behind a stale per-instance memo', () => {
    // readViews now reuses a memo of its own prior walk across calls on the
    // SAME instance (record/store.ts's WalkCache — the O(n²)-per-page fix).
    // That memo must be thrown away, not silently reused, the instant a new
    // record lands: otherwise a walk started before an append would report
    // backlinks as they stood BEFORE the write, even though nothing about the
    // read contract promises a snapshot — every other read in this file
    // observes appends immediately, and paging must not become the exception.
    const fx = makeFixture();
    fx.setNow('2026-05-01T00:00:00.000Z');
    const target = fx.store.append(input({ claim: 'the original' }));
    if (!target.ok) throw new Error('seed failed');
    fx.setNow('2026-06-01T00:00:00.000Z');
    const filler = fx.store.append(input({ claim: 'filler' }));
    if (!filler.ok) throw new Error('seed failed');

    // First call builds (and retains) a memo that ends at `filler` — it has
    // no idea a referrer is coming.
    const before = fx.store.readViews({ limit: 1 });
    expect(before.map((v) => v.id)).toEqual([filler.record.id]);

    // A NEW record supersedes the target, landing after the memo was built.
    fx.setNow('2026-07-01T00:00:00.000Z');
    const referrer = fx.store.append(
      input({ claim: 'the replacement', references: [{ rel: 'supersedes', id: target.record.id }] }),
    );
    if (!referrer.ok) throw new Error('seed failed');

    // A full re-read on the SAME instance sees the new record AND the
    // now-complete backlink on the target — the stale memo was discarded,
    // not extended in place with half the picture.
    const after = fx.store.readViews();
    expect(after.map((v) => v.id)).toEqual([referrer.record.id, filler.record.id, target.record.id]);
    expect(after.find((v) => v.id === target.record.id)?.referenced_by).toEqual([
      { rel: 'supersedes', id: referrer.record.id },
    ]);
  });

  it('DIFFERENTIAL: readViews agrees with read (the independent oracle) on id/scope/before_id, including the two combinations that once diverged', () => {
    // read() applies id, before_id, and scope as an AND on every record (see
    // its `wanted` predicate) and was never touched by the perf change —
    // readViews's id-select fast path must answer identically for the same
    // options, or it is narrowing/widening the result the unindexed sibling
    // would give for no reason other than which branch happened to run.
    const fx = makeFixture();
    const ids = seedFive(fx);
    const target = ids[2] as string;
    const targetRecord = fx.store.read({ id: target })[0];
    if (targetRecord === undefined) throw new Error('seed missing target');
    const idsOf = (rows: readonly { id: string }[]): string[] => rows.map((r) => r.id);

    // id alone.
    expect(idsOf(fx.store.readViews({ id: target }))).toEqual(idsOf(fx.store.read({ id: target })));

    // id + scope MATCHING the target's own scope: both sides return it.
    expect(idsOf(fx.store.readViews({ id: target, scope: targetRecord.scope }))).toEqual(
      idsOf(fx.store.read({ id: target, scope: targetRecord.scope })),
    );
    expect(idsOf(fx.store.readViews({ id: target, scope: targetRecord.scope }))).toEqual([target]);

    // id + scope MISMATCHING — the scope-leak regression: readViews once
    // returned the record anyway, ignoring scope entirely once id matched.
    expect(idsOf(fx.store.readViews({ id: target, scope: 'nonexistent-vocabulary' }))).toEqual(
      idsOf(fx.store.read({ id: target, scope: 'nonexistent-vocabulary' })),
    );
    expect(fx.store.readViews({ id: target, scope: 'nonexistent-vocabulary' })).toEqual([]);

    // id + before_id on the INCLUDED side of the boundary (target strictly
    // older than a newer id — still on the page).
    const newerThanTarget = ids[3] as string;
    expect(idsOf(fx.store.readViews({ id: target, before_id: newerThanTarget }))).toEqual(
      idsOf(fx.store.read({ id: target, before_id: newerThanTarget })),
    );
    expect(idsOf(fx.store.readViews({ id: target, before_id: newerThanTarget }))).toEqual([target]);

    // id + before_id EXACTLY AT the boundary (the boundary is exclusive —
    // `record.id < before_id` — so naming the target itself excludes it) and
    // PAST the boundary (an older before_id excludes it too) — the exactly-
    // once-walk regression: readViews once re-emitted a record at or after
    // the page boundary it had already been paged past.
    const olderThanTarget = ids[1] as string;
    for (const beforeId of [target, olderThanTarget]) {
      expect(idsOf(fx.store.readViews({ id: target, before_id: beforeId }))).toEqual(
        idsOf(fx.store.read({ id: target, before_id: beforeId })),
      );
      expect(fx.store.readViews({ id: target, before_id: beforeId })).toEqual([]);
    }
  });
});

describe('cross-process freshness: two RecordStore instances sharing one on-disk store', () => {
  it("a write from a SECOND instance between two readViews calls on the FIRST is visible on the very next call — no stale cross-instance cache", () => {
    // Mirrors the real deployment shape: an MCP session memoizes ONE
    // RecordStore for its whole life (record/tools.ts), while the
    // hook-invoked CLI transport constructs its OWN short-lived instance per
    // invocation — both writing through this one on-disk store. A stale
    // per-instance memo would make the warm MCP session silently stop seeing
    // hook-written records: not a throw, an INCOMPLETE page, which is the
    // critical regression this test pins.
    const projectRoot = makeTempDir('ideate-record-store-test-');
    const telemetryDir = makeTempDir('ideate-record-telemetry-test-');
    const config: IdeateConfigV3 = {
      schema_version: V3_SCHEMA_VERSION,
      record: { path: DEFAULT_RECORD_PATH },
      backend: 'local',
    };
    let nowIso = '2026-05-01T00:00:00.000Z';
    const clock: Clock = () => new Date(nowIso);
    const telemetry = new TelemetryCounters(telemetryDir, clock);
    const instanceA = new RecordStore(config, projectRoot, telemetry, clock);
    const instanceB = new RecordStore(config, projectRoot, telemetry, clock);

    // A appends, then does a FULL readViews walk — warming A's own
    // per-instance memo (record/store.ts's WalkCache).
    const first = instanceA.append(input({ claim: 'seen by A' }));
    if (!first.ok) throw new Error('seed failed');
    expect(instanceA.readViews().map((r) => r.id)).toEqual([first.record.id]);

    // A SECOND instance — never sharing any in-memory state with A — appends
    // to the SAME on-disk directory.
    nowIso = '2026-06-01T00:00:00.000Z';
    const second = instanceB.append(input({ claim: 'written by the other instance' }));
    if (!second.ok) throw new Error('seed failed');

    // A's memo was warmed BEFORE B's write. A's very next call must still
    // report both records, in the correct order, with B's write visible.
    expect(instanceA.readViews().map((r) => r.id)).toEqual([second.record.id, first.record.id]);
    // The unindexed sibling was never in question, but confirms the fixture
    // itself: both records really are on disk, agreeing with readViews.
    expect(instanceA.read().map((r) => r.id)).toEqual([second.record.id, first.record.id]);
  });
});

describe('WalkCache growth is structural, not per-call (Finding 1: the [machine] unbounded-memo claim, pinned deterministically)', () => {
  // record/store.ts's WalkCache doc comment reports a MEASURED byte figure
  // (~9.3 MB / ~4 KB per record over 2,382 records) for the memo's retained
  // footprint. That number is a snapshot — heap measurement varies with GC
  // timing, Node version, and concurrent load — so asserting it here would
  // be a flaky guard. What IS deterministic, and what "growth is linear and
  // reaches steady state" actually MEANS, is pinned instead: the memo holds
  // exactly one entry per record this instance has read (never more than
  // once for the same record, however many calls it takes to read it), and
  // a second identical walk adds no further entries. `walkCacheEntryCountForTest`
  // is a narrow test-only accessor added to RecordStore (see its doc
  // comment) purely to make this checkable without reaching past a private
  // field from the test — the memo itself stays exactly as designed.
  function seedN(fx: Fixture, n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      fx.setNow(`2026-0${String((i % 3) + 5)}-01T00:00:00.000Z`); // spread across 3 month shards
      const result = fx.store.append(input({ claim: `record ${String(i)}` }));
      if (!result.ok) throw new Error('seed failed');
      ids.push(result.record.id);
    }
    return ids;
  }

  it('a full readViews walk memoizes exactly one entry per record; a second identical walk adds none', () => {
    const fx = makeFixture();
    const ids = seedN(fx, 6);
    expect(fx.store.walkCacheEntryCountForTest).toBe(0); // nothing memoized before any readViews call

    const first = fx.store.readViews();
    expect(first).toHaveLength(6);
    expect(fx.store.walkCacheEntryCountForTest).toBe(ids.length); // one entry per record, not per call

    // A second, IDENTICAL walk re-reads nothing new — every record it
    // touches is already in the memo — so the entry count must not move.
    const second = fx.store.readViews();
    expect(second).toHaveLength(6);
    expect(fx.store.walkCacheEntryCountForTest).toBe(ids.length);
  });

  it('a page-to-exhaustion walk (many calls) still ends with exactly one entry per record — growth is per RECORD, not per CALL', () => {
    const fx = makeFixture();
    const ids = seedN(fx, 6);

    // Walk to exhaustion two records at a time — three separate readViews
    // calls over the same six records. If the memo grew per CALL instead of
    // per RECORD, this would leave MORE than 6 entries; it must not.
    let beforeId: string | undefined;
    let pages = 0;
    for (;;) {
      const page = fx.store.readViews({ limit: 2, ...(beforeId !== undefined ? { before_id: beforeId } : {}) });
      if (page.length === 0) break;
      pages++;
      beforeId = page.at(-1)?.id;
    }
    expect(pages).toBe(3);
    expect(fx.store.walkCacheEntryCountForTest).toBe(ids.length);
  });
});

describe('append: reference-id ULID validation at the write chokepoint', () => {
  it('rejects a non-ULID reference id with a typed SCHEMA failure and writes nothing', () => {
    const fx = makeFixture();
    const result = fx.store.append(
      input({ references: [{ rel: 'supersedes', id: 'not-a-ulid' }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('SCHEMA');
    expect(result.reason).toMatch(/not a well-formed ULID/);
    // No record directory was created — nothing persisted.
    expect(existsSync(fx.recordDir)).toBe(false);
  });

  it('accepts a well-formed ULID reference id', () => {
    const fx = makeFixture();
    const result = fx.store.append(
      input({ references: [{ rel: 'supersedes', id: '01JZM8Z0000000000000000000' }] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('append-only API surface', () => {
  it('the record modules export no update/delete/rank/score verb', async () => {
    for (const mod of [await import('./store.js'), await import('./schema.js'), await import('./id.js')]) {
      for (const name of Object.keys(mod)) {
        expect(name).not.toMatch(/update|delete|remove|rank|score|redact/i);
      }
    }
  });

  it('RecordStore instances expose only append/read — no mutation or ranking method', () => {
    const { store } = makeFixture();
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store) as object).filter(
      (n) => n !== 'constructor',
    );
    for (const name of methods) {
      expect(name).not.toMatch(/update|delete|remove|rank|score/i);
    }
    expect(methods).toContain('append');
    expect(methods).toContain('read');
  });

  it('the medium enforces append-only: re-appending an existing id fails, file untouched', () => {
    const { store } = makeFixture();
    const first = store.append(input());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = readFileSync(first.path, 'utf8');

    const overwrite = store.append(input({ id: first.record.id, claim: 'rewritten history' }));
    expect(overwrite).toMatchObject({ ok: false, code: 'WRITE' });
    expect(readFileSync(first.path, 'utf8')).toBe(before);
  });
});
