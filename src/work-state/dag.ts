// plugin/src/work-state/dag.ts — depends_on cycle + dangling-reference guard.
//
// `depends_on` is a DAG by contract, and the server enforces it: `create` and
// `update_meta` MUST reject any edit that would introduce a cycle in
// `depends_on` — a server-side check at write time (the graph is small; a
// simple DFS suffices), returning a typed error naming the cycle. Recovery is
// `update_meta` with a corrected dependency list. A companion rule this
// module also enforces: a `depends_on` reference to an item that does not
// exist can never resolve to `done`, so the item carrying it could never
// become claimable — reject it at write time too, typed.
//
// PURE GRAPH LOGIC ONLY: no store access, no SQL, no I/O. verbs.ts supplies a
// `DependsOnLookup` callback (backed by `WorkStateStore#getItem`) so this
// module stays independently testable against an in-memory graph.
//
// Never touches `spec` (opacity): this module only ever looks at
// `depends_on`, which is structured contract data, not the opaque payload.

import { WorkStateModuleError } from './types.js';

/** Typed failure codes this module raises. Distinct from `WorkStateErrorCode`
 *  (types.ts) — that union is store.ts's persistence-layer contract and is
 *  out of this work item's file scope to extend; a DAG violation is a
 *  write-time validation concern one layer up, so it gets its own error
 *  type here instead of smuggling a new code into the store's enum.
 *
 *  `CYCLE`/`DANGLING_DEPENDENCY` guard the `depends_on` graph (SEQUENCING).
 *  `PARENT_CYCLE`/`DANGLING_PARENT` guard the `parent_id` chain
 *  (CONTAINMENT) — deliberately SEPARATE codes for a deliberately separate,
 *  orthogonal invariant: the two guards walk two independent graphs and share
 *  no traversal state. `DANGLING_PARENT` is the single-parent sibling of
 *  `DANGLING_DEPENDENCY`; `PARENT_CYCLE` the parent-chain sibling of `CYCLE`. */
export type DagErrorCode = 'CYCLE' | 'DANGLING_DEPENDENCY' | 'PARENT_CYCLE' | 'DANGLING_PARENT';

/** Typed, loud DAG-guard failure — thrown, never silently swallowed.
 *  Extends `WorkStateModuleError` so callers can catch any
 *  work-state failure with one `instanceof` check; its own `name` and its
 *  own narrow `code` union are unchanged. */
export class DagError extends WorkStateModuleError {
  override readonly name = 'DagError';
  override readonly code: DagErrorCode;

  constructor(code: DagErrorCode, message: string) {
    super(code, message);
    this.code = code;
  }
}

/**
 * Resolve one item's CURRENT `depends_on` list (the state before the edit
 * under validation). `undefined` means the item does not exist — the caller
 * (verbs.ts) backs this with `WorkStateStore#getItem`.
 */
export type DependsOnLookup = (id: string) => string[] | undefined;

/**
 * Reject any id in `dependsOn` that does not resolve via `lookup`. A
 * dangling dependency can never become `done`, so the item it is attached to
 * could never become claimable — this is rejected unconditionally,
 * not just as a cycle special case. Lists every missing id (not just the
 * first) so the caller gets the full picture in one round trip.
 */
export function assertDependenciesExist(dependsOn: readonly string[], lookup: DependsOnLookup): void {
  const missing = dependsOn.filter((id) => lookup(id) === undefined);
  if (missing.length > 0) {
    throw new DagError(
      'DANGLING_DEPENDENCY',
      `work-state dag: depends_on references nonexistent item(s): ${missing.join(', ')}`,
    );
  }
}

/**
 * Reject a `depends_on` edit that would introduce a cycle reachable from
 * `itemId`.
 *
 * `proposedDependsOn` is the CANDIDATE full `depends_on` list for `itemId`
 * (update_meta replaces the list wholesale — see store.ts's `updateMeta` —
 * so this always receives the complete proposed list, never a delta).
 * Every OTHER item's `depends_on` is read through `lookup`, which reflects
 * the graph as it stands BEFORE this edit. Under the invariant that this
 * guard runs on every `create` and `update_meta` (so the graph is already
 * acyclic before any single edit), the only way a cycle can appear is
 * through the edge(s) this edit is about to add — so a depth-first walk
 * starting at `itemId`, following the proposed edges first and every other
 * node's real edges thereafter, that ever reaches `itemId` again names
 * exactly the cycle being introduced.
 *
 * On failure, the thrown `DagError.message` NAMES the cycle path, e.g.
 * `"a → b → c → a"` — the walk's own path, not just "a cycle exists".
 *
 * The DFS is GENERAL: `itemId` is seeded onto the "currently on this walk's
 * stack" set before the walk starts, so reaching it again is just one
 * instance of the broader check — any id revisited while still on the
 * current stack is a cycle, whether or not that id is `itemId` itself. This
 * gives `create()` (which calls this with a synthetic id that can never be
 * `itemId`-equal to any real node — see verbs.ts) genuine defense-in-depth:
 * a pre-existing cycle reachable from the given `depends_on` list, however
 * it arose, is still caught and named.
 */
export function assertNoCycle(itemId: string, proposedDependsOn: readonly string[], lookup: DependsOnLookup): void {
  const path: string[] = [itemId];
  const onStack = new Set<string>([itemId]);

  function walk(dependsOn: readonly string[]): void {
    for (const depId of dependsOn) {
      if (onStack.has(depId)) {
        throw new DagError(
          'CYCLE',
          `work-state dag: depends_on would introduce a cycle: ${[...path, depId].join(' → ')}`,
        );
      }
      const nextDependsOn = lookup(depId);
      // A dangling reference is `assertDependenciesExist`'s job, not this
      // function's — treat an unresolvable id as a dead end for cycle
      // purposes so the two checks stay independently composable.
      if (nextDependsOn === undefined) continue;
      path.push(depId);
      onStack.add(depId);
      walk(nextDependsOn);
      path.pop();
      onStack.delete(depId);
    }
  }

  walk(proposedDependsOn);
}

// ---------------------------------------------------------------------------
// Containment (`parent_id`) guards.
//
// The parent edge is a SECOND, independent structural edge — CONTAINMENT, not
// SEQUENCING. These two guards are kept mechanically DISTINCT from the
// `depends_on` guards above: different functions, a different traversal (a
// single upward parent-CHAIN walk, not the branching depends_on DFS), and
// different error codes. Neither reads the other's edge. This is the hard
// "kept DISTINCT from depends_on's DAG guard" requirement — two independent
// acyclicity invariants over two independent graphs, never one merged check.
// ---------------------------------------------------------------------------

/**
 * Resolve one item's CURRENT single `parent_id` (the state before the edit
 * under validation): a parent id, `null` when the item is a root, or
 * `undefined` when the item does not exist. The caller (verbs.ts) backs this
 * with `WorkStateStore#getItem` (mapping a missing item to `undefined` and a
 * present item's `parent_id` — itself `string | null` — straight through).
 */
export type ParentLookup = (id: string) => string | null | undefined;

/**
 * Reject a non-null `parent_id` that does not resolve via `lookup`. A dangling
 * parent pointer names a container that does not exist, so the containment
 * tree would be broken — rejected at write time, typed, exactly as
 * {@link assertDependenciesExist} rejects a dangling dependency (this is its
 * single-parent sibling). A `null` parent (a root) is never passed here — the
 * caller only invokes this guard when a real parent id is being set.
 */
export function assertParentExists(parentId: string, lookup: ParentLookup): void {
  if (lookup(parentId) === undefined) {
    throw new DagError(
      'DANGLING_PARENT',
      `work-state dag: parent_id references nonexistent item: ${parentId}`,
    );
  }
}

/**
 * Reject a `parent_id` edit that would make `itemId` its own ancestor.
 *
 * Because the parent edge is single-valued, this is a simple upward CHAIN walk
 * (no fan-out, unlike the `depends_on` DFS): start at `proposedParentId` and
 * follow `parent_id -> parent_id -> ...` toward the root. If the walk ever
 * reaches `itemId`, the proposed edge closes a containment cycle — rejected
 * with a typed `PARENT_CYCLE` error NAMING the chain (e.g. `a → b → c → a`),
 * matching how {@link assertNoCycle} names a depends_on cycle. A `null` parent
 * (root reached) terminates the walk cleanly; an `undefined` (dangling
 * ancestor) is a dead end here — reporting it is {@link assertParentExists}'s
 * job, keeping the two guards independently composable.
 *
 * Under the invariant that this guard runs on every create/update_meta (so the
 * tree is acyclic before any single edit), the only edge that can introduce a
 * cycle is the one being added, so walking up from the proposed parent and
 * looking for `itemId` is sufficient and names exactly the introduced cycle.
 * Defense-in-depth: a `visited` set seeded with `itemId` also catches (and
 * names, rather than looping forever on) a PRE-EXISTING corrupt chain among
 * the ancestors, whether or not it passes through `itemId` — mirroring
 * {@link assertNoCycle}'s general-DFS posture. `create()` calls this with a
 * synthetic id that can never equal a real node, giving it that same
 * defense-in-depth even though a brand-new item cannot structurally be its own
 * ancestor yet.
 */
export function assertNoParentCycle(itemId: string, proposedParentId: string, lookup: ParentLookup): void {
  const path: string[] = [itemId];
  const onPath = new Set<string>([itemId]);
  let current: string | null | undefined = proposedParentId;
  while (current !== null && current !== undefined) {
    path.push(current);
    if (onPath.has(current)) {
      throw new DagError(
        'PARENT_CYCLE',
        `work-state dag: parent_id would introduce a cycle: ${path.join(' → ')}`,
      );
    }
    onPath.add(current);
    current = lookup(current);
  }
}
