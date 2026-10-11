import type { RuntimeProvider, RuntimeRef } from './contracts.js';
/** One owner for activity leases. Provider calls and idle deadlines are serialized. */
export declare class Lifecycle {
    private readonly provider;
    private readonly runtime;
    private readonly minutes;
    private readonly onIdle;
    private readonly onError;
    private readonly scheduleIdle;
    private leases;
    private idle?;
    private renewal?;
    private generation;
    private renewalGeneration;
    private disposed;
    private activation?;
    private readonly policyLane;
    constructor(provider: RuntimeProvider, runtime: RuntimeRef, minutes: number, onIdle: () => void, onError: (error: unknown) => void, scheduleIdle?: (operation: () => Promise<void>) => Promise<void>);
    get active(): number;
    private set;
    private renew;
    acquire(): Promise<() => Promise<void>>;
    arm(): Promise<void>;
    stop(): Promise<void>;
    dispose(): void;
}
