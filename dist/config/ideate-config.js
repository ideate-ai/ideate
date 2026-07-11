// .ideate.json — the ideate v3 project config module.
//
// Spec: docs/design/v3-architecture.md §2.3 (config schema, lazy init,
// non-destructive v9 detection) and §2.1 (the record path's role: default
// `.ideate/record/`, configurable per project; the config tells the ingester
// and the tools where to look — record IDs, not paths, are the stable URIs).
//
// The v3 config is minimal: `schema_version` (a new major, marking the v3
// config family), `record.path`, and `backend`. v2's schema_version-9
// knowledge-store fields (`importance_weights`, `decay_lambda`,
// `reinforcement_deltas`, `vague_rule_thresholds`) are DROPPED from the v3
// schema, not migrated — they belong to the parked knowledge tier (GP-21).
//
// Migration posture (§2.3): non-destructive. Lazy init detects a v9 config
// and writes the v3 keys alongside it without touching any existing field;
// the file may carry both shapes during the transition. Because
// `schema_version` is itself an existing v2 field in a v9 file, it is NOT
// rewritten during coexistence — v3 presence is detected by v3's own keys
// (`record`, `backend`), and the in-memory v3 view always reports the v3
// schema version. A freshly lazy-initialized file (no v2 shape present)
// carries `schema_version: 10` directly.
import * as fs from "node:fs";
import * as path from "node:path";
/** The v3 config schema major — one past v2's 9. */
export const V3_SCHEMA_VERSION = 10;
/** Default record directory, relative to the project root (§2.1). */
export const DEFAULT_RECORD_PATH = ".ideate/record/";
/** The config file's name at the project root. */
export const CONFIG_FILENAME = ".ideate.json";
/** Typed, loud config failure. A corrupt config is never overwritten. */
export class IdeateConfigError extends Error {
    name = "IdeateConfigError";
    code;
    configPath;
    constructor(code, configPath, message) {
        super(`${message} (${configPath})`);
        this.code = code;
        this.configPath = configPath;
    }
}
/**
 * Resolve the record directory for a project.
 *
 * THE single source of truth for the resolved record path. Nothing else in
 * the codebase may compute `<projectRoot>/<record.path>` — every consumer
 * (the ingester's read side, the record writer, the store) resolves the
 * directory through this function and this function only. Migration-forward
 * (§2.1) depends on the path being read from exactly one place.
 */
export function recordPath(config, projectRoot) {
    return path.resolve(projectRoot, config.record.path);
}
/**
 * Load the project's `.ideate.json`, lazily initializing it on first use.
 *
 * - No file → lazy init (§2.3 onboarding): create `.ideate.json` with the
 *   defaults and create the record directory. No ceremony, no interview.
 * - File with pre-v3 fields (a v2 schema_version-9 config) and no v3 keys →
 *   v9 detected: merge the v3 keys into the file WITHOUT touching any
 *   existing field (every v2 field is preserved verbatim; nothing deleted,
 *   nothing rewritten), create the record directory, return the v3 view.
 * - File already carrying the v3 keys → return them; the file is not
 *   rewritten.
 * - Corrupt/unparseable file → IdeateConfigError, loudly; never overwritten.
 */
export function loadConfig(projectRoot) {
    const configPath = path.join(projectRoot, CONFIG_FILENAME);
    let raw;
    try {
        raw = fs.readFileSync(configPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            // Lazy init: first call creates the config and the record directory.
            const config = defaultConfig();
            writeConfigFile(configPath, config);
            ensureRecordDir(config, projectRoot);
            return config;
        }
        throw err;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        throw new IdeateConfigError("PARSE", configPath, `.ideate.json is not valid JSON and has been left untouched — fix or remove it by hand: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new IdeateConfigError("INVALID", configPath, ".ideate.json must contain a JSON object; the file has been left untouched");
    }
    const file = parsed;
    const carriesV3Keys = file["record"] !== undefined || file["backend"] !== undefined;
    if (carriesV3Keys) {
        const config = readV3View(file, configPath);
        ensureRecordDir(config, projectRoot);
        return config; // No write: an already-v3 file passes through unchanged.
    }
    // Pre-v3 config detected (v9 in practice). Non-destructive merge: every
    // existing field — including v2's schema_version — is carried into the
    // output object verbatim; only the v3 keys are added alongside.
    const merged = {
        ...file,
        record: { path: DEFAULT_RECORD_PATH },
        backend: "local",
    };
    writeConfigFile(configPath, merged);
    const config = defaultConfig();
    ensureRecordDir(config, projectRoot);
    return config;
}
/** The exact lazy-init defaults (§2.3). */
function defaultConfig() {
    return {
        schema_version: V3_SCHEMA_VERSION,
        record: { path: DEFAULT_RECORD_PATH },
        backend: "local",
    };
}
/** Validate the v3 keys of a parsed config object and return the v3 view. */
function readV3View(file, configPath) {
    const schemaVersion = file["schema_version"];
    if (typeof schemaVersion === "number" && schemaVersion > V3_SCHEMA_VERSION) {
        throw new IdeateConfigError("INVALID", configPath, `.ideate.json has schema_version ${String(schemaVersion)}, newer than this ideate understands (${String(V3_SCHEMA_VERSION)})`);
    }
    const record = file["record"];
    const recordPathValue = record !== null && typeof record === "object" && !Array.isArray(record)
        ? record["path"]
        : undefined;
    if (typeof recordPathValue !== "string" || recordPathValue.length === 0) {
        throw new IdeateConfigError("INVALID", configPath, ".ideate.json carries v3 keys but record.path is missing or not a non-empty string; the file has been left untouched");
    }
    const backend = file["backend"];
    if (backend !== "local") {
        throw new IdeateConfigError("INVALID", configPath, `.ideate.json carries v3 keys but backend is ${JSON.stringify(backend)}; only "local" is supported`);
    }
    return {
        schema_version: V3_SCHEMA_VERSION,
        record: { path: recordPathValue },
        backend: "local",
    };
}
function writeConfigFile(configPath, value) {
    fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function ensureRecordDir(config, projectRoot) {
    // Resolved through recordPath() — the single source of truth, used even here.
    fs.mkdirSync(recordPath(config, projectRoot), { recursive: true });
}
//# sourceMappingURL=ideate-config.js.map