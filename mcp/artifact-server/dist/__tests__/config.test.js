import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { readIdeateConfig, findIdeateConfig, resolveArtifactDir, } from "../config.js";
let tmpDir;
function write(relPath, content) {
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
    it("returns config when .ideate.json exists with valid artifactDir", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "specs" }));
        const result = readIdeateConfig(tmpDir);
        expect(result).toEqual({ artifactDir: "specs" });
    });
    it("returns null when file does not exist", () => {
        expect(readIdeateConfig(tmpDir)).toBeNull();
    });
    it("returns null when artifactDir is missing", () => {
        write(".ideate.json", JSON.stringify({ someOtherKey: "value" }));
        expect(readIdeateConfig(tmpDir)).toBeNull();
    });
    it("returns null when artifactDir is empty string", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "  " }));
        expect(readIdeateConfig(tmpDir)).toBeNull();
    });
    it("returns null when JSON is malformed", () => {
        write(".ideate.json", "{ not valid json }");
        expect(readIdeateConfig(tmpDir)).toBeNull();
    });
});
// -----------------------------------------------------------------------
// findIdeateConfig
// -----------------------------------------------------------------------
describe("findIdeateConfig", () => {
    it("finds .ideate.json in the start directory", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "specs" }));
        const result = findIdeateConfig(tmpDir);
        expect(result).toBe(path.join(tmpDir, "specs"));
    });
    it("finds .ideate.json in a parent directory", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "specs" }));
        const subDir = path.join(tmpDir, "src", "components");
        fs.mkdirSync(subDir, { recursive: true });
        const result = findIdeateConfig(subDir);
        expect(result).toBe(path.join(tmpDir, "specs"));
    });
    it("resolves artifactDir relative to the .ideate.json location", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "./my-specs" }));
        const result = findIdeateConfig(tmpDir);
        expect(result).toBe(path.join(tmpDir, "my-specs"));
    });
    it("returns null when no .ideate.json exists in any ancestor", () => {
        const result = findIdeateConfig(tmpDir);
        expect(result).toBeNull();
    });
});
// -----------------------------------------------------------------------
// resolveArtifactDir
// -----------------------------------------------------------------------
describe("resolveArtifactDir", () => {
    it("returns artifact_dir from args when provided", () => {
        const result = resolveArtifactDir({ artifact_dir: "/absolute/path/to/specs" }, tmpDir);
        expect(result).toBe("/absolute/path/to/specs");
    });
    it("falls back to .ideate.json when artifact_dir is absent", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "specs" }));
        const result = resolveArtifactDir({}, tmpDir);
        expect(result).toBe(path.join(tmpDir, "specs"));
    });
    it("prefers explicit artifact_dir over .ideate.json", () => {
        write(".ideate.json", JSON.stringify({ artifactDir: "specs" }));
        const result = resolveArtifactDir({ artifact_dir: "/explicit/path" }, tmpDir);
        expect(result).toBe("/explicit/path");
    });
    it("throws when no artifact_dir and no .ideate.json", () => {
        expect(() => resolveArtifactDir({}, tmpDir)).toThrow("artifact_dir");
    });
    it("throws when artifact_dir is an empty string and no .ideate.json", () => {
        expect(() => resolveArtifactDir({ artifact_dir: "  " }, tmpDir)).toThrow("artifact_dir");
    });
});
//# sourceMappingURL=config.test.js.map