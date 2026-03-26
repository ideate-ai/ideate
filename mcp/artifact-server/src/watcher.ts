import chokidar, { FSWatcher, WatchOptions } from "chokidar";
import { EventEmitter } from "events";
import path from "path";

export interface FileChangeEvent {
  artifactDir: string;
  filePath: string;
}

/**
 * Watches one or more artifact directories for file changes.
 * Emits "change" events with the artifact directory and file path.
 * Used by the cache layer to invalidate stale entries.
 */
export class ArtifactWatcher extends EventEmitter {
  private watchers: Map<string, FSWatcher> = new Map();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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

    const onEvent = (filePath: string) => {
      const existing = this.debounceTimers.get(artifactDir);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        this.debounceTimers.delete(artifactDir);
        this.emit("change", {
          artifactDir,
          filePath: path.resolve(filePath),
        } satisfies FileChangeEvent);
      }, this.debounceMs);
      this.debounceTimers.set(artifactDir, timer);
    };

    watcher.on("add", onEvent);
    watcher.on("change", onEvent);
    watcher.on("unlink", onEvent);

    this.watchers.set(artifactDir, watcher);
  }

  unwatch(artifactDir: string): void {
    const timer = this.debounceTimers.get(artifactDir);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(artifactDir);
    }
    const watcher = this.watchers.get(artifactDir);
    if (watcher) {
      watcher.close();
      this.watchers.delete(artifactDir);
    }
  }

  close(): void {
    for (const [dir] of this.watchers) {
      this.unwatch(dir);
    }
  }
}

export const artifactWatcher = new ArtifactWatcher();
