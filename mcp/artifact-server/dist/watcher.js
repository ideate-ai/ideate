import chokidar from "chokidar";
import { EventEmitter } from "events";
import path from "path";
/**
 * Watches one or more artifact directories for file changes.
 * Emits "change" events with separate changed and deleted file lists.
 * Used by the index layer for incremental re-indexing.
 */
export class ArtifactWatcher extends EventEmitter {
    watchers = new Map();
    debounceTimers = new Map();
    pendingChanged = new Map();
    pendingDeleted = new Map();
    extraOptions;
    debounceMs;
    constructor(extraOptions = {}, debounceMs = 500) {
        super();
        this.extraOptions = extraOptions;
        this.debounceMs = debounceMs;
    }
    watch(artifactDir) {
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
            const timer = setTimeout(() => {
                this.debounceTimers.delete(artifactDir);
                const changed = this.pendingChanged.get(artifactDir) ?? new Set();
                const deleted = this.pendingDeleted.get(artifactDir) ?? new Set();
                // If a file was changed then deleted, only process the delete
                for (const f of deleted) {
                    changed.delete(f);
                }
                this.pendingChanged.delete(artifactDir);
                this.pendingDeleted.delete(artifactDir);
                if (changed.size > 0 || deleted.size > 0) {
                    this.emit("change", {
                        artifactDir,
                        changed: [...changed],
                        deleted: [...deleted],
                    });
                }
            }, this.debounceMs);
            this.debounceTimers.set(artifactDir, timer);
        };
        const onAddOrChange = (filePath) => {
            const resolved = path.resolve(filePath);
            if (!this.pendingChanged.has(artifactDir)) {
                this.pendingChanged.set(artifactDir, new Set());
            }
            this.pendingChanged.get(artifactDir).add(resolved);
            // Remove from deleted if re-created
            this.pendingDeleted.get(artifactDir)?.delete(resolved);
            scheduleFlush();
        };
        const onUnlink = (filePath) => {
            const resolved = path.resolve(filePath);
            if (!this.pendingDeleted.has(artifactDir)) {
                this.pendingDeleted.set(artifactDir, new Set());
            }
            this.pendingDeleted.get(artifactDir).add(resolved);
            // Remove from changed since it's gone
            this.pendingChanged.get(artifactDir)?.delete(resolved);
            scheduleFlush();
        };
        watcher.on("add", onAddOrChange);
        watcher.on("change", onAddOrChange);
        watcher.on("unlink", onUnlink);
        this.watchers.set(artifactDir, watcher);
    }
    unwatch(artifactDir) {
        const timer = this.debounceTimers.get(artifactDir);
        if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(artifactDir);
        }
        this.pendingChanged.delete(artifactDir);
        this.pendingDeleted.delete(artifactDir);
        const watcher = this.watchers.get(artifactDir);
        if (watcher) {
            watcher.close();
            this.watchers.delete(artifactDir);
        }
    }
    close() {
        for (const [dir] of this.watchers) {
            this.unwatch(dir);
        }
    }
}
export const artifactWatcher = new ArtifactWatcher();
//# sourceMappingURL=watcher.js.map