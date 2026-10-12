import type { FileEntry } from '../core/contracts.js';
/** In-process only; metadata reuse is opt-in, never a persisted source of truth. */
export declare class HashCache {
    private readonly records;
    private readonly verified;
    scan(path: string, maxBytes: number, mode?: 'strict' | 'metadata'): Promise<FileEntry>;
    /** Call only after a complete successful tree scan, with the included absolute paths. */
    prune(paths: string[]): void;
    clear(): void;
}
