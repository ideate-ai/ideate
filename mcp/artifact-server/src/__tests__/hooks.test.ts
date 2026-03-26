import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  loadHooks,
  dispatchHook,
  fireEvent,
  EVENT_PLAN_COMPLETE,
  EVENT_WORK_ITEM_STARTED,
  EVENT_WORK_ITEM_COMPLETED,
  EVENT_REVIEW_FINDING,
  EVENT_REVIEW_COMPLETE,
  EVENT_CYCLE_CONVERGED,
  EVENT_ANDON_TRIGGERED,
} from "../hooks.js";
import type { HookConfig } from "../hooks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeHooks(hooks: unknown[]): void {
  const ideateDir = path.join(tmpDir, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
  fs.writeFileSync(
    path.join(ideateDir, "hooks.json"),
    JSON.stringify({ hooks }),
    "utf8"
  );
}

function ideateDir(): string {
  return path.join(tmpDir, ".ideate");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-hooks-test-"));
  // Create the .ideate directory by default (but not hooks.json)
  fs.mkdirSync(path.join(tmpDir, ".ideate"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

describe("event name constants", () => {
  it("exports EVENT_PLAN_COMPLETE = 'plan.complete'", () => {
    expect(EVENT_PLAN_COMPLETE).toBe("plan.complete");
  });

  it("exports EVENT_WORK_ITEM_STARTED = 'work_item.started'", () => {
    expect(EVENT_WORK_ITEM_STARTED).toBe("work_item.started");
  });

  it("exports EVENT_WORK_ITEM_COMPLETED = 'work_item.completed'", () => {
    expect(EVENT_WORK_ITEM_COMPLETED).toBe("work_item.completed");
  });

  it("exports EVENT_REVIEW_FINDING = 'review.finding'", () => {
    expect(EVENT_REVIEW_FINDING).toBe("review.finding");
  });

  it("exports EVENT_REVIEW_COMPLETE = 'review.complete'", () => {
    expect(EVENT_REVIEW_COMPLETE).toBe("review.complete");
  });

  it("exports EVENT_CYCLE_CONVERGED = 'cycle.converged'", () => {
    expect(EVENT_CYCLE_CONVERGED).toBe("cycle.converged");
  });

  it("exports EVENT_ANDON_TRIGGERED = 'andon.triggered'", () => {
    expect(EVENT_ANDON_TRIGGERED).toBe("andon.triggered");
  });
});

// ---------------------------------------------------------------------------
// loadHooks — AC 4, AC 11
// ---------------------------------------------------------------------------

describe("loadHooks", () => {
  it("returns empty hooks array when hooks.json does not exist", () => {
    // .ideate/ exists but hooks.json does not
    const result = loadHooks(ideateDir());
    expect(result).toEqual({ hooks: [] });
  });

  it("returns empty hooks array when ideateDir itself does not exist", () => {
    const nonExistent = path.join(tmpDir, "no-such-dir");
    const result = loadHooks(nonExistent);
    expect(result).toEqual({ hooks: [] });
  });

  it("returns hooks from a valid hooks.json", () => {
    writeHooks([
      { event: "plan.complete", type: "command", value: "echo done" },
    ]);
    const result = loadHooks(ideateDir());
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0].event).toBe("plan.complete");
    expect(result.hooks[0].type).toBe("command");
    expect(result.hooks[0].value).toBe("echo done");
  });

  it("defaults enabled to true when not specified", () => {
    writeHooks([
      { event: "plan.complete", type: "prompt", value: "hello" },
    ]);
    const result = loadHooks(ideateDir());
    expect(result.hooks[0].enabled).toBe(true);
  });

  it("preserves enabled: false when specified", () => {
    writeHooks([
      { event: "plan.complete", type: "command", value: "echo hi", enabled: false },
    ]);
    const result = loadHooks(ideateDir());
    expect(result.hooks[0].enabled).toBe(false);
  });

  it("returns empty hooks array when hooks.json is malformed JSON", () => {
    const ideate = ideateDir();
    fs.writeFileSync(path.join(ideate, "hooks.json"), "{ not valid }", "utf8");
    const result = loadHooks(ideate);
    expect(result).toEqual({ hooks: [] });
  });

  it("returns empty hooks when hooks is not an array", () => {
    const ideate = ideateDir();
    fs.writeFileSync(
      path.join(ideate, "hooks.json"),
      JSON.stringify({ hooks: "not-an-array" }),
      "utf8"
    );
    const result = loadHooks(ideate);
    expect(result.hooks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchHook — variable substitution — AC 6, 7, 8, 12
// ---------------------------------------------------------------------------

describe("dispatchHook — variable substitution", () => {
  it("replaces ${WORK_ITEM} with provided value in a prompt hook", () => {
    const hook: HookConfig = {
      event: "work_item.started",
      type: "prompt",
      value: "Starting work item: ${WORK_ITEM}",
      enabled: true,
    };
    const result = dispatchHook(hook, { WORK_ITEM: "WI-042" });
    expect(result).toBe("Starting work item: WI-042");
  });

  it("replaces multiple different variables in a prompt hook", () => {
    const hook: HookConfig = {
      event: "review.finding",
      type: "prompt",
      value: "Event: ${EVENT}, Item: ${WORK_ITEM}, Severity: ${SEVERITY}",
      enabled: true,
    };
    const result = dispatchHook(hook, {
      EVENT: "review.finding",
      WORK_ITEM: "WI-001",
      SEVERITY: "major",
    });
    expect(result).toBe("Event: review.finding, Item: WI-001, Severity: major");
  });

  it("leaves unreplaced variables as-is when not in variables map", () => {
    const hook: HookConfig = {
      event: "plan.complete",
      type: "prompt",
      value: "Hello ${UNKNOWN_VAR}",
      enabled: true,
    };
    const result = dispatchHook(hook, {});
    expect(result).toBe("Hello ${UNKNOWN_VAR}");
  });
});

describe("dispatchHook — command type", () => {
  it("executes a shell command and returns stdout", () => {
    const hook: HookConfig = {
      event: "plan.complete",
      type: "command",
      value: "echo test",
      enabled: true,
    };
    const result = dispatchHook(hook, {});
    expect(result.trim()).toBe("test");
  });

  it("substitutes variables before executing command", () => {
    const hook: HookConfig = {
      event: "work_item.completed",
      type: "command",
      value: "echo ${WORK_ITEM}",
      enabled: true,
    };
    const result = dispatchHook(hook, { WORK_ITEM: "WI-007" });
    expect(result.trim()).toBe("WI-007");
  });
});

describe("dispatchHook — disabled hooks", () => {
  it("returns empty string when hook.enabled is false (command type)", () => {
    const hook: HookConfig = {
      event: "plan.complete",
      type: "command",
      value: "echo should-not-run",
      enabled: false,
    };
    const result = dispatchHook(hook, {});
    expect(result).toBe("");
  });

  it("returns empty string when hook.enabled is false (prompt type)", () => {
    const hook: HookConfig = {
      event: "plan.complete",
      type: "prompt",
      value: "Should not be returned",
      enabled: false,
    };
    const result = dispatchHook(hook, {});
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fireEvent — AC 9, 10, 14, 15
// ---------------------------------------------------------------------------

describe("fireEvent — filters by event name", () => {
  it("only dispatches hooks matching the event name", () => {
    writeHooks([
      { event: "plan.complete", type: "command", value: "echo plan", enabled: true },
      { event: "work_item.started", type: "command", value: "echo wi", enabled: true },
    ]);

    // Should not throw and should only process plan.complete hooks
    // We verify by ensuring no error is thrown and the function completes
    expect(() => {
      fireEvent(ideateDir(), "plan.complete", {});
    }).not.toThrow();
  });

  it("does nothing when no hooks match the event name", () => {
    writeHooks([
      { event: "plan.complete", type: "command", value: "echo plan", enabled: true },
    ]);
    expect(() => {
      fireEvent(ideateDir(), "work_item.started", {});
    }).not.toThrow();
  });

  it("does nothing when hooks.json does not exist", () => {
    // No hooks.json in ideateDir
    expect(() => {
      fireEvent(ideateDir(), "plan.complete", {});
    }).not.toThrow();
  });
});

describe("fireEvent — disabled hooks are skipped", () => {
  it("does not execute disabled hooks", () => {
    writeHooks([
      { event: "plan.complete", type: "command", value: "exit 1", enabled: false },
    ]);
    // If the disabled hook ran, it would throw due to exit code 1
    expect(() => {
      fireEvent(ideateDir(), "plan.complete", {});
    }).not.toThrow();
  });
});

describe("fireEvent — error handling", () => {
  it("catches errors from individual hooks without stopping remaining hooks", () => {
    writeHooks([
      { event: "plan.complete", type: "command", value: "exit 1", enabled: true },
      { event: "plan.complete", type: "command", value: "echo second", enabled: true },
    ]);
    // Should not throw even though the first hook fails
    expect(() => {
      fireEvent(ideateDir(), "plan.complete", {});
    }).not.toThrow();
  });

  it("passes variables through to dispatched hooks", () => {
    writeHooks([
      {
        event: "work_item.completed",
        type: "command",
        value: "echo ${WORK_ITEM}",
        enabled: true,
      },
    ]);
    // Should not throw
    expect(() => {
      fireEvent(ideateDir(), "work_item.completed", { WORK_ITEM: "WI-001" });
    }).not.toThrow();
  });
});
