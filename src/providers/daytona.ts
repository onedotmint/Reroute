import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import { spawnRaw, shellCommand, type RawProcess } from '../platform/process.js';
import { RemoteProvider, loadSdk, sdkMissing, runtimeRef } from './common.js';
import { sshArgs } from './ssh.js';
export type DaytonaSandboxState = 'creating' | 'restoring' | 'destroyed' | 'destroying' | 'started' | 'stopped' | 'starting' | 'stopping' | 'error' | 'build_failed' | 'pending_build' | 'building_snapshot' | 'unknown' | 'pulling_snapshot' | 'archived' | 'archiving' | 'resizing' | 'snapshotting' | 'forking' | 'pausing' | 'paused' | 'resuming' | '11184809';
const GPU_TYPES = ['H100', 'H200', 'B300', 'RTX-PRO-6000', 'RTX-4090', 'RTX-5090', 'MI355X'] as const;
export type DaytonaGpuType = typeof GPU_TYPES[number];
export interface DaytonaCreateBaseParams {
  name?: string; labels?: Record<string, string>; envVars?: Record<string, string>;
  autoStopInterval?: number; autoArchiveInterval?: number; autoDeleteInterval?: number;
  volumes?: { volumeId: string; mountPath: string; subpath?: string }[];
  spot?: boolean;
}
export interface DaytonaCreateImageParams extends DaytonaCreateBaseParams {
  image: string;
  resources?: { cpu?: number; memory?: number; disk?: number; gpu?: number; gpuType?: DaytonaGpuType };
}
export interface DaytonaCreateSnapshotParams extends DaytonaCreateBaseParams { snapshot?: string }
export type DaytonaCreateParams = DaytonaCreateImageParams | DaytonaCreateSnapshotParams;
export interface DaytonaSandbox {
  id: string; state?: DaytonaSandboxState;
  start(timeout?: number): Promise<void>; stop(timeout?: number): Promise<void>;
  setAutostopInterval(minutes: number): Promise<void>;
  createSshAccess(minutes: number): Promise<{ token: string; sshCommand: string; expiresAt: Date }>;
  getPreviewLink(port: number): Promise<{ url: string; token: string }>;
}
export interface DaytonaClient {
  get(id: string): Promise<DaytonaSandbox>;
  create(params: DaytonaCreateParams, options?: { timeout?: number }): Promise<DaytonaSandbox>;
  delete(sandbox: DaytonaSandbox, timeout?: number): Promise<void>;
}
export interface DaytonaSdk {
  Daytona: new (config?: { target?: string; requestTimeoutMs?: number }) => DaytonaClient;
  DaytonaNotFoundError: new (message: string, statusCode?: number) => Error & { statusCode?: number };
}
export interface DaytonaProviderOptions {
  target?: string; snapshot?: string; autoArchiveMinutes?: number; autoDeleteMinutes?: number;
  volumes?: DaytonaCreateBaseParams['volumes']; sshHost?: string; sshPort?: number;
}
export class DaytonaProvider extends RemoteProvider {
  readonly id = 'daytona' as const;
  readonly capabilities: Capabilities = { resources: ['cpu','memoryMiB','diskGiB','gpu','region','image','spot'], persistence: 'disk', idle: 'stop', preview: true, stdin: true, nativeIdle: true };
  private client?: DaytonaClient;
  private sdkModule?: DaytonaSdk;
  private access = new Map<string, { token: string; expires: number }>();
  constructor(private readonly options: DaytonaProviderOptions = {}, private readonly sdkLoader: () => Promise<DaytonaSdk> = () => loadSdk<DaytonaSdk>('@daytona/sdk')) { super(); }
  private async sdk(region?: string): Promise<DaytonaClient> {
    const sdk = this.sdkModule ??= await this.sdkLoader();
    return this.client ??= new sdk.Daytona({ target: region ?? this.options.target, requestTimeoutMs: 30000 });
  }
  private missing(error: unknown): boolean {
    return !!this.sdkModule && sdkMissing(error, this.sdkModule.DaytonaNotFoundError);
  }
  async ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef> {
    assertCapabilities(spec, this.capabilities, this.id);
    invariant(!(spec.spot && !spec.gpu), 'UNSUPPORTED_CAPABILITY', 'Daytona spot requires a GPU request');
    invariant(!(this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB || spec.gpu)), 'UNSUPPORTED_CAPABILITY', 'Daytona snapshot resources are fixed; omit portable resource/image overrides or use an image');
    invariant(spec.gpu?.type === undefined || GPU_TYPES.includes(spec.gpu.type as DaytonaGpuType), 'UNSUPPORTED_CAPABILITY', 'Daytona requires a supported GPU type');
    const client = await this.sdk(spec.region); let sandbox: DaytonaSandbox | undefined;
    // Stable sandbox name makes a daemon crash between create and state-write recoverable.
    try { sandbox = await client.get(previous?.id ?? `reroute-${project.id}`); } catch (error) { if (!this.missing(error)) throw error; }
    if (!sandbox) {
      const base: DaytonaCreateBaseParams = {
        name: `reroute-${project.id}`, labels: { 'reroute.project': project.id }, envVars: spec.env,
        autoStopInterval: spec.idleTimeoutMinutes,
        ...(this.options.autoArchiveMinutes !== undefined ? { autoArchiveInterval: this.options.autoArchiveMinutes } : {}),
        ...(this.options.autoDeleteMinutes !== undefined ? { autoDeleteInterval: this.options.autoDeleteMinutes } : {}),
        ...(this.options.volumes ? { volumes: this.options.volumes } : {}),
        ...(spec.spot !== undefined ? { spot: spec.spot } : {})
      };
      let params: DaytonaCreateParams = { ...base, ...(this.options.snapshot ? { snapshot: this.options.snapshot } : {}) };
      if (!this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB || spec.gpu)) {
        params = { ...base, image: spec.image ?? 'python:3.12-slim',
          resources: { cpu: spec.cpu, memory: spec.memoryMiB === undefined ? undefined : spec.memoryMiB / 1024, disk: spec.diskGiB, gpu: spec.gpu?.count ?? (spec.gpu ? 1 : undefined), gpuType: spec.gpu?.type as DaytonaGpuType | undefined } };
      }
      sandbox = await client.create(params, { timeout: 60 });
    } else if (sandbox.state !== 'started') {
      invariant(sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', `Daytona sandbox is not safely startable: ${sandbox.state}`);
      await sandbox.start(60);
    }
    invariant(sandbox.state === 'started', 'PROVIDER_WIRE', `Daytona sandbox is not ready: ${sandbox.state}`);
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
    return spawnRaw('ssh', [...sshArgs({ host, user: access.token, port: this.options.sshPort }), shellCommand(argv)]);
  }
  async status(runtime: RuntimeRef): Promise<RuntimeStatus> {
    try { const state = (await (await this.sdk()).get(runtime.id)).state; return state === 'started' ? 'running' : state !== undefined && ['stopped','paused','archived'].includes(state) ? 'stopped' : 'unknown'; }
    catch (error) { if (this.missing(error)) return 'missing'; throw error; }
  }
  async applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void> {
    const sandbox = await (await this.sdk()).get(runtime.id);
    // Native timers do not reliably count internal background activity: disable while leased.
    await sandbox.setAutostopInterval(policy.active ? 0 : Math.max(1, Math.ceil(policy.minutes)));
    if (!policy.active && policy.minutes === 0) await sandbox.stop(60);
  }
  async destroy(runtime: RuntimeRef): Promise<void> {
    try { const client = await this.sdk(); await client.delete(await client.get(runtime.id), 60); }
    catch (error) { if (!this.missing(error)) throw error; }
    this.access.delete(runtime.id);
  }
  async preview(runtime: RuntimeRef, port: number): Promise<string> {
    const result = await (await (await this.sdk()).get(runtime.id)).getPreviewLink(port);
    invariant(typeof result.url === 'string' && result.url.startsWith('https://'), 'PROVIDER_WIRE', 'Invalid Daytona preview URL'); return result.url;
  }
}
