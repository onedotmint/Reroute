import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { RuntimeRef, ExecRequest, ExecutionHandle, ExecutionExit, ExecutionEvent, FileTransport, Manifest, SyncPolicy, FileChange, FileEntry } from '../core/contracts.js';
import { AsyncQueue } from '../core/queue.js';
import { RerouteError, invariant } from '../core/errors.js';
import { packageRoot, safeRelative } from '../platform/files.js';
import { excluded, validSyncPattern } from '../sync/sync.js';
import { validArtifactPath } from '../sync/artifacts.js';
import type { RawProcess } from '../platform/process.js';
export type Launch = (runtime: RuntimeRef, argv: string[]) => Promise<RawProcess>;
let source: string | undefined;
export function workerArgv(payload: Record<string, unknown>): string[] {
  source ??= readFileSync(join(packageRoot, 'assets', 'worker.py'), 'utf8');
  return ['python3', '-u', '-c', source, Buffer.from(JSON.stringify(payload)).toString('base64')];
}
interface Channel { raw: RawProcess; ready: Promise<void>; done: Promise<unknown>; queue: AsyncQueue<ExecutionEvent>; stdinAck: AsyncQueue<void> }
async function channel(launch: Launch, runtime: RuntimeRef, payload: Record<string, unknown>, receive?: (packet: Record<string, unknown>, raw: RawProcess) => Promise<FileEntry | undefined>): Promise<Channel> {
  const streamingRequest = payload.op === 'rpc';
  const raw = await launch(runtime, workerArgv(streamingRequest || receive ? { op: receive ? 'file_stream' : 'rpc_stream', root: runtime.root } : { ...payload, root: runtime.root }));
  const queue = new AsyncQueue<ExecutionEvent>();
  const stdinAck = new AsyncQueue<void>(8);
  let readyResolve!: () => void, readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  let gotResult = false, result: unknown, heartbeat: NodeJS.Timeout | undefined;
  let timeoutReject!: (error: unknown) => void;
  const idleFailure = new Promise<never>((_, reject) => { timeoutReject = reject; });
  void idleFailure.catch(() => {});
  let startedTimer: NodeJS.Timeout | undefined;
  const armTimer = () => {
    clearTimeout(startedTimer);
    startedTimer = setTimeout(() => {
      if (receive) timeoutReject(new RerouteError('TRANSPORT_TIMEOUT', 'Remote file stream made no progress for 30 seconds'));
      void raw.kill().catch(() => {});
    }, 30000);
  };
  armTimer();
  const send = (frame: unknown) => raw.write(Buffer.from(JSON.stringify(frame) + '\n'));
  if (payload.op === 'exec') heartbeat = setInterval(() => { void send({ type: 'ping' }).catch(() => { void raw.kill(); }); }, 10000);
  const done = (async () => {
    const read = (async () => {
      let line = ''; const decoder = new StringDecoder('utf8');
      for await (const event of raw.events) {
        if (event.stream === 'stderr') continue; // Native errors can contain auth URLs: never leak them.
        line += decoder.write(event.data);
        invariant((receive ? Buffer.byteLength(line) <= 256 * 1024 : line.length <= 64 * 1024 * 1024), 'PROTOCOL_LIMIT', 'Remote protocol frame exceeded its limit');
        let boundary: number;
        while ((boundary = line.indexOf('\n')) >= 0) {
          const text = line.slice(0, boundary); line = line.slice(boundary + 1);
          if (receive) invariant(Buffer.byteLength(text) <= 112 * 1024, 'PROTOCOL_LIMIT', 'Remote file frame exceeded its limit');
          let packet: Record<string, unknown>;
          try { packet = JSON.parse(text) as Record<string, unknown>; }
          catch { throw new RerouteError('REMOTE_PROTOCOL', 'Unexpected remote output. Disable login banners and verify Python 3 on the runtime.'); }
          invariant(packet && typeof packet.type === 'string', 'REMOTE_PROTOCOL', 'Malformed remote packet');
          if (receive) {
            invariant(!gotResult, 'REMOTE_PROTOCOL', 'Unexpected packet after file stream confirmation');
            if (packet.type === 'error') throw new RerouteError('REMOTE_WORKER', `Remote workspace operation failed: ${String(packet.message).slice(0, 240)}`, 74);
            armTimer();
            const value = await Promise.race([receive(packet, raw), idleFailure]);
            if (value !== undefined) { gotResult = true; result = value; readyResolve(); }
            armTimer();
          } else if (packet.type === 'started') { clearTimeout(startedTimer); readyResolve(); }
          else if (packet.type === 'stdin_ack') stdinAck.push(undefined);
          else if (packet.type === 'output') {
            invariant((packet.stream === 'stdout' || packet.stream === 'stderr') && typeof packet.data === 'string' && packet.data.length <= 100000, 'REMOTE_PROTOCOL', 'Invalid remote output frame');
            queue.push({ type: 'output', stream: packet.stream, data: Buffer.from(packet.data, 'base64') });
          } else if (packet.type === 'exit') {
            invariant(Number.isInteger(packet.code) && Number(packet.code) >= 0 && Number(packet.code) <= 255, 'REMOTE_PROTOCOL', 'Invalid execution exit code');
            gotResult = true; result = { code: packet.code, signal: packet.signal, timedOut: packet.timedOut === true, cancelled: packet.cancelled === true }; readyResolve();
          } else if (packet.type === 'rpc') { gotResult = true; result = packet.value; readyResolve(); }
          else if (packet.type === 'error') throw new RerouteError('REMOTE_WORKER', `Remote workspace operation failed: ${String(packet.message).slice(0, 240)}`, 74);
          else throw new RerouteError('REMOTE_PROTOCOL', 'Unknown remote protocol packet');
        }
        if (receive) invariant(Buffer.byteLength(line) <= 112 * 1024, 'PROTOCOL_LIMIT', 'Remote file frame exceeded its limit');
      }
      if (receive) invariant(line === '' && decoder.end() === '', 'REMOTE_PROTOCOL', 'Truncated file stream frame');
      const transportCode = await raw.wait();
      invariant(gotResult && transportCode === 0, 'TRANSPORT_LOST', 'Remote transport ended without a confirmed result. No local fallback was used.');
      queue.end(); return result;
    })();
    try { return await (receive ? Promise.race([read, idleFailure]) : read); }
    catch (error) { readyReject(error); queue.end(error); await raw.kill().catch(() => {}); throw error; }
    finally { stdinAck.end(new RerouteError('STDIN_CLOSED', 'Execution input is closed')); clearInterval(heartbeat); clearTimeout(startedTimer); }
  })();
  void done.catch(() => {});
  if (streamingRequest || receive) {
    try {
      const data = Buffer.from(JSON.stringify(payload) + '\n');
      if (receive) invariant(data.length <= 100 * 1024, 'PROTOCOL_LIMIT', 'File stream request exceeded its limit');
      for (let i = 0; i < data.length; i += 32768) {
        const write = raw.write(data.subarray(i, i + 32768));
        await (receive ? Promise.race([write, idleFailure]) : write);
      }
      if (!receive) await raw.closeInput();
    } catch (error) { await raw.kill().catch(() => {}); throw error; }
  }
  return { raw, ready, done, queue, stdinAck };
}
export async function execute(launch: Launch, runtime: RuntimeRef, request: ExecRequest): Promise<ExecutionHandle> {
  const c = await channel(launch, runtime, { ...request, op: 'exec' });
  await c.ready;
  let cancelled = false, cancellation: Promise<void> | undefined;
  let inputChain: Promise<void> = Promise.resolve();
  const acknowledgements = c.stdinAck[Symbol.asyncIterator]();
  const send = (frame: unknown) => c.raw.write(Buffer.from(JSON.stringify(frame) + '\n'));
  const input = (operation: () => Promise<void>) => {
    const result = inputChain.then(operation); inputChain = result.catch(() => {}); return result;
  };
  return {
    events: c.queue,
    wait: () => c.done as Promise<ExecutionExit>,
    write: data => input(async () => {
      let pending = 0;
      for (let i = 0; i < data.length; i += 32768) {
        invariant(!cancelled, 'CANCELLED', 'Execution was cancelled');
        await send({ type: 'stdin', data: data.subarray(i, i + 32768).toString('base64') });
        if (++pending === 8) { await acknowledgements.next(); pending--; }
      }
      while (pending-- > 0) await acknowledgements.next();
    }),
    endInput: () => Promise.race([input(() => send({ type: 'eof' })), c.done]).then(() => {}),
    cancel: () => cancellation ??= (async () => {
      cancelled = true;
      const timer = setTimeout(() => { void c.raw.kill().catch(() => {}); }, 5000); timer.unref();
      // Cancellation must not wait for stdin or a blocked transport write.
      void send({ type: 'cancel' }).catch(() => {});
      try { await c.done.catch(() => {}); } finally { clearTimeout(timer); }
    })()
  };
}
async function rpc(launch: Launch, runtime: RuntimeRef, args: Record<string, unknown>): Promise<unknown> {
  const c = await channel(launch, runtime, { op: 'rpc', ...args });
  return c.done;
}
function manifest(value: unknown, policy: SyncPolicy): Manifest {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'REMOTE_PROTOCOL', 'Invalid source manifest');
  const entries = Object.entries(value);
  invariant(entries.length <= policy.maxFiles, 'REMOTE_PROTOCOL', 'Remote file count exceeds policy');
  for (const [, item] of entries) {
    invariant(item && typeof item === 'object' && typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash) && Number.isInteger(item.mode) && Number.isInteger(item.size) && item.size >= 0 && item.size <= policy.maxFileBytes, 'REMOTE_PROTOCOL', 'Malformed file metadata');
  }
  return value as Manifest;
}
// Weak identity scope survives recreated transports, not process exits or runtime replacement.
const scanCaches = new WeakMap<RuntimeRef, { binding: string; key: string; files: unknown }>();
export function fileTransport(launch: Launch, runtime: RuntimeRef): FileTransport {
  const identity = () => JSON.stringify([runtime.provider, runtime.id, runtime.projectId, runtime.root, runtime.meta.workspaceGeneration]);
  return {
    get hashIdentity() { return identity(); },
    invalidateHashes: () => { scanCaches.delete(runtime); },
    download: async (path: string, policy: SyncPolicy, consume: (data: Buffer) => Promise<void>, artifact = false) => {
      safeRelative(path);
      invariant(Buffer.byteLength(path) <= 4096 && typeof artifact === 'boolean', 'UNSAFE_PATH', 'Invalid file stream path');
      invariant(Array.isArray(policy.excludes) && policy.excludes.every(validSyncPattern) && Number.isSafeInteger(policy.maxFiles) && policy.maxFiles > 0 && Number.isSafeInteger(policy.maxFileBytes) && policy.maxFileBytes > 0, 'CONFIG', 'Invalid file stream policy');
      invariant(artifact ? validArtifactPath(path) && policy.maxFileBytes <= 32 * 1024 * 1024 && !excluded(path.split('/').slice(1).join('/'), policy) : !excluded(path, policy), 'UNSAFE_PATH', 'Excluded file stream path or invalid artifact limit');
      let state: 'start' | 'chunks' | 'result' | 'done' = 'start';
      let sequence = 0, bytes = 0, size = 0, mode = 0;
      const hash = createHash('sha256');
      let entry: FileEntry | undefined;
      const c = await channel(launch, runtime, { op: 'file_stream', action: 'read_stream', path, policy, artifact }, async (packet, raw) => {
        invariant(packet.path === path, 'REMOTE_PROTOCOL', 'File stream path mismatch');
        const fields = (...keys: string[]) => invariant(Object.keys(packet).length === keys.length && keys.every(key => Object.hasOwn(packet, key)), 'REMOTE_PROTOCOL', 'Malformed file stream frame');
        if (state === 'start' && packet.type === 'file_start') {
          fields('type', 'path', 'size', 'mode');
          invariant(Number.isSafeInteger(packet.size) && Number(packet.size) >= 0 && Number(packet.size) <= policy.maxFileBytes && Number.isInteger(packet.mode) && Number(packet.mode) >= 0 && Number(packet.mode) <= 0o777, 'REMOTE_PROTOCOL', 'Invalid file stream metadata');
          size = Number(packet.size); mode = Number(packet.mode); state = 'chunks';
        } else if (state === 'chunks' && packet.type === 'file_chunk') {
          fields('type', 'path', 'seq', 'data');
          invariant(packet.seq === sequence && typeof packet.data === 'string' && packet.data.length > 0 && packet.data.length <= 87384, 'REMOTE_PROTOCOL', 'Invalid file stream chunk');
          const data = Buffer.from(packet.data, 'base64');
          invariant(data.length === Math.min(65536, size - bytes) && data.length > 0 && data.toString('base64') === packet.data, 'REMOTE_PROTOCOL', 'Noncanonical or oversized file stream chunk');
          bytes += data.length; hash.update(data);
          await consume(data);
          await raw.write(Buffer.from(JSON.stringify({ type: 'file_ack', path, seq: sequence++ }) + '\n'));
        } else if (state === 'chunks' && packet.type === 'file_end') {
          fields('type', 'path', 'seq', 'hash', 'size', 'mode');
          invariant(packet.seq === sequence && bytes === size && packet.size === size && packet.mode === mode && typeof packet.hash === 'string' && /^[a-f0-9]{64}$/.test(packet.hash) && packet.hash === hash.digest('hex'), 'REMOTE_PROTOCOL', 'Unverified file stream end');
          entry = { hash: packet.hash, size, mode }; state = 'result';
        } else if (state === 'result' && packet.type === 'file_result') {
          fields('type', 'path', 'ok');
          invariant(packet.ok === true, 'REMOTE_PROTOCOL', 'File stream was not confirmed');
          state = 'done'; return entry;
        } else throw new RerouteError('REMOTE_PROTOCOL', 'Unexpected file stream frame order');
        return undefined;
      });
      return c.done as Promise<FileEntry>;
    },
    readArtifact: async (path, maxFileBytes) => {
      invariant(validArtifactPath(path) && Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 && maxFileBytes <= 32 * 1024 * 1024, 'ARTIFACT_PATH', 'Invalid artifact path or limit');
      const policy = { excludes: [], maxFiles: 1, maxFileBytes };
      const result = await rpc(launch, runtime, { action: 'artifact', path, policy });
      manifest({ [path]: result }, policy);
      invariant(result && typeof (result as { data?: unknown }).data === 'string', 'REMOTE_PROTOCOL', 'Invalid artifact response');
      return result as import('../core/contracts.js').FileEntry & { data: string };
    },
    scan: async policy => {
      if (policy.hashMode !== 'metadata') { scanCaches.delete(runtime); return manifest(await rpc(launch, runtime, { action: 'scan', policy }), policy); }
      const binding = identity();
      let cache = scanCaches.get(runtime);
      if (!cache || cache.binding !== binding) cache = { binding, key: randomBytes(32).toString('hex'), files: {} };
      try {
        const result = await rpc(launch, runtime, { action: 'scan_cached', policy, cache: { key: cache.key, files: cache.files } }) as { manifest?: unknown; cache?: unknown };
        const files = manifest(result?.manifest, policy);
        invariant(result.cache && typeof result.cache === 'object' && !Array.isArray(result.cache) && Object.keys(result.cache).length <= policy.maxFiles, 'REMOTE_PROTOCOL', 'Invalid scan cache response');
        cache.files = result.cache; scanCaches.set(runtime, cache); return files;
      } catch (error) { scanCaches.delete(runtime); throw error; }
    },
    read: async (paths, policy) => {
      const result = await rpc(launch, runtime, { action: 'read', paths, policy });
      invariant(result && typeof result === 'object' && !Array.isArray(result), 'REMOTE_PROTOCOL', 'Invalid file response');
      const obj = result as Record<string, unknown>;
      invariant(paths.every(path => typeof obj[path] === 'string') && Object.keys(obj).every(p => paths.includes(p)), 'REMOTE_PROTOCOL', 'Unexpected file response');
      return obj as Record<string, string>;
    },
    apply: async (changes: FileChange[], policy) => {
      const result = await rpc(launch, runtime, { action: 'apply', changes, policy }) as { ok?: unknown };
      invariant(result?.ok === true, 'REMOTE_PROTOCOL', 'Remote write was not confirmed');
    }
  };
}
