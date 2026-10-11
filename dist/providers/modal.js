import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import { AsyncQueue } from '../core/queue.js';
import { RemoteProvider, loadSdk, missing, runtimeRef } from './common.js';
export class ModalProvider extends RemoteProvider {
    options;
    sdkLoader;
    id = 'modal';
    capabilities = { resources: ['cpu', 'memoryMiB', 'gpu', 'region', 'image'], persistence: 'volume', idle: 'terminate', preview: true, stdin: true, nativeIdle: false };
    client;
    sandboxes = new Map();
    constructor(options = {}, sdkLoader = () => loadSdk('modal')) {
        super();
        this.options = options;
        this.sdkLoader = sdkLoader;
    }
    async sdk() { return this.client ??= new (await this.sdkLoader()).ModalClient(); }
    async sandbox(id) {
        let sandbox = this.sandboxes.get(id);
        if (!sandbox) {
            sandbox = await (await this.sdk()).sandboxes.fromId(id);
            this.sandboxes.set(id, sandbox);
        }
        return sandbox;
    }
    async ensureReady(project, spec, previous) {
        assertCapabilities(spec, this.capabilities, this.id);
        const client = await this.sdk();
        const appName = String(this.options.app ?? 'reroute');
        let sandbox;
        try {
            sandbox = previous ? await this.sandbox(previous.id) : await client.sandboxes.fromName(appName, `reroute-${project.id}`);
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
        if (sandbox && await sandbox.poll() !== null) {
            this.sandboxes.delete(sandbox.sandboxId);
            sandbox = undefined;
        }
        const mount = String(this.options.volumeMount ?? '/workspace');
        invariant(mount.startsWith('/') && !mount.includes('..'), 'CONFIG', 'Modal volumeMount must be an absolute path');
        if (!sandbox) {
            const app = await client.apps.fromName(appName, { createIfMissing: true });
            const image = client.images.fromRegistry(spec.image ?? 'python:3.12-slim');
            const volume = await client.volumes.fromName(String(this.options.volume ?? `reroute-${project.id}`), { createIfMissing: true });
            const secrets = await Promise.all((this.options.secrets ?? []).map(name => client.secrets.fromName(name)));
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
    async launch(runtime, argv) {
        const process = await (await this.sandbox(runtime.id)).exec(argv, { mode: 'binary', stdout: 'pipe', stderr: 'pipe', timeoutMs: 0 });
        invariant(process.stdin && typeof process.stdin.getWriter === 'function' && typeof process.closeStdin === 'function', 'SDK_PROTOCOL', 'Modal SDK requires writable stdin and independent closeStdin (modal@0.11.0)');
        const writer = process.stdin.getWriter();
        const events = new AsyncQueue();
        let inputClosed = false;
        const pump = async (stream, name) => { for await (const data of stream)
            events.push({ type: 'output', stream: name, data: Buffer.from(data) }); };
        const done = Promise.all([pump(process.stdout, 'stdout'), pump(process.stderr, 'stderr'), process.wait()]).then(([, , code]) => { events.end(); return code; }, error => { events.end(error); throw error; });
        void done.catch(() => { });
        const close = async () => { if (!inputClosed) {
            inputClosed = true;
            await writer.close();
        } };
        return { events, write: async (data) => { await writer.write(data); }, closeInput: close, wait: () => done,
            // SDK closeStdin bypasses its WritableStream queue; worker EOF kills its own group.
            kill: async () => { inputClosed = true; await process.closeStdin(); await done.catch(() => { }); } };
    }
    async status(runtime) {
        try {
            return await (await this.sandbox(runtime.id)).poll() === null ? 'running' : 'stopped';
        }
        catch (error) {
            if (missing(error))
                return 'missing';
            throw error;
        }
    }
    async applyIdlePolicy(runtime, policy) {
        if (!policy.active && policy.minutes === 0) {
            await (await this.sandbox(runtime.id)).terminate();
            this.sandboxes.delete(runtime.id);
        }
        // Core owns idle deadline. Modal has terminate/recreate, not fictional VM stop/start.
    }
    async destroy(runtime) {
        try {
            await (await this.sandbox(runtime.id)).terminate();
        }
        catch (error) {
            if (!missing(error))
                throw error;
        }
        this.sandboxes.delete(runtime.id); // Named volume retained intentionally; deletion requires native Modal confirmation.
    }
    async preview(runtime, port) {
        const tunnels = await (await this.sandbox(runtime.id)).tunnels();
        invariant(typeof tunnels[port]?.url === 'string', 'UNSUPPORTED_CAPABILITY', `Modal port ${port} was not declared before sandbox creation. Add it to providers.modal.ports.`);
        return tunnels[port].url;
    }
}
