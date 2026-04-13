/**
 * logger.ts — Structured logging for the MCP artifact server.
 *
 * CRITICAL: MCP servers communicate via stdout (newline-delimited JSON-RPC).
 * Any console.log() call corrupts the protocol stream and causes
 * "[Tool result missing due to internal error]" on the client.
 *
 * This module provides:
 *   - log.info/warn/error/debug → all write to stderr (safe for MCP)
 *   - Optional file logging to LOG_PATH for persistent debugging
 *   - Tool call tracing with timing for diagnosing failures
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Log file path — opt-in via IDEATE_MCP_LOG env var, or default location
// ---------------------------------------------------------------------------

const LOG_PATH = process.env.IDEATE_MCP_LOG
  ?? path.join(os.homedir(), ".claude", "logs", "ideate-mcp.log");

let logFileEnabled = true;
let logFd: number | null = null;

function ensureLogDir(): void {
  if (!logFileEnabled) return;
  try {
    const dir = path.dirname(LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    logFd = fs.openSync(LOG_PATH, "a");
  } catch {
    logFileEnabled = false;
  }
}

// Initialize on module load
ensureLogDir();

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: string, prefix: string, msg: string, extra?: unknown): string {
  const base = `[${timestamp()}] [${level}] [${prefix}] ${msg}`;
  if (extra !== undefined) {
    const extraStr = extra instanceof Error
      ? `${extra.message}\n${extra.stack}`
      : typeof extra === "string" ? extra : JSON.stringify(extra);
    return `${base} ${extraStr}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Core log functions — all write to stderr + optional file
// ---------------------------------------------------------------------------

function writeLog(formatted: string): void {
  // Always write to stderr (safe for MCP)
  process.stderr.write(formatted + "\n");

  // Also write to file if enabled
  if (logFileEnabled && logFd !== null) {
    try {
      fs.writeSync(logFd, formatted + "\n");
    } catch {
      // If file write fails, disable file logging silently
      logFileEnabled = false;
    }
  }
}

export const log = {
  info(prefix: string, msg: string, extra?: unknown): void {
    writeLog(formatMessage("INFO", prefix, msg, extra));
  },

  warn(prefix: string, msg: string, extra?: unknown): void {
    writeLog(formatMessage("WARN", prefix, msg, extra));
  },

  error(prefix: string, msg: string, extra?: unknown): void {
    writeLog(formatMessage("ERROR", prefix, msg, extra));
  },

  debug(prefix: string, msg: string, extra?: unknown): void {
    if (process.env.IDEATE_MCP_DEBUG) {
      writeLog(formatMessage("DEBUG", prefix, msg, extra));
    }
  },

  /** Log a tool call with timing. Returns a function to call when the tool completes. */
  toolCall(name: string, args: Record<string, unknown>): () => void {
    const start = Date.now();
    const argSummary = Object.keys(args).length > 0
      ? ` args=${JSON.stringify(Object.keys(args))}`
      : "";
    log.debug("tool", `→ ${name}${argSummary}`);
    return () => {
      const elapsed = Date.now() - start;
      log.debug("tool", `← ${name} (${elapsed}ms)`);
    };
  },
};
