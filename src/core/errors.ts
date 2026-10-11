export class RerouteError extends Error {
  constructor(public readonly code: string, message: string, public readonly exitCode = 70) {
    super(message); this.name = 'RerouteError';
  }
}
export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new RerouteError(code, message);
}
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}
export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
/** No raw provider objects/errors: these often contain HTTP authorization headers. */
export function safeMessage(error: unknown): string {
  return error instanceof RerouteError ? redact(error.message) : 'Provider or transport failed. Check native provider authentication and reachability; no local fallback was used.';
}
export function redact(value: string): string {
  return value.replace(/\b(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,"']+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[REDACTED]@');
}
