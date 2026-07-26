// plugin/src/work-state/dag.test.ts — acceptance tests for the
// depends_on cycle + dangling-reference guard.
//
// Pure graph logic: an in-memory `Map<string, string[]>` stands in for the
// store lookup this module is deliberately decoupled from (dag.ts imports
// nothing from store.ts, schema.ts, or verbs.ts).

import { describe, expect, it } from 'vitest';

import {
  DagError,
  assertDependenciesExist,
  assertNoCycle,
  assertNoParentCycle,
  assertParentExists,
  assertSupersedesTargetsExist,
} from './dag.js';
import type { DependsOnLookup, ParentLookup } from './dag.js';

function lookupFrom(graph: Record<string, string[]>): DependsOnLookup {
  return (id: string) => graph[id];
}

/** Parent-chain lookup from an in-memory map: a key present maps to its
 *  `parent_id` (a string, or `null` for a root); a key ABSENT maps to
 *  `undefined` (the item does not exist). */
function parentLookupFrom(graph: Record<string, string | null>): ParentLookup {
  return (id: string) => (id in graph ? graph[id] : undefined);
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

describe('assertParentExists (containment)', () => {
  it('passes silently when the parent resolves (including a parent that is itself a root)', () => {
    const lookup = parentLookupFrom({ p: null, q: 'p' });
    expect(() => assertParentExists('p', lookup)).not.toThrow();
    expect(() => assertParentExists('q', lookup)).not.toThrow();
  });

  it('throws a typed DANGLING_PARENT error naming the missing parent id', () => {
    const lookup = parentLookupFrom({ p: null });
    let thrown: unknown;
    try {
      assertParentExists('ghost', lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_PARENT');
    expect((thrown as DagError).message).toContain('ghost');
  });
});

describe('assertNoParentCycle (containment)', () => {
  it('passes silently on an acyclic parent chain terminating at a root', () => {
    // c -> b -> a -> (root). Proposing d's parent = c walks up cleanly.
    const lookup = parentLookupFrom({ a: null, b: 'a', c: 'b' });
    expect(() => assertNoParentCycle('d', 'c', lookup)).not.toThrow();
  });

  it('rejects a direct self-parent: a is its own parent, naming "a → a"', () => {
    const lookup = parentLookupFrom({ a: null });
    let thrown: unknown;
    try {
      assertNoParentCycle('a', 'a', lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('PARENT_CYCLE');
    expect((thrown as DagError).message).toContain('a → a');
  });

  it('rejects a longer ancestor cycle and NAMES the full chain', () => {
    // Existing: c -> b, b -> a (a is a root). Proposing a's parent = c closes
    // the loop a -> c -> b -> a.
    const lookup = parentLookupFrom({ a: null, b: 'a', c: 'b' });
    let thrown: unknown;
    try {
      assertNoParentCycle('a', 'c', lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('PARENT_CYCLE');
    expect((thrown as DagError).message).toContain('a → c → b → a');
  });

  it('treats a dangling ancestor as a clean dead end — that is assertParentExists\'s job', () => {
    // The proposed parent exists, but ITS parent points at a nonexistent item.
    const lookup = parentLookupFrom({ p: 'ghost' });
    expect(() => assertNoParentCycle('a', 'p', lookup)).not.toThrow();
  });

  it('catches a PRE-EXISTING corrupt ancestor chain not passing through the item (defense-in-depth)', () => {
    // x -> y -> x already exists (corruption); proposing a brand-new synthetic
    // item's parent = x must still surface (and name) that cycle rather than
    // looping forever.
    const lookup = parentLookupFrom({ x: 'y', y: 'x' });
    let thrown: unknown;
    try {
      assertNoParentCycle('__synthetic__', 'x', lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('PARENT_CYCLE');
    expect((thrown as DagError).message).toContain('x → y → x');
  });
});

describe('assertSupersedesTargetsExist', () => {
  it('passes silently when every edge target resolves', () => {
    const lookup = lookupFrom({ a: [], b: [] });
    expect(() =>
      assertSupersedesTargetsExist(
        [
          { rel: 'supersedes', id: 'a' },
          { rel: 'relates-to', id: 'b' },
        ],
        lookup,
      ),
    ).not.toThrow();
  });

  it('passes silently on an empty references list', () => {
    const lookup = lookupFrom({});
    expect(() => assertSupersedesTargetsExist([], lookup)).not.toThrow();
  });

  it('throws a typed DANGLING_SUPERSEDES error naming the missing id', () => {
    const lookup = lookupFrom({ a: [] });
    let thrown: unknown;
    try {
      assertSupersedesTargetsExist([{ rel: 'supersedes', id: 'ghost' }], lookup);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_SUPERSEDES');
    expect((thrown as DagError).message).toContain('ghost');
  });

  it('checks every edge regardless of rel, and lists every missing id, not just the first', () => {
    const lookup = lookupFrom({ a: [] });
    let thrown: unknown;
    try {
      assertSupersedesTargetsExist(
        [
          { rel: 'supersedes', id: 'ghost1' },
          { rel: 'relates-to', id: 'a' },
          { rel: 'refutes', id: 'ghost2' },
        ],
        lookup,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DagError);
    expect((thrown as DagError).code).toBe('DANGLING_SUPERSEDES');
    expect((thrown as DagError).message).toContain('ghost1');
    expect((thrown as DagError).message).toContain('ghost2');
  });

  it('a self-edge does NOT throw — supersedes is existence-guarded only, never cycle-checked', () => {
    // A replacement edge is not a sequencing DAG: even an edge pointing back
    // at the item itself is not this guard's concern (the record store's
    // posture — cycle-check nothing).
    const lookup = lookupFrom({ a: [] });
    expect(() => assertSupersedesTargetsExist([{ rel: 'supersedes', id: 'a' }], lookup)).not.toThrow();
  });
});
