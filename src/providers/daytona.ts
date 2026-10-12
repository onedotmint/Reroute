import { randomUUID } from 'node:crypto';
import { credentialsFor } from '../auth.js';
import type { Profile, Provider, ExecOptions, ExecResult } from '../types.js';
export class DaytonaProvider implements Provider {
  readonly stdin = false;
  private client?: import('@daytona/sdk').Daytona;
  private sandbox?: import('@daytona/sdk').Sandbox;
  constructor(readonly profile: Profile, private readonly load = () => import('@daytona/sdk')) {}
  private async lookup(): Promise<import('@daytona/sdk').Sandbox> {
    if (!this.client) {
      const secrets = await credentialsFor('daytona');
      this.client = new (await this.load()).Daytona({ ...(secrets.DAYTONA_API_KEY ? { apiKey: secrets.DAYTONA_API_KEY } : {}) });
    }
    return this.client.get(this.profile.id);
  }
  async status(): Promise<string> { const state = (await this.lookup()).state; return state === 'started' ? 'running' : String(state); }
  private async running(): Promise<import('@daytona/sdk').Sandbox> {
    this.sandbox ??= await this.lookup();
    if (this.sandbox.state !== 'started') throw new Error('Daytona is not started. Resume explicitly with reroute resource resume --yes --allow-cost');
    return this.sandbox;
  }
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (options.stdin) throw new Error('Daytona stdin/EOF is not supported by this adapter');
    options.signal?.throwIfAborted();
    const sb = await this.running(), session = 'reroute-' + randomUUID(), seconds = Math.ceil((options.timeoutMs ?? 120000) / 1000);
    await sb.process.createSession(session);
    let completed = false, stdout = '', stderr = '';
    try {
      if (!options.stdout && !options.stderr) {
        const r = await sb.process.executeSessionCommand(session, { command, runAsync: false, suppressInputEcho: true }, seconds);
        if (typeof r.exitCode !== 'number') throw new Error('Daytona returned no confirmed exit code');
        completed = true; return { code: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
      const run = await sb.process.executeSessionCommand(session, { command, runAsync: true, suppressInputEcho: true }, seconds);
      if (!run.cmdId) throw new Error('Daytona returned no command ID');
      let streamError: unknown;
      const logs = sb.process.getSessionCommandLogs(session, run.cmdId,
        s => { stdout = (stdout + s).slice(-1024 * 1024); options.stdout?.(Buffer.from(s)); },
        s => { stderr = (stderr + s).slice(-1024 * 1024); options.stderr?.(Buffer.from(s)); }).catch(e => { streamError = e; });
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (streamError) throw streamError;
        const state = await sb.process.getSessionCommand(session, run.cmdId);
        if (typeof state.exitCode === 'number') {
          completed = true;
          await Promise.race([logs, new Promise<never>((_, reject) => { const t = setTimeout(() => reject(new Error('Daytona output drain timed out')), 10000); t.unref(); })]);
          if (streamError) throw streamError;
          return { code: state.exitCode, stdout, stderr };
        }
        await new Promise(r => setTimeout(r, 150));
      }
      throw new Error('Daytona execution status unknown after client deadline');
    } finally { if (completed) await sb.process.deleteSession(session); }
  }
  async put(local: string, remote: string): Promise<void> { await (await this.running()).fs.uploadFile(local, remote, 120); }
  async get(remote: string, local: string): Promise<void> { await (await this.running()).fs.downloadFile(remote, local, 120); }
  async lifecycle(action: 'stop' | 'resume' | 'destroy'): Promise<void> {
    const sb = await this.lookup();
    if (action === 'resume') await sb.start(120);
    else if (action === 'stop') await sb.stop(120);
    else await sb.delete(120, true);
    this.sandbox = undefined;
  }
}
