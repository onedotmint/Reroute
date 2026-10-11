import { assertCapabilities } from '../config/config.js';
import { invariant } from '../core/errors.js';
import { spawnRaw, shellCommand, capture } from '../platform/process.js';
import { RemoteProvider, runtimeRef, rawCapture, DESTROY_DIRECTORY } from './common.js';
export function sshArgs(options) {
    invariant(typeof options.host === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:@\[\]-]*$/.test(options.host), 'SSH_HOST', 'Provide a valid SSH host or ~/.ssh/config alias with --host');
    if (options.user)
        invariant(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.user), 'SSH_USER', 'Invalid SSH user');
    if (options.port !== undefined)
        invariant(Number.isInteger(options.port) && options.port > 0 && options.port <= 65535, 'SSH_PORT', 'Invalid SSH port');
    return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
        ...(options.port ? ['-p', String(options.port)] : []), ...(options.user ? ['-l', options.user] : []), options.host];
}
export class SshProvider extends RemoteProvider {
    options;
    id = 'ssh';
    capabilities = { resources: [], persistence: 'disk', idle: 'none', preview: true, stdin: true, nativeIdle: false };
    forwards = new Map();
    constructor(options) {
        super();
        this.options = options;
        sshArgs(options);
    }
    async ensureReady(project, spec, previous) {
        assertCapabilities(spec, this.capabilities, this.id);
        const runtime = previous ?? runtimeRef(this.id, project, project.id, `${(this.options.remoteRoot ?? '~/.cache/reroute/workspaces').replace(/\/$/, '')}/${project.id}`);
        invariant(runtime.projectId === project.id, 'WRONG_PROJECT', 'Runtime belongs to another project');
        if (!previous && this.options.bootstrap)
            await rawCapture(await this.launch(runtime, ['sh', '-c', this.options.bootstrap]));
        return this.initialize(runtime);
    }
    async launch(_runtime, argv) { return spawnRaw('ssh', [...sshArgs(this.options), shellCommand(argv)]); }
    async status(runtime) {
        const result = await capture('ssh', [...sshArgs(this.options), shellCommand(['test', '-d', runtime.root])], { timeoutMs: 20000 });
        return result.code === 0 ? 'running' : result.code === 1 ? 'missing' : 'unknown';
    }
    async applyIdlePolicy(runtime, policy) {
        if (!policy.active) {
            const forward = this.forwards.get(runtime.id);
            if (forward) {
                await forward.kill();
                this.forwards.delete(runtime.id);
            }
        }
        // Reroute owns a directory, never the SSH machine. No VM stop or shutdown here.
    }
    async destroy(runtime) {
        await this.applyIdlePolicy(runtime, { active: false, minutes: 0 });
        await rawCapture(await this.launch(runtime, ['python3', '-c', DESTROY_DIRECTORY, runtime.root, runtime.projectId]));
    }
    async preview(runtime, port) {
        if (!this.forwards.has(runtime.id)) {
            const args = sshArgs(this.options);
            args.splice(0, 1, '-N');
            args.splice(args.length - 1, 0, '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${port}`);
            const forward = spawnRaw('ssh', args);
            await forward.closeInput();
            void (async () => { try {
                for await (const _event of forward.events) { /* drain SSH diagnostics */ }
            }
            finally {
                this.forwards.delete(runtime.id);
            } })().catch(() => { });
            const ended = await Promise.race([forward.wait().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
            invariant(!ended, 'PREVIEW_FORWARD', 'SSH forwarding failed. Check whether the local port is already in use.');
            this.forwards.set(runtime.id, forward);
        }
        return `http://127.0.0.1:${port}`;
    }
}
