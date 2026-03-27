/**
 * readiness-gate.test.ts — Tests for the MCP readiness gate.
 *
 * The readiness gate ensures that tool calls block until the index rebuild
 * is complete, and that errors propagate cleanly if the rebuild fails.
 *
 * Because the gate is a module-level singleton (one promise per import),
 * we create fresh gate instances per test to avoid cross-test pollution.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Helper: create a fresh readiness gate (mirrors tools/index.ts logic)
// ---------------------------------------------------------------------------

function createGate() {
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const indexReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  return {
    indexReady,
    signalIndexReady: () => resolveReady(),
    signalIndexFailed: (err: Error) => rejectReady(err),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readiness gate", () => {
  it("blocks until signalIndexReady is called", async () => {
    const gate = createGate();
    let resolved = false;

    const pending = gate.indexReady.then(() => {
      resolved = true;
    });

    // Gate should not have resolved yet
    await Promise.resolve(); // flush microtasks
    expect(resolved).toBe(false);

    // Signal readiness
    gate.signalIndexReady();
    await pending;
    expect(resolved).toBe(true);
  });

  it("propagates errors when signalIndexFailed is called", async () => {
    const gate = createGate();
    const error = new Error("rebuildIndex exploded");

    gate.signalIndexFailed(error);

    await expect(gate.indexReady).rejects.toThrow("rebuildIndex exploded");
  });

  it("resolves immediately on subsequent awaits after signalIndexReady", async () => {
    const gate = createGate();
    gate.signalIndexReady();

    // First await
    await gate.indexReady;

    // Second await — should resolve immediately, not hang
    await gate.indexReady;
  });

  it("rejects immediately on subsequent awaits after signalIndexFailed", async () => {
    const gate = createGate();
    gate.signalIndexFailed(new Error("index broken"));

    // Catch the first rejection
    await expect(gate.indexReady).rejects.toThrow("index broken");

    // Second await — should also reject immediately
    await expect(gate.indexReady).rejects.toThrow("index broken");
  });

  it("tool handler blocks during rebuild, then executes after signalIndexReady", async () => {
    const gate = createGate();

    // Simulate a tool handler that awaits the gate before returning
    async function mockToolHandler(): Promise<string> {
      await gate.indexReady;
      return "tool result";
    }

    // Start the tool call — it should be pending
    let result: string | undefined;
    const toolPromise = mockToolHandler().then((r) => {
      result = r;
    });

    // Flush microtasks — tool should still be waiting
    await Promise.resolve();
    expect(result).toBeUndefined();

    // Signal readiness — tool should now complete
    gate.signalIndexReady();
    await toolPromise;
    expect(result).toBe("tool result");
  });

  it("concurrent tool calls all unblock when gate resolves", async () => {
    const gate = createGate();

    async function mockToolHandler(id: number): Promise<number> {
      await gate.indexReady;
      return id;
    }

    // Launch several concurrent tool calls
    const promises = [1, 2, 3, 4, 5].map((id) => mockToolHandler(id));

    // None should have resolved yet
    await Promise.resolve();

    // Signal readiness — all should complete
    gate.signalIndexReady();
    const results = await Promise.all(promises);
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it("concurrent tool calls all reject when gate fails", async () => {
    const gate = createGate();

    async function mockToolHandler(): Promise<string> {
      await gate.indexReady;
      return "should not reach here";
    }

    const promises = [mockToolHandler(), mockToolHandler(), mockToolHandler()];

    gate.signalIndexFailed(new Error("rebuild failed"));

    for (const p of promises) {
      await expect(p).rejects.toThrow("rebuild failed");
    }
  });
});
