import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { assertCapabilities } from '../config/config.js';
import { invariant, RerouteError } from '../core/errors.js';
import { spawnRaw, shellCommand, type RawProcess } from '../platform/process.js';
import { RemoteProvider, loadSdk, sdkMissing, runtimeRef } from './common.js';
import { sshArgs } from './ssh.js';
import type { Launch } from './channel.js';
export type DaytonaSandboxState = 'creating' | 'restoring' | 'destroyed' | 'destroying' | 'started' | 'stopped' | 'starting' | 'stopping' | 'error' | 'build_failed' | 'pending_build' | 'building_snapshot' | 'unknown' | 'pulling_snapshot' | 'archived' | 'archiving' | 'resizing' | 'snapshotting' | 'forking' | 'pausing' | 'paused' | 'resuming' | '11184809';
const GPU_TYPES = ['H100', 'H200', 'B300', 'RTX-PRO-6000', 'RTX-4090', 'RTX-5090', 'MI355X'] as const;
export type DaytonaGpuType = typeof GPU_TYPES[number];
export interface DaytonaCreateBaseParams {
  name?: string; labels?: Record<string, string>; envVars?: Record<string, string>;
  autoStopInterval?: number; autoArchiveInterval?: number; autoDeleteInterval?: number;
  volumes?: { volumeId: string; mountPath: string; subpath?: string }[];
  spot?: boolean; ephemeral?: boolean; ttlMinutes?: number;
}
export interface DaytonaCreateImageParams extends DaytonaCreateBaseParams {
  image: string;
  resources?: { cpu?: number; memory?: number; disk?: number; gpu?: number; gpuType?: DaytonaGpuType };
}
export interface DaytonaCreateSnapshotParams extends DaytonaCreateBaseParams { snapshot?: string }
export type DaytonaCreateParams = DaytonaCreateImageParams | DaytonaCreateSnapshotParams;
export interface DaytonaSandbox {
  id: string; state?: DaytonaSandboxState; labels: Record<string, string>;
  sandboxClass?: 'container' | 'linux-vm' | 'windows' | '11184809'; gpu: number; spot?: boolean;
  autoDeleteInterval?: number; autoDestroyAt?: string;
  start(timeout?: number): Promise<void>; stop(timeout?: number): Promise<void>;
  setAutostopInterval(minutes: number): Promise<void>;
  setAutoDeleteInterval(minutes: number): Promise<void>;
  refreshActivity(): Promise<void>;
  createSshAccess(minutes: number): Promise<{ token: string; sshCommand: string; expiresAt: Date }>;
  getPreviewLink(port: number): Promise<{ url: string; token: string }>;
  getSignedPreviewUrl(port: number, expiresInSeconds?: number): Promise<{ url: string; token: string }>;
}
export interface DaytonaClient {
  get(id: string): Promise<DaytonaSandbox>;
  snapshot: { get(name: string): Promise<{ sandboxClass?: DaytonaSandbox['sandboxClass']; resources?: { gpu?: unknown } }> };
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
  // Warm coordinator state is not proof that the remote disk still has its original owner.
  protected override bridge: Launch = async (runtime, argv) => { await this.verifyWorkspace(runtime); return this.launch(runtime, argv); };
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
  private validateSpec(spec: RuntimeSpec): void {
    assertCapabilities(spec, this.capabilities, this.id);
    invariant(!spec.gpu && !spec.spot, 'UNSUPPORTED_CAPABILITY', 'Daytona GPU/Spot sandboxes are ephemeral and cannot safely stop or restore; use a CPU container');
    invariant(this.options.autoDeleteMinutes === undefined || this.options.autoDeleteMinutes === -1, 'UNSUPPORTED_CAPABILITY', 'Daytona autoDeleteMinutes must be -1 (disabled) to preserve source');
    invariant(!(this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB)), 'UNSUPPORTED_CAPABILITY', 'Daytona snapshot resources are fixed; omit portable resource/image overrides or use an image');
  }
  private validateRuntime(runtime: RuntimeRef, projectId = runtime.projectId): void {
    invariant(runtime.provider === this.id && runtime.projectId === projectId && typeof runtime.id === 'string' && runtime.id.length > 0, 'WRONG_RUNTIME', 'Daytona runtime must match the original project, provider and sandbox ID');
  }
  private validateSandbox(sandbox: DaytonaSandbox, projectId: string, expectedId?: string): void {
    invariant(sandbox.labels?.['reroute.project'] === projectId && (!expectedId || sandbox.id === expectedId), 'WRONG_RUNTIME', 'Daytona sandbox ID/ownership label does not match; inspect the original sandbox before retrying');
    invariant(sandbox.sandboxClass === 'container' && sandbox.gpu === 0 && sandbox.spot === false && sandbox.autoDeleteInterval !== 0, 'UNSUPPORTED_CAPABILITY', 'Daytona lifecycle requires a non-ephemeral CPU container (no GPU, Spot or VM)');
    invariant(!sandbox.autoDestroyAt, 'UNSUPPORTED_CAPABILITY', 'Daytona sandbox has a hard TTL; remove its native TTL before restoring or managing it');
  }
  private async owned(runtime: RuntimeRef): Promise<DaytonaSandbox> {
    this.validateRuntime(runtime);
    const sandbox = await (await this.sdk()).get(runtime.id);
    this.validateSandbox(sandbox, runtime.projectId, runtime.id);
    return sandbox;
  }
  private async preserve(sandbox: DaytonaSandbox, minutes: number): Promise<void> {
    await sandbox.setAutoDeleteInterval(-1);
    await sandbox.setAutostopInterval(Math.max(1, Math.ceil(minutes)));
  }
  private async start(sandbox: DaytonaSandbox): Promise<void> {
    if (sandbox.state !== 'started') {
      invariant(sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', 'Daytona sandbox is not safely startable; inspect its native state before retrying');
      await sandbox.start(60);
    }
    invariant(sandbox.state === 'started', 'PROVIDER_WIRE', 'Daytona sandbox is not ready; wait for its native start operation before retrying');
  }
  async restore(project: ProjectRef, spec: RuntimeSpec, runtime: RuntimeRef): Promise<RuntimeRef> {
    this.validateSpec(spec); this.validateRuntime(runtime, project.id);
    invariant(!!runtime.meta.workspaceGeneration, 'WORKSPACE_IDENTITY', 'Original workspace generation is missing; recover its recorded identity before restoring');
    const sandbox = await this.owned(runtime);
    invariant(sandbox.state === 'started' || sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', 'Daytona sandbox is not safely startable; inspect its native state before retrying');
    await this.preserve(sandbox, Math.max(5, spec.idleTimeoutMinutes));
    await this.start(sandbox);
    return this.verifyWorkspace(runtime);
  }
  async ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef> {
    this.validateSpec(spec);
    if (previous) return this.restore(project, spec, previous);
    const client = await this.sdk(spec.region); let sandbox: DaytonaSandbox | undefined;
    // Stable sandbox name makes a daemon crash between create and state-write recoverable.
    try { sandbox = await client.get(`reroute-${project.id}`); } catch (error) { if (!this.missing(error)) throw error; }
    if (!sandbox) {
      if (this.options.snapshot) {
        const snapshot = await client.snapshot.get(this.options.snapshot);
        invariant(snapshot.sandboxClass === 'container' && !!snapshot.resources && !snapshot.resources.gpu, 'UNSUPPORTED_CAPABILITY', 'Daytona snapshot must have verified CPU-container metadata before creation; GPU/VM/unknown snapshots are unsupported');
      }
      const base: DaytonaCreateBaseParams = {
        name: `reroute-${project.id}`, labels: { 'reroute.project': project.id }, envVars: spec.env,
        autoStopInterval: Math.max(5, Math.ceil(spec.idleTimeoutMinutes)), autoDeleteInterval: -1, ttlMinutes: 0, ephemeral: false, spot: false,
        ...(this.options.autoArchiveMinutes !== undefined ? { autoArchiveInterval: this.options.autoArchiveMinutes } : {}),
        ...(this.options.volumes ? { volumes: this.options.volumes } : {})
      };
      let params: DaytonaCreateParams = { ...base, ...(this.options.snapshot ? { snapshot: this.options.snapshot } : {}) };
      if (!this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB)) {
        params = { ...base, image: spec.image ?? 'python:3.12-slim',
          resources: { cpu: spec.cpu, memory: spec.memoryMiB === undefined ? undefined : spec.memoryMiB / 1024, disk: spec.diskGiB } };
      }
      sandbox = await client.create(params, { timeout: 60 });
      this.validateSandbox(sandbox, project.id);
      invariant(sandbox.state === 'started', 'PROVIDER_WIRE', 'Daytona sandbox is not ready; inspect its native create operation before retrying');
    } else {
      this.validateSandbox(sandbox, project.id);
      throw new RerouteError('WORKSPACE_IDENTITY', 'A Daytona sandbox already exists without a recorded runtime/generation. Recover its original project state or back up its files using native tools; Reroute will not initialize or replace its workspace.');
    }
    return this.initialize(runtimeRef(this.id, project, sandbox.id, `/tmp/reroute/${project.id}`));
  }
  async launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess> {
    this.validateRuntime(runtime);
    let access = this.access.get(runtime.id);
    if (!access || access.expires < Date.now()) {
      const token = await (await this.owned(runtime)).createSshAccess(30);
      invariant(typeof token.token === 'string' && /^[A-Za-z0-9._-]+$/.test(token.token), 'PROVIDER_WIRE', 'Invalid short-lived Daytona SSH access token');
      access = { token: token.token, expires: Date.now() + 20 * 60000 }; this.access.set(runtime.id, access);
    }
    const host = String(this.options.sshHost ?? 'ssh.app.daytona.io');
    invariant(!process.env.DAYTONA_API_URL || !process.env.DAYTONA_API_URL.includes('://') || process.env.DAYTONA_API_URL.startsWith('https://app.daytona.io/') || !!this.options.sshHost, 'DAYTONA_SSH_HOST', 'Custom Daytona installations require providers.daytona.sshHost');
    // Short-lived token stays in memory; it is never written into runtime metadata or logs.
    return spawnRaw('ssh', [...sshArgs({ host, user: access.token, port: this.options.sshPort }), shellCommand(argv)]);
  }
  async status(runtime: RuntimeRef): Promise<RuntimeStatus> {
    this.validateRuntime(runtime);
    try { const state = (await this.owned(runtime)).state; return state === 'started' ? 'running' : state === 'archived' ? 'archived' : state === 'stopped' ? 'stopped' : 'unknown'; }
    catch (error) { if (this.missing(error)) return 'missing'; throw error; }
  }
  async applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void> {
    this.validateRuntime(runtime);
    const sandbox = await this.owned(runtime);
    invariant(policy.active ? sandbox.state === 'started' : sandbox.state === 'started' || sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', 'Daytona sandbox state is unsafe for lifecycle management; inspect its native state');
    // A finite native timer survives daemon failure; active leases reset real last activity.
    await this.preserve(sandbox, policy.active ? Math.max(5, policy.minutes) : policy.minutes);
    if (policy.active) await sandbox.refreshActivity();
    if (!policy.active && policy.minutes === 0 && sandbox.state === 'started') await sandbox.stop(60);
  }
  async destroy(runtime: RuntimeRef): Promise<void> {
    this.validateRuntime(runtime);
    try { const client = await this.sdk(); await client.delete(await this.owned(runtime), 60); }
    catch (error) { if (!this.missing(error)) throw error; }
    this.access.delete(runtime.id);
  }
  async preview(runtime: RuntimeRef, port: number): Promise<string> {
    this.validateRuntime(runtime);
    const result = await (await this.owned(runtime)).getSignedPreviewUrl(port, 300);
    invariant(typeof result.url === 'string' && result.url.startsWith('https://'), 'PROVIDER_WIRE', 'Invalid Daytona preview URL'); return result.url;
  }
}
