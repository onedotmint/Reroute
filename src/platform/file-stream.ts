import { promises as fs, constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FileEntry, FileTransport, SyncPolicy } from '../core/contracts.js';
import { invariant } from '../core/errors.js';

const CHUNK_BYTES = 64 * 1024;
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  if (a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mode !== b.mode) return false;
  for (const [ns, ms] of [['birthtimeNs', 'birthtimeMs'], ['mtimeNs', 'mtimeMs'], ['ctimeNs', 'ctimeMs']] as const) {
    if (typeof a[ns] === 'bigint' && typeof b[ns] === 'bigint' ? a[ns] !== b[ns] : a[ms] !== b[ms]) return false;
  }
  return true;
}
/** Read an opened regular file incrementally; reject mutation or replacement during the read. */
export async function readFileChunks(path: string, consume: (data: Buffer) => Promise<void>, maxBytes = Number.MAX_SAFE_INTEGER, expected?: BigIntStats): Promise<FileEntry> {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    invariant(before.isFile(), 'SOURCE_TYPE', 'Synchronized path must be a regular file');
    if (expected) invariant(sameIdentity(expected, before), 'SYNC_RACE', 'File changed before content validation');
    invariant(before.size <= BigInt(maxBytes), 'FILE_TOO_LARGE', 'Source file exceeds sync limit');
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK_BYTES, Number(before.size)))); let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      invariant(size <= maxBytes, 'FILE_TOO_LARGE', 'File grew beyond transfer limit');
      const data = buffer.subarray(0, bytesRead); digest.update(data); await consume(data);
    }
    const after = await file.stat({ bigint: true }), named = await fs.lstat(path, { bigint: true });
    invariant(named.isFile() && sameIdentity(before, after) && sameIdentity(after, named) && BigInt(size) === after.size, 'SYNC_RACE', 'File changed during content validation');
    return { hash: digest.digest('hex'), size, mode: Number(before.mode & 0o777n) };
  } finally { await file.close(); }
}
export function hashFile(path: string, maxBytes?: number, expected?: BigIntStats): Promise<FileEntry> {
  return readFileChunks(path, async () => {}, maxBytes, expected);
}
/** Temp remains private until every byte, declared metadata and optional planned hash agree. */
async function stageFile(destination: string, maxBytes: number, produce: (consume: (data: Buffer) => Promise<void>) => Promise<FileEntry>, expected?: FileEntry): Promise<string> {
  await fs.mkdir(dirname(destination), { recursive: true });
  const temp = join(dirname(destination), `.reroute-tmp-${randomUUID()}.tmp`);
  const file = await fs.open(temp, 'wx', 0o600);
  try {
    const digest = createHash('sha256'); let size = 0;
    const entry = await produce(async data => {
      invariant(Buffer.isBuffer(data) && data.length > 0 && data.length <= CHUNK_BYTES, 'REMOTE_PROTOCOL', 'Invalid transfer chunk');
      size += data.length;
      invariant(size <= maxBytes, 'FILE_TOO_LARGE', 'Transfer exceeds limit');
      digest.update(data);
      for (let offset = 0; offset < data.length;) {
        const { bytesWritten } = await file.write(data, offset, data.length - offset, null);
        invariant(bytesWritten > 0, 'FILE_WRITE', 'Could not write transfer chunk'); offset += bytesWritten;
      }
    });
    const actual = digest.digest('hex');
    invariant(entry.size === size && entry.hash === actual && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777, 'SYNC_RACE', 'Transferred content or metadata is invalid');
    if (expected) invariant(expected.hash === actual && expected.size === size && expected.mode === entry.mode, 'SYNC_RACE', 'Remote source changed during transfer');
    await file.close(); return temp;
  } catch (error) { await file.close().catch(() => {}); await fs.rm(temp, { force: true }); throw error; }
}
export async function stageDownload(transport: FileTransport, path: string, policy: SyncPolicy, destination: string, expected?: FileEntry, artifact = false): Promise<string> {
  return stageFile(destination, policy.maxFileBytes, async consume => {
    if (transport.download) return transport.download(path, policy, consume, artifact);
    // Compatibility for older injected transports; all shipped providers use bounded download.
    const entry = artifact ? await transport.readArtifact!(path, policy.maxFileBytes) : undefined;
    const encoded = artifact ? entry?.data : (await transport.read([path], policy))[path];
    invariant(typeof encoded === 'string' && encoded.length <= Math.ceil(policy.maxFileBytes / 3) * 4, 'FILE_TOO_LARGE', 'File response exceeds transfer limit');
    const data = Buffer.from(encoded, 'base64');
    for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) await consume(data.subarray(offset, offset + CHUNK_BYTES));
    return entry ?? { hash: createHash('sha256').update(data).digest('hex'), size: data.length, mode: expected?.mode ?? 0o644 };
  }, expected);
}
export async function copyVerified(source: string, destination: string, expectedHash: string): Promise<void> {
  let temp: string | undefined;
  try {
    temp = await stageFile(destination, Number.MAX_SAFE_INTEGER, async consume => {
      const entry = await readFileChunks(source, consume);
      invariant(entry.hash === expectedHash, 'SYNC_RACE', 'Local source changed before backup'); return entry;
    });
    await fs.rename(temp, destination);
  } finally { if (temp) await fs.rm(temp, { force: true }); }
}
