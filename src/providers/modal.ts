import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { feedInput, hash } from '../util.js';
import { credentialsFor } from '../auth.js';
import { TOOLCHAIN_IMAGE, TOOLCHAIN_BASE, TOOLCHAIN_COMMANDS } from '../toolchain.js';
import type { Profile, Provider, ExecOptions, ExecResult, ManagedRequest } from '../types.js';
export class ModalProvider implements Provider {
  readonly stdin = true;
  private client?: import('modal').ModalClient;
  private sandbox?: import('modal').Sandbox;
  constructor(readonly profile: Profile, private readonly load = () => import('modal')) {}
  private async api(): Promise<import('modal').ModalClient> {
    if (!this.client) {
      const secrets = await credentialsFor('modal', this.profile.credential);
      this.client = new (await this.load()).ModalClient({ timeoutMs: 15000, maxRetries: 0,
        ...(secrets.MODAL_TOKEN_ID && secrets.MODAL_TOKEN_SECRET ? { tokenId: secrets.MODAL_TOKEN_ID, tokenSecret: secrets.MODAL_TOKEN_SECRET } : {}) });
    }
    return this.client;
  }
  private async lookup(): Promise<import('modal').Sandbox> {
    const sb = this.sandbox ??= await (await this.api()).sandboxes.fromId(this.profile.id);
    if (this.profile.owner) {
      const tags = await sb.getTags();
      if (tags['reroute-owner'] !== this.profile.owner || tags['reroute-managed'] !== 'v3') throw new Error('Modal ownership mismatch; resource retained untouched');
    }
    return sb;
  }
  async ensureManaged(request: ManagedRequest): Promise<Profile> {
    if (!this.profile.managed || !this.profile.compute || !this.profile.image) throw new Error('Incomplete managed Modal configuration');
    if (request.start && !this.profile.managed.authorized) throw new Error('Modal spending not authorized');
    const api = await this.api();
    const mayCreate = request.create || (request.start && request.replaceStopped === true);
    const appName = this.profile.app ?? 'rr-' + request.owner;
    const app = await api.apps.fromName(appName, { createIfMissing: mayCreate });
    const tags = { 'reroute-managed': 'v3', 'reroute-owner': request.owner, 'reroute-name': request.name,
      'reroute-compute': hash(JSON.stringify(this.profile.compute) + '\0' + this.profile.image) };
    const found = [];
    for await (const sb of api.sandboxes.list({ appId: app.appId, tags })) found.push(sb);
    if (found.length > 1) throw new Error('Multiple owned Modal allocations match; manual inspection required');
    let sb = found[0];
    if (!sb && this.profile.id !== 'auto') {
      const previous = await api.sandboxes.fromId(this.profile.id);
      const previousTags = await previous.getTags();
      if (Object.entries(tags).some(([key, value]) => previousTags[key] !== value)) throw new Error('Modal ownership/specification mismatch');
      const stopped = await previous.poll() !== null;
      if (!request.start) sb = previous;
      else if (!stopped) throw new Error('Modal listing did not confirm the known running allocation; no replacement created');
      else if (!mayCreate) throw new Error('Prior Modal allocation is stopped. Recover its state before authorizing a replacement');
    }
    if (sb) {
      const observed = await sb.getTags();
      if (Object.entries(tags).some(([key, value]) => observed[key] !== value)) throw new Error('Modal ownership/specification mismatch');
      if (request.start && !Number.isFinite(Number(observed['reroute-expires-at']))) throw new Error('Modal resource lifetime is unconfirmed; no task launched');
      if (request.start && Number(observed['reroute-expires-at']) < Date.now() + request.guardMinutes * 60000) {
        if (!request.replaceStopped) throw new Error('Modal remaining lifetime is insufficient; no task launched. Recover/stop before replacement');
        await sb.terminate({ wait: true });
        sb = undefined;
      }
    }
    if (!sb) {
      if (!mayCreate) throw new Error('Modal allocation unconfirmed; no creation retry performed');
      const volume = await api.volumes.fromName('rr-cache-' + request.owner, { createIfMissing: true });
      const base = api.images.fromRegistry(this.profile.image === TOOLCHAIN_IMAGE ? TOOLCHAIN_BASE : this.profile.image);
      const image = this.profile.image === TOOLCHAIN_IMAGE ? base.dockerfileCommands(TOOLCHAIN_COMMANDS) : base;
      sb = await api.sandboxes.create(app, image, { name: request.name,
        tags: { ...tags, 'reroute-expires-at': String(Date.now() + request.guardMinutes * 60000) },
        cpu: this.profile.compute.cpu, cpuLimit: this.profile.compute.cpu,
        memoryMiB: this.profile.compute.memoryGiB * 1024, memoryLimitMiB: this.profile.compute.memoryGiB * 1024,
        timeoutMs: request.guardMinutes * 60000,
        // No short idle timer: platform exec-idle semantics must not kill a quiet build.
        volumes: { '/var/reroute-cache': volume } });
    }
    this.sandbox = sb;
    Object.assign(this.profile, { id: sb.sandboxId, app: appName, owner: request.owner, cacheVolume: '/var/reroute-cache' });
    return { ...this.profile };
  }
  async guard(minutes: number): Promise<void> {
    const tags = await (await this.lookup()).getTags();
    if (!Number.isFinite(Number(tags['reroute-expires-at'])) || Number(tags['reroute-expires-at']) < Date.now() + minutes * 60000) throw new Error('Modal lifetime cannot be extended; task not launched. Stop/recreate this owned resource first');
  }
  async idle(_minutes: number): Promise<void> {
    // Modal has no high-level lifetime extension API: release confirmed jobs immediately.
    await (await this.lookup()).terminate({ wait: true });
  }
  async status(): Promise<string> { return await (await this.lookup()).poll() === null ? 'running' : 'stopped'; }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const sb = await this.lookup();
    if (await sb.poll() !== null) throw new Error('Modal sandbox is stopped; use explicit snapshot resume');
    // Login profiles can discard toolchain paths inherited from the image.
    const proc = await sb.exec(['bash', '-c', command], { mode: 'binary', timeoutMs: Math.ceil((options.timeoutMs ?? 120000) / 1000) * 1000 });
    let stdout = '', stderr = '', stdoutTruncated = false, stderrTruncated = false;
    const drain = async (stream: ReadableStream<Uint8Array>, target: 'stdout' | 'stderr') => {
      const reader = stream.getReader(), decoder = new StringDecoder('utf8');
      try { for (;;) { options.signal?.throwIfAborted(); const {done,value} = await reader.read(); if (done) break; const b = Buffer.from(value!), text = decoder.write(b); if (target === 'stdout') { stdoutTruncated ||= stdout.length + text.length > 1024 * 1024; stdout = (stdout + text).slice(-1024 * 1024); } else { stderrTruncated ||= stderr.length + text.length > 1024 * 1024; stderr = (stderr + text).slice(-1024 * 1024); } options[target]?.(b); } }
      finally { const tail = decoder.end(); if (target === 'stdout') stdout = (stdout + tail).slice(-1024 * 1024); else stderr = (stderr + tail).slice(-1024 * 1024); reader.releaseLock(); }
    };
    const writer = proc.stdin.getWriter();
    const input = options.stdin ? feedInput(options.stdin, chunk => writer.write(chunk), () => writer.close()) : undefined;
    const eof = input ? input.done.then(() => new Promise<never>(()=>{})) : writer.close().then(() => new Promise<never>(()=>{}));
    try { const [code] = await Promise.all([Promise.race([proc.wait(), eof]), drain(proc.stdout, 'stdout'), drain(proc.stderr, 'stderr')]); return { code, stdout, stderr, stdoutTruncated, stderrTruncated }; }
    finally { input?.stop(); writer.releaseLock(); }
  }
  async put(local: string, remote: string): Promise<void> { await (await this.lookup()).filesystem.copyFromLocal(local, remote); }
  async get(remote: string, local: string): Promise<void> { await (await this.lookup()).filesystem.copyToLocal(remote, local); }
  async lifecycle(action: 'stop' | 'resume' | 'destroy', checkpoint?: (patch: Partial<Profile>) => Promise<void>): Promise<Partial<Profile> | void> {
    const api = await this.api();
    if (action === 'resume') {
      if (this.profile.managed) throw new Error('Managed Modal starts on the next authorized task; compute is recreated, not resumed in place');
      if (this.profile.pendingResume) throw new Error('Previous Modal resume is unconfirmed. Find ' + this.profile.pendingResume + ' in the provider and attach its ID; no creation retry performed');
      if (!checkpoint) throw new Error('Modal resume needs a durable checkpoint before creating compute');
      if (!this.profile.snapshot || !this.profile.app) throw new Error('Modal resume requires a saved filesystem snapshot and the existing app name');
      if (await (await this.lookup()).poll() === null) throw new Error('Old Modal sandbox is still running; no duplicate compute created');
      const app = await api.apps.fromName(this.profile.app, { createIfMissing: false });
      const image = await api.images.fromId(this.profile.snapshot);
      const name = 'rr-resume-' + randomUUID();
      await checkpoint({ pendingResume: name });
      const sb = await api.sandboxes.create(app, image, { timeoutMs: 3600000, name });
      this.sandbox = sb;
      const patch = { id: sb.sandboxId, snapshot: undefined, pendingResume: undefined };
      await checkpoint(patch);
      return patch;
    }
    const sb = await this.lookup();
    if (action === 'stop' && !this.profile.managed) {
      if (!checkpoint || !this.profile.app) throw new Error('Set the existing Modal app name before stopping; snapshot must be saved before termination');
      const image = await sb.snapshotFilesystem({ timeoutMs: 55000 });
      const patch = { snapshot: image.imageId };
      await checkpoint(patch);
      await sb.terminate({ wait: true });
      return patch;
    }
    await sb.terminate({ wait: true });
  }
  async close(): Promise<void> { this.sandbox?.detach(); this.client?.close(); }
}
