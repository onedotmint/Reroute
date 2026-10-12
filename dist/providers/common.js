import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { RerouteError, invariant } from '../core/errors.js';
import { home } from '../platform/files.js';
import { execute, fileTransport } from './channel.js';
/** SDKs are installed in a user-owned optional tool directory, not in every project. */
export async function loadSdk(name) {
    const resolver = createRequire(join(home(), 'sdk', 'package.json'));
    let location;
    try {
        location = resolver.resolve(name);
    }
    catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND')
            throw error;
        throw new RerouteError('SDK_MISSING', `Missing ${name}. Run reroute setup --install-sdk ${name === '@daytona/sdk' ? 'daytona' : name}.`);
    }
    return await import(pathToFileURL(location).href);
}
/** Daytona missing detection uses the loaded SDK's class, not names or transport-shaped objects. */
export function sdkMissing(error, notFound) {
    return error instanceof notFound && error.statusCode === 404;
}
export function missing(error) {
    if (!error || typeof error !== 'object')
        return false;
    const e = error;
    return e.status === 404 || e.statusCode === 404 || e.response?.status === 404 || e.name === 'NotFoundError' || e.name === 'SandboxNotFoundError';
}
export function runtimeRef(provider, project, id, root, meta = {}) {
    invariant(typeof id === 'string' && id.length > 0 && id.length < 300, 'PROVIDER_WIRE', 'Provider returned an invalid runtime identity');
    return { provider, id, root, projectId: project.id, meta };
}
export async function rawCapture(raw, timeoutMs = 60000) {
    let timer;
    const operation = (async () => {
        await raw.closeInput();
        let text = '', bytes = 0;
        for await (const event of raw.events) {
            bytes += event.data.length;
            invariant(bytes < 1024 * 1024, 'CONTROL_OUTPUT_LIMIT', 'Remote control output exceeded its limit');
            if (event.stream === 'stdout')
                text += event.data.toString();
        }
        invariant(await raw.wait() === 0, 'REMOTE_BOOTSTRAP', 'Remote bootstrap failed. Check the configured image, Python 3, filesystem permissions and native provider connectivity.');
        return text;
    })();
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new RerouteError('CONTROL_TIMEOUT', 'Remote preparation timed out; inspect native connectivity/Python/filesystem, then retry. No local fallback was used.', 124)), timeoutMs);
            })]);
    }
    catch (error) {
        void raw.kill().catch(() => { });
        throw error;
    }
    finally {
        clearTimeout(timer);
    }
}
export const INITIALIZE = `import os,json,sys,uuid
p=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]
assert os.path.realpath(p)==p, 'symlink runtime root'
os.makedirs(p,mode=0o700,exist_ok=True)
s=os.path.join(p,'.reroute-runtime'); assert os.path.realpath(s)==s, 'symlink owner directory'
os.makedirs(s,mode=0o700,exist_ok=True)
f=os.path.join(s,'owner.json'); assert os.path.realpath(f)==f, 'symlink owner marker'
if os.path.exists(f):
 data=json.load(open(f)); assert data['projectId']==identity, 'runtime already owned'
else:
 data={'projectId':identity,'generation':str(uuid.uuid4())}
 with open(f,'x') as o: json.dump(data,o)
if 'generation' not in data:
 data['generation']=str(uuid.uuid4())
 with open(f,'w') as o: json.dump(data,o)
print(json.dumps({'root':p,'generation':data['generation']}))`;
export const VERIFY_WORKSPACE = `import os,json,sys
p=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]; generation=sys.argv[3]
assert os.path.realpath(p)==p and os.path.isdir(p), 'missing or symlink runtime root'
s=os.path.join(p,'.reroute-runtime'); f=os.path.join(s,'owner.json')
assert os.path.realpath(s)==s and os.path.realpath(f)==f, 'symlink owner marker'
with open(f) as o: data=json.load(o)
assert data['projectId']==identity and data['generation']==generation, 'workspace identity changed'
print(json.dumps({'root':p,'projectId':data['projectId'],'generation':data['generation']}))`;
export class RemoteProvider {
    bridge = async (runtime, argv) => { await this.verifyWorkspace(runtime); return this.launch(runtime, argv); };
    exec(runtime, request) { return execute(this.bridge, runtime, request); }
    files(runtime) { return fileTransport(this.bridge, runtime); }
    async verifyWorkspace(runtime) {
        const generation = runtime.meta.workspaceGeneration;
        invariant(typeof generation === 'string' && /^[a-f0-9-]{36}$/.test(generation), 'WORKSPACE_IDENTITY', 'Original workspace generation is missing; recover its recorded identity before restoring');
        let output;
        try {
            output = await rawCapture(await this.launch(runtime, ['python3', '-c', VERIFY_WORKSPACE, runtime.root, runtime.projectId, generation]));
        }
        catch (error) {
            if (error instanceof RerouteError && error.code === 'REMOTE_BOOTSTRAP')
                throw new RerouteError('WORKSPACE_IDENTITY', 'Original workspace or owner marker is missing, unsafe or changed; inspect the original sandbox without initializing a replacement');
            throw error;
        }
        let parsed;
        try {
            parsed = JSON.parse(output.trim());
        }
        catch {
            throw new RerouteError('PROVIDER_WIRE', 'Invalid workspace verification response');
        }
        invariant(parsed.root === runtime.root && parsed.projectId === runtime.projectId && parsed.generation === generation, 'WORKSPACE_IDENTITY', 'Original workspace identity changed; restore the original owner marker and disk before retrying');
        return runtime;
    }
    async initialize(runtime) {
        const output = (await rawCapture(await this.launch(runtime, ['python3', '-c', INITIALIZE, runtime.root, runtime.projectId]))).trim();
        let parsed;
        try {
            parsed = JSON.parse(output);
        }
        catch {
            throw new RerouteError('PROVIDER_WIRE', 'Invalid workspace initialization response');
        }
        invariant(typeof parsed.root === 'string' && typeof parsed.generation === 'string' && /^[a-f0-9-]{36}$/.test(parsed.generation), 'PROVIDER_WIRE', 'Invalid workspace generation');
        const root = parsed.root;
        invariant(root.startsWith('/') && !root.includes('\n'), 'PROVIDER_WIRE', 'Remote returned an invalid workspace path');
        return { ...runtime, root, meta: { ...runtime.meta, workspaceGeneration: parsed.generation } };
    }
}
