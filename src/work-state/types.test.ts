// plugin/src/work-state/types.test.ts — acceptance test for a
// unified error base for every typed work-state failure.
//
// Without it, `WorkStateError` (types.ts), `ClaimEngineError`
// (claims.ts), `VerbError` (verbs.ts), and `DagError` (dag.ts) would be four
// structurally-identical classes with no shared ancestor — a caller wanting
// to catch "any work-state failure" in one place had no type to catch. This
// file pins that `WorkStateModuleError` now catches all four, and that each
// subclass keeps its own distinct `name` and its own narrow `code` union.

import { describe, expect, it } from 'vitest';

import { ClaimEngineError } from './claims.js';
import { DagError } from './dag.js';
import type { NewWorkItemInput, UpdateMetaInput, WorkItem } from './types.js';
import { WorkStateError, WorkStateModuleError } from './types.js';
import { VerbError } from './verbs.js';

describe('WorkStateModuleError — a unified base every typed work-state failure extends', () => {
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

// The parent_id containment field on the three contract interfaces.
// These are compile-time-and-runtime pins: the objects would not type-check if
// the field were missing or mis-typed, and the runtime reads confirm the shape.
describe('parent_id contract field', () => {
  it('WorkItem.parent_id is always present — a string when contained, null when a root', () => {
    const root: WorkItem = {
      id: '01ROOT',
      tenant_id: 'local',
      title: 'root',
      spec: '{}',
      spec_format: 'json',
      status: 'open',
      claim: null,
      depends_on: [],
      parent_id: null,
      references: [],
      created_by: { human: 'dan' },
      created_at: 'now',
      updated_at: 'now',
      version: 1,
    };
    const child: WorkItem = { ...root, id: '01CHILD', parent_id: '01ROOT' };

    expect(root.parent_id).toBeNull();
    expect(child.parent_id).toBe('01ROOT');
  });

  it('NewWorkItemInput.parent_id is optional; absent or null both mean "create as a root"', () => {
    const absent: NewWorkItemInput = {
      title: 't',
      spec: '{}',
      spec_format: 'json',
      created_by: { human: 'dan' },
    };
    const explicitNull: NewWorkItemInput = { ...absent, parent_id: null };
    const withParent: NewWorkItemInput = { ...absent, parent_id: '01ROOT' };

    expect('parent_id' in absent).toBe(false);
    expect(explicitNull.parent_id).toBeNull();
    expect(withParent.parent_id).toBe('01ROOT');
  });

  it('UpdateMetaInput.parent_id distinguishes absent (unchanged), null (clear-to-root), and a string (set/move)', () => {
    const unchanged: UpdateMetaInput = { title: 'renamed' };
    const clearToRoot: UpdateMetaInput = { parent_id: null };
    const setParent: UpdateMetaInput = { parent_id: '01ROOT' };

    expect('parent_id' in unchanged).toBe(false);
    // present-with-null is a real set value, distinct from absent
    expect('parent_id' in clearToRoot).toBe(true);
    expect(clearToRoot.parent_id).toBeNull();
    expect(setParent.parent_id).toBe('01ROOT');
  });
});
