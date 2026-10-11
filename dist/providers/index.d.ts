import type { ProjectConfig, RuntimeProvider } from '../core/contracts.js';
/** Composition root is the only place that selects concrete providers. */
export declare function createProvider(config: ProjectConfig): RuntimeProvider;
