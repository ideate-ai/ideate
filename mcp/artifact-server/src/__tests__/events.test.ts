/**
 * events.test.ts — Integration tests for handleEmitEvent tool.
 *
 * Tests the event emission system which dispatches hooks based on event names.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import type { ToolContext } from "../types.js";
import { handleEmitEvent } from "../tools/events.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let artifactDir: string;
let db: Database.Database;
let ctx: ToolContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-events-test-"));
  artifactDir = path.join(tmpDir, "artifact");

  // Create artifact dir structure
  fs.mkdirSync(artifactDir, { recursive: true });

  // Open a temp-file DB
  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });
  ctx = { db, drizzleDb, ideateDir: artifactDir };
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper to create hooks.json
// ---------------------------------------------------------------------------

function writeHooks(hooks: Array<{event: string; type: string; value: string; enabled?: boolean}>): void {
  fs.writeFileSync(
    path.join(artifactDir, "hooks.json"),
    JSON.stringify({ hooks }),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleEmitEvent", () => {
  describe("required parameters", () => {
    it("throws when event parameter is missing", async () => {
      await expect(
        handleEmitEvent(ctx, { variables: { foo: "bar" } })
      ).rejects.toThrow("Missing required parameter: event");
    });

    it("throws when event is empty string", async () => {
      await expect(
        handleEmitEvent(ctx, { event: "" })
      ).rejects.toThrow("Missing required parameter: event");
    });

    it("throws when event is null", async () => {
      await expect(
        handleEmitEvent(ctx, { event: null })
      ).rejects.toThrow("Missing required parameter: event");
    });
  });

  describe("valid event emission", () => {
    it("returns summary with no hooks when hooks.json does not exist", async () => {
      const result = await handleEmitEvent(ctx, { event: "test.event" });
      const parsed = JSON.parse(result);

      expect(parsed.event).toBe("test.event");
      expect(parsed.hooks_matched).toBe(0);
      expect(parsed.hooks_executed).toBe(0);
      expect(parsed.errors).toEqual([]);
    });

    it("returns summary with no hooks when hooks.json is empty", async () => {
      writeHooks([]);
      const result = await handleEmitEvent(ctx, { event: "test.event" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(0);
      expect(parsed.hooks_executed).toBe(0);
    });

    it("matches and executes a single hook", async () => {
      writeHooks([
        { event: "test.event", type: "prompt", value: "echo ${FOO}" }
      ]);

      const result = await handleEmitEvent(ctx, {
        event: "test.event",
        variables: { FOO: "bar" }
      });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(1);
      expect(parsed.hooks_executed).toBe(1);
      expect(parsed.errors).toEqual([]);
    });

    it("matches multiple hooks for the same event", async () => {
      writeHooks([
        { event: "multi.event", type: "prompt", value: "hook1" },
        { event: "multi.event", type: "prompt", value: "hook2" },
        { event: "other.event", type: "prompt", value: "hook3" }
      ]);

      const result = await handleEmitEvent(ctx, { event: "multi.event" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(2);
      expect(parsed.hooks_executed).toBe(2);
    });
  });

  describe("variable substitution", () => {
    it("substitutes variables in hook values", async () => {
      writeHooks([
        { event: "var.event", type: "prompt", value: "Result: ${WORK_ITEM_ID}" }
      ]);

      const result = await handleEmitEvent(ctx, {
        event: "var.event",
        variables: { WORK_ITEM_ID: "WI-123" }
      });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_executed).toBe(1);
      expect(parsed.errors).toEqual([]);
    });

    it("coerces variable values to strings", async () => {
      writeHooks([
        { event: "coerce.event", type: "prompt", value: "Number: ${NUM}" }
      ]);

      const result = await handleEmitEvent(ctx, {
        event: "coerce.event",
        variables: { NUM: 42 } as Record<string, unknown>
      });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_executed).toBe(1);
    });

    it("handles missing variables gracefully", async () => {
      writeHooks([
        { event: "missing.var", type: "prompt", value: "Value: ${MISSING}" }
      ]);

      const result = await handleEmitEvent(ctx, { event: "missing.var" });
      const parsed = JSON.parse(result);

      // Hook should still execute, ${MISSING} remains unsubstituted
      expect(parsed.hooks_executed).toBe(1);
    });
  });

  describe("hook execution errors", () => {
    it("catches hook errors and reports them", async () => {
      writeHooks([
        { event: "error.event", type: "command", value: "exit 1" }
      ]);

      const result = await handleEmitEvent(ctx, { event: "error.event" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(1);
      expect(parsed.hooks_executed).toBe(0);
      expect(parsed.errors.length).toBe(1);
      expect(parsed.errors[0]).toContain("Hook \"exit 1\" (command) failed");
    });

    it("continues executing hooks after one fails", async () => {
      writeHooks([
        { event: "multi.error", type: "command", value: "exit 1" },
        { event: "multi.error", type: "prompt", value: "success" }
      ]);

      const result = await handleEmitEvent(ctx, { event: "multi.error" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(2);
      expect(parsed.hooks_executed).toBe(1);
      expect(parsed.errors.length).toBe(1);
    });
  });

  describe("enabled/disabled hooks", () => {
    it("skips disabled hooks", async () => {
      writeHooks([
        { event: "enabled.test", type: "prompt", value: "active", enabled: true },
        { event: "enabled.test", type: "prompt", value: "inactive", enabled: false }
      ]);

      const result = await handleEmitEvent(ctx, { event: "enabled.test" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(1); // Only enabled hooks counted
      expect(parsed.hooks_executed).toBe(1);
    });

    it("treats missing enabled field as true (enabled by default)", async () => {
      writeHooks([
        { event: "default.enabled", type: "prompt", value: "test" }
        // enabled field is missing, should default to true
      ]);

      const result = await handleEmitEvent(ctx, { event: "default.enabled" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(1);
      expect(parsed.hooks_executed).toBe(1);
    });
  });

  describe("malformed hooks.json", () => {
    it("returns empty hooks when hooks.json is malformed", async () => {
      fs.writeFileSync(
        path.join(artifactDir, "hooks.json"),
        "{ invalid json",
        "utf8"
      );

      const result = await handleEmitEvent(ctx, { event: "test.event" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(0);
      expect(parsed.hooks_executed).toBe(0);
    });

    it("handles hooks.json with missing hooks array", async () => {
      fs.writeFileSync(
        path.join(artifactDir, "hooks.json"),
        JSON.stringify({ otherField: "value" }),
        "utf8"
      );

      const result = await handleEmitEvent(ctx, { event: "test.event" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(0);
    });
  });

  describe("event matching", () => {
    it("only matches hooks with exact event name", async () => {
      writeHooks([
        { event: "exact.match", type: "prompt", value: "match" },
        { event: "exact.match.other", type: "prompt", value: "no_match" },
        { event: "prefix.exact.match", type: "prompt", value: "no_match" }
      ]);

      const result = await handleEmitEvent(ctx, { event: "exact.match" });
      const parsed = JSON.parse(result);

      expect(parsed.hooks_matched).toBe(1);
    });

    it("handles standard event names", async () => {
      writeHooks([
        { event: "work_item.started", type: "prompt", value: "started" },
        { event: "work_item.completed", type: "prompt", value: "completed" }
      ]);

      const startedResult = await handleEmitEvent(ctx, { event: "work_item.started" });
      const started = JSON.parse(startedResult);
      expect(started.hooks_executed).toBe(1);

      const completedResult = await handleEmitEvent(ctx, { event: "work_item.completed" });
      const completed = JSON.parse(completedResult);
      expect(completed.hooks_executed).toBe(1);
    });
  });
});