import type { ToolContext } from "../types.js";
import {
  readRawConfig,
  writeConfig,
  IdeateConfigJson,
} from "../config.js";

// ---------------------------------------------------------------------------
// handleUpdateConfig — deep-merge a partial patch into config.json
// ---------------------------------------------------------------------------

export async function handleUpdateConfig(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const patch = args.patch as Partial<IdeateConfigJson> | undefined;

  if (patch === undefined || patch === null || typeof patch !== "object") {
    throw new Error("Missing required parameter: patch");
  }

  // 1. Read raw stored config (no defaults applied)
  const rawStored = readRawConfig(ctx.ideateDir);

  // 2. Deep-merge patch into the raw stored config.
  //    We write back only explicitly stored fields — never inflate with defaults.
  //    For agent_budgets / model_overrides / ppr we merge key-by-key.

  const merged: IdeateConfigJson = {
    schema_version: rawStored.schema_version,
  };

  // project_name
  if (rawStored.project_name !== undefined) {
    merged.project_name = rawStored.project_name;
  }
  if ("project_name" in patch) {
    merged.project_name = patch.project_name;
  }

  // schema_version direct overwrite
  if ("schema_version" in patch && typeof patch.schema_version === "number") {
    merged.schema_version = patch.schema_version;
  }

  // agent_budgets: key-level merge — only write if stored or patched
  if (rawStored.agent_budgets !== undefined || patch.agent_budgets !== undefined) {
    merged.agent_budgets = {
      ...(rawStored.agent_budgets ?? {}),
      ...(patch.agent_budgets ?? {}),
    };
  }

  // model_overrides: null-signal merge — null value in patch deletes the key from stored
  const patchOverrides = patch.model_overrides as Record<string, string | null> | undefined;
  if (rawStored.model_overrides !== undefined || patchOverrides !== undefined) {
    const mergedOverrides: Record<string, string> = { ...(rawStored.model_overrides ?? {}) };
    for (const [key, val] of Object.entries(patchOverrides ?? {})) {
      if (val === null) {
        delete mergedOverrides[key];
      } else {
        mergedOverrides[key] = val;
      }
    }
    // Only write if non-empty (sparse invariant: empty object === absent key)
    if (Object.keys(mergedOverrides).length > 0) {
      merged.model_overrides = mergedOverrides;
    }
  }

  // ppr: field-level merge — only write if stored or patched; keep sparse
  const patchPpr = patch.ppr;
  const rawPpr = rawStored.ppr;
  if (rawPpr !== undefined || patchPpr !== undefined) {
    const mergedPpr: NonNullable<IdeateConfigJson["ppr"]> = {};
    if (rawPpr?.alpha !== undefined || patchPpr?.alpha !== undefined) {
      mergedPpr.alpha = patchPpr?.alpha !== undefined ? patchPpr.alpha : rawPpr?.alpha;
    }
    if (rawPpr?.max_iterations !== undefined || patchPpr?.max_iterations !== undefined) {
      mergedPpr.max_iterations =
        patchPpr?.max_iterations !== undefined ? patchPpr.max_iterations : rawPpr?.max_iterations;
    }
    if (rawPpr?.convergence_threshold !== undefined || patchPpr?.convergence_threshold !== undefined) {
      mergedPpr.convergence_threshold =
        patchPpr?.convergence_threshold !== undefined
          ? patchPpr.convergence_threshold
          : rawPpr?.convergence_threshold;
    }
    if (rawPpr?.default_token_budget !== undefined || patchPpr?.default_token_budget !== undefined) {
      mergedPpr.default_token_budget =
        patchPpr?.default_token_budget !== undefined
          ? patchPpr.default_token_budget
          : rawPpr?.default_token_budget;
    }
    if (rawPpr?.edge_type_weights !== undefined || patchPpr?.edge_type_weights !== undefined) {
      mergedPpr.edge_type_weights = {
        ...(rawPpr?.edge_type_weights ?? {}),
        ...(patchPpr?.edge_type_weights ?? {}),
      };
    }
    merged.ppr = mergedPpr;
  }

  // 3. Validate merged result
  const errors: string[] = [];

  // agent_budgets: all values must be positive integers (> 0)
  for (const [agent, budget] of Object.entries(merged.agent_budgets ?? {})) {
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) {
      errors.push(
        `agent_budgets.${agent}: must be a positive integer (got ${budget})`
      );
    }
  }

  // model_overrides: all values must be non-empty strings
  for (const [agent, model] of Object.entries(merged.model_overrides ?? {})) {
    if (typeof model !== "string" || model.trim() === "") {
      errors.push(
        `model_overrides.${agent}: must be a non-empty string (got ${JSON.stringify(model)})`
      );
    }
  }

  // ppr.alpha: strictly between 0 and 1 exclusive
  if (
    merged.ppr?.alpha !== undefined &&
    (typeof merged.ppr.alpha !== "number" ||
      merged.ppr.alpha <= 0 ||
      merged.ppr.alpha >= 1)
  ) {
    errors.push(
      `ppr.alpha: must be a number strictly between 0 and 1 exclusive (got ${merged.ppr.alpha})`
    );
  }

  // ppr.max_iterations: positive integer
  if (
    merged.ppr?.max_iterations !== undefined &&
    (typeof merged.ppr.max_iterations !== "number" ||
      !Number.isInteger(merged.ppr.max_iterations) ||
      merged.ppr.max_iterations <= 0)
  ) {
    errors.push(
      `ppr.max_iterations: must be a positive integer (got ${merged.ppr.max_iterations})`
    );
  }

  // ppr.convergence_threshold: positive number
  if (
    merged.ppr?.convergence_threshold !== undefined &&
    (typeof merged.ppr.convergence_threshold !== "number" ||
      merged.ppr.convergence_threshold <= 0)
  ) {
    errors.push(
      `ppr.convergence_threshold: must be a positive number (got ${merged.ppr.convergence_threshold})`
    );
  }

  // ppr.default_token_budget: positive integer
  if (
    merged.ppr?.default_token_budget !== undefined &&
    (typeof merged.ppr.default_token_budget !== "number" ||
      !Number.isInteger(merged.ppr.default_token_budget) ||
      merged.ppr.default_token_budget <= 0)
  ) {
    errors.push(
      `ppr.default_token_budget: must be a positive integer (got ${merged.ppr.default_token_budget})`
    );
  }

  if (errors.length > 0) {
    return JSON.stringify(
      { status: "error", errors },
      null,
      2
    );
  }

  // 4. Determine which top-level keys changed (compare raw stored vs merged)
  const updatedKeys: string[] = [];
  const topLevelKeys: (keyof IdeateConfigJson)[] = [
    "schema_version",
    "project_name",
    "agent_budgets",
    "model_overrides",
    "ppr",
  ];
  for (const key of topLevelKeys) {
    // IdeateConfigJson lacks an index signature; cast through unknown for key-based access
    const beforeVal = JSON.stringify((rawStored as unknown as Record<string, unknown>)[key]);
    const afterVal = JSON.stringify((merged as unknown as Record<string, unknown>)[key]);
    if (beforeVal !== afterVal) {
      updatedKeys.push(key);
    }
  }


  // 5. Write validated config
  writeConfig(ctx.ideateDir, merged);

  // 6. Return updated_keys (no file paths per P-33)
  return JSON.stringify(
    { status: "updated", updated_keys: updatedKeys },
    null,
    2
  );
}
