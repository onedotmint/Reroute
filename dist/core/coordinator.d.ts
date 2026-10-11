import type { ProjectState, ProviderId, ExecutionHandle, ExecutionEvent, ExecutionExit, ProviderFactory } from './contracts.js';
import { ProjectStore } from './projects.js';
export interface RunInput {
    cwd: string;
    argv: string[];
    env: Record<string, string>;
    timeoutMs?: number;
}
export interface RunHooks {
    signal?: AbortSignal;
    onHandle?: (handle: ExecutionHandle) => void;
    onOutput?: (event: ExecutionEvent) => Promise<void> | void;
}
export declare class Coordinator {
    private readonly factory;
    readonly store: ProjectStore;
    private entries;
    private generation;
    private closing;
    private shutdownTask?;
    private checkExecution;
    constructor(factory: ProviderFactory);
    private entry;
    enable(cwd: string, provider: ProviderId, override: Record<string, unknown>, fresh?: boolean): Promise<ProjectState>;
    private protectSource;
    private reconcile;
    private ready;
    start(cwd: string): Promise<ProjectState>;
    run(input: RunInput, hooks?: RunHooks): Promise<ExecutionExit>;
    synchronize(cwd: string, acceptLocal?: boolean): Promise<unknown>;
    devStart(input: RunInput, port?: number): Promise<{
        id: string;
        port?: number;
    }>;
    devLogs(cwd: string): Promise<string>;
    devStop(cwd: string): Promise<void>;
    devPreview(cwd: string): Promise<string>;
    stop(cwd: string, destroy?: boolean): Promise<void>;
    disable(cwd: string): Promise<void>;
    status(cwd: string): Promise<unknown>;
    shutdown(): Promise<void>;
    private shutdownEntries;
    recover(): Promise<void>;
}
