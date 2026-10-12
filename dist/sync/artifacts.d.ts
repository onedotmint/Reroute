import type { ArtifactPolicy, FileTransport } from '../core/contracts.js';
export declare function validArtifactPath(path: unknown): path is string;
/** Explicit files only, never merge artifacts into source or its baseline. Call under the project lane. */
export declare function fetchArtifacts(root: string, policy: ArtifactPolicy, transport: FileTransport): Promise<{
    directory: string;
    files: string[];
}>;
