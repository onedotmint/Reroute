import type { ProjectConfig, ProviderId, RuntimeSpec, Capabilities } from '../core/contracts.js';
export declare const PROVIDERS: ProviderId[];
export declare const DEFAULT_CONFIG: ProjectConfig;
export declare function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown>;
export declare function validateConfig(input: unknown): ProjectConfig;
export declare function loadConfig(root?: string, override?: Record<string, unknown>): Promise<ProjectConfig>;
export declare function assertCapabilities(spec: RuntimeSpec, cap: Capabilities, provider: string): void;
