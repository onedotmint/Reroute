import { assertCapabilities } from '../config/config.js';
import { invariant, RerouteError } from '../core/errors.js';
import { spawnRaw, shellCommand } from '../platform/process.js';
import { RemoteProvider, loadSdk, sdkMissing, runtimeRef } from './common.js';
import { sshArgs } from './ssh.js';
const GPU_TYPES = ['H100', 'H200', 'B300', 'RTX-PRO-6000', 'RTX-4090', 'RTX-5090', 'MI355X'];
export class DaytonaProvider extends RemoteProvider {
    options;
    sdkLoader;
    id = 'daytona';
    capabilities = { resources: ['cpu', 'memoryMiB', 'diskGiB', 'gpu', 'region', 'image', 'spot'], persistence: 'disk', idle: 'stop', preview: true, stdin: true, nativeIdle: true };
    client;
    sdkModule;
    access = new Map();
    constructor(options = {}, sdkLoader = () => loadSdk('@daytona/sdk')) {
        super();
        this.options = options;
        this.sdkLoader = sdkLoader;
    }
    async sdk(region) {
        const sdk = this.sdkModule ??= await this.sdkLoader();
        return this.client ??= new sdk.Daytona({ target: region ?? this.options.target, requestTimeoutMs: 30000 });
    }
    missing(error) {
        return !!this.sdkModule && sdkMissing(error, this.sdkModule.DaytonaNotFoundError);
    }
    validateTransport() {
        if (process.env.DAYTONA_API_URL) {
            let endpoint;
            try {
                endpoint = new URL(process.env.DAYTONA_API_URL);
            }
            catch {
                throw new RerouteError('DAYTONA_SSH_HOST', 'DAYTONA_API_URL must be an absolute URL; custom installations require providers.daytona.sshHost');
            }
            invariant(endpoint.origin === 'https://app.daytona.io' || !!this.options.sshHost, 'DAYTONA_SSH_HOST', 'Custom Daytona installations require providers.daytona.sshHost before creating a resource');
        }
        sshArgs({ host: this.options.sshHost ?? 'ssh.app.daytona.io', port: this.options.sshPort });
    }
    validateSpec(spec) {
        this.validateTransport();
        assertCapabilities(spec, this.capabilities, this.id);
        invariant(!spec.gpu && !spec.spot, 'UNSUPPORTED_CAPABILITY', 'Daytona GPU/Spot sandboxes are ephemeral and cannot safely stop or restore; use a CPU container');
        invariant(this.options.autoDeleteMinutes === undefined || this.options.autoDeleteMinutes === -1, 'UNSUPPORTED_CAPABILITY', 'Daytona autoDeleteMinutes must be -1 (disabled) to preserve source');
        invariant(!(this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB)), 'UNSUPPORTED_CAPABILITY', 'Daytona snapshot resources are fixed; omit portable resource/image overrides or use an image');
    }
    validateRuntime(runtime, projectId = runtime.projectId) {
        invariant(runtime.provider === this.id && runtime.projectId === projectId && typeof runtime.id === 'string' && runtime.id.length > 0, 'WRONG_RUNTIME', 'Daytona runtime must match the original project, provider and sandbox ID');
    }
    validateSandbox(sandbox, projectId, expectedId) {
        invariant(sandbox.labels?.['reroute.project'] === projectId && (!expectedId || sandbox.id === expectedId), 'WRONG_RUNTIME', 'Daytona sandbox ID/ownership label does not match; inspect the original sandbox before retrying');
        invariant(sandbox.sandboxClass === 'container' && sandbox.gpu === 0 && sandbox.spot === false && sandbox.autoDeleteInterval !== 0, 'UNSUPPORTED_CAPABILITY', 'Daytona lifecycle requires a non-ephemeral CPU container (no GPU, Spot or VM)');
        invariant(!sandbox.autoDestroyAt, 'UNSUPPORTED_CAPABILITY', 'Daytona sandbox has a hard TTL; remove its native TTL before restoring or managing it');
    }
    async owned(runtime) {
        this.validateRuntime(runtime);
        const sandbox = await (await this.sdk()).get(runtime.id);
        this.validateSandbox(sandbox, runtime.projectId, runtime.id);
        return sandbox;
    }
    async preserve(sandbox, minutes) {
        await sandbox.setAutoDeleteInterval(-1);
        await sandbox.setAutostopInterval(Math.max(1, Math.ceil(minutes)));
    }
    async start(sandbox) {
        if (sandbox.state !== 'started') {
            invariant(sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', 'Daytona sandbox is not safely startable; inspect its native state before retrying');
            await sandbox.start(60);
        }
        invariant(sandbox.state === 'started', 'PROVIDER_WIRE', 'Daytona sandbox is not ready; wait for its native start operation before retrying');
    }
    async restore(project, spec, runtime) {
        this.validateSpec(spec);
        this.validateRuntime(runtime, project.id);
        invariant(typeof runtime.meta.workspaceGeneration === 'string' && /^[a-f0-9-]{36}$/.test(runtime.meta.workspaceGeneration), 'WORKSPACE_IDENTITY', 'Original workspace generation is missing; recover its recorded identity before restoring');
        const sandbox = await this.owned(runtime);
        invariant(sandbox.state === 'started' || sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', 'Daytona sandbox is not safely startable; inspect its native state before retrying');
        await this.preserve(sandbox, Math.max(5, spec.idleTimeoutMinutes));
        await this.start(sandbox);
        return this.verifyWorkspace(runtime);
    }
    async ensureReady(project, spec, previous) {
        this.validateSpec(spec);
        if (previous)
            return this.restore(project, spec, previous);
        const client = await this.sdk(spec.region);
        let sandbox;
        // Stable sandbox name makes a daemon crash between create and state-write recoverable.
        try {
            sandbox = await client.get(`reroute-${project.id}`);
        }
        catch (error) {
            if (!this.missing(error))
                throw error;
        }
        if (!sandbox) {
            if (this.options.snapshot) {
                const snapshot = await client.snapshot.get(this.options.snapshot);
                invariant(snapshot.sandboxClass === 'container' && !!snapshot.resources && !snapshot.resources.gpu, 'UNSUPPORTED_CAPABILITY', 'Daytona snapshot must have verified CPU-container metadata before creation; GPU/VM/unknown snapshots are unsupported');
            }
            const base = {
                name: `reroute-${project.id}`, labels: { 'reroute.project': project.id }, envVars: spec.env,
                autoStopInterval: Math.max(5, Math.ceil(spec.idleTimeoutMinutes)), autoDeleteInterval: -1, ttlMinutes: 0, ephemeral: false, spot: false,
                ...(this.options.autoArchiveMinutes !== undefined ? { autoArchiveInterval: this.options.autoArchiveMinutes } : {}),
                ...(this.options.volumes ? { volumes: this.options.volumes } : {})
            };
            let params = { ...base, ...(this.options.snapshot ? { snapshot: this.options.snapshot } : {}) };
            if (!this.options.snapshot && (spec.image || spec.cpu || spec.memoryMiB || spec.diskGiB)) {
                params = { ...base, image: spec.image ?? 'python:3.12-slim',
                    resources: { cpu: spec.cpu, memory: spec.memoryMiB === undefined ? undefined : spec.memoryMiB / 1024, disk: spec.diskGiB } };
            }
            sandbox = await client.create(params, { timeout: 60 });
            this.validateSandbox(sandbox, project.id);
            invariant(sandbox.state === 'started', 'PROVIDER_WIRE', 'Daytona sandbox is not ready; inspect its native create operation before retrying');
        }
        else {
            this.validateSandbox(sandbox, project.id);
            throw new RerouteError('WORKSPACE_IDENTITY', 'A Daytona sandbox already exists without a recorded runtime/generation. Recover its original project state or back up its files using native tools; Reroute will not initialize or replace its workspace.');
        }
        return this.initialize(runtimeRef(this.id, project, sandbox.id, `/tmp/reroute/${project.id}`));
    }
    async launch(runtime, argv) {
        this.validateRuntime(runtime);
        this.validateTransport();
        let access = this.access.get(runtime.id);
        if (!access || access.expires < Date.now()) {
            const token = await (await this.owned(runtime)).createSshAccess(30);
            invariant(typeof token.token === 'string' && /^[A-Za-z0-9._-]+$/.test(token.token), 'PROVIDER_WIRE', 'Invalid short-lived Daytona SSH access token');
            const expires = new Date(token.expiresAt).getTime();
            invariant(Number.isFinite(expires) && expires > Date.now() + 30000, 'PROVIDER_WIRE', 'Daytona SSH access is expired or too short-lived; retry native authentication');
            access = { token: token.token, expires: Math.min(Date.now() + 20 * 60000, expires - 30000) };
            this.access.set(runtime.id, access);
        }
        const host = String(this.options.sshHost ?? 'ssh.app.daytona.io');
        // Short-lived token stays in memory; it is never written into runtime metadata or logs.
        return spawnRaw('ssh', [...sshArgs({ host, user: access.token, port: this.options.sshPort }), shellCommand(argv)]);
    }
    async status(runtime) {
        this.validateRuntime(runtime);
        try {
            const state = (await this.owned(runtime)).state;
            return state === 'started' ? 'running' : state === 'archived' ? 'archived' : state === 'stopped' ? 'stopped' : 'unknown';
        }
        catch (error) {
            if (this.missing(error))
                return 'missing';
            throw error;
        }
    }
    async applyIdlePolicy(runtime, policy) {
        this.validateRuntime(runtime);
        const sandbox = await this.owned(runtime);
        invariant(policy.active ? sandbox.state === 'started' : sandbox.state === 'started' || sandbox.state === 'stopped' || sandbox.state === 'archived', 'PROVIDER_WIRE', 'Daytona sandbox state is unsafe for lifecycle management; inspect its native state');
        // A finite native timer survives daemon failure; active leases reset real last activity.
        await this.preserve(sandbox, policy.active ? Math.max(5, policy.minutes) : policy.minutes);
        if (policy.active)
            await sandbox.refreshActivity();
        if (!policy.active && policy.minutes === 0 && sandbox.state === 'started')
            await sandbox.stop(60);
    }
    async destroy(runtime) {
        this.validateRuntime(runtime);
        try {
            const client = await this.sdk();
            await client.delete(await this.owned(runtime), 60);
        }
        catch (error) {
            if (!this.missing(error))
                throw error;
        }
        this.access.delete(runtime.id);
    }
    async preview(runtime, port) {
        this.validateRuntime(runtime);
        const result = await (await this.owned(runtime)).getSignedPreviewUrl(port, 300);
        invariant(typeof result.url === 'string' && result.url.startsWith('https://'), 'PROVIDER_WIRE', 'Invalid Daytona preview URL');
        return result.url;
    }
}
