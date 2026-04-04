import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ToolContext } from "../types.js";
import type { MutateNodeInput } from "../adapter.js";

// ---------------------------------------------------------------------------
// Default autopilot state
// ---------------------------------------------------------------------------

interface AutopilotState {
  cycles_completed: number;
  convergence_achieved: boolean;
  started_at: string | null;
  last_phase: string | null;
  last_cycle: number | null;
  deferred: boolean;
  deferred_reason: string | null;
  last_full_review_cycle: number | null;
  last_cycle_findings: { critical: number; significant: number; minor: number } | null;
  total_items_executed: number | null;
  full_review_interval: number | null;
  phases_completed: number;
  current_project: string | null;
  workspace_label: string | null;
  [key: string]: unknown;
}

// Whitelist of static state property names
const STATIC_STATE_PROPERTIES = new Set([
  "cycles_completed",
  "convergence_achieved",
  "started_at",
  "last_phase",
  "last_cycle",
  "deferred",
  "deferred_reason",
  "last_full_review_cycle",
  "last_cycle_findings",
  "total_items_executed",
  "full_review_interval",
  "phases_completed",
  "current_project",
  "workspace_label",
]);

// Pattern for dynamic cycle commit properties: cycle_NNN_start_commit, cycle_NNN_end_commit
const CYCLE_COMMIT_PROPERTY_PATTERN = /^cycle_\d+_(start|end)_commit$/;

export function isValidStateKey(key: string): boolean {
  return STATIC_STATE_PROPERTIES.has(key) || CYCLE_COMMIT_PROPERTY_PATTERN.test(key);
}

function defaultAutopilotState(): AutopilotState {
  return {
    cycles_completed: 0,
    convergence_achieved: false,
    started_at: null,
    last_phase: null,
    last_cycle: null,
    deferred: false,
    deferred_reason: null,
    last_full_review_cycle: null,
    last_cycle_findings: null,
    total_items_executed: null,
    full_review_interval: null,
    phases_completed: 0,
    current_project: null,
    workspace_label: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function autopilotStatePath(ideateDir: string): string {
  return path.join(ideateDir, "autopilot-state.yaml");
}

async function readAutopilotState(ctx: ToolContext): Promise<AutopilotState> {
  if (ctx.adapter) {
    const raw = await ctx.adapter.readNodeContent("autopilot-state");
    if (raw) {
      try {
        const parsed = parseYaml(raw) as Record<string, unknown>;
        return { ...defaultAutopilotState(), ...parsed };
      } catch {
        return defaultAutopilotState();
      }
    }
    return defaultAutopilotState();
  }
  // Fallback: direct filesystem read (used in tests and when adapter is not set)
  const filePath = autopilotStatePath(ctx.ideateDir);
  if (!fs.existsSync(filePath)) {
    return defaultAutopilotState();
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return { ...defaultAutopilotState(), ...parsed };
  } catch {
    return defaultAutopilotState();
  }
}

async function writeAutopilotState(ctx: ToolContext, state: AutopilotState): Promise<void> {
  if (ctx.adapter) {
    const input: MutateNodeInput = {
      id: "autopilot-state",
      type: "autopilot_state" as MutateNodeInput["type"],
      properties: { ...state },
    };
    await ctx.adapter.putNode(input);
    return;
  }
  // Fallback: direct filesystem write (used in tests and when adapter is not set)
  const filePath = autopilotStatePath(ctx.ideateDir);
  fs.writeFileSync(filePath, stringifyYaml(state), "utf8");
}

// ---------------------------------------------------------------------------
// handleManageAutopilotState — unified get/update for autopilot session state
// ---------------------------------------------------------------------------

export async function handleManageAutopilotState(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const action = args.action as string | undefined;

  if (!action || (action !== "get" && action !== "update")) {
    throw new Error("Missing or invalid required parameter: action (must be 'get' or 'update')");
  }

  if (action === "get") {
    const state = await readAutopilotState(ctx);
    return JSON.stringify(state, null, 2);
  }

  // action === "update"
  const update = args.state as Record<string, unknown> | undefined;

  if (!update || typeof update !== "object") {
    throw new Error("Missing required parameter: state (must be an object when action is 'update')");
  }

  // Validate that all keys are known state properties
  const invalidKeys = Object.keys(update).filter((key) => !isValidStateKey(key));
  if (invalidKeys.length > 0) {
    const validKeys = [...STATIC_STATE_PROPERTIES, "cycle_NNN_start_commit", "cycle_NNN_end_commit"].join(", ");
    throw new Error(
      `Invalid state keys: ${invalidKeys.join(", ")}. Valid keys: ${validKeys}`
    );
  }

  const current = await readAutopilotState(ctx);

  // Shallow merge update onto current state
  const merged: AutopilotState = { ...current };
  for (const [key, value] of Object.entries(update)) {
    merged[key] = value;
  }

  await writeAutopilotState(ctx, merged);

  return JSON.stringify(merged, null, 2);
}
