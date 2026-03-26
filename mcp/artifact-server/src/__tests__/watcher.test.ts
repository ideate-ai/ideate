import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { ArtifactWatcher, FileChangeEvent } from "../watcher.js";
import { rebuildIndex } from "../indexer.js";
import { createSchema } from "../schema.js";

let tmpDir: string;
let ideateDir: string;
let watcher: ArtifactWatcher;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-watcher-test-"));
  ideateDir = path.join(tmpDir, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
  // usePolling ensures events fire reliably in CI and sandbox environments
  // where native FSEvents/inotify watchers may not be available.
  watcher = new ArtifactWatcher({ usePolling: true, interval: 100 });
});

afterEach(async () => {
  watcher.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Returns a promise that resolves with the first "change" event emitted by the
 * watcher within the given timeout (ms), or rejects on timeout.
 */
function waitForChange(
  w: ArtifactWatcher,
  timeoutMs = 2000
): Promise<FileChangeEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`No change event received within ${timeoutMs}ms`));
    }, timeoutMs);

    w.once("change", (event: FileChangeEvent) => {
      clearTimeout(timer);
      resolve(event);
    });
  });
}

describe("ArtifactWatcher — .ideate/ directory", () => {
  it("emits a change event when a YAML file is written to .ideate/", async () => {
    watcher.watch(ideateDir);

    // Allow the polling watcher to take its initial directory snapshot
    // before writing the new file so the addition is detected as a change.
    await new Promise((r) => setTimeout(r, 300));

    const changePromise = waitForChange(watcher);
    const yamlPath = path.join(ideateDir, "test-artifact.yaml");
    fs.writeFileSync(yamlPath, "id: WI-001\ntitle: Test\n", "utf8");

    const event = await changePromise;
    expect(event.artifactDir).toBe(ideateDir);
    expect(event.filePath).toBe(path.resolve(yamlPath));
  });

  it("emits a change event when an existing YAML file is modified", async () => {
    const yamlPath = path.join(ideateDir, "existing.yaml");
    fs.writeFileSync(yamlPath, "id: WI-002\ntitle: Original\n", "utf8");

    watcher.watch(ideateDir);

    const changePromise = waitForChange(watcher);
    // Small delay to let the polling watcher establish its baseline snapshot
    // before we modify the file, so the change is detected as a diff.
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(yamlPath, "id: WI-002\ntitle: Modified\n", "utf8");

    const event = await changePromise;
    expect(event.artifactDir).toBe(ideateDir);
    expect(event.filePath).toBe(path.resolve(yamlPath));
  });

  it("emits a change event when a YAML file is deleted from .ideate/", async () => {
    const yamlPath = path.join(ideateDir, "to-delete.yaml");
    fs.writeFileSync(yamlPath, "id: WI-003\ntitle: Delete me\n", "utf8");

    watcher.watch(ideateDir);

    const changePromise = waitForChange(watcher);
    // Small delay to let polling establish baseline before deleting
    await new Promise((r) => setTimeout(r, 300));
    fs.unlinkSync(yamlPath);

    const event = await changePromise;
    expect(event.artifactDir).toBe(ideateDir);
    expect(event.filePath).toBe(path.resolve(yamlPath));
  });
});

// ---------------------------------------------------------------------------
// Debounce test: N rapid writes coalesce into a single "change" emission
// ---------------------------------------------------------------------------

describe("ArtifactWatcher — debounce coalescing", () => {
  it("emits exactly one change event when multiple files are written in rapid succession", async () => {
    // Use a short debounce window (150ms) so the test runs quickly.
    // usePolling with interval: 50 ensures events fire reliably.
    const debounceMs = 150;
    const debounceWatcher = new ArtifactWatcher(
      // awaitWriteFinish: false disables chokidar's built-in write-stabilization
      // delay, ensuring raw events reach onEvent immediately. Without this, chokidar
      // coalesces the burst before debounce logic runs — making the debounce untestable.
      { usePolling: true, interval: 50, awaitWriteFinish: false },
      debounceMs
    );

    const coalesceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ideate-watcher-debounce-")
    );

    try {
      debounceWatcher.watch(coalesceDir);

      // Let the polling watcher establish its initial snapshot
      await new Promise((r) => setTimeout(r, 300));

      let callCount = 0;
      debounceWatcher.on("change", () => {
        callCount++;
      });

      // Write 5 files in rapid succession (< 50ms apart)
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(coalesceDir, `file-${i}.yaml`),
          `id: WI-DEBOUNCE-00${i}\n`,
          "utf8"
        );
        await new Promise((r) => setTimeout(r, 20));
      }

      // Wait for the debounce window to expire (debounceMs + polling interval + buffer)
      await new Promise((r) => setTimeout(r, debounceMs + 300));

      // All 5 rapid events should have coalesced into exactly 1 callback invocation
      expect(callCount).toBe(1);
    } finally {
      debounceWatcher.close();
      fs.rmSync(coalesceDir, { recursive: true, force: true });
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// Integration test: file write → watcher event → rebuildIndex → DB updated
// ---------------------------------------------------------------------------

describe("ArtifactWatcher integration — event triggers rebuildIndex", () => {
  it("inserts a work_items row after file write triggers rebuildIndex via watcher event", async () => {
    // Create a separate temp dir for this test to avoid interaction with the
    // shared beforeEach watcher.
    const integrationTmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ideate-watcher-integration-")
    );
    const integrationIdeateDir = path.join(integrationTmpDir, ".ideate");
    // Create required subdirectories
    const subdirs = [
      "work-items",
      "principles",
      "constraints",
      "policies",
      "decisions",
      "questions",
      "modules",
      "research",
      "interviews",
      "archive/cycles",
    ];
    for (const sub of subdirs) {
      fs.mkdirSync(path.join(integrationIdeateDir, sub), { recursive: true });
    }

    const db = new Database(":memory:");
    createSchema(db);

    const integrationWatcher = new ArtifactWatcher({ usePolling: true, interval: 100 });

    try {
      // Register event handler: when the watcher fires, call rebuildIndex
      integrationWatcher.on("change", () => {
        rebuildIndex(db, drizzle(db),integrationIdeateDir);
      });

      integrationWatcher.watch(integrationIdeateDir);

      // Allow the polling watcher to establish its initial snapshot
      await new Promise((r) => setTimeout(r, 300));

      // Set up a promise to wait for the change event
      const changePromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("No change event received within 3000ms"));
        }, 3000);
        integrationWatcher.once("change", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      // Write a minimal work_item YAML fixture
      const wiYaml = [
        `id: "WI-INTEG-001"`,
        `type: "work_item"`,
        `title: "Integration test item"`,
        `status: "pending"`,
        `complexity: "small"`,
        `cycle_created: 1`,
        `cycle_modified: null`,
        `depends: []`,
        `blocks: []`,
        `criteria: []`,
        `scope: []`,
        `content_hash: ""`,
        `token_count: 0`,
        `file_path: ""`,
      ].join("\n") + "\n";

      fs.writeFileSync(
        path.join(integrationIdeateDir, "work-items", "WI-INTEG-001.yaml"),
        wiYaml,
        "utf8"
      );

      // Wait for the watcher event (which triggers rebuildIndex)
      await changePromise;

      // rebuildIndex runs in the `on` handler registered before the `once` resolver,
      // so it has already completed when changePromise resolves. This delay is a
      // precaution only.
      await new Promise((r) => setTimeout(r, 50));

      // Assert the work_items table has the expected row
      const row = db
        .prepare("SELECT * FROM work_items WHERE id = 'WI-INTEG-001'")
        .get() as { id: string; title: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe("WI-INTEG-001");
    } finally {
      integrationWatcher.close();
      fs.rmSync(integrationTmpDir, { recursive: true, force: true });
    }
  }, 8000);
});
