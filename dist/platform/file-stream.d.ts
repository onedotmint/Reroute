import type { BigIntStats } from 'node:fs';
import type { FileEntry, FileTransport, SyncPolicy } from '../core/contracts.js';
/** Read an opened regular file incrementally; reject mutation or replacement during the read. */
export declare function readFileChunks(path: string, consume: (data: Buffer) => Promise<void>, maxBytes?: number, expected?: BigIntStats): Promise<FileEntry>;
export declare function hashFile(path: string, maxBytes?: number, expected?: BigIntStats): Promise<FileEntry>;
export declare function stageDownload(transport: FileTransport, path: string, policy: SyncPolicy, destination: string, expected?: FileEntry, artifact?: boolean): Promise<string>;
export declare function copyVerified(source: string, destination: string, expectedHash: string): Promise<void>;
