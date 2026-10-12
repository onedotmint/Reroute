import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ArtifactPolicy, FileTransport } from '../core/contracts.js';
import { safeRelative, safePath, privateDir } from '../platform/files.js';
import { stageDownload } from '../platform/file-stream.js';
import { invariant, RerouteError, safeMessage } from '../core/errors.js';
import { excluded } from './sync.js';

export function validArtifactPath(path: unknown): path is string {
  if (typeof path !== 'string' || /[\0-\x1f\x7f*?\[\]{}]/.test(path)) return false;
  try { safeRelative(path); } catch { return false; }
  const parts = path.split('/');
  return parts.length > 1 && ['target','dist','build','coverage','.next','.nuxt'].includes(parts[0]!) && !excluded(parts.slice(1).join('/'), {excludes: [], maxFileBytes: 1, maxFiles: 1});
}
/** Explicit files only, never merge artifacts into source or its baseline. Call under the project lane. */
export async function fetchArtifacts(root: string, policy: ArtifactPolicy, transport: FileTransport): Promise<{ directory: string; files: string[] }> {
  invariant(policy.paths.length > 0 && policy.paths.length <= 100 && policy.paths.every(validArtifactPath), 'ARTIFACT_PATH', 'Configure up to 100 exact files below target/dist/build/coverage/.next/.nuxt; no directories, globs or credentials');
  invariant(Number.isSafeInteger(policy.maxFileBytes) && policy.maxFileBytes > 0 && policy.maxFileBytes <= 32 * 1024 * 1024, 'ARTIFACT_LIMIT', 'Artifact limit must be 1..33554432 bytes per file');
  invariant(transport.download || transport.readArtifact, 'UNSUPPORTED_CAPABILITY', 'Provider transport cannot retrieve artifacts');
  const relative = '.reroute/artifacts/' + randomUUID(), directory = await safePath(root, relative);
  await privateDir(directory);
  try {
    for (const path of policy.paths) {
      const destination = await safePath(root, relative + '/' + path);
      await fs.mkdir(dirname(destination), { recursive: true }); await safePath(root, relative + '/' + path);
      const temp = await stageDownload(transport, path, { excludes: [], maxFiles: 1, maxFileBytes: policy.maxFileBytes }, destination, undefined, true);
      try { await safePath(root, relative + '/' + path); await fs.rename(temp, destination); }
      finally { await fs.rm(temp, { force: true }); }
    }
    return { directory, files: policy.paths };
  } catch (error) { throw new RerouteError('ARTIFACT_FETCH', `Artifact retrieval failed; any partial files are isolated in ${directory}. Source/baseline unchanged. ${safeMessage(error)}`, 74); }
}
