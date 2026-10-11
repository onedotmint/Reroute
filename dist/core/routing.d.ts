export declare const RUNTIME_COMMANDS: string[];
export declare function routingDecision(argv: string[], commands?: string[]): {
    executable: string;
    route: 'local' | 'remote';
    rule: string;
};
export declare function route(argv: string[], commands?: string[]): 'local' | 'remote';
export declare function isControlEnv(key: string): boolean;
export declare function isSecretName(key: string): boolean;
export declare function environmentBaseline(env: NodeJS.ProcessEnv): string;
export declare function selectedEnvironment(env: NodeJS.ProcessEnv, allow?: string[]): Record<string, string>;
export declare function unshimmedPath(path: string | undefined, shimDir: string): string;
export declare function remoteCwd(localRoot: string, cwd: string, remoteRoot: string): string;
export declare function mapArgv(argv: string[], localRoot: string, remoteRoot: string): string[];
