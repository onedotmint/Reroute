export declare const HARNESSES: readonly ["pi", "omp", "claude", "codex", "deepseek", "opencode", "cursor"];
export type Harness = typeof HARNESSES[number];
export declare const SDKS: Record<string, string>;
export declare function agentHome(): string;
export declare function binary(name: string): Promise<string | undefined>;
export declare function detectHarnesses(): Promise<Harness[]>;
/** Merge only an owned hook; do not rewrite unrelated entries or corrupt JSON. */
export declare function mergeHookFile(path: string, host: 'claude' | 'codex' | 'cursor'): Promise<void>;
export declare function installHarness(id: Harness): Promise<string>;
export declare function installSdk(provider: string): Promise<void>;
export declare function authStatus(): Promise<Record<string, unknown>>;
export declare function setup(options: {
    harnesses?: Harness[];
    install?: string;
    skipAdapters?: boolean;
    allowCodexHook?: boolean;
}): Promise<unknown>;
export declare function doctor(cwd: string, fix: boolean, probe: boolean): Promise<unknown>;
