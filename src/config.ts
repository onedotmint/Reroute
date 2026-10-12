import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { access, readdir, readFile } from 'node:fs/promises';
import { PROVIDERS, type Config, type Profile, type Job } from './types.js';
import { atomicJson, jsonFile, processExec } from './util.js';
export const defaults = (): Config => ({ version: 3, active: '', mode: 'auto', profiles: {}, tasks: ['build', 'test', 'check', 'benchmark'], remote: [], local: [], timeoutSeconds: 1800 });
export function validate(c: Config): Config {
  if (c.version !== 3 || !['auto', 'local'].includes(c.mode)) throw new Error('Unsupported Reroute configuration; legacy state is never migrated or overwritten automatically.');
  if (!c.profiles || typeof c.active !== 'string' || !c.profiles[c.active]) throw new Error('Choose a configured profile with reroute setup.');
  if (!Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds <= 0 || c.timeoutSeconds > 86400) throw new Error('timeoutSeconds must be in (0, 86400].');
  if (!Array.isArray(c.tasks) || c.tasks.some(x => !['build','test','check','benchmark'].includes(x))) throw new Error('Invalid task categories');
  for (const rules of [c.remote, c.local]) if (!Array.isArray(rules) || rules.some(r => !Array.isArray(r) || !r.length || r.some(x => typeof x !== 'string' || !x || /[\0\r\n]/.test(x)))) throw new Error('Routing prefixes must be nonempty argument arrays');
  for (const [name, p] of Object.entries(c.profiles)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || !PROVIDERS.includes(p.provider)) throw new Error('Invalid provider/profile');
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(p.id)) throw new Error(`Invalid resource identifier in ${name}`);
    if (p.root !== undefined && (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(p.root) || p.root.split('/').some(x => x === '.' || x === '..'))) throw new Error('Remote root must be an absolute POSIX path without traversal');
    if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) throw new Error('Invalid SSH port');
    if (p.identityFile !== undefined && (typeof p.identityFile !== 'string' || /[\0\r\n]/.test(p.identityFile))) throw new Error('Invalid identity file');
  }
  return c;
}
export async function projectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd);
  for (;;) {
    try { await access(join(current, '.reroute.json')); return current; } catch {}
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  const r = await processExec('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined);
  return r?.code === 0 ? r.stdout.trim() : resolve(cwd);
}
export async function loadConfig(cwd: string): Promise<{ root: string; config?: Config }> {
  const root = await projectRoot(cwd), config = await jsonFile<Config>(join(root, '.reroute.json'));
  return { root, config: config ? validate(config) : undefined };
}
export const saveConfig = (root: string, config: Config) => atomicJson(join(root, '.reroute.json'), validate(config));
export async function hasLegacy(root: string): Promise<boolean> {
  for (const p of ['reroute.toml', '.reroute.toml', '.reroute/state.json', '.reroute/config.toml']) { try { await access(join(root, p)); return true; } catch {} }
  return false;
}
export const stateDir = () => process.env.REROUTE_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'reroute-v3');
export const jobPath = (id: string) => { if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid job ID'); return join(stateDir(), 'jobs', id + '.json'); };
export const saveJob = (job: Job) => atomicJson(jobPath(job.id), job);
export async function getJob(id: string): Promise<Job> { const j = await jsonFile<Job>(jobPath(id)); if (!j) throw new Error('Unknown job ID'); return j; }
export async function listJobs(): Promise<Job[]> {
  const dir = join(stateDir(), 'jobs');
  const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return []; });
  return (await Promise.all(names.filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).map(async n => JSON.parse(await readFile(join(dir, n), 'utf8')) as Job))).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export const activeProfile = (config: Config): Profile => config.profiles[config.active]!;
