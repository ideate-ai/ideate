import chokidar from "chokidar";
import { EventEmitter } from "events";
import path from "path";
/**
 * Watches one or more artifact directories for file changes.
 * Emits "change" events with the artifact directory and file path.
 * Used by the cache layer to invalidate stale entries.
 */
export class ArtifactWatcher extends EventEmitter {
    watchers = new Map();
    debounceTimers = new Map();
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
        const onEvent = (filePath) => {
            const existing = this.debounceTimers.get(artifactDir);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                this.debounceTimers.delete(artifactDir);
                this.emit("change", {
                    artifactDir,
                    filePath: path.resolve(filePath),
                });
            }, this.debounceMs);
            this.debounceTimers.set(artifactDir, timer);
        };
        watcher.on("add", onEvent);
        watcher.on("change", onEvent);
        watcher.on("unlink", onEvent);
        this.watchers.set(artifactDir, watcher);
    }
    unwatch(artifactDir) {
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
    close() {
        for (const [dir] of this.watchers) {
            this.unwatch(dir);
        }
    }
}
export const artifactWatcher = new ArtifactWatcher();
//# sourceMappingURL=watcher.js.map