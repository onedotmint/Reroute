import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Profile, Provider, ExecOptions, ExecResult } from '../types.js';
export class E2BProvider implements Provider {
  readonly stdin = true;
  private sandbox?: import('e2b').Sandbox;
  constructor(readonly profile: Profile, private readonly load: () => Promise<Pick<typeof import('e2b'), 'Sandbox' | 'CommandExitError'>> = () => import('e2b')) {}
  async status(): Promise<string> { return (await (await this.load()).Sandbox.getInfo(this.profile.id, { requestTimeoutMs: 15000 })).state; }
  private async running(): Promise<import('e2b').Sandbox> {
    if (!this.sandbox) {
      if (await this.status() !== 'running') throw new Error('E2B is not running. Resume explicitly with reroute resource resume --yes --allow-cost');
      // connect can resume a sandbox; it is never called from status, stop, or destroy.
      this.sandbox = await (await this.load()).Sandbox.connect(this.profile.id, { requestTimeoutMs: 15000 });
    }
    return this.sandbox;
  }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const sdk = await this.load(), sb = await this.running(); let stdout = '', stderr = '';
    const handle = await sb.commands.run(command, { background: true, stdin: !!options.stdin, timeoutMs: options.timeoutMs ?? 120000, requestTimeoutMs: 15000, signal: options.signal,
      onStdout: s => { stdout = (stdout + s).slice(-1024 * 1024); options.stdout?.(Buffer.from(s)); },
      onStderr: s => { stderr = (stderr + s).slice(-1024 * 1024); options.stderr?.(Buffer.from(s)); } });
    const input = options.stdin ? (async () => { for await (const chunk of options.stdin!) await handle.sendStdin(chunk); await handle.closeStdin(); })() : Promise.resolve();
    try { const [result] = await Promise.all([handle.wait(), input]); return { code: result.exitCode, stdout, stderr }; }
    catch (e) { if (e instanceof sdk.CommandExitError) return { code: e.exitCode, stdout, stderr }; throw e; }
    finally { handle.disconnect(); }
  }
  async put(local: string, remote: string): Promise<void> { await (await this.running()).files.write(remote, Readable.toWeb(createReadStream(local)) as ReadableStream, { requestTimeoutMs: 120000 }); }
  async get(remote: string, local: string): Promise<void> { const stream = await (await this.running()).files.read(remote, { format: 'stream', requestTimeoutMs: 120000 }); await pipeline(Readable.fromWeb(stream as import('node:stream/web').ReadableStream<Uint8Array>), createWriteStream(local, { flags: 'wx', mode: 0o600 })); }
  async lifecycle(action: 'stop' | 'resume' | 'destroy'): Promise<void> {
    const { Sandbox } = await this.load();
    if (action === 'resume') { this.sandbox = await Sandbox.connect(this.profile.id, { requestTimeoutMs: 60000 }); return; }
    const result = action === 'stop' ? await Sandbox.pause(this.profile.id, { requestTimeoutMs: 60000 }) : await Sandbox.kill(this.profile.id, { requestTimeoutMs: 60000 });
    this.sandbox = undefined;
    if (!result && action === 'stop') throw new Error('E2B pause was not confirmed');
  }
}
