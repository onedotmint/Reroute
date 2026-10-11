import type { Manifest, FileTransport, SyncPolicy } from '../core/contracts.js';
export declare function validSyncPattern(value: unknown): value is string;
type Exclusion = {
    reason: 'minimum-security' | 'minimum-exclusion' | 'policy-exclusion';
    pattern?: string;
};
export declare function excluded(path: string, policy: SyncPolicy): boolean;
export declare function scanLocal(root: string, policy: SyncPolicy): Promise<Manifest>;
export interface SyncPreview {
    scope: 'local-only';
    included: {
        path: string;
        reason: 'included';
        bytes: number;
    }[];
    excluded: ({
        path: string;
    } & Exclusion)[];
    files: {
        count: number;
        bytes: number;
        limits: {
            maxFiles: number;
            maxFileBytes: number;
        };
        overFileCount: boolean;
        oversized: string[];
    };
    symlinks: string[];
    unsupportedTypes: {
        path: string;
        type: string;
    }[];
    sensitiveNameRisks: {
        path: string;
        excluded: boolean;
        reason: 'sensitive-name-only';
    }[];
    readiness: {
        scope: 'local-only';
        ready: boolean;
        remote: 'not-checked';
    };
    errors: {
        path: string;
        code: string;
        message: string;
    }[];
}
/** Read-only metadata snapshot: no content reads, hashes, baseline, provider or remote checks. */
export declare function syncPreview(root: string, policy: SyncPolicy): Promise<SyncPreview>;
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
export {};
