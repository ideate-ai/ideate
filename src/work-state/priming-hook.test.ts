// plugin/src/work-state/priming-hook.test.ts — WI-303 acceptance tests for
// the claim-time priming hook point, MECHANICALLY GATED OFF (GP-23).
//
// Pins:
// - flag absent -> primeOnClaim emits nothing observable except the
//   `work_claims` telemetry counter increment (no stderr output).
// - flag true in `.ideate.json` -> the hook still emits NOTHING more than a
//   typed NOT_IMPLEMENTED marker on stderr; it never throws and the counter
//   still increments.
// - grep-falsifiability: no `process.env` read exists anywhere in this
//   file's own source (no env-var override for the gate).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelemetryCounters } from '../telemetry/counters.js';
import { reportFromDir } from '../telemetry/report.js';
import { PrimingHookError, primeOnClaim, readClaimPrimingFlag } from './priming-hook.js';
import type { ActorRef } from './types.js';

const FIXED_ISO = '2026-07-11T12:00:00.000Z';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ideate-priming-hook-test-'));
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

function actor(human = 'dan'): ActorRef {
  return { human };
}

describe('readClaimPrimingFlag', () => {
  it('is false when .ideate.json does not exist', () => {
    const dir = makeTempDir();
    expect(readClaimPrimingFlag(dir)).toBe(false);
  });

  it('is false when .ideate.json is unparseable JSON', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.ideate.json'), '{ not json', 'utf8');
    expect(readClaimPrimingFlag(dir)).toBe(false);
  });

  it('is false when the file has no work_state block', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.ideate.json'), JSON.stringify({ schema_version: 10, backend: 'local' }), 'utf8');
    expect(readClaimPrimingFlag(dir)).toBe(false);
  });

  it('is false when claim_priming is present but not literally true', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, '.ideate.json'),
      JSON.stringify({ work_state: { path: '.ideate-work/', claim_priming: 'yes' } }),
      'utf8',
    );
    expect(readClaimPrimingFlag(dir)).toBe(false);
  });

  it('is true when work_state.claim_priming is literally true', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, '.ideate.json'), JSON.stringify({ work_state: { claim_priming: true } }), 'utf8');
    expect(readClaimPrimingFlag(dir)).toBe(true);
  });
});

describe('primeOnClaim — mechanically gated off (GP-23)', () => {
  it('flag absent: no priming output, but the work_claims counter increments', () => {
    const projectRoot = makeTempDir();
    const telemetryDir = makeTempDir();
    const telemetry = new TelemetryCounters(telemetryDir, () => new Date(FIXED_ISO));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    primeOnClaim({ projectRoot, itemId: 'item-1', actor: actor(), sessionId: 'sess-1', telemetry });

    expect(stderrSpy).not.toHaveBeenCalled();
    const { report } = reportFromDir(telemetryDir);
    expect(report.workClaims.total).toBe(1);
    expect(report.workClaims.byItem).toEqual({ 'item-1': 1 });
  });

  it('flag true: emits nothing more than a NOT_IMPLEMENTED marker on stderr, never throws, and still counts', () => {
    const projectRoot = makeTempDir();
    writeFileSync(join(projectRoot, '.ideate.json'), JSON.stringify({ work_state: { claim_priming: true } }), 'utf8');
    const telemetryDir = makeTempDir();
    const telemetry = new TelemetryCounters(telemetryDir, () => new Date(FIXED_ISO));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() =>
      primeOnClaim({ projectRoot, itemId: 'item-2', actor: actor(), sessionId: 'sess-1', telemetry }),
    ).not.toThrow();

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = String(stderrSpy.mock.calls[0]?.[0]);
    expect(written).toContain('not exist yet');
    expect(written).toContain('item-2');

    const { report } = reportFromDir(telemetryDir);
    expect(report.workClaims.total).toBe(1);
  });

  it('a PrimingHookError, if ever thrown by a caller directly, carries a typed code', () => {
    const err = new PrimingHookError('NOT_IMPLEMENTED', 'x');
    expect(err.code).toBe('NOT_IMPLEMENTED');
    expect(err.name).toBe('PrimingHookError');
  });
});

describe('grep-falsifiability: no env-var override', () => {
  it('priming-hook.ts never reads process.env', () => {
    const sourcePath = fileURLToPath(new URL('./priming-hook.ts', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    expect(source).not.toContain('process.env');
  });
});
