import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { ProjectState, ProjectConfig, ProviderId, RuntimeProvider, RuntimeRef, ExecutionHandle, ExecutionEvent, ExecutionExit, ProviderFactory } from './contracts.js';
import { ProjectStore, findProject } from './projects.js';
import { loadConfig } from '../config/config.js';
import { SerialLane } from './queue.js';
import { Synchronizer } from '../sync/sync.js';
import { Lifecycle } from './lifecycle.js';
import { mapArgv, remoteCwd, route } from './routing.js';
import { invariant, RerouteError, safeMessage } from './errors.js';
import { log, LogTail } from './logging.js';
interface Entry {
  state: ProjectState; config: ProjectConfig; provider: RuntimeProvider; lane: SerialLane;
  sync: Synchronizer; lifecycle?: Lifecycle; pendingRelease?: () => Promise<void>; warm: boolean; error?: string;
  active: Map<string, ExecutionHandle>; dev?: DevSession; verifiedAt: number; generation: number; stopping: number;
}
interface DevSession { id: string; handle: ExecutionHandle; logs: LogTail; done: Promise<ExecutionExit>; port?: number; syncTimer?: NodeJS.Timeout }
export interface RunInput { cwd: string; argv: string[]; env: Record<string, string>; timeoutMs?: number }
export interface RunHooks { signal?: AbortSignal; onHandle?: (handle: ExecutionHandle) => void; onOutput?: (event: ExecutionEvent) => Promise<void> | void }
export class Coordinator {
  readonly store = new ProjectStore();
  private entries = new Map<string, Promise<Entry>>();
  private generation = 0;
  private closing = false;
  private shutdownTask?: Promise<void>;
  private checkExecution(entry: Entry, generation: number): void {
    if (this.closing || entry.stopping || generation < entry.generation || !entry.state.enabled) throw new RerouteError('CANCELLED', 'Execution was stopped before it could proceed', 130);
  }
  constructor(private readonly factory: ProviderFactory) {}
  private async entry(cwd: string, allowDisabled = false): Promise<Entry> {
    if (!allowDisabled) invariant(!this.closing, 'CANCELLED', 'Coordinator is shutting down');
    const state = await findProject(cwd);
    if (!allowDisabled) invariant(!this.closing, 'CANCELLED', 'Coordinator is shutting down');
    invariant(state && (state.enabled || allowDisabled), 'NOT_ENABLED', 'This project is not enabled. Run reroute enable; use reroute local for an explicit local override.');
    let pending = this.entries.get(state.project.id);
    if (!pending) {
      pending = (async () => {
        const config = await loadConfig(state.project.root, { ...state.override, provider: state.provider });
        return { state, config, provider: this.factory(config), lane: new SerialLane(), sync: new Synchronizer(state.project.root, config.sync), active: new Map(), warm: false, verifiedAt: 0, generation: 0, stopping: 0 };
      })();
      this.entries.set(state.project.id, pending);
      void pending.catch(() => this.entries.delete(state.project.id));
    }
    return pending;
  }
  async enable(cwd: string, provider: ProviderId, override: Record<string, unknown>, fresh = false): Promise<ProjectState> {
    invariant(!this.closing, 'CANCELLED', 'Coordinator is shutting down');
    let previous: ProjectState | undefined;
    try { previous = await findProject(cwd); } catch (error) { if (!fresh) throw error; }
    const pending = previous && this.entries.get(previous.project.id);
    if (!pending) return this.store.enable(cwd, provider, override, fresh);
    const entry = await pending;
    invariant(!entry.active.size && !entry.dev, 'PROJECT_BUSY', 'Stop active commands/dev sessions before changing project configuration');
    return entry.lane.run(async () => {
      invariant(!entry.active.size && !entry.dev, 'PROJECT_BUSY', 'Project became active during configuration change');
      const config = await loadConfig(previous!.project.root, { ...override, provider });
      const state = await this.store.enable(cwd, provider, override, fresh);
      entry.lifecycle?.dispose(); entry.lifecycle = undefined; entry.warm = false;
      if (fresh) { this.entries.delete(previous!.project.id); return state; }
      entry.state = state; entry.config = config; entry.provider = this.factory(config);
      entry.sync = new Synchronizer(state.project.root, config.sync);
      if (state.syncPending) await this.ready(entry, true);
      return state;
    });
  }
  private async protectSource(entry: Entry): Promise<void> {
    invariant(await fs.realpath(entry.state.project.root) === entry.state.project.root, 'PROJECT_MOVED', 'Project source path is no longer available at its original location');
    if (!entry.state.syncPending) { entry.state.syncPending = true; await this.store.save(entry.state); }
    entry.pendingRelease ??= await entry.lifecycle!.acquire();
  }
  private async reconcile(entry: Entry, acceptLocal = false): Promise<unknown> {
    await this.protectSource(entry);
    try {
      const files = entry.provider.files(entry.state.runtime!);
      const result = acceptLocal ? await entry.sync.acceptLocal(files) : await entry.sync.reconcile(files);
      entry.state.syncPending = false;
      try { await this.store.save(entry.state); } catch (error) { entry.state.syncPending = true; throw error; }
      const release = entry.pendingRelease; entry.pendingRelease = undefined;
      if (release) await release();
      entry.error = undefined;
      return result;
    } catch (error) { entry.error = safeMessage(error); throw error; }
  }
  private validateRuntime(entry: Entry, runtime: RuntimeRef): void {
    invariant(runtime.provider === entry.state.provider && runtime.provider === entry.provider.id && runtime.projectId === entry.state.project.id,
      'WRONG_RUNTIME', 'Runtime identity does not belong to this project/provider; no replacement or destruction was attempted');
  }
  private async ready(entry: Entry, existingOnly = false): Promise<void> {
    const retained = existingOnly || entry.state.syncPending;
    invariant(!entry.state.syncPending || entry.state.runtime, 'SOURCE_PENDING', 'Pending source has no recorded runtime; recover its original state instead of creating a replacement');
    const previous = entry.state.runtime;
    let restored: RuntimeRef | undefined;
    if (previous) {
      this.validateRuntime(entry, previous);
      if (!entry.warm || retained || Date.now() - entry.verifiedAt > 5000) {
        const status = await entry.provider.status(previous);
        invariant(status !== 'unknown', 'RUNTIME_UNKNOWN', 'Runtime status could not be established. Check native connectivity; no replacement was created.');
        if (status !== 'running') { entry.warm = false; entry.lifecycle?.dispose(); entry.pendingRelease = undefined; }
        if (status === 'stopped' || status === 'archived' || (status === 'running' && retained && !entry.warm && entry.provider.restore)) {
          if (entry.provider.restore) {
            const generation = entry.generation;
            invariant(!this.closing, 'CANCELLED', 'Coordinator is shutting down; original runtime was not resumed');
            invariant(typeof previous.meta.workspaceGeneration === 'string' && previous.meta.workspaceGeneration.length > 0,
              'WRONG_RUNTIME', 'Original workspace generation is missing; verify native workspace ownership before recovery');
            try { restored = await entry.provider.restore(entry.state.project, entry.config.runtime, structuredClone(previous)); }
            catch (error) {
              entry.error = safeMessage(error);
              if (error instanceof RerouteError) throw error;
              throw new RerouteError('RUNTIME_RESTORE', `Could not resume original ${previous.provider} runtime ${previous.id}. Check native authentication/connectivity, then retry reroute sync; no replacement was created.`);
            }
            invariant(!this.closing && generation === entry.generation, 'CANCELLED', 'Recovery was interrupted; original runtime and pending source were retained');
            this.validateRuntime(entry, restored);
            invariant(restored.id === previous.id && restored.root === previous.root && restored.meta.workspaceGeneration === previous.meta.workspaceGeneration,
              'WRONG_RUNTIME', 'Recovery changed the runtime identity or workspace generation; pending source and baseline were retained');
            invariant(await entry.provider.status(restored) === 'running', 'RUNTIME_RESTORE', 'Original runtime is not running after recovery; check native state and retry reroute sync');
            invariant(!this.closing && generation === entry.generation, 'CANCELLED', 'Recovery was interrupted; original runtime and pending source were retained');
          } else invariant(!retained, 'SOURCE_PENDING', 'This provider cannot safely resume the original runtime. Resume it with native tools, then reroute sync; no replacement was created');
        } else invariant(!(retained && status === 'missing'), 'SOURCE_PENDING', 'Original runtime is missing; recover its native backup. Pending source cannot be replaced by an empty runtime');
        entry.verifiedAt = Date.now();
      }
    }
    if (entry.warm) return;
    const runtime = restored ?? (retained && previous ? previous : await entry.provider.ensureReady(entry.state.project, entry.config.runtime, previous));
    this.validateRuntime(entry, runtime);
    if (retained && previous) invariant(runtime.id === previous.id && runtime.root === previous.root && runtime.meta.workspaceGeneration === previous.meta.workspaceGeneration,
      'WRONG_RUNTIME', 'Retained source requires the original runtime and workspace generation');
    // If an ephemeral runtime was recreated, its empty filesystem is not a deletion of local source.
    if (!entry.state.runtime || entry.state.runtime.id !== runtime.id || entry.state.runtime.meta.workspaceGeneration !== runtime.meta.workspaceGeneration) {
      await fs.rm(`${entry.state.project.root}/.reroute/sync-base.json`, { force: true });
    }
    entry.state.runtime = runtime; await this.store.save(entry.state);
    entry.lifecycle?.dispose(); entry.pendingRelease = undefined;
    entry.lifecycle = new Lifecycle(entry.provider, runtime, entry.config.runtime.idleTimeoutMinutes,
      () => { entry.warm = false; },
      error => { entry.error = safeMessage(error); entry.warm = false; entry.lifecycle?.dispose(); for (const handle of entry.active.values()) void handle.cancel(); void log('lifecycle_error', { project: entry.state.project.id }); }, operation => entry.lane.run(operation));
    entry.warm = true; entry.verifiedAt = Date.now(); entry.error = undefined;
    if (entry.state.syncPending) await this.protectSource(entry);
  }
  async start(cwd: string): Promise<ProjectState> {
    const generation = this.generation, entry = await this.entry(cwd);
    this.checkExecution(entry, generation);
    return entry.lane.run(async () => { this.checkExecution(entry, generation); await this.ready(entry); this.checkExecution(entry, generation); await entry.lifecycle!.arm(); return entry.state; });
  }
  async run(input: RunInput, hooks: RunHooks = {}): Promise<ExecutionExit> {
    const generation = this.generation, entry = await this.entry(input.cwd);
    this.checkExecution(entry, generation);
    invariant(route(input.argv, entry.config.routing.commands) === 'remote', 'CONTROL_PLANE', 'This executable is a local control-plane command or is not in routing.commands. Use reroute local -- ... or configure the runtime command group.');
    return entry.lane.run(async () => {
      const id = randomUUID(); let release: (() => Promise<void>) | undefined; let handle: ExecutionHandle | undefined;
      let returnSyncStarted = false;
      const cancel = () => { if (handle) void handle.cancel(); };
      try {
        this.checkExecution(entry, generation);
        await this.ready(entry);
        this.checkExecution(entry, generation);
        invariant(!hooks.signal?.aborted, 'CANCELLED', 'Cancelled during runtime preparation');
        release = await entry.lifecycle!.acquire();
        await this.reconcile(entry);
        this.checkExecution(entry, generation);
        invariant(!hooks.signal?.aborted, 'CANCELLED', 'Cancelled during source synchronization');
        const cwd = await fs.realpath(input.cwd);
        await this.protectSource(entry);
        this.checkExecution(entry, generation);
        invariant(!hooks.signal?.aborted, 'CANCELLED', 'Cancelled before process startup');
        handle = await entry.provider.exec(entry.state.runtime!, { argv: mapArgv(input.argv, entry.state.project.root, entry.state.runtime!.root), cwd: remoteCwd(entry.state.project.root, cwd, entry.state.runtime!.root), env: { ...entry.config.runtime.env, ...input.env }, timeoutMs: input.timeoutMs });
        entry.active.set(id, handle); this.checkExecution(entry, generation); hooks.signal?.addEventListener('abort', cancel, { once: true });
        if (hooks.signal?.aborted) cancel();
        hooks.onHandle?.(handle);
        if (!hooks.onHandle) await Promise.race([handle.endInput(), handle.wait()]);
        await log('execution_started', { project: entry.state.project.id, execution: id });
        for await (const event of handle.events) await hooks.onOutput?.(event);
        const result = await handle.wait();
        // Lockfiles/formatters are reconciled even after nonzero exits and cancellation.
        returnSyncStarted = true;
        await this.reconcile(entry);
        entry.state.lastActivity = Date.now(); await this.store.save(entry.state);
        await log('execution_finished', { project: entry.state.project.id, execution: id, exit: result.code });
        return result;
      } catch (error) {
        if (handle) {
          await handle.cancel();
          if (!returnSyncStarted) await this.reconcile(entry);
        }
        throw error;
      } finally {
        hooks.signal?.removeEventListener('abort', cancel); entry.active.delete(id);
        if (release) await release();
      }
    }, hooks.signal);
  }
  async synchronize(cwd: string, acceptLocal = false): Promise<unknown> {
    const generation = this.generation, entry = await this.entry(cwd);
    this.checkExecution(entry, generation);
    return entry.lane.run(async () => {
      this.checkExecution(entry, generation);
      await this.ready(entry); this.checkExecution(entry, generation); const release = await entry.lifecycle!.acquire();
      try { return await this.reconcile(entry, acceptLocal); }
      finally { await release(); }
    });
  }
  async devStart(input: RunInput, port?: number): Promise<{ id: string; port?: number }> {
    const generation = this.generation, entry = await this.entry(input.cwd);
    this.checkExecution(entry, generation);
    invariant(route(input.argv, entry.config.routing.commands) === 'remote', 'CONTROL_PLANE', 'Dev commands must use a configured runtime executable');
    return entry.lane.run(async () => {
      this.checkExecution(entry, generation);
      invariant(!entry.dev, 'DEV_EXISTS', 'A dev session already exists. Use reroute dev stop first.');
      await this.ready(entry); this.checkExecution(entry, generation); const release = await entry.lifecycle!.acquire();
      const id = randomUUID(); let handle: ExecutionHandle | undefined;
      try {
        await this.reconcile(entry);
        this.checkExecution(entry, generation);
        const cwd = await fs.realpath(input.cwd);
        await this.protectSource(entry);
        this.checkExecution(entry, generation);
        handle = await entry.provider.exec(entry.state.runtime!, { ...input, argv: mapArgv(input.argv, entry.state.project.root, entry.state.runtime!.root), cwd: remoteCwd(entry.state.project.root, cwd, entry.state.runtime!.root), env: { ...entry.config.runtime.env, ...input.env } });
        entry.active.set(id, handle); this.checkExecution(entry, generation);
        await Promise.race([handle.endInput(), handle.wait()]);
        this.checkExecution(entry, generation);
      } catch (error) {
        try {
          if (handle) { await handle.cancel().catch(() => {}); await this.reconcile(entry); }
        } finally { entry.active.delete(id); await release(); }
        throw error;
      }
      const devHandle = handle;
      const logs = new LogTail();
      const done = (async () => {
        try { for await (const event of devHandle.events) logs.push(event.stream, event.data); return await devHandle.wait(); }
        catch (error) { logs.push('reroute', Buffer.from(safeMessage(error))); throw error; }
        finally {
          if (entry.dev?.syncTimer) clearInterval(entry.dev.syncTimer);
          entry.active.delete(id);
          await entry.lane.run(async () => { await this.reconcile(entry); }).catch(error => { logs.push('reroute', Buffer.from(safeMessage(error))); });
          await release().catch(error => { entry.error = safeMessage(error); });
        }
      })(); void done.catch(() => {});
      const dev: DevSession = { id, handle: devHandle, logs, done, port }; entry.dev = dev;
      let syncing = false;
      dev.syncTimer = setInterval(() => {
        if (syncing) return; syncing = true;
        void entry.lane.run(() => this.reconcile(entry)).catch(error => {
          entry.error = safeMessage(error); logs.push('reroute', Buffer.from(entry.error)); void devHandle.cancel();
        }).finally(() => { syncing = false; });
      }, 2000); dev.syncTimer.unref();
      return { id, port };
    });
  }
  async devLogs(cwd: string): Promise<string> { const entry = await this.entry(cwd, true); invariant(entry.dev, 'NO_DEV', 'No dev session in this daemon'); return entry.dev.logs.read(); }
  async devStop(cwd: string): Promise<void> {
    const entry = await this.entry(cwd, true); if (!entry.dev) return;
    const dev = entry.dev; clearInterval(dev.syncTimer); await dev.handle.cancel(); await dev.done.catch(() => {}); entry.dev = undefined;
  }
  async devPreview(cwd: string): Promise<string> {
    const entry = await this.entry(cwd);
    invariant(entry.dev?.port && entry.state.runtime, 'PREVIEW_PORT', 'Start reroute dev --port PORT -- COMMAND before requesting a preview');
    invariant(entry.provider.preview, 'UNSUPPORTED_CAPABILITY', 'This provider has no preview support');
    return entry.provider.preview(entry.state.runtime, entry.dev.port);
  }
  async stop(cwd: string, destroy = false): Promise<void> {
    const generation = ++this.generation, entry = await this.entry(cwd, true);
    entry.generation = Math.max(entry.generation, generation); entry.stopping++;
    try {
      if (entry.dev?.syncTimer) clearInterval(entry.dev.syncTimer);
      // Cancel every handle before waiting for dev cleanup, which needs this lane.
      await Promise.all([...entry.active.values()].map(handle => handle.cancel()));
      await this.devStop(cwd);
      await entry.lane.run(async () => {
        if (!entry.state.runtime) return;
        // Never discard generated source if cancellation/startup reconciliation failed.
        const status = await entry.provider.status(entry.state.runtime);
        invariant(status !== 'unknown', 'RUNTIME_UNKNOWN', 'Runtime status could not be established; no stop or destruction was attempted');
        const resumable = (status === 'stopped' || status === 'archived') && !!entry.provider.restore;
        invariant(status === 'running' || resumable || (!entry.state.syncPending && (!destroy || status === 'missing')), 'SOURCE_PENDING', 'Resume the original runtime with native provider tools and synchronize before destroying it');
        if (status === 'running' || resumable) { await this.ready(entry, true); await this.reconcile(entry); }
        entry.lifecycle?.dispose(); entry.pendingRelease = undefined;
        if (destroy) { await entry.provider.destroy(entry.state.runtime); delete entry.state.runtime; }
        else await entry.provider.applyIdlePolicy(entry.state.runtime, { active: false, minutes: 0 });
        entry.warm = false; await this.store.save(entry.state);
      });
    } finally { entry.stopping--; }
  }
  async disable(cwd: string): Promise<void> {
    const entry = await this.entry(cwd, true); entry.stopping++;
    try {
      await this.stop(cwd);
      entry.state.enabled = false; await this.store.save(entry.state); this.entries.delete(entry.state.project.id);
    } finally { entry.stopping--; }
  }
  async status(cwd: string): Promise<unknown> {
    const state = await findProject(cwd); if (!state) return { enabled: false, message: 'No Reroute project here' };
    const entry = await this.entry(cwd, true);
    let status = 'not-created'; if (entry.state.runtime) status = await entry.provider.status(entry.state.runtime);
    return { enabled: state.enabled, project: state.project, provider: state.provider, runtime: entry.state.runtime?.id, status, active: entry.active.size, dev: entry.dev?.id, syncPending: entry.state.syncPending === true, warning: entry.error };
  }
  shutdown(): Promise<void> {
    this.closing = true;
    return this.shutdownTask ??= this.shutdownEntries();
  }
  private async shutdownEntries(): Promise<void> {
    await Promise.all([...this.entries.values()].map(async pending => {
      const entry = await pending.catch(() => undefined); if (!entry) return;
      if (entry.dev?.syncTimer) clearInterval(entry.dev.syncTimer);
      await Promise.all([...entry.active.values()].map(handle => handle.cancel().catch(() => {})));
      await entry.dev?.done.catch(() => {});
      await entry.lane.run(async () => {
        try {
          if (entry.state.runtime) {
            const nativeIdle = entry.provider.capabilities.nativeIdle;
            if (entry.state.syncPending || (!nativeIdle && entry.provider.capabilities.idle !== 'none')) {
              const status = await entry.provider.status(entry.state.runtime);
              invariant(status !== 'unknown', 'RUNTIME_UNKNOWN', 'Cannot establish runtime status during shutdown');
              if (status === 'running') { await this.ready(entry, true); await this.reconcile(entry); }
              else invariant(!entry.state.syncPending, 'SOURCE_PENDING', 'Pending source remains on the original runtime; no idle cleanup was armed');
            }
            await entry.provider.applyIdlePolicy(entry.state.runtime, { active: false, minutes: nativeIdle ? entry.config.runtime.idleTimeoutMinutes : 0 });
          }
        } finally { entry.lifecycle?.dispose(); entry.pendingRelease = undefined; }
      }).catch(async error => { entry.error = safeMessage(error); await log('shutdown_needs_attention', { project: entry.state.project.id }); });
    }));
  }
  async recover(): Promise<void> {
    for (const state of await this.store.all()) {
      if (!state.runtime || !state.enabled) continue;
      try {
        const entry = await this.entry(state.project.root);
        await entry.lane.run(async () => {
          if (this.closing || entry.stopping || entry.lifecycle || entry.active.size) return;
          // A stale user index must not recover another identity/provider at this path.
          if (entry.state.project.id !== state.project.id || entry.state.provider !== state.provider || entry.state.runtime?.id !== state.runtime!.id) return;
          const status = await entry.provider.status(state.runtime!);
          if (status === 'running') { await this.ready(entry); await entry.lifecycle!.arm(); }
          else if (entry.state.syncPending) entry.error = 'Original runtime has pending source. Run reroute sync to resume a supported stopped/archived runtime; otherwise recover it with native tools. No replacement was created.';
        });
      } catch { await log('recovery_needs_attention', { project: state.project.id }); }
    }
  }
}
