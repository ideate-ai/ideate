// plugin/src/work-state/dag.test.ts — WI-302 acceptance tests for the
// depends_on cycle + dangling-reference guard.
//
// Pure graph logic: an in-memory `Map<string, string[]>` stands in for the
// store lookup this module is deliberately decoupled from (dag.ts imports
// nothing from store.ts, schema.ts, or verbs.ts).

import { describe, expect, it } from 'vitest';

import { DagError, assertDependenciesExist, assertNoCycle } from './dag.js';
import type { DependsOnLookup } from './dag.js';

function lookupFrom(graph: Record<string, string[]>): DependsOnLookup {
  return (id: string) => graph[id];
}

describe('assertDependenciesExist', () => {
  it('passes silently when every referenced id resolves', () => {
    const lookup = lookupFrom({ a: [], b: ['a'] });
    expect(() => assertDependenciesExist(['a'], lookup)).not.toThrow();
  });

  it('passes silently on an empty depends_on list', () => {
    const lookup = lookupFrom({});
    expect(() => assertDependenciesExist([], lookup)).not.toThrow();
  });

  it('throws a typed DANGLING_DEPENDENCY error naming the missing id', () => {
    const lookup = lookupFrom({ a: [] });
    let thrown: unknown;
    try {
      assertDependenciesExist(['ghost'], lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_DEPENDENCY');
    expect((thrown as DagError).message).toContain('ghost');
  });

  it('lists every missing id, not just the first', () => {
    const lookup = lookupFrom({ a: [] });
    let thrown: unknown;
    try {
      assertDependenciesExist(['ghost1', 'a', 'ghost2'], lookup);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as DagError).message).toContain('ghost1');
    expect((thrown as DagError).message).toContain('ghost2');
  });
});

describe('assertNoCycle', () => {
  it('passes silently on an acyclic graph, including a diamond shape', () => {
    // a -> b -> d, a -> c -> d (diamond; d has no deps)
    const graph: Record<string, string[]> = { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] };
    const lookup = lookupFrom(graph);
    expect(() => assertNoCycle('a', graph['a'] as string[], lookup)).not.toThrow();
  });

  it('passes silently on an empty proposed depends_on list', () => {
    const lookup = lookupFrom({});
    expect(() => assertNoCycle('a', [], lookup)).not.toThrow();
  });

  it('rejects direct self-reference: a depends on itself', () => {
    const lookup = lookupFrom({ a: [] });
    let thrown: unknown;
    try {
      assertNoCycle('a', ['a'], lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('CYCLE');
    expect((thrown as DagError).message).toContain('a → a');
  });

  it('rejects a longer cycle and NAMES the full path in the error', () => {
    // Proposing a -> b, where b -> c -> a already (b, c pre-existing).
    const graph: Record<string, string[]> = { b: ['c'], c: ['a'] };
    const lookup = lookupFrom(graph);
    let thrown: unknown;
    try {
      assertNoCycle('a', ['b'], lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('CYCLE');
    expect((thrown as DagError).message).toContain('a → b → c → a');
  });

  it('does not throw for a dangling reference — that is assertDependenciesExist\'s job', () => {
    const lookup = lookupFrom({});
    expect(() => assertNoCycle('a', ['ghost'], lookup)).not.toThrow();
  });

  it('catches a cycle among referenced items even when the walk never revisits the root id (defense-in-depth)', () => {
    // x -> y -> x already exists (simulating a corrupted/pre-existing
    // sub-graph); proposing that a brand-new synthetic root depends on x
    // must still surface that cycle, since the walk is general (any repeat
    // on the current stack is a cycle, not only a return to the root).
    const graph: Record<string, string[]> = { x: ['y'], y: ['x'] };
    const lookup = lookupFrom(graph);
    let thrown: unknown;
    try {
      assertNoCycle('__synthetic_root__', ['x'], lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('CYCLE');
    expect((thrown as DagError).message).toContain('x → y → x');
  });
});
