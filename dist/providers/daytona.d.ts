import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { type RawProcess } from '../platform/process.js';
import { RemoteProvider } from './common.js';
import type { Launch } from './channel.js';
export type DaytonaSandboxState = 'creating' | 'restoring' | 'destroyed' | 'destroying' | 'started' | 'stopped' | 'starting' | 'stopping' | 'error' | 'build_failed' | 'pending_build' | 'building_snapshot' | 'unknown' | 'pulling_snapshot' | 'archived' | 'archiving' | 'resizing' | 'snapshotting' | 'forking' | 'pausing' | 'paused' | 'resuming' | '11184809';
declare const GPU_TYPES: readonly ["H100", "H200", "B300", "RTX-PRO-6000", "RTX-4090", "RTX-5090", "MI355X"];
export type DaytonaGpuType = typeof GPU_TYPES[number];
export interface DaytonaCreateBaseParams {
    name?: string;
    labels?: Record<string, string>;
    envVars?: Record<string, string>;
    autoStopInterval?: number;
    autoArchiveInterval?: number;
    autoDeleteInterval?: number;
    volumes?: {
        volumeId: string;
        mountPath: string;
        subpath?: string;
    }[];
    spot?: boolean;
    ephemeral?: boolean;
    ttlMinutes?: number;
}
export interface DaytonaCreateImageParams extends DaytonaCreateBaseParams {
    image: string;
    resources?: {
        cpu?: number;
        memory?: number;
        disk?: number;
        gpu?: number;
        gpuType?: DaytonaGpuType;
    };
}
export interface DaytonaCreateSnapshotParams extends DaytonaCreateBaseParams {
    snapshot?: string;
}
export type DaytonaCreateParams = DaytonaCreateImageParams | DaytonaCreateSnapshotParams;
export interface DaytonaSandbox {
    id: string;
    state?: DaytonaSandboxState;
    labels: Record<string, string>;
    sandboxClass?: 'container' | 'linux-vm' | 'windows' | '11184809';
    gpu: number;
    spot?: boolean;
    autoDeleteInterval?: number;
    autoDestroyAt?: string;
    start(timeout?: number): Promise<void>;
    stop(timeout?: number): Promise<void>;
    setAutostopInterval(minutes: number): Promise<void>;
    setAutoDeleteInterval(minutes: number): Promise<void>;
    refreshActivity(): Promise<void>;
    createSshAccess(minutes: number): Promise<{
        token: string;
        sshCommand: string;
        expiresAt: Date;
    }>;
    getPreviewLink(port: number): Promise<{
        url: string;
        token: string;
    }>;
    getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{
        url: string;
        token: string;
    }>;
}
export interface DaytonaClient {
    get(id: string): Promise<DaytonaSandbox>;
    snapshot: {
        get(name: string): Promise<{
            sandboxClass?: DaytonaSandbox['sandboxClass'];
            resources?: {
                gpu?: unknown;
            };
        }>;
    };
    create(params: DaytonaCreateParams, options?: {
        timeout?: number;
    }): Promise<DaytonaSandbox>;
    delete(sandbox: DaytonaSandbox, timeout?: number): Promise<void>;
}
export interface DaytonaSdk {
    Daytona: new (config?: {
        target?: string;
        requestTimeoutMs?: number;
    }) => DaytonaClient;
    DaytonaNotFoundError: new (message: string, statusCode?: number) => Error & {
        statusCode?: number;
    };
}
export interface DaytonaProviderOptions {
    target?: string;
    snapshot?: string;
    autoArchiveMinutes?: number;
    autoDeleteMinutes?: number;
    volumes?: DaytonaCreateBaseParams['volumes'];
    sshHost?: string;
    sshPort?: number;
}
export declare class DaytonaProvider extends RemoteProvider {
    private readonly options;
    private readonly sdkLoader;
    readonly id: "daytona";
    readonly capabilities: Capabilities;
    protected bridge: Launch;
    private client?;
    private sdkModule?;
    private access;
    constructor(options?: DaytonaProviderOptions, sdkLoader?: () => Promise<DaytonaSdk>);
    private sdk;
    private missing;
    private validateSpec;
    private validateRuntime;
    private validateSandbox;
    private owned;
    private preserve;
    private start;
    restore(project: ProjectRef, spec: RuntimeSpec, runtime: RuntimeRef): Promise<RuntimeRef>;
    ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
    launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess>;
    status(runtime: RuntimeRef): Promise<RuntimeStatus>;
    applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
    destroy(runtime: RuntimeRef): Promise<void>;
    preview(runtime: RuntimeRef, port: number): Promise<string>;
}
export {};
