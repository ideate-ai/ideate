// Tests for the .ideate.json v3 config module (v3-architecture §2.3, §2.1).
// All filesystem work happens in per-test temp dirs — never a real workspace.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILENAME,
  DEFAULT_RECORD_PATH,
  IdeateConfigError,
  V3_SCHEMA_VERSION,
  loadConfig,
  recordPath,
  type IdeateConfigV3,
} from "./ideate-config.js";

/** A faithful v2 schema_version-9 config: all four knowledge-store fields plus
 *  the other v2 top-level fields. The exact values are arbitrary; the test
 *  contract is that every one of them survives byte-for-byte. */
const V9_FIXTURE = {
  schema_version: 9,
  artifact_directory: ".ideate",
  importance_weights: { decision: 0.9, finding: 0.7, rule: 0.55, event: 0.4 },
  decay_lambda: 0.02,
  reinforcement_deltas: { cited: 0.15, applied: 0.25, ignored: -0.05 },
  vague_rule_thresholds: { min_specificity: 0.6, max_hedge_terms: 2 },
} as const;

const V2_KNOWLEDGE_STORE_FIELDS = [
  "importance_weights",
  "decay_lambda",
  "reinforcement_deltas",
  "vague_rule_thresholds",
] as const;

let root: string;

function configFile(): string {
  return path.join(root, CONFIG_FILENAME);
}

function readConfigFileRaw(): string {
  return fs.readFileSync(configFile(), "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-config-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("lazy init (no config file)", () => {
  it("creates .ideate.json with the exact v3 defaults and returns them", () => {
    const config = loadConfig(root);

    expect(config).toEqual({
      schema_version: 10,
      record: { path: ".ideate/record/" },
      backend: "local",
    });
    expect(V3_SCHEMA_VERSION).toBe(10);
    expect(DEFAULT_RECORD_PATH).toBe(".ideate/record/");

    const onDisk: unknown = JSON.parse(readConfigFileRaw());
    expect(onDisk).toEqual({
      schema_version: 10,
      record: { path: ".ideate/record/" },
      backend: "local",
    });
  });

  it("creates the record directory", () => {
    loadConfig(root);
    const dir = path.join(root, ".ideate", "record");
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it("has exactly the v3 fields and none of the v2 knowledge-store fields", () => {
    loadConfig(root);
    const onDisk = JSON.parse(readConfigFileRaw()) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual(["backend", "record", "schema_version"]);
    for (const field of V2_KNOWLEDGE_STORE_FIELDS) {
      expect(onDisk).not.toHaveProperty(field);
    }
  });
});

describe("v9 detection (v2 config present, no v3 keys)", () => {
  it("adds the v3 keys and byte-preserves every v2 field, deleting nothing", () => {
    const originalRaw = `${JSON.stringify(V9_FIXTURE, null, 2)}\n`;
    fs.writeFileSync(configFile(), originalRaw, "utf8");

    const config = loadConfig(root);

    expect(config).toEqual({
      schema_version: 10,
      record: { path: ".ideate/record/" },
      backend: "local",
    });

    const after = JSON.parse(readConfigFileRaw()) as Record<string, unknown>;

    // Nothing deleted: every original key is still present...
    for (const key of Object.keys(V9_FIXTURE)) {
      expect(after).toHaveProperty(key);
    }
    // ...and every v2 field is byte-preserved (serialized form identical).
    for (const [key, value] of Object.entries(V9_FIXTURE)) {
      expect(JSON.stringify(after[key])).toBe(JSON.stringify(value));
    }
    // The v3 keys were merged alongside.
    expect(after["record"]).toEqual({ path: ".ideate/record/" });
    expect(after["backend"]).toBe("local");
    // schema_version is an existing v2 field: NOT rewritten (coexistence).
    expect(after["schema_version"]).toBe(9);
    // Exactly the union of shapes — no stray keys.
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(V9_FIXTURE), "record", "backend"].sort(),
    );
  });

  it("creates the record directory", () => {
    fs.writeFileSync(configFile(), JSON.stringify(V9_FIXTURE), "utf8");
    loadConfig(root);
    expect(fs.statSync(path.join(root, ".ideate", "record")).isDirectory()).toBe(true);
  });

  it("is idempotent: a second load does not rewrite the merged file", () => {
    fs.writeFileSync(configFile(), JSON.stringify(V9_FIXTURE), "utf8");
    loadConfig(root);
    const mergedRaw = readConfigFileRaw();
    const mergedStat = fs.statSync(configFile());

    const config = loadConfig(root);

    expect(config.record.path).toBe(".ideate/record/");
    expect(readConfigFileRaw()).toBe(mergedRaw);
    expect(fs.statSync(configFile()).mtimeMs).toBe(mergedStat.mtimeMs);
  });
});

describe("existing v3 config", () => {
  it("passes through unchanged — same content, same mtime, no rewrite", () => {
    const v3Raw = `${JSON.stringify(
      { schema_version: 10, record: { path: ".ideate/record/" }, backend: "local" },
      null,
      2,
    )}\n`;
    fs.writeFileSync(configFile(), v3Raw, "utf8");
    const before = fs.statSync(configFile());

    const config = loadConfig(root);

    expect(config).toEqual({
      schema_version: 10,
      record: { path: ".ideate/record/" },
      backend: "local",
    });
    expect(readConfigFileRaw()).toBe(v3Raw);
    expect(fs.statSync(configFile()).mtimeMs).toBe(before.mtimeMs);
  });

  it("returns a custom record.path as configured", () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ schema_version: 10, record: { path: "notes/record" }, backend: "local" }),
      "utf8",
    );
    const config = loadConfig(root);
    expect(config.record.path).toBe("notes/record");
  });

  it("rejects a config from a newer schema major, loudly", () => {
    fs.writeFileSync(
      configFile(),
      JSON.stringify({ schema_version: 11, record: { path: "x" }, backend: "local" }),
      "utf8",
    );
    expect(() => loadConfig(root)).toThrowError(IdeateConfigError);
  });

  it("rejects malformed v3 keys without touching the file", () => {
    const raw = JSON.stringify({ schema_version: 10, record: {}, backend: "local" });
    fs.writeFileSync(configFile(), raw, "utf8");
    expect(() => loadConfig(root)).toThrowError(IdeateConfigError);
    expect(readConfigFileRaw()).toBe(raw);
  });
});

describe("corrupt config", () => {
  it("throws a typed error and never overwrites the file", () => {
    const garbage = "{ this is not json";
    fs.writeFileSync(configFile(), garbage, "utf8");

    let thrown: unknown;
    try {
      loadConfig(root);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(IdeateConfigError);
    expect((thrown as IdeateConfigError).code).toBe("PARSE");
    expect((thrown as IdeateConfigError).configPath).toBe(configFile());
    expect(readConfigFileRaw()).toBe(garbage);
    // Loud failure has no side effects: no record dir sprouted.
    expect(fs.existsSync(path.join(root, ".ideate"))).toBe(false);
  });

  it("rejects non-object JSON (array) with a typed INVALID error, file untouched", () => {
    const raw = "[1, 2, 3]";
    fs.writeFileSync(configFile(), raw, "utf8");

    let thrown: unknown;
    try {
      loadConfig(root);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(IdeateConfigError);
    expect((thrown as IdeateConfigError).code).toBe("INVALID");
    expect(readConfigFileRaw()).toBe(raw);
  });
});

describe("recordPath — the single source of truth", () => {
  const configWith = (p: string): IdeateConfigV3 => ({
    schema_version: V3_SCHEMA_VERSION,
    record: { path: p },
    backend: "local",
  });

  it("resolves the default path under the project root", () => {
    expect(recordPath(configWith(DEFAULT_RECORD_PATH), root)).toBe(
      path.resolve(root, ".ideate", "record"),
    );
  });

  it("resolves a custom relative path under the project root", () => {
    expect(recordPath(configWith("notes/record"), root)).toBe(
      path.resolve(root, "notes", "record"),
    );
  });

  it("honors an absolute custom path as-is", () => {
    const abs = path.join(root, "elsewhere", "record");
    expect(recordPath(configWith(abs), root)).toBe(abs);
  });

  it("agrees with the directory loadConfig lazily creates", () => {
    const config = loadConfig(root);
    expect(fs.statSync(recordPath(config, root)).isDirectory()).toBe(true);
  });

  it("is the only place in plugin/src that computes the record path", () => {
    // Grep-style guard: no module outside this config directory may carry the
    // record-path literal — everything must consume the recordPath export.
    const srcRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");
    const configDir = path.resolve(fileURLToPath(import.meta.url), "..");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          walk(full);
        } else if (entry.isFile() && full.endsWith(".ts") && path.dirname(full) !== configDir) {
          if (fs.readFileSync(full, "utf8").includes(".ideate/record")) {
            offenders.push(full);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);

    // And the export shape itself: a two-argument function plus the default.
    expect(typeof recordPath).toBe("function");
    expect(recordPath.length).toBe(2);
    expect(DEFAULT_RECORD_PATH).toBe(".ideate/record/");
  });
});
