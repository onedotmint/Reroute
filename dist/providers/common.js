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
    catch {
        throw new RerouteError('SDK_MISSING', `Missing ${name}. Run reroute setup --install-sdk ${name === '@daytona/sdk' ? 'daytona' : name}.`);
    }
    return await import(pathToFileURL(location).href);
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
export async function rawCapture(raw) {
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
}
export const INITIALIZE = `import os,json,sys,uuid
p=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]
assert os.path.realpath(p)==p, 'symlink runtime root'
os.makedirs(p,mode=0o700,exist_ok=True)
s=os.path.join(p,'.reroute-runtime'); os.makedirs(s,mode=0o700,exist_ok=True)
f=os.path.join(s,'owner.json')
if os.path.exists(f):
 data=json.load(open(f)); assert data['projectId']==identity, 'runtime already owned'
else:
 data={'projectId':identity,'generation':str(uuid.uuid4())}
 with open(f,'x') as o: json.dump(data,o)
if 'generation' not in data:
 data['generation']=str(uuid.uuid4())
 with open(f,'w') as o: json.dump(data,o)
print(json.dumps({'root':p,'generation':data['generation']}))`;
export const DESTROY_DIRECTORY = `import os,json,sys,shutil
p=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]
if not os.path.exists(p): sys.exit(0)
assert os.path.basename(p)==identity and os.path.realpath(p)==p, 'unsafe runtime root'
assert json.load(open(os.path.join(p,'.reroute-runtime','owner.json')))['projectId']==identity, 'wrong owner'
shutil.rmtree(p)`;
export class RemoteProvider {
    bridge = (runtime, argv) => this.launch(runtime, argv);
    exec(runtime, request) { return execute(this.bridge, runtime, request); }
    files(runtime) { return fileTransport(this.bridge, runtime); }
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
