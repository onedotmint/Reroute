import type { Manifest, FileTransport, SyncPolicy } from '../core/contracts.js';
export declare function excluded(path: string, policy: SyncPolicy): boolean;
export declare function scanLocal(root: string, policy: SyncPolicy): Promise<Manifest>;
export interface SyncPlan {
    push: string[];
    pull: string[];
    conflicts: string[];
}
export declare function planSync(base: Manifest, local: Manifest, remote: Manifest): SyncPlan;
/** Three-way, crash-recoverable, incremental reconciliation. Call under a project lane. */
export declare class Synchronizer {
    private readonly root;
    private readonly policy;
    constructor(root: string, policy: SyncPolicy);
    reconcile(transport: FileTransport): Promise<{
        pushed: number;
        pulled: number;
    }>;
    acceptLocal(transport: FileTransport): Promise<void>;
}
