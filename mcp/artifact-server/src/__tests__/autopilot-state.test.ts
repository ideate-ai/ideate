/**
 * autopilot-state.test.ts — Unit tests for isValidStateKey and autopilot state utilities.
 */

import { describe, it, expect } from "vitest";
import { isValidStateKey } from "../tools/autopilot-state.js";

// ---------------------------------------------------------------------------
// isValidStateKey edge case tests
// ---------------------------------------------------------------------------

describe("isValidStateKey", () => {
  // -------------------------------------------------------------------------
  // Happy path tests (reference)
  // -------------------------------------------------------------------------

  it("accepts valid static state properties", () => {
    expect(isValidStateKey("cycles_completed")).toBe(true);
    expect(isValidStateKey("convergence_achieved")).toBe(true);
    expect(isValidStateKey("started_at")).toBe(true);
    expect(isValidStateKey("last_phase")).toBe(true);
    expect(isValidStateKey("last_cycle")).toBe(true);
    expect(isValidStateKey("deferred")).toBe(true);
    expect(isValidStateKey("deferred_reason")).toBe(true);
    expect(isValidStateKey("last_full_review_cycle")).toBe(true);
    expect(isValidStateKey("last_cycle_findings")).toBe(true);
    expect(isValidStateKey("total_items_executed")).toBe(true);
    expect(isValidStateKey("full_review_interval")).toBe(true);
    expect(isValidStateKey("phases_completed")).toBe(true);
    expect(isValidStateKey("current_project")).toBe(true);
    expect(isValidStateKey("workspace_label")).toBe(true);
  });

  it("accepts valid cycle commit properties", () => {
    expect(isValidStateKey("cycle_001_start_commit")).toBe(true);
    expect(isValidStateKey("cycle_001_end_commit")).toBe(true);
    expect(isValidStateKey("cycle_999_start_commit")).toBe(true);
    expect(isValidStateKey("cycle_042_end_commit")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge case: empty string key
  // -------------------------------------------------------------------------

  describe("empty string key", () => {
    it("rejects empty string", () => {
      expect(isValidStateKey("")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Edge case: numeric keys
  // -------------------------------------------------------------------------

  describe("numeric keys", () => {
    it("rejects purely numeric string", () => {
      expect(isValidStateKey("123")).toBe(false);
    });

    it("rejects numeric prefix without proper format", () => {
      expect(isValidStateKey("123_cycle")).toBe(false);
    });

    it("rejects numeric suffix on static property", () => {
      expect(isValidStateKey("cycles_completed_123")).toBe(false);
    });

    it("accepts valid cycle number format (digits in correct position)", () => {
      // cycle_NNN_start_commit / cycle_NNN_end_commit are valid
      expect(isValidStateKey("cycle_0_start_commit")).toBe(true);
      expect(isValidStateKey("cycle_1_end_commit")).toBe(true);
      expect(isValidStateKey("cycle_123_start_commit")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Edge case: unicode keys
  // -------------------------------------------------------------------------

  describe("unicode keys", () => {
    it("rejects unicode characters in key names", () => {
      expect(isValidStateKey("cycles_cømplèted")).toBe(false);
      expect(isValidStateKey("convergência")).toBe(false);
      expect(isValidStateKey("开始时间")).toBe(false);
      expect(isValidStateKey("started_λt")).toBe(false);
    });

    it("rejects emoji in key names", () => {
      expect(isValidStateKey("cycles_🚀_completed")).toBe(false);
      expect(isValidStateKey("deferred_✅")).toBe(false);
    });

    it("rejects unicode whitespace characters", () =>   {
      expect(isValidStateKey("cycles\u00A0completed")).toBe(false); // non-breaking space
      expect(isValidStateKey("started_at\u2003")).toBe(false); // em space
    });
  });

  // -------------------------------------------------------------------------
  // Edge case: special characters in keys
  // -------------------------------------------------------------------------

  describe("special characters in keys", () => {
    it("rejects hyphenated keys", () => {
      expect(isValidStateKey("cycles-completed")).toBe(false);
      expect(isValidStateKey("last-cycle")).toBe(false);
    });

    it("rejects keys with spaces", () => {
      expect(isValidStateKey("cycles completed")).toBe(false);
      expect(isValidStateKey(" started_at")).toBe(false);
      expect(isValidStateKey("started_at ")).toBe(false);
    });

    it("rejects keys with dots (object path notation)", () => {
      expect(isValidStateKey("cycles.completed")).toBe(false);
      expect(isValidStateKey("state.started_at")).toBe(false);
    });

    it("rejects keys with slashes", () => {
      expect(isValidStateKey("cycles/completed")).toBe(false);
      expect(isValidStateKey("state/started_at")).toBe(false);
    });

    it("rejects keys with special regex characters", () => {
      expect(isValidStateKey("cycles^completed")).toBe(false);
      expect(isValidStateKey("started$at")).toBe(false);
      expect(isValidStateKey("cycles*completed")).toBe(false);
      expect(isValidStateKey("started+at")).toBe(false);
      expect(isValidStateKey("cycles?completed")).toBe(false);
      expect(isValidStateKey("started[at]")).toBe(false);
      expect(isValidStateKey("(started_at)")).toBe(false);
    });

    it("rejects SQL-like injection patterns", () => {
      expect(isValidStateKey("cycles;DROP TABLE")).toBe(false);
      expect(isValidStateKey("cycles'--")).toBe(false);
      expect(isValidStateKey('started"at')).toBe(false);
    });

    it("rejects prototype pollution attempts", () => {
      expect(isValidStateKey("__proto__")).toBe(false);
      expect(isValidStateKey("constructor")).toBe(false);
      expect(isValidStateKey("prototype")).toBe(false);
    });

    it("rejects JSON path-style keys", () => {
      expect(isValidStateKey("cycles[0]")).toBe(false);
      expect(isValidStateKey("started_at.value")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------

  describe("additional edge cases", () => {
    it("rejects uppercase variations", () => {
      expect(isValidStateKey("CYCLES_COMPLETED")).toBe(false);
      expect(isValidStateKey("Cycles_Completed")).toBe(false);
      expect(isValidStateKey("Started_At")).toBe(false);
    });

    it("rejects partially matching static properties", () => {
      expect(isValidStateKey("cycles")).toBe(false);
      expect(isValidStateKey("cycle")).toBe(false);
      expect(isValidStateKey("started")).toBe(false);
      expect(isValidStateKey("deferred_reason_extra")).toBe(false);
    });

    it("rejects cycle commit properties with wrong format", () => {
      // Missing parts
      expect(isValidStateKey("cycle_001_commit")).toBe(false);
      expect(isValidStateKey("cycle_001_start")).toBe(false);
      expect(isValidStateKey("cycle_001_end")).toBe(false);

      // Wrong order
      expect(isValidStateKey("start_commit_cycle_001")).toBe(false);
      expect(isValidStateKey("cycle_001_commit_start")).toBe(false);

      // Non-numeric cycle number
      expect(isValidStateKey("cycle_abc_start_commit")).toBe(false);
      expect(isValidStateKey("cycle_001a_start_commit")).toBe(false);

      // Extra suffix
      expect(isValidStateKey("cycle_001_start_commit_extra")).toBe(false);
    });

    it("handles null and undefined gracefully", () => {
      // TypeScript would catch these at compile time, but runtime safety is good
      // @ts-expect-error - testing runtime behavior with invalid input
      expect(isValidStateKey(null)).toBe(false);
      // @ts-expect-error - testing runtime behavior with invalid input
      expect(isValidStateKey(undefined)).toBe(false);
    });
  });
});