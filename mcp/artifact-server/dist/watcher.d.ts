import { WatchOptions } from "chokidar";
import { EventEmitter } from "events";
export interface FileChangeEvent {
    artifactDir: string;
    filePath: string;
}
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
export declare class ArtifactWatcher extends EventEmitter {
    private watchers;
    private debounceTimers;
    private pendingChanged;
    private pendingDeleted;
    private extraOptions;
    readonly debounceMs: number;
    constructor(extraOptions?: WatchOptions, debounceMs?: number);
    watch(artifactDir: string): void;
    unwatch(artifactDir: string): void;
    close(): void;
}
export declare const artifactWatcher: ArtifactWatcher;
//# sourceMappingURL=watcher.d.ts.map