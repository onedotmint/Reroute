export declare class RerouteError extends Error {
    readonly code: string;
    readonly exitCode: number;
    constructor(code: string, message: string, exitCode?: number);
}
export declare function invariant(condition: unknown, code: string, message: string): asserts condition;
export declare function errorCode(error: unknown): string | undefined;
export declare function message(error: unknown): string;
/** No raw provider objects/errors: these often contain HTTP authorization headers. */
export declare function safeMessage(error: unknown): string;
export declare function redact(value: string): string;
