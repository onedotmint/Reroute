import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { type RawProcess } from '../platform/process.js';
import { RemoteProvider } from './common.js';
import type { Launch } from './channel.js';
export interface SshOptions {
    host: string;
    user?: string;
    port?: number;
    remoteRoot?: string;
    bootstrap?: string;
}
export declare function sshArgs(options: SshOptions): string[];
export declare class SshProvider extends RemoteProvider {
    private readonly options;
    readonly id: "ssh";
    readonly capabilities: Capabilities;
    private forwards;
    constructor(options: SshOptions);
    private root;
    private assertRuntime;
    protected bridge: Launch;
    protected verifyWorkspace(runtime: RuntimeRef): Promise<RuntimeRef>;
    ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
    launch(_runtime: RuntimeRef, argv: string[]): Promise<RawProcess>;
    status(runtime: RuntimeRef): Promise<RuntimeStatus>;
    applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
    destroy(runtime: RuntimeRef): Promise<void>;
    preview(runtime: RuntimeRef, port: number): Promise<string>;
}
