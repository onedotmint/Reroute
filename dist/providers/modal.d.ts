import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import type { RawProcess } from '../platform/process.js';
import { RemoteProvider } from './common.js';
interface ModalProcess {
    stdin: WritableStream<Uint8Array>;
    stdout: AsyncIterable<Uint8Array>;
    stderr: AsyncIterable<Uint8Array>;
    wait(): Promise<number>;
    closeStdin(): Promise<void>;
}
interface Sandbox {
    sandboxId: string;
    poll(): Promise<number | null>;
    terminate(): Promise<void>;
    exec(argv: string[], options?: Record<string, unknown>): Promise<ModalProcess>;
    tunnels(): Promise<Record<number, {
        url: string;
    }>>;
}
interface Client {
    apps: {
        fromName(name: string, options: {
            createIfMissing: boolean;
        }): Promise<unknown>;
    };
    images: {
        fromRegistry(name: string): unknown;
    };
    volumes: {
        fromName(name: string, options: {
            createIfMissing: boolean;
        }): Promise<unknown>;
    };
    secrets: {
        fromName(name: string): Promise<unknown>;
    };
    sandboxes: {
        create(app: unknown, image: unknown, options: Record<string, unknown>): Promise<Sandbox>;
        fromId(id: string): Promise<Sandbox>;
        fromName(app: string, name: string): Promise<Sandbox>;
    };
}
interface Sdk {
    ModalClient: new () => Client;
}
export declare class ModalProvider extends RemoteProvider {
    private readonly options;
    private readonly sdkLoader;
    readonly id: "modal";
    readonly capabilities: Capabilities;
    private client?;
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
