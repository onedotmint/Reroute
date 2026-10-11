import type { RuntimeProvider, ProviderId, Capabilities, ProjectRef, RuntimeRef, RuntimeSpec, RuntimeStatus, IdlePolicy, ExecRequest } from '../core/contracts.js';
import { type Launch } from './channel.js';
import type { RawProcess } from '../platform/process.js';
/** SDKs are installed in a user-owned optional tool directory, not in every project. */
export declare function loadSdk<T>(name: string): Promise<T>;
/** Daytona missing detection uses the loaded SDK's class, not names or transport-shaped objects. */
export declare function sdkMissing(error: unknown, notFound: new (message: string, statusCode?: number) => Error & {
    statusCode?: number;
}): boolean;
export declare function missing(error: unknown): boolean;
export declare function runtimeRef(provider: ProviderId, project: ProjectRef, id: unknown, root: string, meta?: Record<string, string>): RuntimeRef;
export declare function rawCapture(raw: RawProcess): Promise<string>;
export declare const INITIALIZE = "import os,json,sys,uuid\np=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]\nassert os.path.realpath(p)==p, 'symlink runtime root'\nos.makedirs(p,mode=0o700,exist_ok=True)\ns=os.path.join(p,'.reroute-runtime'); os.makedirs(s,mode=0o700,exist_ok=True)\nf=os.path.join(s,'owner.json')\nif os.path.exists(f):\n data=json.load(open(f)); assert data['projectId']==identity, 'runtime already owned'\nelse:\n data={'projectId':identity,'generation':str(uuid.uuid4())}\n with open(f,'x') as o: json.dump(data,o)\nif 'generation' not in data:\n data['generation']=str(uuid.uuid4())\n with open(f,'w') as o: json.dump(data,o)\nprint(json.dumps({'root':p,'generation':data['generation']}))";
export declare const VERIFY_WORKSPACE = "import os,json,sys\np=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]; generation=sys.argv[3]\nassert os.path.realpath(p)==p and os.path.isdir(p), 'missing or symlink runtime root'\ns=os.path.join(p,'.reroute-runtime'); f=os.path.join(s,'owner.json')\nassert os.path.realpath(s)==s and os.path.realpath(f)==f, 'symlink owner marker'\nwith open(f) as o: data=json.load(o)\nassert data['projectId']==identity and data['generation']==generation, 'workspace identity changed'\nprint(json.dumps({'root':p,'projectId':data['projectId'],'generation':data['generation']}))";
export declare const DESTROY_DIRECTORY = "import os,json,sys,shutil\np=os.path.abspath(os.path.expanduser(sys.argv[1])); identity=sys.argv[2]\nif not os.path.exists(p): sys.exit(0)\nassert os.path.basename(p)==identity and os.path.realpath(p)==p, 'unsafe runtime root'\nassert json.load(open(os.path.join(p,'.reroute-runtime','owner.json')))['projectId']==identity, 'wrong owner'\nshutil.rmtree(p)";
export declare abstract class RemoteProvider implements RuntimeProvider {
    abstract readonly id: ProviderId;
    abstract readonly capabilities: Capabilities;
    abstract ensureReady(project: ProjectRef, spec: RuntimeSpec, previous?: RuntimeRef): Promise<RuntimeRef>;
    abstract status(runtime: RuntimeRef): Promise<RuntimeStatus>;
    abstract applyIdlePolicy(runtime: RuntimeRef, policy: IdlePolicy): Promise<void>;
    abstract destroy(runtime: RuntimeRef): Promise<void>;
    abstract launch(runtime: RuntimeRef, argv: string[]): Promise<RawProcess>;
    protected bridge: Launch;
    exec(runtime: RuntimeRef, request: ExecRequest): Promise<import("../core/contracts.js").ExecutionHandle>;
    files(runtime: RuntimeRef): import("../core/contracts.js").FileTransport;
    protected verifyWorkspace(runtime: RuntimeRef): Promise<RuntimeRef>;
    protected initialize(runtime: RuntimeRef): Promise<RuntimeRef>;
}
