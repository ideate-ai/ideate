// .ideate.json — the ideate project config module.
//
// Config schema, project-root discovery, lazy init, and non-destructive
// detection of a legacy config.
//
// Root discovery (`findProjectRoot` / `resolveProjectRoot`) is separate from
// loading: `loadConfig` takes the root it is given and lazily creates a config
// there, which is correct for an explicitly-targeted caller and was the whole
// defect for a cwd-defaulted one. Callers that used to default to
// `process.cwd()` now resolve through `resolveProjectRoot` first.
// The record path defaults to `.ideate/record/` and is configurable per
// project; the config tells the ingester and the tools where to look — record
// IDs, not paths, are the stable URIs.
//
// The config is minimal: `schema_version` (the current schema family),
// `record.path`, and `backend`. A legacy schema_version-9 config's
// knowledge-store fields (`importance_weights`, `decay_lambda`,
// `reinforcement_deltas`, `vague_rule_thresholds`) are DROPPED from the
// current schema, not migrated.
//
// Migration posture: non-destructive. Lazy init detects a legacy config and
// writes the current keys alongside it without touching any existing field;
// the file may carry both shapes during the transition. Because
// `schema_version` is itself an existing field in a legacy file, it is NOT
// rewritten during coexistence — current-schema presence is detected by its
// own keys (`record`, `backend`), and the in-memory view always reports the
// current schema version. A freshly lazy-initialized file (no legacy shape
// present) carries `schema_version: 10` directly.
//
// `work_state`: an OPTIONAL block, `{ "path": ... }`, giving the work-state
// (delegation board) SQLite store a configurable location, mirroring
// `record.path`. Unlike `record`, this key is NEVER written by `loadConfig` —
// it stays entirely absent from the file unless a user configures it by hand,
// so its introduction is byte-preserving by construction (no existing config,
// legacy or current, gains a new key it didn't already have). `workStatePath()`
// applies `DEFAULT_WORK_STATE_PATH` whenever the block is absent, the same
// coexistence discipline the legacy-to-current merge used for `record`/`backend`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The config schema major. */
export const V3_SCHEMA_VERSION = 10;

/** Default record directory, relative to the project root. */
export const DEFAULT_RECORD_PATH = ".ideate/record/";

/** Default work-state (delegation board) store directory, relative to the
 *  project root. */
export const DEFAULT_WORK_STATE_PATH = ".ideate-work/";

/** The config file's name at the project root. */
export const CONFIG_FILENAME = ".ideate.json";

/**
 * Env override naming the project root explicitly, bypassing the upward walk.
 *
 * Mirrors the `IDEATE_TELEMETRY_DIR` precedent in telemetry/cli.ts. The other
 * explicit-targeting path — passing `projectRoot` straight to `loadConfig` /
 * the store constructors, which is what scripts/migrate-v2 and the isolated
 * board-validation runs do — never reaches the walk at all and is unaffected.
 */
export const PROJECT_ROOT_ENV = "IDEATE_PROJECT_ROOT";

/** How {@link findProjectRoot} arrived at the root it returned. */
export type ProjectRootOrigin =
  /** {@link PROJECT_ROOT_ENV} named it; no walk was performed. */
  | "env"
  /** An enclosing `.ideate.json` was found at or above the start directory. */
  | "enclosing"
  /** No enclosing project exists; the start directory itself onboards. */
  | "onboarding";

export interface ProjectRootResolution {
  /** The absolute project root to load config from. */
  root: string;
  origin: ProjectRootOrigin;
  /** The absolute directory the search began at. */
  startedFrom: string;
}

/**
 * Find the project root that governs `startDir`, by walking UPWARD for an
 * existing `.ideate.json`.
 *
 * WHY THIS EXISTS. `loadConfig` lazily creates a config wherever it is
 * pointed. Every caller that defaulted to `process.cwd()` therefore onboarded
 * a brand-new empty project the moment it ran from anywhere but the root, and
 * silently wrote everything from that invocation into it. Twenty-one such
 * phantom stores accumulated across six projects, holding ~2,470 stranded
 * records — the largest under `plugin/`, simply because `cd plugin` is the
 * natural place to run this repository's own build and tests.
 *
 * WHERE THE WALK STOPS. At the filesystem root, and — when the start
 * directory is inside `$HOME` — BELOW `$HOME`: the home directory itself is
 * never accepted as a project root, and nothing above it is consulted.
 *
 * That exclusion is not theoretical tidiness. `$HOME/.ideate.json` exists on
 * the machine this defect was found on, holding 24 records, itself one of the
 * phantom stores this walk exists to stop creating. Accepting it as a root
 * would turn the fix into a worse bug: every invocation anywhere under the
 * user's home directory that is not inside a real project would silently
 * attach to one catch-all store. A home directory is not a project.
 *
 * Deliberately NOT the git repository boundary: this repository's own
 * `plugin/` is a git submodule, so a git-boundary stop would fail to find the
 * root in exactly the case that produced the largest phantom store.
 *
 * WHEN NOTHING IS FOUND the start directory is returned with origin
 * `onboarding`, and lazy init proceeds there. First-run onboarding stays
 * frictionless — no ceremony, no interview, unchanged from before — but the
 * CLI layer announces it on stderr rather than doing it in silence (P-45: an
 * unexpected configuration must never be adopted quietly).
 */
export function findProjectRoot(
  startDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRootResolution {
  const override = env[PROJECT_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    const root = path.resolve(override.trim());
    return { root, origin: "env", startedFrom: root };
  }

  const startedFrom = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  // Only bind the walk to $HOME when the start is genuinely inside it;
  // a start outside (a temp dir, a checkout under /srv) walks to the root.
  const boundedByHome = startedFrom === home || startedFrom.startsWith(`${home}${path.sep}`);

  let dir = startedFrom;
  for (;;) {
    // Checked BEFORE the existence probe, so `$HOME/.ideate.json` is never
    // consulted at all — see the note above on why the home directory is
    // excluded rather than merely being the last rung of the ladder.
    if (boundedByHome && dir === home) break;
    if (fs.existsSync(path.join(dir, CONFIG_FILENAME))) {
      return { root: dir, origin: "enclosing", startedFrom };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return { root: startedFrom, origin: "onboarding", startedFrom };
}

/**
 * The project root for a default-rooted caller: {@link findProjectRoot}, plus
 * the loud stderr notice when the answer is "no enclosing project, onboarding
 * a new one here". THE resolution seam for every caller that used to pass
 * `process.cwd()` straight through.
 */
export function resolveProjectRoot(
  startDir: string,
  options: { env?: NodeJS.ProcessEnv; warn?: (message: string) => void } = {},
): string {
  const resolution = findProjectRoot(startDir, options.env ?? process.env);
  if (resolution.origin === "onboarding" && options.warn !== undefined) {
    options.warn(
      `ideate: no enclosing ${CONFIG_FILENAME} found at or above ${resolution.startedFrom} — ` +
        `onboarding a NEW ideate project there. If you meant to use an existing project, ` +
        `run from inside it or set ${PROJECT_ROOT_ENV}.\n`,
    );
  }
  return resolution.root;
}

/** The config shape — exactly these fields, nothing from the legacy knowledge-store schema. */
export interface IdeateConfigV3 {
  schema_version: typeof V3_SCHEMA_VERSION;
  record: {
    /** Record directory, relative to the project root (absolute also honored). */
    path: string;
  };
  /** Board backend selection: local SQLite now, hosted later. */
  backend: "local";
  /** Optional work-state (delegation board) store location. Absent
   *  by default — see the file header note above; consumers resolve the
   *  effective path via `workStatePath()`, never this field directly. */
  work_state?: {
    /** Work-state directory, relative to the project root (absolute also
     *  honored). Optional within the block — absent falls back to
     *  {@link DEFAULT_WORK_STATE_PATH}, so a block carrying only
     *  `claim_priming` is valid. */
    path?: string;
    /** Claim-time priming gate: absent/false = the hook
     *  point stays mechanically disabled. No env-var override exists.
     *  NOTE: priming-hook.ts reads this field via its own side-effect-free
     *  raw read (a hook path must never trigger config lazy-init writes);
     *  this schema declaration is the single typed definition both agree
     *  on. */
    claim_priming?: boolean;
  };
}

export type IdeateConfigErrorCode =
  /** The file exists but is not parseable JSON. Never overwritten. */
  | "PARSE"
  /** The file parses but its shape is invalid (or from a newer ideate). */
  | "INVALID";

/** Typed, loud config failure. A corrupt config is never overwritten. */
export class IdeateConfigError extends Error {
  override readonly name = "IdeateConfigError";
  readonly code: IdeateConfigErrorCode;
  readonly configPath: string;

  constructor(code: IdeateConfigErrorCode, configPath: string, message: string) {
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
 * depends on the path being read from exactly one place.
 */
export function recordPath(config: IdeateConfigV3, projectRoot: string): string {
  return path.resolve(projectRoot, config.record.path);
}

/**
 * Resolve the work-state (delegation board) directory for a project.
 *
 * THE single source of truth for the resolved work-state path, mirroring
 * `recordPath`'s role for records. Falls back to
 * {@link DEFAULT_WORK_STATE_PATH} when the config carries no `work_state`
 * block — the common case, since `loadConfig` never writes this key on its
 * own (see the file header note).
 */
export function workStatePath(config: IdeateConfigV3, projectRoot: string): string {
  return path.resolve(projectRoot, config.work_state?.path ?? DEFAULT_WORK_STATE_PATH);
}

/**
 * Load the project's `.ideate.json`, lazily initializing it on first use.
 *
 * - No file → lazy init (onboarding): create `.ideate.json` with the
 *   defaults and create the record directory. No ceremony, no interview.
 * - File with legacy fields (a schema_version-9 config) and no current keys →
 *   legacy detected: merge the current keys into the file WITHOUT touching any
 *   existing field (every legacy field is preserved verbatim; nothing deleted,
 *   nothing rewritten), create the record directory, return the current view.
 * - File already carrying the current keys → return them; the file is not
 *   rewritten.
 * - Corrupt/unparseable file → IdeateConfigError, loudly; never overwritten.
 */
export function loadConfig(projectRoot: string): IdeateConfigV3 {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Lazy init: first call creates the config and the record directory.
      //
      // ENOENT lazy-init race: two concurrent sessions can both observe
      // ENOENT here (two simultaneous sessions on one machine is ordinary,
      // not exceptional — it applies just as much to config lazy-init as it
      // does to board.db). The write below uses the `wx` flag (exclusive create,
      // fails loudly with `EEXIST` rather than silently overwriting) so a
      // losing writer can never clobber whatever the winner already wrote.
      // The EEXIST branch below is deliberately non-fatal: BOTH writers
      // reach this exact branch with IDENTICAL, deterministically-derived
      // content — `defaultConfig()` takes no input from the existing file
      // (there IS no existing file; that is what "ENOENT" means), so
      // whichever process's write actually landed on disk contains the
      // exact same bytes this process would have written. There is nothing
      // to reconcile: the loser simply proceeds with the in-memory `config`
      // it already built, which is byte-for-byte what's now on disk.
      const config = defaultConfig();
      try {
        writeConfigFile(configPath, config, "wx");
      } catch (writeErr) {
        if ((writeErr as NodeJS.ErrnoException).code !== "EEXIST") throw writeErr;
      }
      ensureRecordDir(config, projectRoot);
      return config;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new IdeateConfigError(
      "PARSE",
      configPath,
      `.ideate.json is not valid JSON and has been left untouched — fix or remove it by hand: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdeateConfigError(
      "INVALID",
      configPath,
      ".ideate.json must contain a JSON object; the file has been left untouched",
    );
  }

  const file = parsed as Record<string, unknown>;
  const carriesV3Keys = file["record"] !== undefined || file["backend"] !== undefined;

  if (carriesV3Keys) {
    const config = readV3View(file, configPath);
    ensureRecordDir(config, projectRoot);
    return config; // No write: an already-current file passes through unchanged.
  }

  // Legacy config detected (schema_version-9 in practice). Non-destructive
  // merge: every existing field — including its schema_version — is carried
  // into the output object verbatim; only the current keys are added alongside.
  const merged: Record<string, unknown> = {
    ...file,
    record: { path: DEFAULT_RECORD_PATH },
    backend: "local",
  };
  writeConfigFile(configPath, merged);

  const config = defaultConfig();
  ensureRecordDir(config, projectRoot);
  return config;
}

/** The exact lazy-init defaults. */
function defaultConfig(): IdeateConfigV3 {
  return {
    schema_version: V3_SCHEMA_VERSION,
    record: { path: DEFAULT_RECORD_PATH },
    backend: "local",
  };
}

/** Validate the current-schema keys of a parsed config object and return the view. */
function readV3View(file: Record<string, unknown>, configPath: string): IdeateConfigV3 {
  const schemaVersion = file["schema_version"];
  if (typeof schemaVersion === "number" && schemaVersion > V3_SCHEMA_VERSION) {
    throw new IdeateConfigError(
      "INVALID",
      configPath,
      `.ideate.json has schema_version ${String(schemaVersion)}, newer than this ideate understands (${String(V3_SCHEMA_VERSION)})`,
    );
  }

  const record = file["record"];
  const recordPathValue =
    record !== null && typeof record === "object" && !Array.isArray(record)
      ? (record as Record<string, unknown>)["path"]
      : undefined;
  if (typeof recordPathValue !== "string" || recordPathValue.length === 0) {
    throw new IdeateConfigError(
      "INVALID",
      configPath,
      ".ideate.json carries v3 keys but record.path is missing or not a non-empty string; the file has been left untouched",
    );
  }

  const backend = file["backend"];
  if (backend !== "local") {
    throw new IdeateConfigError(
      "INVALID",
      configPath,
      `.ideate.json carries v3 keys but backend is ${JSON.stringify(backend)}; only "local" is supported`,
    );
  }

  // `work_state` is OPTIONAL: absent is the common, unremarkable case (the
  // resolver falls back to DEFAULT_WORK_STATE_PATH). When present, it must
  // be well-formed — malformed shapes are rejected loudly, file untouched.
  const workStateRaw = file["work_state"];
  let workState: { path?: string; claim_priming?: boolean } | undefined;
  if (workStateRaw !== undefined) {
    if (workStateRaw === null || typeof workStateRaw !== "object" || Array.isArray(workStateRaw)) {
      throw new IdeateConfigError(
        "INVALID",
        configPath,
        ".ideate.json carries a work_state key but it is not an object; the file has been left untouched",
      );
    }
    const workStateRecord = workStateRaw as Record<string, unknown>;
    const workStatePathValue = workStateRecord["path"];
    if (workStatePathValue !== undefined && (typeof workStatePathValue !== "string" || workStatePathValue.length === 0)) {
      throw new IdeateConfigError(
        "INVALID",
        configPath,
        ".ideate.json carries work_state.path but it is not a non-empty string; the file has been left untouched",
      );
    }
    const claimPrimingValue = workStateRecord["claim_priming"];
    if (claimPrimingValue !== undefined && typeof claimPrimingValue !== "boolean") {
      throw new IdeateConfigError(
        "INVALID",
        configPath,
        ".ideate.json carries work_state.claim_priming but it is not a boolean; the file has been left untouched",
      );
    }
    workState = {
      ...(workStatePathValue === undefined ? {} : { path: workStatePathValue }),
      ...(claimPrimingValue === undefined ? {} : { claim_priming: claimPrimingValue }),
    };
  }

  return {
    schema_version: V3_SCHEMA_VERSION,
    record: { path: recordPathValue },
    backend: "local",
    ...(workState === undefined ? {} : { work_state: workState }),
  };
}

function writeConfigFile(
  configPath: string,
  value: Record<string, unknown> | IdeateConfigV3,
  flag: "w" | "wx" = "w",
): void {
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag });
}

function ensureRecordDir(config: IdeateConfigV3, projectRoot: string): void {
  // Resolved through recordPath() — the single source of truth, used even here.
  fs.mkdirSync(recordPath(config, projectRoot), { recursive: true });
}
