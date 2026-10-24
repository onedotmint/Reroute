import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGzip } from 'node:zlib';
import { readFile, writeFile, mkdtemp, rm, mkdir, link, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { Compute, Config, ExecOptions, ExecResult, Job, JobStatus, Profile, Provider, Snapshot } from './types.js';
import { withManagedResource, managedAction } from './resources.js';
import { activeProfile, getJob, listJobs, loadConfig, loadUserConfig, requireProjectAuthorization, saveConfig, saveJob } from './config.js';
import { hash, inside, noSymlink, requireSuccess, safeRelative, shell } from './util.js';
import { snapshot } from './snapshot.js';
import { nodePreparation } from './prepare.js';
import { createProvider } from './providers/index.js';
export { ruleRouter } from './router.js';
export { loadConfig } from './config.js';

const terminal = (status: string) => ['exited','cancelled','timed_out','failed'].includes(status);
let helperSource: Promise<string> | undefined;
export async function helperCommand(action: string, data: Record<string, unknown>): Promise<string> {
  helperSource ??= readFile(new URL('../assets/task.py', import.meta.url), 'utf8');
  return shell(['python3', '-c', await helperSource, action, Buffer.from(JSON.stringify(data)).toString('base64')]);
}
type CacheMetrics = Pick<NonNullable<Job['metrics']>, 'executionMs' | 'cacheHit' | 'cacheSaved' | 'cacheRestoreMs' | 'cacheSaveMs' | 'remoteStageMs' | 'remoteUnpackMs' | 'remoteVerifyMs' | 'remotePrepareMs' | 'cleanupMs' | 'cacheRestoreBytes' | 'cacheSaveBytes'>;
type Receipt = { status: JobStatus; code?: number; error?: string; metrics?: CacheMetrics; cacheWarning?: string };
function parseReceipt(value: unknown): Receipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote receipt; state not confirmed');
  const { status, code, error, metrics, cacheWarning } = value as Record<string, unknown>;
  if (typeof status !== 'string' || !['preparing','running','exited','cancelled','timed_out','failed','unknown'].includes(status)
    || (error !== undefined && typeof error !== 'string')
    || (code !== undefined && (!Number.isSafeInteger(code) || (code as number) < 0 || (code as number) > 255))
    || (terminal(status) && code === undefined) || (['preparing','running'].includes(status) && code !== undefined)) throw new Error('Invalid remote receipt; state not confirmed');
  const receipt: Receipt = { status: status as JobStatus, ...(code === undefined ? {} : { code: code as number }), ...(error === undefined ? {} : { error: (error as string).slice(-8192) }) };
  if (metrics && typeof metrics === 'object' && !Array.isArray(metrics)) {
    receipt.metrics = {};
    for (const name of ['executionMs','cacheRestoreMs','cacheSaveMs','remoteStageMs','remoteUnpackMs','remoteVerifyMs','remotePrepareMs','cleanupMs','cacheRestoreBytes','cacheSaveBytes'] as const) {
      const n = (metrics as Record<string, unknown>)[name];
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) receipt.metrics[name] = n;
    }
    for (const name of ['cacheHit', 'cacheSaved'] as const) {
      const flag = (metrics as Record<string, unknown>)[name];
      if (typeof flag === 'boolean') receipt.metrics[name] = flag;
    }
  }
  if (typeof cacheWarning === 'string') receipt.cacheWarning = cacheWarning.slice(-8192);
  return receipt;
}
function applyReceipt(job: Job, receipt: Receipt): void {
  const { metrics, ...state } = receipt;
  Object.assign(job, state);
  if (job.metrics && metrics) Object.assign(job.metrics, metrics);
}
async function control<T>(provider: Provider, action: string, job: Pick<Job, 'root' | 'id'>, extra: Record<string,unknown> = {}, options: ExecOptions = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const command = await helperCommand(action, { root: job.root, id: job.id, ...extra });
  options.signal?.throwIfAborted();
  const r = await requireSuccess(provider.exec(command, { timeoutMs: action === 'cancel' ? 15000 : 120000, ...options }));
  if (r.stdoutTruncated) throw new Error(`Truncated remote ${action} response; state not confirmed`);
  try { const value: unknown = JSON.parse(r.stdout); return (['status','cancel','abort-prepare'].includes(action) ? parseReceipt(value) : value) as T; } catch { throw new Error(`Invalid or truncated remote ${action} response; state not confirmed`); }
}
export interface RunOptions extends ExecOptions {
  cwd: string;
  config?: Config;
  root?: string;
  provider?: Provider; // dependency injection for component contracts, never a production fallback
  compute?: Partial<Compute>;
  onJob?: (job: Job) => void;
  onProgress?: (progress: { stage: string; message: string }) => void;
}
export interface RunResult extends ExecResult { job: Job }

function progress(options: RunOptions, stage: string, message: string): void {
  // UI observers must not interrupt ownership, cancellation or receipt handling.
  try { options.onProgress?.({ stage, message }); } catch {}
}

async function packInput(input: Snapshot, names: string[], archive: string, signal?: AbortSignal) {
  const digest = createHash('sha256');
  async function* payload() {
    for (const name of names) {
      signal?.throwIfAborted();
      for await (const chunk of createReadStream(join(input.dir, name))) yield chunk;
    }
  }
  // A manifest-indexed gzip stream: no archive paths, links or executable metadata to trust.
  await pipeline(Readable.from(payload()), createGzip(), createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
  for await (const chunk of createReadStream(archive)) digest.update(chunk);
  return { bytes: (await stat(archive)).size, sha256: digest.digest('hex') };
}

function remoteProgress(options: RunOptions, token: string, notify: (stage: string, message: string) => void) {
  const messages = { 'cache-restore': 'Restoring remote download cache', execute: 'Executing remote command', cleanup: 'Confirming descendant termination and archiving task work', 'cache-save': 'Saving remote download cache' };
  const frames = Object.entries(messages).map(([stage, message]) => ({ stage, message, bytes: Buffer.from(`\x1eREROUTE_PROGRESS:${token}:${stage}\x1f`) }));
  const decoder = new StringDecoder('utf8');
  let captured = '', observed = false;
  const emit = (bytes: Buffer) => {
    if (bytes.length) { captured = (captured + decoder.write(bytes)).slice(-1024 * 1024); options.stderr?.(bytes); }
  };
  let pending: Buffer = Buffer.alloc(0);
  return {
    stderr(chunk: Buffer) {
      observed = true;
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        let match: typeof frames[number] | undefined, position = pending.length;
        for (const frame of frames) { const at = pending.indexOf(frame.bytes); if (at >= 0 && at < position) { match = frame; position = at; } }
        if (match) {
          emit(pending.subarray(0, position));
          notify(match.stage, match.message);
          pending = pending.subarray(position + match.bytes.length);
          continue;
        }
        // Keep only a possible split-frame prefix; all unrelated bytes pass through unchanged.
        let keep = pending.length;
        const max = Math.max(...frames.map(frame => frame.bytes.length));
        for (let at = Math.max(0, pending.length - max + 1); at < pending.length; at++) {
          const suffix = pending.subarray(at);
          if (frames.some(frame => suffix.equals(frame.bytes.subarray(0, suffix.length)))) { keep = at; break; }
        }
        emit(pending.subarray(0, keep)); pending = pending.subarray(keep); break;
      }
    },
    finish() { emit(pending); pending = Buffer.alloc(0); captured = (captured + decoder.end()).slice(-1024 * 1024); },
    output(stderr: string) {
      if (observed) return captured;
      for (const frame of frames) stderr = stderr.split(frame.bytes.toString()).join('');
      return stderr;
    },
  };
}

export async function runRemote(command: string, options: RunOptions): Promise<RunResult> {
  options.signal?.throwIfAborted();
  const loaded = options.config && options.root ? { config: options.config, root: options.root } : await loadConfig(options.cwd);
  const config = loaded.config;
  if (!config) throw new Error('No Reroute configuration. Run reroute setup once for user defaults.');
  const root = await realpath(loaded.root), cwd = await realpath(options.cwd);
  if (!inside(root, cwd)) throw new Error('Working directory is outside the configured project');
  await requireProjectAuthorization(root, config);
  if (options.compute && !activeProfile(config).managed) throw new Error('Per-task sizing needs managed cloud compute; no resource resized');
  const profile = { ...activeProfile(config) }, provider = options.provider ?? createProvider(profile);
  if (options.stdin && !provider.stdin) throw new Error(`${profile.provider} does not support stdin/EOF; no task started`);
  const timeoutSeconds = options.timeoutMs === undefined ? config.timeoutSeconds : options.timeoutMs / 1000;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 86400) throw new Error('Task timeout must be in (0, 86400] seconds');
  // Verify source before provisioning, and reuse this single snapshot for the actual task.
  progress(options, 'snapshot', 'Scanning and verifying source snapshot');
  // Effective overrides must not erase a user's explicitly private identity paths.
  const identityProfiles = [...Object.values((await loadUserConfig())?.profiles ?? {}), ...Object.values(config.profiles)];
  const input = await snapshot(root, { signal: options.signal, privatePaths: identityProfiles.flatMap(p => p.identityFile ? [resolve(p.identityFile.replace(/^~(?=\/)/, homedir()))] : []) });
  try {
    if (profile.managed && !options.provider) {
      const result = await withManagedResource(root, config, command, options, (resolved, remote) =>
        executePrepared(command, { ...options, root, cwd, config: { ...config, profiles: { ...config.profiles, [config.active]: resolved } } }, input, remote));
      await saveJob(result.job);
      return result;
    }
    try { return await executePrepared(command, { ...options, root, cwd, config }, input, provider); }
    finally { await provider.close?.(); }
  } finally { await input.cleanup(); }
}
async function executePrepared(command: string, options: RunOptions & { root: string; config: Config }, input: Snapshot, provider: Provider): Promise<RunResult> {
  const { root, cwd, config } = options, profile = { ...activeProfile(config) };
  const job: Job = { id: randomUUID(), project: root, profile, root: `${profile.root ?? '/tmp/reroute-v3'}/p-${hash(root + '\0' + config.active + '\0' + profile.provider).slice(0,32)}`, command,
    cwd: relative(root, cwd).split('\\').join('/') || '.', createdAt: new Date().toISOString(), status: 'preparing' };
  const timeoutSeconds = options.timeoutMs === undefined ? config.timeoutSeconds : options.timeoutMs / 1000;
  let owned = false, inFlight = false, started = false, stage = 'remote-prepare';
  const notify = (next: string, message: string) => { stage = next; progress(options, next, message); };
  const controlDir = await mkdtemp(join(tmpdir(), 'reroute-request-'));
  try {
    job.metrics = { inputBytes: input.bytes, inputMs: input.milliseconds, transferredBytes: 0, transferMs: 0, cacheKey: '', packMs: 0, archiveBytes: 0, uploadMs: 0, uploadedBytes: 0, uploadFiles: 0 };
    await saveJob(job); options.onJob?.(job);
    notify('remote-prepare', 'Checking remote workspace and acquiring task lock');
    const prepareStart = performance.now();
    if (await provider.status() !== 'running') throw new Error(`${profile.provider} is not running; use explicit resource resume (no automatic paid resume)`);
    options.signal?.throwIfAborted();
    await control(provider, 'boot', job);
    inFlight = true;
    await control(provider, 'acquire', job); owned = true; inFlight = false;
    job.metrics.prepareMs = performance.now() - prepareStart;
    const cacheKey = hash(input.cacheKey + '\0' + profile.provider + (profile.image ? '\0' + profile.image : ''));
    const requestFile = join(controlDir, 'request.json');
    await writeFile(requestFile, JSON.stringify({ files: input.files, command, cwd: job.cwd, timeoutSeconds, cacheKey, persistentCache: profile.cacheVolume, prepare: await nodePreparation(input.dir,job.cwd,command) }), { mode: 0o600 });
    const transferStart = performance.now();
    inFlight = true;
    notify('upload', 'Uploading verified input manifest');
    const requestStart = performance.now();
    await provider.put(requestFile, `${job.root}/jobs/${job.id}/request.json`);
    job.metrics.requestUploadMs = performance.now() - requestStart;
    job.metrics.requestBytes = (await stat(requestFile)).size;
    const stageStart = performance.now();
    const plan = await control<{needed: string[]; metrics?: CacheMetrics}>(provider, 'stage', job);
    job.metrics.prepareMs += performance.now() - stageStart;
    Object.assign(job.metrics, parseReceipt({ status: 'preparing', metrics: plan.metrics }).metrics);
    let transferredBytes = 0, archive;
    if (provider.sync) {
      const uploadStart = performance.now();
      transferredBytes = await provider.sync(input.dir, `${job.root}/input`);
      job.metrics.uploadMs = performance.now() - uploadStart;
      // rsync reports literal file data; protocol overhead is not measured.
      job.metrics.uploadedBytes = transferredBytes;
    } else {
      if (!Array.isArray(plan.needed) || new Set(plan.needed).size !== plan.needed.length) throw new Error('Invalid remote transfer plan');
      const entries = new Map(input.files.map(f => [f.path, f]));
      for (const name of plan.needed) {
        safeRelative(name); const entry = entries.get(name);
        if (!entry) throw new Error('Remote requested a file outside the verified snapshot');
        transferredBytes += entry.size;
      }
      if (plan.needed.length) {
        options.signal?.throwIfAborted();
        notify('pack', `Packing ${plan.needed.length} changed source files`);
        const packStart = performance.now(), path = join(controlDir, 'input.gz');
        archive = await packInput(input, plan.needed, path, options.signal);
        job.metrics.packMs = performance.now() - packStart;
        job.metrics.archiveBytes = archive.bytes;
        notify('upload', `Uploading one input archive (${archive.bytes} bytes)`);
        const uploadStart = performance.now();
        await provider.put(path, `${job.root}/jobs/${job.id}/input.gz`);
        job.metrics.uploadMs = performance.now() - uploadStart;
        job.metrics.uploadedBytes = archive.bytes;
        job.metrics.uploadFiles = plan.needed.length;
      }
    }
    notify('verify', 'Remote unpack, checksum verification and isolated work preparation');
    const sealStart = performance.now();
    const sealed = await control<{metrics?: CacheMetrics}>(provider, 'seal', job, archive ? { archive } : {});
    job.metrics.sealMs = performance.now() - sealStart;
    Object.assign(job.metrics, parseReceipt({ status: 'preparing', metrics: sealed.metrics }).metrics);
    inFlight = false;
    if (profile.managed) await provider.guard?.(Math.ceil(timeoutSeconds / 60) + 5);
    Object.assign(job.metrics, { transferredBytes, transferMs: performance.now() - transferStart, cacheKey });
    if (options.signal?.aborted) {
      applyReceipt(job, await control<Receipt>(provider, 'abort-prepare', job));
      await saveJob(job); return { code: 130, stdout: '', stderr: '', job };
    }
    job.status = 'running'; await saveJob(job); started = true;
    const connection = new AbortController();
    let abortHandler: (() => void) | undefined;
    const cancelled = new Promise<{ interrupted: Receipt }>(resolveCancel => {
      abortHandler = () => {
        void (async () => {
          let receipt: Receipt;
          try { receipt = await control<Receipt>(provider, 'cancel', job); }
          catch (error) { receipt = { status: 'unknown', error: `Cancellation unconfirmed: ${String(error)}` }; }
          connection.abort(); resolveCancel({ interrupted: receipt });
        })();
      };
      options.signal?.addEventListener('abort', abortHandler, { once: true });
    });
    notify('remote-run', 'Starting remote supervisor');
    const progressToken = options.onProgress ? randomUUID().replaceAll('-', '') : undefined;
    const phases = progressToken ? remoteProgress(options, progressToken, notify) : undefined;
    const execute = provider.exec(await helperCommand('run', { root: job.root, id: job.id, ...(progressToken ? { progressToken } : {}) }), {
      stdout: options.stdout ?? (() => {}), stderr: phases?.stderr ?? options.stderr ?? (() => {}), stdin: options.stdin,
      timeoutMs: timeoutSeconds * 1000 + (profile.cacheVolume ? 300000 : 20000), signal: connection.signal,
    }).then(result => { phases?.finish(); return { result: phases ? { ...result, stderr: phases.output(result.stderr) } : result }; }, error => { phases?.finish(); return { error }; });
    if (options.signal?.aborted) abortHandler?.();
    try {
      const outcome = await Promise.race([execute, cancelled]);
      let receipt: Receipt;
      try { receipt = 'interrupted' in outcome ? outcome.interrupted : await control<Receipt>(provider, 'status', job); }
      catch (error) { receipt = { status: 'unknown', error: `Remote state query failed: ${String(error)}` }; }
      job.status = receipt.status; applyReceipt(job, receipt);
      if (!terminal(job.status)) job.status = 'unknown';
      if ('error' in outcome) job.error = `Transport/output failed: ${String(outcome.error)}. Remote status: ${job.status}. Not retried locally.`;
      if ('result' in outcome && terminal(job.status) && outcome.result.code !== job.code) job.error = `Transport exit ${outcome.result.code} disagrees with remote receipt ${job.code}; output may be incomplete`;
      if ('interrupted' in outcome && terminal(job.status) && job.status !== 'cancelled') job.error = `Cancellation raced with ${job.status}; remote receipt retained, output delivery interrupted`;
      if (job.status === 'unknown') job.error ??= 'Remote process termination or completion is not confirmed. Inspect reroute status and the provider; do not rerun blindly.';
      if (job.error) job.error = `[${stage}] ${job.error}`;
      await saveJob(job);
      progress(options, 'complete', `Remote task ${job.status}`);
      return { code: job.error || job.status === 'unknown' ? 125 : job.code ?? 125,
        stdout: 'result' in outcome ? outcome.result.stdout : '', stderr: 'result' in outcome ? outcome.result.stderr : '', job };
    } finally { if (abortHandler) options.signal?.removeEventListener('abort', abortHandler); }
  } catch (error) {
    job.error = `[${stage}] ${String(error)}`;
    if (owned && !inFlight && !started) {
      try { applyReceipt(job, await control<Receipt>(provider, 'abort-prepare', job)); } catch { job.status = 'unknown'; }
    } else job.status = inFlight || started ? 'unknown' : 'failed';
    if (!owned && /BUSY:/.test(String(error))) job.status = 'failed';
    if (owned && inFlight) {
      try { const receipt = await control<Receipt>(provider, 'status', job); if (terminal(receipt.status)) applyReceipt(job, receipt); } catch {}
    }
    if (owned && inFlight && job.status === 'unknown') job.error += '. Input acknowledgement is uncertain; the remote lock is retained. Inspect the provider before manual recovery.';
    await saveJob(job);
    throw new Error(`${job.error} [job ${job.id}; ${job.status}; never retried locally]`, { cause: error });
  } finally { await rm(controlDir, { recursive: true, force: true }); }
}

export async function inspectJob(id: string, action: 'status' | 'cancel' = 'status', options: {
  project?: string; signal?: AbortSignal; provider?: Provider; onConfirmed?: (job: Job) => void;
} = {}): Promise<Job> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (action !== 'status' && action !== 'cancel') throw new Error('Invalid inspection action');
  let job: Job;
  try {
    job = await getJob(id);
    if (!job || job.id !== id) throw new Error('Job not found in this project');
    if (options.project !== undefined && await realpath(job.project) !== await realpath(options.project)) throw new Error('Job not found in this project');
  } catch (error) {
    if (options.project !== undefined) throw new Error('Job not found in this project');
    throw error;
  }
  signal?.throwIfAborted();
  const provider = options.provider ?? createProvider(job.profile);
  // A provider may ignore AbortSignal; race the query without letting its late result advance inspection.
  async function query<T>(operation: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        abort = () => reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { signal?.throwIfAborted(); return operation(); }).then(resolve, reject);
      });
    } finally { if (abort) signal?.removeEventListener('abort', abort); }
  }
  try {
    const state = await query(() => provider.status());
    signal?.throwIfAborted();
    if (state !== 'running') return { ...job, error: `Resource ${state}; no command, connect, or implicit resume performed. Last recorded state shown.` };
    // E2B connect may resume a concurrently paused sandbox; scoped read-only inspection must fail closed.
    if (options.project !== undefined && action === 'status' && job.profile.provider === 'e2b')
      return { ...job, error: 'E2B task verification unavailable: the existing connection API may resume a sandbox. No connection attempted. Last recorded state shown.' };
    const receipt = await query(() => control<unknown>(provider, action, job, {}, { signal }));
    signal?.throwIfAborted();
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Invalid remote receipt; state not confirmed');
    const { status, code, error } = receipt as Record<string, unknown>;
    if (typeof status !== 'string' || !['preparing','running','exited','cancelled','timed_out','failed','unknown'].includes(status)
      || (error !== undefined && typeof error !== 'string')
      || (code !== undefined && (!Number.isSafeInteger(code) || (code as number) < 0 || (code as number) > 255))
      || (terminal(status) && code === undefined)
      || (['preparing','running'].includes(status) && code !== undefined)) throw new Error('Invalid remote receipt; state not confirmed');
    delete job.code; delete job.error;
    job.status = status as JobStatus;
    if (code !== undefined) job.code = code as number;
    if (typeof error === 'string') job.error = error;
    const measured = parseReceipt(receipt);
    if (job.metrics && measured.metrics) Object.assign(job.metrics, measured.metrics);
    if (measured.cacheWarning) job.cacheWarning = measured.cacheWarning;
    if (status === 'unknown') job.error ??= 'Remote task state is not confirmed. Last query returned unknown; do not rerun blindly.';
    else options.onConfirmed?.(job);
    signal?.throwIfAborted();
    await saveJob(job);
    return job;
  } finally { await provider.close?.(); }
}
export async function downloadArtifact(id: string, path: string, destination: string): Promise<string> {
  const job = await getJob(id); safeRelative(path);
  const provider = createProvider(job.profile), dest = resolve(destination);
  await noSymlink(dest); await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  // Download beside the target and link atomically with no overwrite (same filesystem).
  const temp = await mkdtemp(join(dirname(dest), '.reroute-download-')), archive = join(temp, 'artifact.tgz');
  try {
    if (await provider.status() !== 'running') throw new Error('Resource is not running; downloading never resumes paid compute');
    const info = await control<{path: string; bytes: number; sha256: string}>(provider, 'artifact', job, {path});
    if (!info.path.startsWith(`${job.root}/jobs/${id}/artifact-`) || !/^artifact-[a-f0-9-]+\.tgz$/.test(info.path.slice(info.path.lastIndexOf('/')+1)) || !/^[a-f0-9]{64}$/.test(info.sha256) || !Number.isSafeInteger(info.bytes) || info.bytes < 0 || info.bytes > 256 * 1024 * 1024) throw new Error('Invalid artifact receipt');
    await provider.get(info.path, archive);
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of createReadStream(archive)) { bytes += chunk.length; digest.update(chunk); if (bytes > info.bytes) throw new Error('Oversized artifact download'); }
    if (bytes !== info.bytes || digest.digest('hex') !== info.sha256) throw new Error('Incomplete artifact download');
    await noSymlink(dest); await link(archive, dest);
    return dest;
  } finally { await rm(temp, { recursive: true, force: true }); await provider.close?.(); }
}
export async function cleanupJob(id: string): Promise<void> {
  const job = await getJob(id), provider = createProvider(job.profile);
  try { if (await provider.status() !== 'running') throw new Error('Resource not running; no implicit resume'); await control(provider, 'cleanup', job); }
  finally { await provider.close?.(); }
}
export async function resourceAction(root: string, config: Config, action: 'stop' | 'resume' | 'destroy' | 'recover'): Promise<void> {
  if (action === 'resume') await requireProjectAuthorization(root, config);
  if (activeProfile(config).managed) return managedAction(await realpath(root), config, action);
  if (action === 'recover') throw new Error('Resource recovery applies to managed cloud profiles only');
  const profile = activeProfile(config), provider = createProvider(profile), oldId = profile.id;
  if (action !== 'resume' && (await listJobs()).some(j => j.profile.provider === profile.provider && j.profile.credential === profile.credential && j.profile.id === oldId && ['preparing','running','unknown'].includes(j.status)))
    throw new Error('Resource has active or unresolved jobs; inspect/cancel them before stopping or destroying it');
  const checkpoint = async (patch: Partial<Profile>) => { Object.assign(profile, patch); await saveConfig(root, config); };
  try {
    const patch = await provider.lifecycle(action, checkpoint);
    if (patch) {
      await checkpoint(patch);
      if (patch.id && patch.id !== oldId) for (const job of await listJobs()) if (job.profile.provider === profile.provider && job.profile.credential === profile.credential && job.profile.id === oldId) { Object.assign(job.profile, patch); await saveJob(job); }
    }
  } finally { await provider.close?.(); }
}
