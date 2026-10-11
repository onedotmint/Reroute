import type { ExecutionEvent } from '../core/contracts.js';
export interface RawProcess {
    events: AsyncIterable<ExecutionEvent>;
    write(data: Buffer): Promise<void>;
    closeInput(): Promise<void>;
    wait(): Promise<number>;
    kill(): Promise<void>;
}
export declare function spawnRaw(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}): RawProcess;
export declare function capture(command: string, args: string[], options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    limit?: number;
}): Promise<{
    code: number;
    stdout: string;
    stderr: string;
}>;
export declare function quote(value: string): string;
export declare function shellCommand(argv: string[]): string;
