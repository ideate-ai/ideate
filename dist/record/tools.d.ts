import type { ToolRegistrar } from '../server.js';
import type { Clock } from './id.js';
/** The complete record tool surface — three verbs, no update, no delete. */
export declare const RECORD_TOOL_NAMES: readonly ["record_append", "record_read", "record_decision"];
/** Options for the registrar factory — all defaulted at the composition edge. */
export interface RecordToolsOptions {
    /** Project root the record lives under. Default: `process.cwd()` at first call. */
    projectRoot?: string;
    /**
     * Telemetry state directory. Default: `<projectRoot>/.ideate-telemetry`,
     * matching the `ideate-telemetry` CLI's placeholder default (never
     * `.ideate/` — see telemetry/cli.ts) so the CLI reads what the server wrote.
     */
    telemetryDir?: string;
    /** Session identity stamped into `source.session_id`. Default: `mcp-<ULID>` minted once per registrar. */
    sessionId?: string;
    /** Injected clock. Default: wall clock — this factory is the outermost composition edge. */
    clock?: Clock;
}
/**
 * Build the registrar for the three record verbs. Matches server.ts's
 * `ToolRegistrar` shape — push the returned function onto `toolRegistrars`
 * (or apply it directly) to contribute the tools at boot.
 *
 * Calling the registrar registers tools and does NOTHING else: config
 * loading, directory creation, and store construction all wait for the first
 * tool call (the lazy-init onboarding of config/ideate-config.ts §2.3).
 */
export declare function createRecordToolsRegistrar(options?: RecordToolsOptions): ToolRegistrar;
//# sourceMappingURL=tools.d.ts.map