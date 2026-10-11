import { join } from 'node:path';
import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy } from '../core/contracts.js';
import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import { atomicWrite, home, privateDir } from '../platform/files.js';
import { capture, type RawProcess } from '../platform/process.js';
import { RemoteProvider, runtimeRef } from './common.js';
import { SshProvider } from './ssh.js';
/** JSON is a YAML 1.2 subset; writing JSON avoids an extra YAML serializer. */
export function skyTask(project: ProjectRef, spec: RuntimeSpec, options: Record<string, unknown>): Record<string, unknown> {
  return {
    name: `reroute-${project.id}`, resources: {
      ...(spec.cpu !== undefined ? { cpus: spec.cpu } : {}),
      ...(spec.memoryMiB !== undefined ? { memory: spec.memoryMiB / 1024 } : {}),
      ...(spec.diskGiB !== undefined ? { disk_size: spec.diskGiB } : {}),
      ...(spec.gpu ? { accelerators: { [spec.gpu.type ?? 'T4']: spec.gpu.count ?? 1 } } : {}),
      ...(spec.image ? { image_id: spec.image } : {}), ...(spec.region ? { region: spec.region } : {}),
      ...(spec.spot !== undefined ? { use_spot: spec.spot } : {}),
      ...(options.infra ? { infra: options.infra } : {}), ...(options.instanceType ? { instance_type: options.instanceType } : {}),
      ...(options.diskTier ? { disk_tier: options.diskTier } : {})
    }, envs: spec.env, ...(options.bootstrap ? { setup: options.bootstrap } : {}), run: 'python3 --version'
  };
}
export class SkyPilotProvider extends RemoteProvider {
  readonly id = 'skypilot' as const;
  readonly capabilities: Capabilities = { resources: ['cpu','memoryMiB','diskGiB','gpu','region','image','spot'], persistence: 'disk', idle: 'stop', preview: true, stdin: true, nativeIdle: true };
  private ssh = new Map<string, SshProvider>();
  constructor(private readonly options: Record<string, unknown> = {}) { super(); }
  private sshProvider(runtime: RuntimeRef): SshProvider {
    let ssh = this.ssh.get(runtime.id);
    if (!ssh) { ssh = new SshProvider({ host: runtime.id }); this.ssh.set(runtime.id, ssh); } return ssh;
  }
  async ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef> {
    assertCapabilities(spec, this.capabilities, this.id);
    const name = previous?.id ?? `reroute-${project.id.slice(0, 20)}`;
    invariant(/^reroute-[a-f0-9-]+$/.test(name), 'PROVIDER_WIRE', 'Invalid Reroute SkyPilot cluster name');
    await privateDir(join(home(), 'sky'));
    const taskFile = join(home(), 'sky', `${project.id}.yaml`);
    await atomicWrite(taskFile, JSON.stringify(skyTask(project, spec, this.options), null, 2));
    const result = await capture('sky', ['launch','-c',name,'--yes','--fast','--idle-minutes-to-autostop',String(spec.idleTimeoutMinutes),taskFile], { timeoutMs: 20 * 60 * 1000 });
    invariant(result.code === 0, 'SKY_LAUNCH', 'SkyPilot launch failed. Inspect sky status and native cloud authentication. No direct cloud provisioning was attempted.');
    const runtime = runtimeRef(this.id, project, name, `${String(this.options.remoteRoot ?? '~/.cache/reroute/workspaces')}/${project.id}`, { spot: String(spec.spot ?? false) });
    // SkyPilot generates the SSH config. Streaming stdio uses that connection, not a cloud SDK.
    return this.initialize(runtime);
  }
  launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess> { return this.sshProvider(runtime).launch(runtime, argv); }
  async status(runtime: RuntimeRef): Promise<RuntimeStatus> {
    const result = await capture('sky', ['status',runtime.id,'--refresh'], { timeoutMs: 90000 });
    if (result.code !== 0) return 'unknown';
    if (/\bUP\b/.test(result.stdout)) return 'running';
    if (/\bSTOPPED\b/.test(result.stdout)) return 'stopped';
    if (/No clusters|not found/i.test(result.stdout)) return 'missing'; return 'unknown';
  }
  async applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void> {
    const args = policy.active ? ['autostop',runtime.id,'--cancel','-y']
      : policy.minutes === 0 ? [runtime.meta.spot === 'true' ? 'down' : 'stop',runtime.id,'-y']
      : ['autostop',runtime.id,'-i',String(Math.max(1, Math.ceil(policy.minutes))),...(runtime.meta.spot === 'true' ? ['--down'] : []),'-y'];
    const result = await capture('sky', args, { timeoutMs: 120000 });
    invariant(result.code === 0, 'SKY_LIFECYCLE', 'SkyPilot lifecycle request failed; check sky status');
    await this.sshProvider(runtime).applyIdlePolicy(runtime, policy);
  }
  async destroy(runtime: RuntimeRef): Promise<void> {
    const result = await capture('sky', ['down',runtime.id,'-y'], { timeoutMs: 120000 });
    invariant(result.code === 0, 'SKY_DESTROY', 'SkyPilot cluster deletion was not confirmed'); this.ssh.delete(runtime.id);
  }
  preview(runtime: RuntimeRef, port: number): Promise<string> { return this.sshProvider(runtime).preview(runtime, port); }
}
