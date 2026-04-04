/**
 * remote-adapter.test.ts — Integration tests for RemoteAdapter wired into
 * selectAdapter via server.ts.
 *
 * These tests require a running ideate-server at localhost:4000. If the server
 * is not reachable, all tests in the live-server suite are skipped automatically.
 *
 * The error-handling tests (missing config, unreachable endpoint) run
 * unconditionally because they do not require a live server.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { selectAdapter } from "../server.js";
import { RemoteAdapter } from "../adapters/remote/index.js";
import { ConnectionError } from "../adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempIdeateDir(config: object): string {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-remote-test-"));
  const ideateDir = path.join(tmpRoot, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
  fs.writeFileSync(
    path.join(ideateDir, "config.json"),
    JSON.stringify(config, null, 2),
    "utf8"
  );
  return ideateDir;
}

// ---------------------------------------------------------------------------
// Check if localhost:4000 is reachable before running live-server tests
// ---------------------------------------------------------------------------

let serverReachable = false;

beforeAll(async () => {
  try {
    const res = await fetch("http://localhost:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(2000),
    });
    serverReachable = res.ok || res.status === 400; // 400 = server up but query may be invalid
  } catch {
    serverReachable = false;
  }
});

// ---------------------------------------------------------------------------
// Unconditional tests — no live server required
// ---------------------------------------------------------------------------

describe("selectAdapter — remote backend wiring", () => {
  it("returns a RemoteAdapter instance when backend is 'remote'", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      remote: {
        endpoint: "http://localhost:4000/graphql",
        org_id: "test-org",
        codebase_id: "test-codebase",
      },
    });

    try {
      // Pass null for db/drizzleDb — the remote path does not use them
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = selectAdapter(ideateDir, null as any, null as any);
      expect(adapter).toBeInstanceOf(RemoteAdapter);
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });

  it("throws a clear error when remote.endpoint is missing", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      remote: {
        org_id: "test-org",
        codebase_id: "test-codebase",
        // endpoint intentionally omitted
      },
    });

    try {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selectAdapter(ideateDir, null as any, null as any)
      ).toThrow("Remote backend requires 'remote.endpoint' in config.json");
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });

  it("throws a clear error when remote config block is absent", () => {
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      // remote block intentionally omitted
    });

    try {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        selectAdapter(ideateDir, null as any, null as any)
      ).toThrow("Remote backend requires 'remote.endpoint' in config.json");
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });
});

describe("RemoteAdapter — unreachable endpoint error handling", () => {
  it("initialize() throws ConnectionError for unreachable endpoint", async () => {
    // Use a port that should never have a server listening
    const ideateDir = makeTempIdeateDir({
      schema_version: 4,
      backend: "remote",
      remote: {
        endpoint: "http://localhost:19999/graphql",
        org_id: "test-org",
        codebase_id: "test-codebase",
      },
    });

    let adapter: RemoteAdapter | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapter = selectAdapter(ideateDir, null as any, null as any) as RemoteAdapter;
      expect(adapter).toBeInstanceOf(RemoteAdapter);

      await expect(adapter.initialize()).rejects.toThrow(ConnectionError);
    } finally {
      fs.rmSync(path.dirname(ideateDir), { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Live-server integration tests — skipped when server is not running
// ---------------------------------------------------------------------------

const describeLive = serverReachable ? describe : describe.skip;

describeLive("RemoteAdapter — live server at localhost:4000", () => {
  let ideateDir: string;
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-remote-live-"));
    ideateDir = path.join(tmpRoot, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });
    fs.writeFileSync(
      path.join(ideateDir, "config.json"),
      JSON.stringify(
        {
          schema_version: 4,
          backend: "remote",
          remote: {
            endpoint: "http://localhost:4000/graphql",
            org_id: "test-org",
            codebase_id: "test-codebase",
          },
        },
        null,
        2
      ),
      "utf8"
    );
  });

  afterAll(() => {
    if (tmpRoot) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("selectAdapter returns RemoteAdapter with live endpoint", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = selectAdapter(ideateDir, null as any, null as any);
    expect(adapter).toBeInstanceOf(RemoteAdapter);
  });

  it("RemoteAdapter.initialize() succeeds with live server", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = selectAdapter(ideateDir, null as any, null as any) as RemoteAdapter;
    // initialize() should resolve without throwing
    await expect(adapter.initialize()).resolves.not.toThrow();
  });
});
