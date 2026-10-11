import type { Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy, ExecutionEvent } from '../core/contracts.js';
import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import { shellCommand, type RawProcess } from '../platform/process.js';
import { AsyncQueue } from '../core/queue.js';
import { RemoteProvider, loadSdk, missing, runtimeRef } from './common.js';
interface CommandHandle { pid: number; wait(): Promise<{ exitCode: number }> }
interface Sandbox {
  sandboxId: string;
  commands: { run(command: string, options: Record<string, unknown>): Promise<CommandHandle>; sendStdin(pid: number, data: Uint8Array): Promise<void>; closeStdin(pid: number): Promise<void>; kill(pid: number): Promise<boolean> };
  setTimeout(ms: number): Promise<void>; pause(): Promise<boolean>; kill(): Promise<boolean>; getHost(port: number): string;
}
interface SandboxClass {
  create(template: string, options: Record<string, unknown>): Promise<Sandbox>;
  connect(id: string, options?: Record<string, unknown>): Promise<Sandbox>;
  getInfo(id: string): Promise<{ state: string }>;
  list(options: Record<string, unknown>): { hasNext: boolean; nextItems(): Promise<{ sandboxId: string }[]> };
}
interface Sdk { Sandbox: SandboxClass }
export class E2BProvider extends RemoteProvider {
  readonly id = 'e2b' as const;
  readonly capabilities: Capabilities = { resources: [], persistence: 'disk', idle: 'stop', preview: true, stdin: true, nativeIdle: true };
  private cls?: SandboxClass;
  private sandboxes = new Map<string, Sandbox>();
  constructor(private readonly options: Record<string, unknown> = {}, private readonly sdkLoader: () => Promise<Sdk> = () => loadSdk<Sdk>('e2b')) { super(); }
  private async sdk(): Promise<SandboxClass> { return this.cls ??= (await this.sdkLoader()).Sandbox; }
  private async sandbox(id: string): Promise<Sandbox> {
    let sandbox = this.sandboxes.get(id); if (!sandbox) { sandbox = await (await this.sdk()).connect(id); this.sandboxes.set(id, sandbox); } return sandbox;
  }
  async ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef> {
    assertCapabilities(spec, this.capabilities, this.id);
    const sdk = await this.sdk(); let sandbox: Sandbox | undefined;
    if (previous) { try { sandbox = await sdk.connect(previous.id); } catch (error) { if (!missing(error)) throw error; } }
    else {
      const paginator = sdk.list({ query: { metadata: { 'reroute.project': project.id } } });
      const matches: { sandboxId: string }[] = [];
      while (paginator.hasNext) { matches.push(...await paginator.nextItems()); invariant(matches.length < 100, 'DUPLICATE_RUNTIME', 'Too many E2B runtimes with the same project identity'); }
      invariant(matches.length <= 1, 'DUPLICATE_RUNTIME', 'Multiple E2B runtimes share this project identity; inspect native provider state before continuing');
      if (matches[0]) sandbox = await sdk.connect(matches[0].sandboxId);
    }
    if (!sandbox) sandbox = await sdk.create(String(this.options.template ?? 'base'), {
      envs: spec.env, metadata: { 'reroute.project': project.id }, timeoutMs: this.options.timeoutMs ?? 3600000,
      lifecycle: { onTimeout: this.options.autoPause === false ? 'kill' : 'pause', autoResume: false }
    });
    this.sandboxes.set(sandbox.sandboxId, sandbox);
    return this.initialize(runtimeRef(this.id, project, sandbox.sandboxId, `/home/user/reroute/${project.id}`));
  }
  async launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess> {
    const sandbox = await this.sandbox(runtime.id); const queue = new AsyncQueue<ExecutionEvent>();
    const command = await sandbox.commands.run(shellCommand(argv), {
      background: true, stdin: true, timeoutMs: 0,
      onStdout: (data: string) => queue.push({ type: 'output', stream: 'stdout', data: Buffer.from(data) }),
      onStderr: (data: string) => queue.push({ type: 'output', stream: 'stderr', data: Buffer.from(data) })
    });
    invariant(Number.isInteger(command.pid), 'SDK_PROTOCOL', 'E2B returned an invalid command handle');
    const done = command.wait().then(result => { queue.end(); return result.exitCode; }, error => {
      if (error && typeof error === 'object' && 'exitCode' in error && Number.isInteger(error.exitCode)) { queue.end(); return Number(error.exitCode); }
      queue.end(error); throw error;
    }); void done.catch(() => {});
    return { events: queue, write: data => sandbox.commands.sendStdin(command.pid, data), closeInput: () => sandbox.commands.closeStdin(command.pid), wait: () => done, kill: async () => { await sandbox.commands.kill(command.pid); } };
  }
  async status(runtime: RuntimeRef): Promise<RuntimeStatus> {
    try { const info = await (await this.sdk()).getInfo(runtime.id); return info.state === 'running' ? 'running' : info.state === 'paused' ? 'stopped' : 'unknown'; }
    catch (error) { if (missing(error)) return 'missing'; throw error; }
  }
  async applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void> {
    const sandbox = await this.sandbox(runtime.id);
    if (!policy.active && policy.minutes === 0) {
      if (this.options.autoPause === false) await sandbox.kill(); else await sandbox.pause();
      this.sandboxes.delete(runtime.id);
    } else await sandbox.setTimeout(policy.active ? Number(this.options.timeoutMs ?? 3600000) : Math.max(60000, policy.minutes * 60000));
  }
  async destroy(runtime: RuntimeRef): Promise<void> {
    try { await (await this.sandbox(runtime.id)).kill(); } catch (error) { if (!missing(error)) throw error; }
    this.sandboxes.delete(runtime.id);
  }
  async preview(runtime: RuntimeRef, port: number): Promise<string> { return 'https://' + (await this.sandbox(runtime.id)).getHost(port); }
}
