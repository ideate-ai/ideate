import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readIdeateConfig,
  findIdeateConfig,
  resolveArtifactDir,
  createIdeateDir,
  writeConfig,
  CONFIG_SCHEMA_VERSION,
} from "../config.js";
import type { IdeateConfigJson } from "../config.js";

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

    const expectedDirs = [
      "work-items",
      "principles",
      "constraints",
      "policies",
      "decisions",
      "questions",
      "modules",
      "research",
      "interviews",
      "cycles",
    ];
    for (const dir of expectedDirs) {
      expect(
        fs.statSync(path.join(ideateDir, dir)).isDirectory()
      ).toBe(true);
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
