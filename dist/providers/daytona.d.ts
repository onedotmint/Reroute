import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { type RawProcess } from '../platform/process.js';
import { RemoteProvider } from './common.js';
interface Sandbox {
    id: string;
    state: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    setAutostopInterval(minutes: number): Promise<void>;
    createSshAccess(minutes: number): Promise<{
        token: string;
    }>;
    getPreviewLink(port: number): Promise<{
        url: string;
    }>;
}
interface Client {
    get(id: string): Promise<Sandbox>;
    create(options: Record<string, unknown>): Promise<Sandbox>;
    delete(sandbox: Sandbox): Promise<void>;
}
interface Sdk {
    Daytona: new (config?: Record<string, unknown>) => Client;
}
export declare class DaytonaProvider extends RemoteProvider {
    private readonly options;
    private readonly sdkLoader;
    readonly id: "daytona";
    readonly capabilities: Capabilities;
    private client?;
    private access;
    constructor(options?: Record<string, unknown>, sdkLoader?: () => Promise<Sdk>);
    private sdk;
    ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
    launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess>;
    status(runtime: RuntimeRef): Promise<RuntimeStatus>;
    applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
    destroy(runtime: RuntimeRef): Promise<void>;
    preview(runtime: RuntimeRef, port: number): Promise<string>;
}
export {};
