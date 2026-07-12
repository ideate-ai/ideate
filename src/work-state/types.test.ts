// plugin/src/work-state/types.test.ts — F-301-001 S1 acceptance test: a
// unified error base for every typed work-state failure.
//
// Before this fix, `WorkStateError` (types.ts), `ClaimEngineError`
// (claims.ts), `VerbError` (verbs.ts), and `DagError` (dag.ts) were four
// structurally-identical classes with no shared ancestor — a caller wanting
// to catch "any work-state failure" in one place had no type to catch. This
// file pins that `WorkStateModuleError` now catches all four, and that each
// subclass keeps its own distinct `name` and its own narrow `code` union.

import { describe, expect, it } from 'vitest';

import { ClaimEngineError } from './claims.js';
import { DagError } from './dag.js';
import { WorkStateError, WorkStateModuleError } from './types.js';
import { VerbError } from './verbs.js';

describe('WorkStateModuleError — F-301-001 S1: a unified base every typed work-state failure extends', () => {
  it('WorkStateError (types.ts/store.ts) is an instance of WorkStateModuleError', () => {
    const err = new WorkStateError('NOT_FOUND', 'x');
    expect(err).toBeInstanceOf(WorkStateModuleError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WorkStateError');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('ClaimEngineError (claims.ts) is an instance of WorkStateModuleError', () => {
    const err = new ClaimEngineError('NOT_CLAIMABLE', 'x');
    expect(err).toBeInstanceOf(WorkStateModuleError);
    expect(err.name).toBe('ClaimEngineError');
    expect(err.code).toBe('NOT_CLAIMABLE');
  });

  it('VerbError (verbs.ts) is an instance of WorkStateModuleError', () => {
    const err = new VerbError('INVALID_TRANSITION', 'x');
    expect(err).toBeInstanceOf(WorkStateModuleError);
    expect(err.name).toBe('VerbError');
    expect(err.code).toBe('INVALID_TRANSITION');
  });

  it('DagError (dag.ts) is an instance of WorkStateModuleError', () => {
    const err = new DagError('CYCLE', 'x');
    expect(err).toBeInstanceOf(WorkStateModuleError);
    expect(err.name).toBe('DagError');
    expect(err.code).toBe('CYCLE');
  });

  it('one instanceof check catches every one of the four work-state error classes', () => {
    const errors: unknown[] = [
      new WorkStateError('SCHEMA', 'x'),
      new ClaimEngineError('INVALID_CLAIM', 'x'),
      new VerbError('INVALID_TRANSITION', 'x'),
      new DagError('DANGLING_DEPENDENCY', 'x'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(WorkStateModuleError);
    }
  });

  it('each subclass keeps its OWN name and narrow code union — this is a shared base, not a merge', () => {
    const names = new Set(
      [
        new WorkStateError('SCHEMA', 'x'),
        new ClaimEngineError('NOT_FOUND', 'x'),
        new VerbError('INVALID_TRANSITION', 'x'),
        new DagError('CYCLE', 'x'),
      ].map((e) => e.name),
    );
    expect(names).toEqual(new Set(['WorkStateError', 'ClaimEngineError', 'VerbError', 'DagError']));
  });
});
