import { type ExecutionExit } from '../core/contracts.js';
export declare function request(packet: Record<string, unknown>, autostart?: boolean): Promise<unknown>;
export declare function ensureDaemon(): Promise<void>;
export declare function reloadDaemon(): Promise<void>;
export declare function remoteRun(packet: Record<string, unknown>): Promise<ExecutionExit>;
