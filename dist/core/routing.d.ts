export declare const RUNTIME_COMMANDS: string[];
export declare const TASK_CATEGORIES: readonly ["build", "test", "check", "benchmark"];
export type TaskCategory = typeof TASK_CATEGORIES[number];
type TaskRules = {
    mode?: 'tasks' | 'legacy';
    tasks?: TaskCategory[];
    local?: string[][];
    remote?: string[][];
};
export declare function routingDecision(argv: string[], commands?: string[], rules?: TaskRules, explicit?: boolean): {
    executable: string;
    route: 'local' | 'remote';
    rule: string;
};
export declare function route(argv: string[], commands?: string[], rules?: TaskRules, explicit?: boolean): 'local' | 'remote';
export declare function isControlEnv(key: string): boolean;
export declare function isSecretName(key: string): boolean;
export declare function environmentBaseline(env: NodeJS.ProcessEnv): string;
export declare function selectedEnvironment(env: NodeJS.ProcessEnv, allow?: string[]): Record<string, string>;
export declare function unshimmedPath(path: string | undefined, shimDir: string): string;
export declare function remoteCwd(localRoot: string, cwd: string, remoteRoot: string): string;
export declare function mapArgv(argv: string[], localRoot: string, remoteRoot: string): string[];
export {};
