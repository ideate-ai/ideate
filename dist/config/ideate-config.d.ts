/** The v3 config schema major — one past v2's 9. */
export declare const V3_SCHEMA_VERSION = 10;
/** Default record directory, relative to the project root (§2.1). */
export declare const DEFAULT_RECORD_PATH = ".ideate/record/";
/** The config file's name at the project root. */
export declare const CONFIG_FILENAME = ".ideate.json";
/** The v3 config shape — exactly these fields, nothing from the v2 knowledge tier. */
export interface IdeateConfigV3 {
    schema_version: typeof V3_SCHEMA_VERSION;
    record: {
        /** Record directory, relative to the project root (absolute also honored). */
        path: string;
    };
    /** Board backend selection: local SQLite now, hosted later. */
    backend: "local";
}
export type IdeateConfigErrorCode = 
/** The file exists but is not parseable JSON. Never overwritten. */
"PARSE"
/** The file parses but its shape is invalid (or from a newer ideate). */
 | "INVALID";
/** Typed, loud config failure. A corrupt config is never overwritten. */
export declare class IdeateConfigError extends Error {
    readonly name = "IdeateConfigError";
    readonly code: IdeateConfigErrorCode;
    readonly configPath: string;
    constructor(code: IdeateConfigErrorCode, configPath: string, message: string);
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
export declare function recordPath(config: IdeateConfigV3, projectRoot: string): string;
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
export declare function loadConfig(projectRoot: string): IdeateConfigV3;
//# sourceMappingURL=ideate-config.d.ts.map