import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnRaw } from '../dist/platform/process.js';
import { execute, fileTransport } from '../dist/providers/channel.js';
export const policy = { excludes: [], maxFileBytes: 4 * 1024 * 1024, maxFiles: 1000 };
export async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'reroute-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const local = join(directory,'local'), remote = join(directory,'remote');
  await fs.mkdir(local); await fs.mkdir(remote);
  const project = { id:randomUUID(), root:local, name:'fixture' };
  const runtime = { id:project.id, projectId:project.id, provider:'ssh', root:remote, meta:{} };
  return { directory, local, remote, project, runtime };
}
export const launch = async (_runtime, argv) => spawnRaw(argv[0], argv.slice(1));
export function transport(runtime) { return fileTransport(launch, runtime); }
export function exec(runtime, argv, options = {}) { return execute(launch, runtime, { argv, cwd:runtime.root, env:{}, ...options }); }
export async function collect(handle, input) {
  const write = (async () => { if (input !== undefined) await handle.write(Buffer.from(input)); await handle.endInput(); })();
  const streams = { stdout:[], stderr:[] };
  for await (const event of handle.events) streams[event.stream].push(event.data);
  await write;
  return { ...await handle.wait(), stdout:Buffer.concat(streams.stdout), stderr:Buffer.concat(streams.stderr) };
}
/** Test transport only. It is never exported in the production provider registry. */
export class FixtureProvider {
  id = 'ssh'; capabilities = { resources:[], persistence:'disk', idle:'none', preview:false, stdin:true, nativeIdle:false };
  readyCount = 0; policies = []; state = 'running';
  constructor(remote) { this.root = remote; }
  async ensureReady(project, _spec, previous) {
    this.readyCount++; await fs.mkdir(this.root,{recursive:true});
    return previous ?? { id:project.id, projectId:project.id, root:this.root, provider:'ssh', meta:{} };
  }
  async status() { return this.state; }
  exec(runtime, request) { return execute(launch,runtime,request); }
  files(runtime) { return transport(runtime); }
  async applyIdlePolicy(_r,p) { this.policies.push({...p}); }
  async destroy() { await fs.rm(this.root,{recursive:true,force:true}); this.state='missing'; }
}
