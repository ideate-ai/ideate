import chokidar, { FSWatcher, WatchOptions } from "chokidar";
import { EventEmitter } from "events";
import path from "path";

export interface BatchChangeEvent {
  artifactDir: string;
  changed: string[];
  deleted: string[];
}

/**
 * Watches one or more artifact directories for file changes.
 * Emits "change" events with separate changed and deleted file lists.
 * Used by the index layer for incremental re-indexing.
 */
export class ArtifactWatcher extends EventEmitter {
  private watchers: Map<string, FSWatcher> = new Map();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private pendingChanged: Map<string, Set<string>> = new Map();
  private pendingDeleted: Map<string, Set<string>> = new Map();
  private flushCallbacks: Map<string, (() => void) | null> = new Map();
  private extraOptions: WatchOptions;
  readonly debounceMs: number;

  constructor(extraOptions: WatchOptions = {}, debounceMs = 500) {
    super();
    this.extraOptions = extraOptions;
    this.debounceMs = debounceMs;
  }

  watch(artifactDir: string): void {
    if (this.watchers.has(artifactDir)) {
      return;
    }

    const watcher = chokidar.watch(artifactDir, {
      ignored: /index\.db(-wal|-shm)?$/,
      persistent: false,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100,
      },
      ...this.extraOptions,
    });

    const scheduleFlush = () => {
      const existing = this.debounceTimers.get(artifactDir);
      if (existing) {
        clearTimeout(existing);
      }
      // Store current batch state for the closure
      const currentChanged = this.pendingChanged.get(artifactDir) ?? new Set<string>();
      const currentDeleted = this.pendingDeleted.get(artifactDir) ?? new Set<string>();
      const flushCallback = () => {
        this.debounceTimers.delete(artifactDir);
        this.flushCallbacks.delete(artifactDir);

        // Clear the pending sets before emitting (trailing debounce)
        this.pendingChanged.delete(artifactDir);
        this.pendingDeleted.delete(artifactDir);

        // If a file was changed then deleted, only process the delete
        for (const f of currentDeleted) {
          currentChanged.delete(f);
        }

        if (currentChanged.size > 0 || currentDeleted.size > 0) {
          this.emit("change", {
            artifactDir,
            changed: [...currentChanged],
            deleted: [...currentDeleted],
          } satisfies BatchChangeEvent);
        }
      };
      this.flushCallbacks.set(artifactDir, flushCallback);
      const timer = setTimeout(flushCallback, this.debounceMs);
      this.debounceTimers.set(artifactDir, timer);
    };

    const onAddOrChange = (filePath: string) => {
      const resolved = path.resolve(filePath);
      if (!this.pendingChanged.has(artifactDir)) {
        this.pendingChanged.set(artifactDir, new Set());
      }
      this.pendingChanged.get(artifactDir)!.add(resolved);
      // Remove from deleted if re-created
      this.pendingDeleted.get(artifactDir)?.delete(resolved);
      scheduleFlush();
    };

    const onUnlink = (filePath: string) => {
      const resolved = path.resolve(filePath);
      if (!this.pendingDeleted.has(artifactDir)) {
        this.pendingDeleted.set(artifactDir, new Set());
      }
      this.pendingDeleted.get(artifactDir)!.add(resolved);
      // Remove from changed since it's gone
      this.pendingChanged.get(artifactDir)?.delete(resolved);
      scheduleFlush();
    };

    watcher.on("add", onAddOrChange);
    watcher.on("change", onAddOrChange);
    watcher.on("unlink", onUnlink);

    this.watchers.set(artifactDir, watcher);
  }

  async unwatch(artifactDir: string): Promise<void> {
    const timer = this.debounceTimers.get(artifactDir);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(artifactDir);
    }
    // Flush any pending changes immediately when unwatching
    const flushCallback = this.flushCallbacks.get(artifactDir);
    if (flushCallback) {
      flushCallback();
    }
    this.flushCallbacks.delete(artifactDir);
    this.pendingChanged.delete(artifactDir);
    this.pendingDeleted.delete(artifactDir);
    const watcher = this.watchers.get(artifactDir);
    if (watcher) {
      this.watchers.delete(artifactDir);
      // Await chokidar's async close so all internal timers and fs handles are
      // released before the caller proceeds. Without this await, the chokidar
      // FSWatcher's internal polling timers may fire after the test has
      // completed, producing spurious warnings and keeping the process alive.
      await watcher.close();
    }
  }

  async close(): Promise<void> {
    const dirs = [...this.watchers.keys()];
    await Promise.all(dirs.map((dir) => this.unwatch(dir)));
  }
}

export const artifactWatcher = new ArtifactWatcher();
