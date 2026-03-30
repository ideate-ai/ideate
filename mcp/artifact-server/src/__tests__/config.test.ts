import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readIdeateConfig,
  readRawConfig,
  findIdeateConfig,
  resolveArtifactDir,
  createIdeateDir,
  writeConfig,
  getConfigWithDefaults,
  CONFIG_SCHEMA_VERSION,
  DEFAULT_AGENT_BUDGETS,
  DEFAULT_PPR_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_APPETITE,
  IDEATE_SUBDIRS,
} from "../config.js";
import type { IdeateConfigJson } from "../config.js";
import { handleUpdateConfig } from "../tools/config.js";
import type { ToolContext } from "../types.js";

let tmpDir: string;

function write(relPath: string, content: string): void {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// readIdeateConfig
// -----------------------------------------------------------------------

describe("readIdeateConfig", () => {
  it("returns config when .ideate/config.json exists with valid schema_version", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2, project_name: "test" })
    );
    const result = readIdeateConfig(tmpDir);
    expect(result).toEqual({ artifactDir: path.join(tmpDir, ".ideate") });
  });

  it("returns null when .ideate directory does not exist", () => {
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });

  it("returns null when config.json is missing from .ideate/", () => {
    fs.mkdirSync(path.join(tmpDir, ".ideate"), { recursive: true });
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });

  it("returns null when schema_version is missing", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ project_name: "test" })
    );
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });

  it("returns null when schema_version is not a number", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: "2" })
    );
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    write(".ideate/config.json", "{ not valid json }");
    expect(readIdeateConfig(tmpDir)).toBeNull();
  });

  it("returns config when only schema_version is present (project_name optional)", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2 })
    );
    const result = readIdeateConfig(tmpDir);
    expect(result).toEqual({ artifactDir: path.join(tmpDir, ".ideate") });
  });
});

// -----------------------------------------------------------------------
// findIdeateConfig
// -----------------------------------------------------------------------

describe("findIdeateConfig", () => {
  it("finds .ideate/config.json in the start directory", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2 })
    );
    const result = findIdeateConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });

  it("finds .ideate/config.json in a parent directory", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2 })
    );
    const subDir = path.join(tmpDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    const result = findIdeateConfig(subDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });

  it("returns path to .ideate/ directory (not config.json)", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2 })
    );
    const result = findIdeateConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
    expect(result!.endsWith(".ideate")).toBe(true);
  });

  it("returns null when no .ideate/config.json exists in any ancestor", () => {
    const result = findIdeateConfig(tmpDir);
    expect(result).toBeNull();
  });

  it("ignores .ideate.json (legacy format)", () => {
    // Old-style .ideate.json at root should NOT be found
    write(".ideate.json", JSON.stringify({ artifactDir: "specs" }));
    const result = findIdeateConfig(tmpDir);
    expect(result).toBeNull();
  });
});

// -----------------------------------------------------------------------
// resolveArtifactDir
// -----------------------------------------------------------------------

describe("resolveArtifactDir", () => {
  it("returns artifact_dir from args when provided", () => {
    const result = resolveArtifactDir(
      { artifact_dir: "/absolute/path/to/specs" },
      tmpDir
    );
    expect(result).toBe("/absolute/path/to/specs");
  });

  it("falls back to .ideate/config.json when artifact_dir is absent", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2 })
    );
    const result = resolveArtifactDir({}, tmpDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });

  it("prefers explicit artifact_dir over .ideate/config.json", () => {
    write(
      ".ideate/config.json",
      JSON.stringify({ schema_version: 2 })
    );
    const result = resolveArtifactDir(
      { artifact_dir: "/explicit/path" },
      tmpDir
    );
    expect(result).toBe("/explicit/path");
  });

  it("throws when no artifact_dir and no .ideate/config.json", () => {
    expect(() => resolveArtifactDir({}, tmpDir)).toThrow("artifact_dir");
  });

  it("throws when artifact_dir is an empty string and no .ideate/config.json", () => {
    expect(() => resolveArtifactDir({ artifact_dir: "  " }, tmpDir)).toThrow(
      "artifact_dir"
    );
  });
});

// -----------------------------------------------------------------------
// createIdeateDir
// -----------------------------------------------------------------------

describe("createIdeateDir", () => {
  it("creates .ideate/ directory with all expected subdirectories", () => {
    const ideateDir = createIdeateDir(tmpDir);
    expect(ideateDir).toBe(path.join(tmpDir, ".ideate"));
    expect(fs.existsSync(ideateDir)).toBe(true);

    for (const sub of IDEATE_SUBDIRS) {
      expect(fs.existsSync(path.join(ideateDir, sub))).toBe(true);
    }
  });

  it("writes config.json with default config", () => {
    const ideateDir = createIdeateDir(tmpDir);
    const configPath = path.join(ideateDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed).toEqual({ schema_version: CONFIG_SCHEMA_VERSION });
  });

  it("writes config.json with custom config", () => {
    const config: IdeateConfigJson = {
      schema_version: 2,
      project_name: "my-project",
    };
    const ideateDir = createIdeateDir(tmpDir, config);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(ideateDir, "config.json"), "utf8")
    );
    expect(parsed).toEqual({
      schema_version: 2,
      project_name: "my-project",
    });
  });

  it("is idempotent — can be called on existing .ideate/", () => {
    createIdeateDir(tmpDir);
    // Should not throw when called again
    const ideateDir = createIdeateDir(tmpDir);
    expect(fs.existsSync(path.join(ideateDir, "config.json"))).toBe(true);
  });

  it("created directory is discoverable by findIdeateConfig", () => {
    createIdeateDir(tmpDir);
    const result = findIdeateConfig(tmpDir);
    expect(result).toBe(path.join(tmpDir, ".ideate"));
  });
});

// -----------------------------------------------------------------------
// writeConfig
// -----------------------------------------------------------------------

describe("writeConfig", () => {
  it("writes config.json to the specified directory", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2 });
    const configPath = path.join(ideateDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(parsed).toEqual({ schema_version: 2 });
  });

  it("overwrites existing config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 1 });
    writeConfig(ideateDir, {
      schema_version: 2,
      project_name: "updated",
    });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(ideateDir, "config.json"), "utf8")
    );
    expect(parsed).toEqual({
      schema_version: 2,
      project_name: "updated",
    });
  });
});

// -----------------------------------------------------------------------
// getConfigWithDefaults
// -----------------------------------------------------------------------

describe("getConfigWithDefaults", () => {
  it("returns all fields with defaults when config has only schema_version", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2 });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.schema_version).toBe(2);
    // agent_budgets should be the full defaults
    expect(result.agent_budgets).toEqual(DEFAULT_AGENT_BUDGETS);
    // ppr should be fully populated with defaults
    expect(result.ppr.alpha).toBe(DEFAULT_PPR_CONFIG.alpha);
    expect(result.ppr.max_iterations).toBe(DEFAULT_PPR_CONFIG.max_iterations);
    expect(result.ppr.convergence_threshold).toBe(
      DEFAULT_PPR_CONFIG.convergence_threshold
    );
    expect(result.ppr.edge_type_weights).toEqual(
      DEFAULT_PPR_CONFIG.edge_type_weights
    );
    expect(result.ppr.default_token_budget).toBe(
      DEFAULT_PPR_CONFIG.default_token_budget
    );
  });

  it("returns merged config when all optional fields are explicitly set", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const customConfig: IdeateConfigJson = {
      schema_version: 2,
      project_name: "my-project",
      agent_budgets: {
        "code-reviewer": 200,
        "custom-agent": 50,
      },
      ppr: {
        alpha: 0.25,
        max_iterations: 100,
        convergence_threshold: 1e-8,
        edge_type_weights: { depends_on: 2.0 },
        default_token_budget: 100000,
      },
    };
    writeConfig(ideateDir, customConfig);

    const result = getConfigWithDefaults(ideateDir);

    expect(result.schema_version).toBe(2);
    expect(result.project_name).toBe("my-project");
    // custom agent budget overrides default, and extra agent is present
    expect(result.agent_budgets["code-reviewer"]).toBe(200);
    expect(result.agent_budgets["custom-agent"]).toBe(50);
    // default agent budgets not overridden remain
    expect(result.agent_budgets["architect"]).toBe(160);
    // ppr scalars from config
    expect(result.ppr.alpha).toBe(0.25);
    expect(result.ppr.max_iterations).toBe(100);
    expect(result.ppr.convergence_threshold).toBe(1e-8);
    expect(result.ppr.default_token_budget).toBe(100000);
    // edge_type_weights: custom overrides default, others from default remain
    expect(result.ppr.edge_type_weights!["depends_on"]).toBe(2.0);
    expect(result.ppr.edge_type_weights!["governed_by"]).toBe(0.8);
  });

  it("applies defaults for missing ppr sub-fields when ppr is partially specified", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2, ppr: { alpha: 0.5 } });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.ppr.alpha).toBe(0.5);
    expect(result.ppr.max_iterations).toBe(DEFAULT_PPR_CONFIG.max_iterations);
    expect(result.ppr.convergence_threshold).toBe(
      DEFAULT_PPR_CONFIG.convergence_threshold
    );
  });

  it("returns defaults when config.json does not exist", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    // No config.json written

    const result = getConfigWithDefaults(ideateDir);

    expect(result.agent_budgets).toEqual(DEFAULT_AGENT_BUDGETS);
    expect(result.ppr.alpha).toBe(DEFAULT_PPR_CONFIG.alpha);
  });

  it("returns model_overrides as empty object when field is absent from config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 2 });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.model_overrides).toEqual({});
  });

  it("returns populated model_overrides when field is present in config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, {
      schema_version: 2,
      model_overrides: {
        "domain-curator": "claude-opus-4-5",
        architect: "claude-opus-4-5",
      },
    });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.model_overrides).toEqual({
      "domain-curator": "claude-opus-4-5",
      architect: "claude-opus-4-5",
    });
  });

  it("applies defaults for circuit_breaker_threshold and default_appetite when absent", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, { schema_version: 3 });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.circuit_breaker_threshold).toBe(DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
    expect(result.default_appetite).toBe(DEFAULT_APPETITE);
  });

  it("respects circuit_breaker_threshold and default_appetite overrides from config.json", () => {
    const ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    writeConfig(ideateDir, {
      schema_version: 3,
      circuit_breaker_threshold: 10,
      default_appetite: 3,
    });

    const result = getConfigWithDefaults(ideateDir);

    expect(result.circuit_breaker_threshold).toBe(10);
    expect(result.default_appetite).toBe(3);
  });
});

// -----------------------------------------------------------------------
// handleUpdateConfig
// -----------------------------------------------------------------------

describe("handleUpdateConfig", () => {
  let ideateDir: string;
  let ctx: ToolContext;

  // Minimal ToolContext — handleUpdateConfig only uses ideateDir
  function makeCtx(dir: string): ToolContext {
    return {
      ideateDir: dir,
    } as unknown as ToolContext;
  }

  beforeEach(() => {
    // Create a fresh .ideate/ dir with a known baseline config
    ideateDir = path.join(tmpDir, "handle-update-config-ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    const baseline: IdeateConfigJson = {
      schema_version: 2,
      project_name: "test-project",
      agent_budgets: {
        "code-reviewer": 80,
        architect: 160,
      },
      model_overrides: {
        "domain-curator": "claude-opus-4-5",
      },
      ppr: {
        alpha: 0.15,
        max_iterations: 50,
        convergence_threshold: 1e-6,
        edge_type_weights: { depends_on: 1.0, governed_by: 0.8 },
        default_token_budget: 50000,
      },
    };
    writeConfig(ideateDir, baseline);
    ctx = makeCtx(ideateDir);
  });

  it("updates a single agent_budget key — other agents are preserved", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { agent_budgets: { "code-reviewer": 120 } } })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("agent_budgets");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.agent_budgets["code-reviewer"]).toBe(120);
    expect(saved.agent_budgets["architect"]).toBe(160);
  });

  it("adds a new model_overrides key while preserving existing keys", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { architect: "claude-opus-4-5" } },
      })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("model_overrides");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.model_overrides["architect"]).toBe("claude-opus-4-5");
    expect(saved.model_overrides["domain-curator"]).toBe("claude-opus-4-5");
  });

  it("updates ppr.alpha — other PPR fields are preserved", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { ppr: { alpha: 0.25 } } })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("ppr");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.ppr.alpha).toBe(0.25);
    expect(saved.ppr.max_iterations).toBe(50);
    expect(saved.ppr.convergence_threshold).toBe(1e-6);
    expect(saved.ppr.default_token_budget).toBe(50000);
  });

  it("updates a single edge_type_weight — other weights are preserved", async () => {
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { ppr: { edge_type_weights: { depends_on: 2.0 } } },
      })
    );
    expect(result.status).toBe("updated");

    const saved = getConfigWithDefaults(ideateDir);
    expect(saved.ppr.edge_type_weights!["depends_on"]).toBe(2.0);
    expect(saved.ppr.edge_type_weights!["governed_by"]).toBe(0.8);
  });

  it("returns error when agent_budget value is 0 — config is not written", async () => {
    const before = fs.readFileSync(path.join(ideateDir, "config.json"), "utf8");
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { agent_budgets: { "code-reviewer": 0 } } })
    );
    expect(result.status).toBe("error");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => e.includes("code-reviewer"))).toBe(true);

    // Config must not have changed
    const after = fs.readFileSync(path.join(ideateDir, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("returns error when model_overrides value is empty string — config is not written", async () => {
    const before = fs.readFileSync(path.join(ideateDir, "config.json"), "utf8");
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { "domain-curator": "" } },
      })
    );
    expect(result.status).toBe("error");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => e.includes("domain-curator"))).toBe(true);

    const after = fs.readFileSync(path.join(ideateDir, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("returns error when ppr.alpha is 1.5 — config is not written", async () => {
    const before = fs.readFileSync(path.join(ideateDir, "config.json"), "utf8");
    const result = JSON.parse(
      await handleUpdateConfig(ctx, { patch: { ppr: { alpha: 1.5 } } })
    );
    expect(result.status).toBe("error");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.some((e: string) => e.includes("ppr.alpha"))).toBe(true);

    const after = fs.readFileSync(path.join(ideateDir, "config.json"), "utf8");
    expect(after).toBe(before);
  });

  it("updated_keys reflects actual top-level keys that changed", async () => {
    // Patch only model_overrides — updated_keys should contain only that key
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { researcher: "claude-opus-4-5" } },
      })
    );
    expect(result.status).toBe("updated");
    expect(result.updated_keys).toContain("model_overrides");
    // agent_budgets did not change
    expect(result.updated_keys).not.toContain("agent_budgets");
  });

  it("written config.json is sparse — only patched keys are present", async () => {
    // Start from a minimal config with no optional keys
    const sparseDir = path.join(tmpDir, "sparse-test-ideate");
    fs.mkdirSync(sparseDir, { recursive: true });
    writeConfig(sparseDir, { schema_version: 2 });
    const sparseCtx = makeCtx(sparseDir);

    // Patch only agent_budgets
    const result = JSON.parse(
      await handleUpdateConfig(sparseCtx, {
        patch: { agent_budgets: { "code-reviewer": 100 } },
      })
    );
    expect(result.status).toBe("updated");

    // Read config.json as raw JSON — ppr and model_overrides must NOT be present
    const raw = readRawConfig(sparseDir);
    expect(raw.agent_budgets).toEqual({ "code-reviewer": 100 });
    expect(raw.ppr).toBeUndefined();
    expect(raw.model_overrides).toBeUndefined();
  });

  it("null-signal removes a stored model_overrides key", async () => {
    // setup: store an override
    await handleUpdateConfig(ctx, { patch: { model_overrides: { architect: "opus" } } });
    // act: clear it
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: { model_overrides: { architect: null } as Record<string, string | null> },
      })
    );
    expect(result.status).toBe("updated");
    const raw = readRawConfig(ideateDir);
    expect(raw.model_overrides).not.toHaveProperty("architect");
  });

  it("null-signal on last key produces absent model_overrides (sparse invariant)", async () => {
    // Start from a config with only one model_override key
    const sparseDir = path.join(tmpDir, "null-signal-sparse-ideate");
    fs.mkdirSync(sparseDir, { recursive: true });
    writeConfig(sparseDir, { schema_version: 2 });
    const sparseCtx = makeCtx(sparseDir);

    await handleUpdateConfig(sparseCtx, {
      patch: { model_overrides: { researcher: "opus" } },
    });
    await handleUpdateConfig(sparseCtx, {
      patch: { model_overrides: { researcher: null } as Record<string, string | null> },
    });
    const raw = readRawConfig(sparseDir);
    expect(raw.model_overrides).toBeUndefined();
  });

  it("null-signal on non-existent key is a no-op", async () => {
    // Start from a minimal config with no model_overrides
    const sparseDir = path.join(tmpDir, "noop-null-signal-ideate");
    fs.mkdirSync(sparseDir, { recursive: true });
    writeConfig(sparseDir, { schema_version: 2 });
    const sparseCtx = makeCtx(sparseDir);

    const result = JSON.parse(
      await handleUpdateConfig(sparseCtx, {
        patch: { model_overrides: { nonexistent: null } as Record<string, string | null> },
      })
    );
    expect(result.status).toBe("updated");
    const raw = readRawConfig(sparseDir);
    expect(raw.model_overrides).toBeUndefined();
  });

  it("mixed patch: sets one key and nulls another in same call", async () => {
    // setup: two keys stored
    await handleUpdateConfig(ctx, {
      patch: { model_overrides: { architect: "opus", researcher: "haiku" } },
    });
    // act: set architect to sonnet, clear researcher
    const result = JSON.parse(
      await handleUpdateConfig(ctx, {
        patch: {
          model_overrides: { architect: "sonnet", researcher: null } as Record<string, string | null>,
        },
      })
    );
    expect(result.status).toBe("updated");
    const raw = readRawConfig(ideateDir);
    expect(raw.model_overrides).toEqual({ architect: "sonnet", "domain-curator": "claude-opus-4-5" });
  });
});
