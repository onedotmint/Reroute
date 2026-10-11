import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { type RawProcess } from '../platform/process.js';
import { RemoteProvider } from './common.js';
/** JSON is a YAML 1.2 subset; writing JSON avoids an extra YAML serializer. */
export declare function skyTask(project: ProjectRef, spec: RuntimeSpec, options: Record<string, unknown>): Record<string, unknown>;
export declare class SkyPilotProvider extends RemoteProvider {
    private readonly options;
    readonly id: "skypilot";
    readonly capabilities: Capabilities;
    private ssh;
    constructor(options?: Record<string, unknown>);
    private sshProvider;
    ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
    launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess>;
    status(runtime: RuntimeRef): Promise<RuntimeStatus>;
    applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
    destroy(runtime: RuntimeRef): Promise<void>;
    preview(runtime: RuntimeRef, port: number): Promise<string>;
}
