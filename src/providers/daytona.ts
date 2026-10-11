import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import { spawnRaw, shellCommand, type RawProcess } from '../platform/process.js';
import { RemoteProvider, loadSdk, missing, runtimeRef } from './common.js';
import { sshArgs } from './ssh.js';
interface Sandbox {
  id: string; state: string;
  start(): Promise<void>; stop(): Promise<void>;
  setAutostopInterval(minutes: number): Promise<void>;
  createSshAccess(minutes: number): Promise<{ token: string }>;
  getPreviewLink(port: number): Promise<{ url: string }>;
}
interface Client { get(id: string): Promise<Sandbox>; create(options: Record<string, unknown>): Promise<Sandbox>; delete(sandbox: Sandbox): Promise<void> }
interface Sdk { Daytona: new (config?: Record<string, unknown>) => Client }
export class DaytonaProvider extends RemoteProvider {
  readonly id = 'daytona' as const;
  readonly capabilities: Capabilities = { resources: ['cpu','memoryMiB','diskGiB','gpu','region','image','spot'], persistence: 'disk', idle: 'stop', preview: true, stdin: true, nativeIdle: true };
  private client?: Client;
  private access = new Map<string, { token: string; expires: number }>();
  constructor(private readonly options: Record<string, unknown> = {}, private readonly sdkLoader: () => Promise<Sdk> = () => loadSdk<Sdk>('@daytona/sdk')) { super(); }
  private async sdk(region?: string): Promise<Client> {
    return this.client ??= new (await this.sdkLoader()).Daytona({ target: region ?? this.options.target, requestTimeoutMs: 30000 });
  }
  async ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef> {
    assertCapabilities(spec, this.capabilities, this.id);
    invariant(!(spec.spot && !spec.gpu), 'UNSUPPORTED_CAPABILITY', 'Daytona spot requires a GPU request');
    invariant(!(this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB || spec.gpu)), 'UNSUPPORTED_CAPABILITY', 'Daytona snapshot resources are fixed; omit portable resource/image overrides or use an image');
    const client = await this.sdk(spec.region); let sandbox: Sandbox | undefined;
    // Stable sandbox name makes a daemon crash between create and state-write recoverable.
    try { sandbox = await client.get(previous?.id ?? `reroute-${project.id}`); } catch (error) { if (!missing(error)) throw error; }
    if (!sandbox) {
      const params: Record<string, unknown> = {
        name: `reroute-${project.id}`, labels: { 'reroute.project': project.id }, envVars: spec.env,
        autoStopInterval: spec.idleTimeoutMinutes,
        ...(this.options.autoArchiveMinutes !== undefined ? { autoArchiveInterval: this.options.autoArchiveMinutes } : {}),
        ...(this.options.autoDeleteMinutes !== undefined ? { autoDeleteInterval: this.options.autoDeleteMinutes } : {}),
        ...(this.options.volumes ? { volumes: this.options.volumes } : {}),
        ...(spec.spot !== undefined ? { spot: spec.spot } : {})
      };
      if (this.options.snapshot) params.snapshot = this.options.snapshot;
      else if (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB || spec.gpu) {
        params.image = spec.image ?? 'python:3.12-slim';
        params.resources = { cpu: spec.cpu, memory: spec.memoryMiB === undefined ? undefined : spec.memoryMiB / 1024, disk: spec.diskGiB, gpu: spec.gpu?.count ?? (spec.gpu ? 1 : undefined), gpuType: spec.gpu?.type };
      }
      sandbox = await client.create(params);
    } else if (sandbox.state !== 'started') await sandbox.start();
    return this.initialize(runtimeRef(this.id, project, sandbox.id, `/tmp/reroute/${project.id}`));
  }
  async launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess> {
    let access = this.access.get(runtime.id);
    if (!access || access.expires < Date.now()) {
      const token = await (await (await this.sdk()).get(runtime.id)).createSshAccess(30);
      invariant(typeof token.token === 'string' && /^[A-Za-z0-9._-]+$/.test(token.token), 'PROVIDER_WIRE', 'Invalid short-lived Daytona SSH access token');
      access = { token: token.token, expires: Date.now() + 20 * 60000 }; this.access.set(runtime.id, access);
    }
    const host = String(this.options.sshHost ?? 'ssh.app.daytona.io');
    invariant(!process.env.DAYTONA_API_URL || !process.env.DAYTONA_API_URL.includes('://') || process.env.DAYTONA_API_URL.startsWith('https://app.daytona.io/') || !!this.options.sshHost, 'DAYTONA_SSH_HOST', 'Custom Daytona installations require providers.daytona.sshHost');
    // Short-lived token stays in memory; it is never written into runtime metadata or logs.
    return spawnRaw('ssh', [...sshArgs({ host, user: access.token, port: this.options.sshPort as number | undefined }), shellCommand(argv)]);
  }
  async status(runtime: RuntimeRef): Promise<RuntimeStatus> {
    try { const state = (await (await this.sdk()).get(runtime.id)).state; return state === 'started' ? 'running' : ['stopped','paused','archived'].includes(state) ? 'stopped' : 'unknown'; }
    catch (error) { if (missing(error)) return 'missing'; throw error; }
  }
  async applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void> {
    const sandbox = await (await this.sdk()).get(runtime.id);
    // Native timers do not reliably count internal background activity: disable while leased.
    await sandbox.setAutostopInterval(policy.active ? 0 : Math.max(1, Math.ceil(policy.minutes)));
    if (!policy.active && policy.minutes === 0) await sandbox.stop();
  }
  async destroy(runtime: RuntimeRef): Promise<void> {
    try { const client = await this.sdk(); await client.delete(await client.get(runtime.id)); }
    catch (error) { if (!missing(error)) throw error; }
    this.access.delete(runtime.id);
  }
  async preview(runtime: RuntimeRef, port: number): Promise<string> {
    const result = await (await (await this.sdk()).get(runtime.id)).getPreviewLink(port);
    invariant(typeof result.url === 'string' && result.url.startsWith('https://'), 'PROVIDER_WIRE', 'Invalid Daytona preview URL'); return result.url;
  }
}
