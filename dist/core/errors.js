export class RerouteError extends Error {
    code;
    exitCode;
    constructor(code, message, exitCode = 70) {
        super(message);
        this.code = code;
        this.exitCode = exitCode;
        this.name = 'RerouteError';
    }
}
export function invariant(condition, code, message) {
    if (!condition)
        throw new RerouteError(code, message);
}
export function errorCode(error) {
    return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
export function message(error) { return error instanceof Error ? error.message : String(error); }
/** No raw provider objects/errors: these often contain HTTP authorization headers. */
export function safeMessage(error) {
    return error instanceof RerouteError ? redact(error.message) : 'Provider or transport failed. Check native provider authentication and reachability; no local fallback was used.';
}
export function redact(value) {
    return value.replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
        .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,"']+/gi, '$1[REDACTED]')
        .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@');
}
