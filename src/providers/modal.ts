import { Readable } from 'node:stream';
import type { Profile, Provider, ExecOptions, ExecResult } from '../types.js';
export class ModalProvider implements Provider {
  readonly stdin = true;
  private client?: import('modal').ModalClient;
  private sandbox?: import('modal').Sandbox;
  constructor(readonly profile: Profile, private readonly load = () => import('modal')) {}
  private async api(): Promise<import('modal').ModalClient> { return this.client ??= new (await this.load()).ModalClient({ timeoutMs: 15000, maxRetries: 0 }); }
  private async lookup(): Promise<import('modal').Sandbox> { return this.sandbox ??= await (await this.api()).sandboxes.fromId(this.profile.id); }
  async status(): Promise<string> { return await (await this.lookup()).poll() === null ? 'running' : 'stopped'; }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    options.signal?.throwIfAborted();
    const sb = await this.lookup();
    if (await sb.poll() !== null) throw new Error('Modal sandbox is stopped; use explicit snapshot resume');
    const proc = await sb.exec(['bash', '-lc', command], { mode: 'binary', timeoutMs: options.timeoutMs ?? 120000 });
    let stdout = '', stderr = '';
    const drain = async (stream: ReadableStream<Uint8Array>, target: 'stdout' | 'stderr') => {
      const reader = stream.getReader();
      try { for (;;) { options.signal?.throwIfAborted(); const {done,value} = await reader.read(); if (done) break; const b = Buffer.from(value!); if (target === 'stdout') stdout = (stdout + b.toString()).slice(-1024 * 1024); else stderr = (stderr + b.toString()).slice(-1024 * 1024); options[target]?.(b); } }
      finally { reader.releaseLock(); }
    };
    const input = options.stdin ? Readable.toWeb(options.stdin as Readable).pipeTo(proc.stdin) : proc.stdin.close();
    const [code] = await Promise.all([proc.wait(), drain(proc.stdout, 'stdout'), drain(proc.stderr, 'stderr'), input]);
    return { code, stdout, stderr };
  }
  async put(local: string, remote: string): Promise<void> { await (await this.lookup()).filesystem.copyFromLocal(local, remote); }
  async get(remote: string, local: string): Promise<void> { await (await this.lookup()).filesystem.copyToLocal(remote, local); }
  async lifecycle(action: 'stop' | 'resume' | 'destroy', checkpoint?: (patch: Partial<Profile>) => Promise<void>): Promise<Partial<Profile> | void> {
    const api = await this.api();
    if (action === 'resume') {
      if (!this.profile.snapshot || !this.profile.app) throw new Error('Modal resume requires a saved filesystem snapshot and the existing app name');
      const app = await api.apps.fromName(this.profile.app, { createIfMissing: false });
      const image = await api.images.fromId(this.profile.snapshot);
      const sb = await api.sandboxes.create(app, image, { timeoutMs: 3600000 });
      this.sandbox = sb;
      return { id: sb.sandboxId, snapshot: undefined };
    }
    const sb = await this.lookup();
    if (action === 'stop') {
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
