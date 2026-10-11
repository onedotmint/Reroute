import type { RuntimeRef, ExecRequest, ExecutionHandle, FileTransport } from '../core/contracts.js';
import type { RawProcess } from '../platform/process.js';
export type Launch = (runtime: RuntimeRef, argv: string[]) => Promise<RawProcess>;
export declare function workerArgv(payload: Record<string, unknown>): string[];
export declare function execute(launch: Launch, runtime: RuntimeRef, request: ExecRequest): Promise<ExecutionHandle>;
export declare function fileTransport(launch: Launch, runtime: RuntimeRef): FileTransport;
