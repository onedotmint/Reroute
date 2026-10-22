import { randomUUID } from 'node:crypto';
import { credentialsFor } from '../auth.js';
import { TOOLCHAIN_IMAGE, TOOLCHAIN_BASE, TOOLCHAIN_COMMANDS } from '../toolchain.js';
import type { Profile, Provider, ExecOptions, ExecResult, ManagedRequest } from '../types.js';
export class DaytonaProvider implements Provider {
  readonly stdin = false;
  private client?: import('@daytona/sdk').Daytona;
  private sandbox?: import('@daytona/sdk').Sandbox;
  constructor(readonly profile: Profile, private readonly load = () => import('@daytona/sdk')) {}
  private async api(): Promise<import('@daytona/sdk').Daytona> {
    if (!this.client) {
      const secrets = await credentialsFor('daytona', this.profile.credential);
      this.client = new (await this.load()).Daytona({ requestTimeoutMs: 30000, ...(secrets.DAYTONA_API_KEY ? { apiKey: secrets.DAYTONA_API_KEY } : {}) });
    }
    return this.client;
  }
  private async lookup(): Promise<import('@daytona/sdk').Sandbox> {
    const sb = await (await this.api()).get(this.profile.id);
    if (this.profile.owner && (sb.labels['reroute-owner'] !== this.profile.owner || sb.labels['reroute-managed'] !== 'v3')) throw new Error('Daytona ownership mismatch; resource retained untouched');
    return sb;
  }
  private async readyVolume(api: import('@daytona/sdk').Daytona, name: string): Promise<{ id: string; state?: string }> {
    const deadline = Date.now() + 60000;
    let volume = await api.volume.get(name, true);
    for (;;) {
      if (!('state' in volume) || volume.state === 'ready') return volume;
      if (['error', 'deleted', 'deleting', 'pending_delete'].includes(String(volume.state))) throw new Error(`Daytona cache Volume is not usable: ${volume.state}`);
      if (Date.now() >= deadline) throw new Error(`Daytona cache Volume did not become ready: ${volume.state}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      volume = await api.volume.get(name, false);
    }
  }
  async ensureManaged(request: ManagedRequest): Promise<Profile> {
    if (!this.profile.managed || !this.profile.compute || !this.profile.image) throw new Error('Incomplete managed Daytona configuration');
    if (request.start && !this.profile.managed.authorized) throw new Error('Daytona spending not authorized');
    const api = await this.api();
    const found = [];
    for await (const sb of api.list({ labels: { 'reroute-managed': 'v3', 'reroute-owner': request.owner } })) {
      if (sb.name === request.name) found.push(sb);
    }
    if (found.length > 1) throw new Error('Multiple owned Daytona resources match; manual inspection required');
    let sb = found[0];
    if (!sb) {
      if (!request.create) throw new Error('Daytona allocation is not confirmed. Inspect the recorded resource name; creation will not be retried');
      const volume = await this.readyVolume(api, 'rr-cache-' + request.owner);
      const image = this.profile.image === TOOLCHAIN_IMAGE ? (await this.load()).Image.base(TOOLCHAIN_BASE).dockerfileCommands(TOOLCHAIN_COMMANDS) : this.profile.image;
      sb = await api.create({ name: request.name, image,
        resources: { cpu: this.profile.compute.cpu, memory: this.profile.compute.memoryGiB },
        labels: { 'reroute-managed': 'v3', 'reroute-owner': request.owner }, public: false,
        autoStopInterval: request.guardMinutes, autoPauseInterval: 0, autoDeleteInterval: -1,
        volumes: [{ volumeId: volume.id, mountPath: '/var/reroute-cache' }] }, { timeout: 300 });
    } else await sb.refreshData();
    if (sb.labels['reroute-owner'] !== request.owner || sb.labels['reroute-managed'] !== 'v3') throw new Error('Daytona ownership mismatch');
    if (sb.cpu !== this.profile.compute.cpu || sb.memory !== this.profile.compute.memoryGiB) throw new Error('Existing Daytona resource does not match requested CPU/memory; no dynamic resize performed');
    Object.assign(this.profile, { id: sb.id, owner: request.owner, cacheVolume: '/var/reroute-cache' });
    if (request.start) {
      // Preserve a task-length inactivity window even if the client disconnects.
      await sb.setAutoPauseInterval(0);
      await sb.setAutostopInterval(request.guardMinutes);
      await sb.setAutoDeleteInterval(-1);
      if (['stopped', 'archived'].includes(String(sb.state))) await sb.start(120);
      else if (sb.state !== 'started') throw new Error('Daytona is transitioning or unavailable; inspect status before retry');
      await sb.refreshActivity();
    }
    this.sandbox = sb;
    return { ...this.profile };
  }
  async guard(minutes: number): Promise<void> { await this.idle(minutes); }
  async idle(minutes: number): Promise<void> {
    const sb = await this.lookup();
    await sb.setAutostopInterval(minutes);
    await sb.refreshActivity();
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
    else if (action === 'stop') {
      if (!['stopped', 'archived'].includes(String(sb.state))) await sb.stop(120);
    }
    else await sb.delete(120, true);
    this.sandbox = undefined;
  }
}
