import { posix } from 'node:path';
import { assertCapabilities } from '../config/config.js';
import { RerouteError, invariant } from '../core/errors.js';
import { spawnRaw, shellCommand, capture } from '../platform/process.js';
import { RemoteProvider, runtimeRef, rawCapture, VERIFY_WORKSPACE } from './common.js';
export function sshArgs(options) {
    invariant(typeof options.host === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:@\[\]-]*$/.test(options.host), 'SSH_HOST', 'Provide a valid SSH host or ~/.ssh/config alias with --host');
    if (options.user)
        invariant(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(options.user), 'SSH_USER', 'Invalid SSH user');
    if (options.port !== undefined)
        invariant(Number.isInteger(options.port) && options.port > 0 && options.port <= 65535, 'SSH_PORT', 'Invalid SSH port');
    return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
        ...(options.port ? ['-p', String(options.port)] : []), ...(options.user ? ['-l', options.user] : []), options.host];
}
const CHECK_ROOT = `import os,sys
p=os.path.abspath(os.path.expanduser(sys.argv[1]))
assert p==sys.argv[1] and p==os.path.abspath(os.path.expanduser(sys.argv[4])), 'wrong runtime root'
assert os.path.realpath(p)==p, 'symlink runtime root'`;
const DESTROY_WORKSPACE = `${CHECK_ROOT}
try: os.lstat(p)
except FileNotFoundError: sys.exit(0)
${VERIFY_WORKSPACE}
import shutil
shutil.rmtree(p)`;
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
    root(projectId) { return `${(this.options.remoteRoot ?? '~/.cache/reroute/workspaces').replace(/\/$/, '')}/${projectId}`; }
    assertRuntime(runtime) {
        invariant(runtime.provider === this.id, 'WRONG_PROVIDER', 'Runtime belongs to another provider');
        invariant(runtime.id === runtime.projectId && !!runtime.projectId && !['.', '..'].includes(runtime.projectId) && posix.basename(runtime.projectId) === runtime.projectId, 'WRONG_PROJECT', 'Invalid SSH project runtime identity');
        invariant(posix.isAbsolute(runtime.root) && posix.basename(runtime.root) === runtime.projectId, 'WORKSPACE_IDENTITY', 'Invalid SSH workspace root');
    }
    bridge = async (runtime, argv) => {
        await this.verifyWorkspace(runtime);
        return this.launch(runtime, argv);
    };
    async verifyWorkspace(runtime) {
        this.assertRuntime(runtime);
        const generation = runtime.meta.workspaceGeneration;
        invariant(typeof generation === 'string' && /^[a-f0-9-]{36}$/.test(generation), 'WORKSPACE_IDENTITY', 'Original workspace generation is missing; recover its recorded identity before restoring');
        let output;
        try {
            output = await rawCapture(await this.launch(runtime, ['python3', '-c', `${CHECK_ROOT}\n${VERIFY_WORKSPACE}`, runtime.root, runtime.projectId, generation, this.root(runtime.projectId)]));
        }
        catch (error) {
            if (error instanceof RerouteError && error.code === 'REMOTE_BOOTSTRAP')
                throw new RerouteError('WORKSPACE_IDENTITY', 'Original SSH workspace or owner marker is missing, unsafe or changed; recover the original disk without initializing a replacement');
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(output.trim());
        }
        catch {
            throw new RerouteError('PROVIDER_WIRE', 'Invalid workspace verification response');
        }
        invariant(parsed.root === runtime.root && parsed.projectId === runtime.projectId && parsed.generation === generation, 'WORKSPACE_IDENTITY', 'Original SSH workspace identity changed');
        return runtime;
    }
    async ensureReady(project, spec, previous) {
        assertCapabilities(spec, this.capabilities, this.id);
        const runtime = previous ?? runtimeRef(this.id, project, project.id, this.root(project.id));
        invariant(runtime.projectId === project.id, 'WRONG_PROJECT', 'Runtime belongs to another project');
        if (previous)
            return this.verifyWorkspace(runtime);
        if (this.options.bootstrap)
            await rawCapture(await this.launch(runtime, ['sh', '-c', this.options.bootstrap]), 10 * 60000);
        return this.initialize(runtime);
    }
    async launch(_runtime, argv) { return spawnRaw('ssh', [...sshArgs(this.options), shellCommand(argv)]); }
    async status(runtime) {
        this.assertRuntime(runtime);
        const result = await capture('ssh', [...sshArgs(this.options), shellCommand(['python3', '-c', `${CHECK_ROOT}
import stat
try: mode=os.lstat(p).st_mode
except FileNotFoundError: print('missing'); sys.exit(0)
assert stat.S_ISDIR(mode), 'not a workspace directory'
print('running')`, runtime.root, runtime.projectId, '', this.root(runtime.projectId)])], { timeoutMs: 20000 });
        return result.code === 0 && result.stdout.trim() === 'running' ? 'running' : result.code === 0 && result.stdout.trim() === 'missing' ? 'missing' : 'unknown';
    }
    async applyIdlePolicy(runtime, policy) {
        if (!policy.active) {
            const forward = this.forwards.get(runtime.id);
            if (forward) {
                await forward.process.kill();
                if (this.forwards.get(runtime.id) === forward)
                    this.forwards.delete(runtime.id);
            }
        }
        // Reroute owns a directory, never the SSH machine. No VM stop or shutdown here.
    }
    async destroy(runtime) {
        this.assertRuntime(runtime);
        const generation = runtime.meta.workspaceGeneration;
        invariant(typeof generation === 'string' && /^[a-f0-9-]{36}$/.test(generation), 'WORKSPACE_IDENTITY', 'Original workspace generation is missing; recover its recorded identity before destroying');
        // Verify and delete in one remote command; only lstat ENOENT is an idempotent absence.
        await rawCapture(await this.launch(runtime, ['python3', '-c', DESTROY_WORKSPACE, runtime.root, runtime.projectId, generation, this.root(runtime.projectId)]));
        await this.applyIdlePolicy(runtime, { active: false, minutes: 0 });
    }
    async preview(runtime, port) {
        invariant(Number.isInteger(port) && port > 0 && port <= 65535, 'PREVIEW_PORT', 'Invalid preview port');
        const previous = this.forwards.get(runtime.id);
        if (previous && previous.port !== port) {
            await previous.process.kill();
            if (this.forwards.get(runtime.id) === previous)
                this.forwards.delete(runtime.id);
        }
        if (!this.forwards.has(runtime.id)) {
            const args = sshArgs(this.options);
            args.splice(0, 1, '-N');
            args.splice(args.length - 1, 0, '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:127.0.0.1:${port}`);
            const forward = spawnRaw('ssh', args);
            await forward.closeInput();
            const entry = { port, process: forward };
            this.forwards.set(runtime.id, entry);
            void (async () => { try {
                for await (const _event of forward.events) { /* drain SSH diagnostics */ }
            }
            finally {
                if (this.forwards.get(runtime.id) === entry)
                    this.forwards.delete(runtime.id);
            } })().catch(() => { });
            const ended = await Promise.race([forward.wait().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]);
            invariant(!ended, 'PREVIEW_FORWARD', 'SSH forwarding failed. Check whether the local port is already in use.');
        }
        return `http://127.0.0.1:${port}`;
    }
}
