// plugin/src/transport/id-resolver.test.ts — acceptance tests for the
// cross-store id-lint resolver (the one module allowed to know about both
// the record store and the board — see id-resolver.ts's own header).
//
// Pins: `composeIdResolver` checks the record store first, then the board;
// an id absent from both is 'unresolved'; a board lookup that THROWS is
// caught and reported 'unknown' with a loud, distinct process warning
// (P-45 — never silently 'resolved' or 'unresolved'); `createProjectIdResolver`
// wires a REAL RecordStore + WorkStateStore from a bare projectRoot and
// answers correctly for a record id, a board item id, and a genuinely
// nonexistent id — including when the board database has never been
// written (no eager file creation, matching WorkStateStore's own lazy-init
// contract).

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RECORD_PATH, V3_SCHEMA_VERSION } from '../config/ideate-config.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import { TelemetryCounters } from '../telemetry/counters.js';
import { WorkStateStore } from '../work-state/store.js';
import { composeIdResolver, createProjectIdResolver } from './id-resolver.js';

const FIXED_ISO = '2026-07-09T12:00:00.000Z';
const CLOCK: Clock = () => new Date(FIXED_ISO);

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-id-resolver-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('composeIdResolver', () => {
  it('resolves an id the RECORD store has, without ever touching the board', () => {
    let boardCalled = false;
    const record = { hasRecord: (id: string) => id === 'RECORD_ID' };
    const board = {
      getItem: (): null => {
        boardCalled = true;
        return null;
      },
    };
    expect(composeIdResolver(record, board)('RECORD_ID')).toBe('resolved');
    expect(boardCalled).toBe(false);
  });

  it('resolves an id the BOARD has when the record store does not', () => {
    const record = { hasRecord: (): boolean => false };
    const board = { getItem: (id: string) => (id === 'BOARD_ID' ? ({} as never) : null) };
    expect(composeIdResolver(record, board)('BOARD_ID')).toBe('resolved');
  });

  it('an id neither store has is "unresolved"', () => {
    const record = { hasRecord: (): boolean => false };
    const board = { getItem: (): null => null };
    expect(composeIdResolver(record, board)('NOWHERE')).toBe('unresolved');
  });

  it('P-45: a board lookup that THROWS is caught and reported "unknown", with a loud, distinct process warning — never silently "resolved" or "unresolved"', () => {
    const record = { hasRecord: (): boolean => false };
    const board = {
      getItem: (): never => {
        throw new Error('database is locked');
      },
    };
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    expect(composeIdResolver(record, board)('ANY_ID')).toBe('unknown');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ANY_ID'),
      expect.objectContaining({ code: 'IDEATE_ID_LINT_RESOLVER_UNAVAILABLE' }),
    );
  });

  it('a record store that throws is NOT caught (existsSync never throws for an ordinary path — see this file header on why only the board half is wrapped)', () => {
    const record = {
      hasRecord: (): never => {
        throw new Error('unexpected record-side failure');
      },
    };
    const board = { getItem: (): null => null };
    expect(() => composeIdResolver(record, board)('ANY_ID')).toThrow('unexpected record-side failure');
  });
});

describe('createProjectIdResolver — wired against REAL stores from a bare projectRoot', () => {
  function makeProject(): { projectRoot: string; telemetry: TelemetryCounters } {
    const projectRoot = makeTempDir();
    const telemetry = new TelemetryCounters(join(projectRoot, '.ideate-telemetry'), CLOCK);
    return { projectRoot, telemetry };
  }

  it('resolves a record id that genuinely exists on disk', () => {
    const { projectRoot, telemetry } = makeProject();
    const config: IdeateConfigV3 = { schema_version: V3_SCHEMA_VERSION, record: { path: DEFAULT_RECORD_PATH }, backend: 'local' };
    const record = new RecordStore(config, projectRoot, telemetry, CLOCK);
    const written = record.append({
      kind: 'finding',
      claim: 'x',
      verification_anchor: '',
      scope: '',
      source: { capture_point: 'test', session_id: 'sess-1' },
      content: 'y',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;

    const resolveId = createProjectIdResolver(projectRoot, telemetry, CLOCK);
    expect(resolveId(written.record.id)).toBe('resolved');
  });

  it('resolves a board item id that genuinely exists', () => {
    const { projectRoot, telemetry } = makeProject();
    const dbPath = join(projectRoot, 'work-state', 'board.db');
    const board = new WorkStateStore(dbPath, CLOCK);
    const item = board.insertItem({ title: 'x', spec: 'y', spec_format: 'z', created_by: { human: 'dan' } });

    const resolveId = createProjectIdResolver(projectRoot, telemetry, CLOCK, dbPath);
    expect(resolveId(item.id)).toBe('resolved');
  });

  it('a genuinely nonexistent id is "unresolved" — including when the board database has NEVER been written (no eager creation)', () => {
    const { projectRoot, telemetry } = makeProject();
    const dbPath = join(projectRoot, 'work-state', 'board.db');
    const resolveId = createProjectIdResolver(projectRoot, telemetry, CLOCK, dbPath);
    expect(resolveId('01KYV31MB4BAWG8ZAP2FZDGVGP')).toBe('unresolved');
    // The check itself must never CREATE the board — WorkStateStore.getItem's
    // own lazy-init contract (never creates the database file on a read).
    expect(existsSync(dbPath)).toBe(false);
  });
});
