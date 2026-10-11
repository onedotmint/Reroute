export type HookHost = 'claude' | 'codex' | 'cursor';
/** Only wire translation lives here. No approval bypass, provider or routing logic. */
export declare function transformHook(host: HookHost, packet: unknown): Record<string, unknown>;
