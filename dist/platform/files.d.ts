export declare const packageRoot: string;
export declare function home(): string;
export declare function cliPath(): string;
export declare function daemonPath(): string;
export declare function hash(data: string | Buffer): string;
export declare function exists(path: string): Promise<boolean>;
export declare function privateDir(path: string): Promise<void>;
export declare function atomicWrite(path: string, data: string | Buffer, mode?: number): Promise<void>;
export declare function readJSON<T>(path: string): Promise<T | undefined>;
export declare function writeJSON(path: string, data: unknown): Promise<void>;
export declare function contained(root: string, path: string): boolean;
export declare function safeRelative(path: string): void;
/** Reject symlink parents both when scanning and immediately before writes. */
export declare function safePath(root: string, rel: string): Promise<string>;
