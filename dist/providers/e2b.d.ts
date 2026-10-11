import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { type RawProcess } from '../platform/process.js';
import { RemoteProvider } from './common.js';
interface CommandHandle {
    pid: number;
    wait(): Promise<{
        exitCode: number;
    }>;
}
interface Sandbox {
    sandboxId: string;
    commands: {
        run(command: string, options: Record<string, unknown>): Promise<CommandHandle>;
        sendStdin(pid: number, data: Uint8Array): Promise<void>;
        closeStdin(pid: number): Promise<void>;
        kill(pid: number): Promise<boolean>;
    };
    setTimeout(ms: number): Promise<void>;
    pause(): Promise<boolean>;
    kill(): Promise<boolean>;
    getHost(port: number): string;
}
interface SandboxClass {
    create(template: string, options: Record<string, unknown>): Promise<Sandbox>;
    connect(id: string, options?: Record<string, unknown>): Promise<Sandbox>;
    getInfo(id: string): Promise<{
        state: string;
    }>;
    list(options: Record<string, unknown>): {
        hasNext: boolean;
        nextItems(): Promise<{
            sandboxId: string;
        }[]>;
    };
}
interface Sdk {
    Sandbox: SandboxClass;
}
export declare class E2BProvider extends RemoteProvider {
    private readonly options;
    private readonly sdkLoader;
    readonly id: "e2b";
    readonly capabilities: Capabilities;
    private cls?;
    private sandboxes;
    constructor(options?: Record<string, unknown>, sdkLoader?: () => Promise<Sdk>);
    private sdk;
    private sandbox;
    ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
    launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess>;
    status(runtime: RuntimeRef): Promise<RuntimeStatus>;
    applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
    destroy(runtime: RuntimeRef): Promise<void>;
    preview(runtime: RuntimeRef, port: number): Promise<string>;
}
export {};
