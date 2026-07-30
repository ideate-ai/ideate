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

/** A `DependsOnLookup` that also RECORDS every call, so a complexity claim
 *  ("the walk is O(V+E), not exponential") becomes a mechanical assertion
 *  rather than a comment: each `lookup` stands for one store row read, so the
 *  call count is the cost the guard imposes on the store. */
function countingLookupFrom(graph: Record<string, string[]>): {
  lookup: DependsOnLookup;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    lookup: (id: string) => {
      calls.push(id);
      return graph[id];
    },
  };
}

/** Build a LATTICE dependency graph of `n` items (`i0 … i{n-1}`) where each
 *  item depends on the previous TWO — the natural shape of incrementally
 *  planned work, and the shape on which a path-enumerating walk costs
 *  Fibonacci-many visits. `V = n`, `E = 2n - 3` (for n >= 2). */
function latticeGraph(n: number): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (let i = 0; i < n; i += 1) {
    const deps: string[] = [];
    if (i >= 1) deps.push(`i${i - 1}`);
    if (i >= 2) deps.push(`i${i - 2}`);
    graph[`i${i}`] = deps;
  }
  return graph;
}

/** The `depends_on` a NEW item added on top of an `n`-item lattice would
 *  carry: the previous two items. */
function latticeHead(n: number): string[] {
  return [`i${n - 1}`, `i${n - 2}`];
}

/** Extract the arrow-joined cycle path a `CYCLE` error NAMES, e.g.
 *  `"a → b → c → a"` → `['a', 'b', 'c', 'a']`. */
function namedCyclePath(thrown: unknown): string[] {
  expect(thrown).toBeInstanceOf(DagError);
  expect((thrown as DagError).code).toBe('CYCLE');
  const marker = 'cycle: ';
  const message = (thrown as DagError).message;
  const at = message.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  return message.slice(at + marker.length).split(' → ');
}

/** Assert the NAMED path is a genuine walk through the graph: it starts at
 *  `itemId`, every consecutive pair is a real edge (the first hop through the
 *  PROPOSED list, every later hop through the graph as stored), and the final
 *  id repeats an earlier one — i.e. it really does close a loop. This is the
 *  property a memo could quietly break: a fast guard that names a path which
 *  is not actually in the graph is worse than a slow one. */
function expectGenuineCyclePath(
  named: readonly string[],
  itemId: string,
  proposedDependsOn: readonly string[],
  graph: Record<string, string[]>,
): void {
  expect(named[0]).toBe(itemId);
  expect(named.length).toBeGreaterThan(1);
  for (let i = 0; i < named.length - 1; i += 1) {
    const from = named[i] as string;
    const to = named[i + 1] as string;
    const edges = i === 0 ? proposedDependsOn : graph[from];
    expect(edges, `no edge list for ${from}`).toBeDefined();
    expect(edges as readonly string[], `${from} → ${to} is not a real edge`).toContain(to);
  }
  // The last hop lands on an id already on the named path — that is the loop.
  expect(named.slice(0, -1)).toContain(named[named.length - 1]);
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

describe('assertNoCycle — fully-explored memo', () => {
  // The walk marks a node fully-explored once its subtree returns clean, so a
  // node reachable by k distinct paths is walked ONCE, not k times. Without
  // that memo a lattice costs Fibonacci-many visits: measured on the pre-memo
  // code, a 40-item lattice took 433,494,435 lookups / ~15s in memory (and far
  // worse through the store, where every lookup is a row read). These tests
  // pin both halves of the change: the cost collapses, and cycle detection —
  // including a cycle reachable only THROUGH a node the memo skips — does not.

  it('completes a 40-item lattice well inside a fixed time budget', () => {
    // Pre-memo this same graph took ~15s; post-memo it is sub-millisecond. The
    // budget is deliberately loose (a slow, loaded CI box still passes) yet
    // still an order of magnitude under the pre-memo cost, so the assertion
    // falsifies the defect rather than measuring machine speed.
    const graph = latticeGraph(40);
    const lookup = lookupFrom(graph);
    const startedAt = performance.now();
    expect(() => assertNoCycle('__new__', latticeHead(40), lookup)).not.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it('reads each reachable node ONCE: lookups are linear, not exponential', () => {
    // The walk traverses each of the 2n - 3 lattice edges once (O(E) work) but
    // the memo is checked BEFORE `lookup`, so only the FIRST edge into a node
    // reads it: exactly n lookups for n reachable nodes, no duplicates. Stated
    // as a closed form in n (not read back from the run), and asserted at two
    // sizes so the growth is pinned as LINEAR — a drift back toward path
    // enumeration (Fibonacci: 433,494,435 lookups at n = 40) fails loudly here.
    for (const n of [40, 200]) {
      const graph = latticeGraph(n);
      const { lookup, calls } = countingLookupFrom(graph);
      assertNoCycle('__new__', latticeHead(n), lookup);
      expect(calls.length).toBe(n);
      expect(new Set(calls).size).toBe(n);
    }
  });

  it('still detects a cycle reachable through a node already fully explored', () => {
    // `shared` is reached by three distinct paths and is fully explored (clean)
    // on the FIRST branch, so both later encounters are memo skips. The cycle
    // sits past those skips: a memo that suppressed the re-walk of `x`/`y` too
    // — the classic conflation of "explored" with "seen" — would miss it.
    const graph: Record<string, string[]> = {
      a: [],
      shared: ['leaf1', 'leaf2'],
      leaf1: [],
      leaf2: [],
      x: ['shared', 'y'],
      y: ['shared', 'a'],
    };
    const { lookup, calls } = countingLookupFrom(graph);
    const proposed = ['shared', 'x'];
    let thrown: unknown;
    try {
      assertNoCycle('a', proposed, lookup);
    } catch (err) {
      thrown = err;
    }
    const named = namedCyclePath(thrown);
    expect(named).toEqual(['a', 'x', 'y', 'a']);
    expectGenuineCyclePath(named, 'a', proposed, graph);
    // The memo really was in play: `shared` was reached three times but read
    // once (this is what makes the case above the interesting one).
    expect(calls.filter((id) => id === 'shared').length).toBe(1);
  });

  it('still detects a cycle discovered AFTER a large sub-graph was memoized', () => {
    // The whole 40-item lattice is walked and memoized on the first proposed
    // edge; only then does the second edge reach `z`, whose own deps are a
    // memo hit followed by the back-edge that closes the loop.
    const graph = latticeGraph(40);
    graph['z'] = ['i37', 'a'];
    const proposed = ['i39', 'z'];
    const lookup = lookupFrom(graph);
    let thrown: unknown;
    try {
      assertNoCycle('a', proposed, lookup);
    } catch (err) {
      thrown = err;
    }
    const named = namedCyclePath(thrown);
    expect(named).toEqual(['a', 'z', 'a']);
    expectGenuineCyclePath(named, 'a', proposed, graph);
  });

  it('still names a genuine long path when the cycle is deep inside the lattice', () => {
    // A back-edge from the lattice floor to a node high above it: the named
    // path is the walk's own descent, ~38 hops, and every hop must be a real
    // edge — a memo that let the walk skip nodes it then NAMED would produce a
    // path that does not exist in the graph.
    const graph = latticeGraph(40);
    (graph['i0'] as string[]).push('i35');
    const proposed = latticeHead(40);
    let thrown: unknown;
    try {
      assertNoCycle('__new__', proposed, lookupFrom(graph));
    } catch (err) {
      thrown = err;
    }
    const named = namedCyclePath(thrown);
    expectGenuineCyclePath(named, '__new__', proposed, graph);
    expect(named[named.length - 1]).toBe('i35');
    expect(named.length).toBeGreaterThan(2);
  });

  it('keeps a dangling reference a dead end even when many paths reach it', () => {
    // Composability with `assertDependenciesExist` is unchanged: the cycle
    // guard still ignores unresolvable ids (memoized or not), and the
    // existence guard still reports them — two independent checks.
    const graph = latticeGraph(20);
    (graph['i0'] as string[]).push('ghost');
    const { lookup, calls } = countingLookupFrom(graph);
    expect(() => assertNoCycle('__new__', latticeHead(20), lookup)).not.toThrow();
    // `ghost` is a dead end, reached once (i0 itself is walked once).
    expect(calls.filter((id) => id === 'ghost').length).toBe(1);
    expect(() => assertDependenciesExist(['ghost'], lookupFrom(graph))).toThrow(DagError);
  });

  it('does not leak the memo across invocations — each call re-walks the CURRENT graph', () => {
    // The graph mutates between writes, so a node proven clean on one call
    // says nothing about the next. A clean call followed by a mutation that
    // introduces a cycle through that same node must still throw.
    const graph: Record<string, string[]> = { a: [], b: ['a'], c: ['b'] };
    const lookup = lookupFrom(graph);
    expect(() => assertNoCycle('__new__', ['c'], lookup)).not.toThrow();
    graph['a'] = ['c'];
    let thrown: unknown;
    try {
      assertNoCycle('__new__', ['c'], lookup);
    } catch (err) {
      thrown = err;
    }
    const named = namedCyclePath(thrown);
    expect(named).toEqual(['__new__', 'c', 'b', 'a', 'c']);
    expectGenuineCyclePath(named, '__new__', ['c'], graph);
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
