import type { ProjectState } from '../core/contracts.js';
export type ProjectChoices = Record<string, string | boolean>;
export declare function projectConfiguration(cwd: string, flags: ProjectChoices): Promise<{
    config: import("../core/contracts.js").ProjectConfig;
    override: Record<string, unknown>;
    root: string;
}>;
export declare function enableProject(cwd: string, flags: ProjectChoices): Promise<{
    enabled: boolean;
    provider: import("../core/contracts.js").ProviderId;
    project: string;
    paidAuthorized: boolean;
    policyMode: "tasks" | "legacy" | undefined;
    migration: string | undefined;
    note: string;
}>;
export declare function projectSettings(cwd: string): Promise<{
    state: ProjectState | undefined;
    root: string;
    config: import("../core/contracts.js").ProjectConfig;
}>;
export declare function localStatus(cwd: string): Promise<{
    paidAuthorized: boolean;
    warning: string | undefined;
    enabled: boolean;
    project: import("../core/contracts.js").ProjectRef | undefined;
    provider: import("../core/contracts.js").ProviderId | undefined;
    runtime: string | undefined;
    status: string;
    active: number | undefined;
    dev: string | undefined;
    syncPending: boolean;
    coordinator: string;
    remoteReadiness: string;
    billing: string;
    stateSource: string;
    routing: "tasks" | "legacy";
    tasks: ("build" | "test" | "check" | "benchmark")[];
}>;
/** Explicit, read-only vendor query: never prepare/restore a runtime. */
export declare function runtimeStatus(cwd: string): Promise<{
    status: string;
    stateSource: string;
    warning: undefined;
} | {
    status: import("../core/contracts.js").RuntimeStatus;
    stateSource: string;
    warning: string | undefined;
} | {
    status: string;
    stateSource: string;
    warning: string;
}>;
export declare function manageRuntime(cwd: string, action: 'start' | 'stop' | 'destroy'): Promise<unknown>;
