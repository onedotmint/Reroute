import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy, ExecutionEvent } from '../core/contracts.js';
import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import type { RawProcess } from '../platform/process.js';
import { AsyncQueue } from '../core/queue.js';
import { RemoteProvider, loadSdk, missing, runtimeRef } from './common.js';
interface ModalProcess {
  stdin: WritableStream<Uint8Array>; stdout: AsyncIterable<Uint8Array>; stderr: AsyncIterable<Uint8Array>; wait(): Promise<number>; closeStdin(): Promise<void>;
}
interface Sandbox {
  sandboxId: string; poll(): Promise<number | null>; terminate(): Promise<void>;
  exec(argv: string[], options?: Record<string, unknown>): Promise<ModalProcess>;
  tunnels(): Promise<Record<number, { url: string }>>;
}
interface Client {
  apps: { fromName(name: string, options: { createIfMissing: boolean }): Promise<unknown> };
  images: { fromRegistry(name: string): unknown };
  volumes: { fromName(name: string, options: { createIfMissing: boolean }): Promise<unknown> };
  secrets: { fromName(name: string): Promise<unknown> };
  sandboxes: { create(app: unknown, image: unknown, options: Record<string, unknown>): Promise<Sandbox>; fromId(id: string): Promise<Sandbox>; fromName(app: string, name: string): Promise<Sandbox> };
}
interface Sdk { ModalClient: new () => Client }
export class ModalProvider extends RemoteProvider {
  readonly id = 'modal' as const;
  readonly capabilities: Capabilities = { resources: ['cpu','memoryMiB','gpu','region','image'], persistence: 'volume', idle: 'terminate', preview: true, stdin: true, nativeIdle: false };
  private client?: Client;
  private sandboxes = new Map<string, Sandbox>();
  constructor(private readonly options: Record<string, unknown> = {}, private readonly sdkLoader: () => Promise<Sdk> = () => loadSdk<Sdk>('modal')) { super(); }
  private async sdk(): Promise<Client> { return this.client ??= new (await this.sdkLoader()).ModalClient(); }
  private async sandbox(id: string): Promise<Sandbox> {
    let sandbox = this.sandboxes.get(id); if (!sandbox) { sandbox = await (await this.sdk()).sandboxes.fromId(id); this.sandboxes.set(id, sandbox); } return sandbox;
  }
  async ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef> {
    assertCapabilities(spec, this.capabilities, this.id);
    const client = await this.sdk(); const appName = String(this.options.app ?? 'reroute'); let sandbox: Sandbox | undefined;
    try { sandbox = previous ? await this.sandbox(previous.id) : await client.sandboxes.fromName(appName, `reroute-${project.id}`); }
    catch (error) { if (!missing(error)) throw error; }
    if (sandbox && await sandbox.poll() !== null) { this.sandboxes.delete(sandbox.sandboxId); sandbox = undefined; }
    const mount = String(this.options.volumeMount ?? '/workspace');
    invariant(mount.startsWith('/') && !mount.includes('..'), 'CONFIG', 'Modal volumeMount must be an absolute path');
    if (!sandbox) {
      const app = await client.apps.fromName(appName, { createIfMissing: true });
      const image = client.images.fromRegistry(spec.image ?? 'python:3.12-slim');
      const volume = await client.volumes.fromName(String(this.options.volume ?? `reroute-${project.id}`), { createIfMissing: true });
      const secrets = await Promise.all(((this.options.secrets ?? []) as string[]).map(name => client.secrets.fromName(name)));
      sandbox = await client.sandboxes.create(app, image, {
        name: `reroute-${project.id}`, cpu: spec.cpu, memoryMiB: spec.memoryMiB,
        cpuLimit: this.options.cpuLimit, memoryLimitMiB: this.options.memoryLimitMiB,
        ...(spec.gpu ? { gpu: `${spec.gpu.type ?? 'T4'}:${spec.gpu.count ?? 1}` } : {}),
        regions: spec.region ? [spec.region] : undefined, env: spec.env, volumes: { [mount]: volume }, secrets,
        encryptedPorts: this.options.ports ?? [], timeoutMs: this.options.timeoutMs ?? 24 * 60 * 60 * 1000,
        tags: { 'reroute.project': project.id }
      });
    }
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return this.initialize(runtimeRef(this.id, project, sandbox.sandboxId, `${mount}/${project.id}`));
  }
  async launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess> {
    const process = await (await this.sandbox(runtime.id)).exec(argv, { mode: 'binary', stdout: 'pipe', stderr: 'pipe', timeoutMs: 0 });
    invariant(process.stdin && typeof process.stdin.getWriter === 'function' && typeof process.closeStdin === 'function', 'SDK_PROTOCOL', 'Modal SDK requires writable stdin and independent closeStdin (modal@0.11.0)');
    const writer = process.stdin.getWriter(); const events = new AsyncQueue<ExecutionEvent>(); let inputClosed = false;
    const pump = async (stream: AsyncIterable<Uint8Array>, name: 'stdout' | 'stderr') => { for await (const data of stream) events.push({ type: 'output', stream: name, data: Buffer.from(data) }); };
    const done = Promise.all([pump(process.stdout, 'stdout'), pump(process.stderr, 'stderr'), process.wait()]).then(([, , code]) => { events.end(); return code; }, error => { events.end(error); throw error; });
    void done.catch(() => {});
    const close = async () => { if (!inputClosed) { inputClosed = true; await writer.close(); } };
    return { events, write: async data => { await writer.write(data); }, closeInput: close, wait: () => done,
      // SDK closeStdin bypasses its WritableStream queue; worker EOF kills its own group.
      kill: async () => { inputClosed = true; await process.closeStdin(); await done.catch(() => {}); } };
  }
  async status(runtime: RuntimeRef): Promise<RuntimeStatus> {
    try { return await (await this.sandbox(runtime.id)).poll() === null ? 'running' : 'stopped'; }
    catch (error) { if (missing(error)) return 'missing'; throw error; }
  }
  async applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void> {
    if (!policy.active && policy.minutes === 0) { await (await this.sandbox(runtime.id)).terminate(); this.sandboxes.delete(runtime.id); }
    // Core owns idle deadline. Modal has terminate/recreate, not fictional VM stop/start.
  }
  async destroy(runtime: RuntimeRef): Promise<void> {
    try { await (await this.sandbox(runtime.id)).terminate(); } catch (error) { if (!missing(error)) throw error; }
    this.sandboxes.delete(runtime.id); // Named volume retained intentionally; deletion requires native Modal confirmation.
  }
  async preview(runtime: RuntimeRef, port: number): Promise<string> {
    const tunnels = await (await this.sandbox(runtime.id)).tunnels();
    invariant(typeof tunnels[port]?.url === 'string', 'UNSUPPORTED_CAPABILITY', `Modal port ${port} was not declared before sandbox creation. Add it to providers.modal.ports.`);
    return tunnels[port]!.url;
  }
}
