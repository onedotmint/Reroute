import type { ProjectState, ProviderId } from './contracts.js';
export declare function findProject(cwd: string): Promise<ProjectState | undefined>;
export declare function projectRoot(cwd: string): Promise<string>;
/** Only the coordinator writes enabled-project identities and runtime state. */
export declare class ProjectStore {
    private lane;
    enable(cwd: string, provider: ProviderId, override: Record<string, unknown>, fresh?: boolean): Promise<ProjectState>;
    save(state: ProjectState): Promise<void>;
    all(): Promise<ProjectState[]>;
}
