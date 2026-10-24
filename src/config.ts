import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { access, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { PROVIDERS, type Config, type Profile, type Job } from './types.js';
import { atomicJson, hash, jsonFile, noSymlink, processExec } from './util.js';
export const defaults = (): Config => ({ version: 3, active: '', mode: 'auto', profiles: {}, tasks: ['build', 'test', 'check', 'benchmark'], remote: [], local: [], timeoutSeconds: 1800 });
export function validate(c: Config): Config {
  const secretKey = (value: unknown): boolean => !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => /api.?key|token.?secret|password|^secrets?$|^credentials$/i.test(key) || secretKey(item));
  if (secretKey(c)) throw new Error('Secrets belong outside project configuration');
  if (c.version !== 3 || !['auto', 'local'].includes(c.mode)) throw new Error('Unsupported Reroute configuration; legacy state is never migrated or overwritten automatically.');
  if (!c.profiles || typeof c.active !== 'string' || !Object.hasOwn(c.profiles, c.active)) throw new Error('Choose a configured profile with reroute setup.');
  if (!Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds <= 0 || c.timeoutSeconds > 86400) throw new Error('timeoutSeconds must be in (0, 86400].');
  if (!Array.isArray(c.tasks) || c.tasks.some(x => !['build','test','check','benchmark'].includes(x))) throw new Error('Invalid task categories');
  for (const rules of [c.remote, c.local]) if (!Array.isArray(rules) || rules.some(r => !Array.isArray(r) || !r.length || r.some(x => typeof x !== 'string' || !x || /[\0\r\n]/.test(x)))) throw new Error('Routing prefixes must be nonempty argument arrays');
  for (const [name, p] of Object.entries(c.profiles)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || !PROVIDERS.includes(p.provider)) throw new Error('Invalid provider/profile');
    if (typeof p.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*$/.test(p.id)) throw new Error(`Invalid resource identifier in ${name}`);
    if (p.pendingResume !== undefined && (typeof p.pendingResume !== 'string' || !/^rr-resume-[0-9a-f-]{36}$/.test(p.pendingResume))) throw new Error('Invalid pending Modal resume marker');
    if (p.credential !== undefined && (typeof p.credential !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(p.credential) || ['.','..'].includes(p.credential))) throw new Error('Invalid credential account name');
    if (Object.keys(p).some(key => /api.?key|token.?secret|password|credentials/i.test(key))) throw new Error('Secrets belong in the private credential store, never project configuration');
    if (p.compute && (!['daytona','modal'].includes(p.provider) || !Number.isFinite(p.compute.cpu) || p.compute.cpu <= 0 || !Number.isFinite(p.compute.memoryGiB) || p.compute.memoryGiB <= 0)) throw new Error('Compute needs positive CPU and memoryGiB on Daytona or Modal');
    if (p.provider === 'daytona' && p.compute && (!Number.isInteger(p.compute.cpu) || !Number.isInteger(p.compute.memoryGiB))) throw new Error('Daytona CPU and memoryGiB must be whole numbers');
    if (p.compute && !p.managed) throw new Error('Compute settings require managed resources; existing targets are not silently resized');
    if (p.provider === 'modal' && p.compute && (p.compute.cpu < 0.125 || !Number.isInteger(p.compute.cpu * 1000) || p.compute.memoryGiB < 0.125 || !Number.isInteger(p.compute.memoryGiB * 1024))) throw new Error('Modal needs at least 0.125 physical cores in millicore increments and at least 128 MiB in whole MiB');
    if (p.managed) {
      if (!['daytona','modal'].includes(p.provider) || !p.compute || !p.image || /[\0\r\n]/.test(p.image)) throw new Error('Managed compute requires Daytona/Modal, compute and a toolchain image');
      if (typeof p.managed.authorized !== 'boolean') throw new Error('Managed billing authorization must be explicit');
      for (const key of ['maxCpu','maxMemoryGiB','maxTaskUsd','monthlyUsd','cpuHourUsd','memoryGiBHourUsd'] as const)
        if (!Number.isFinite(p.managed[key]) || p.managed[key] <= 0) throw new Error('Managed limits and reviewed CPU/memory rates must be positive');
      if (!Number.isFinite(p.managed.storageMonthUsd) || p.managed.storageMonthUsd < 0) throw new Error('Set an explicit monthly storage cost allowance');
      if (!Number.isInteger(p.managed.idleMinutes) || p.managed.idleMinutes < 1 || p.managed.idleMinutes > 1440) throw new Error('idleMinutes must be 1-1440');
      if (p.compute.cpu > p.managed.maxCpu || p.compute.memoryGiB > p.managed.maxMemoryGiB) throw new Error('Compute exceeds the configured quota/cost envelope');
    }
    if (p.root !== undefined && (!/^\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(p.root) || p.root.split('/').some(x => x === '.' || x === '..'))) throw new Error('Remote root must be an absolute POSIX path without traversal');
    if (p.port !== undefined && (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) throw new Error('Invalid SSH port');
    if (p.identityFile !== undefined && (typeof p.identityFile !== 'string' || /[\0\r\n]/.test(p.identityFile))) throw new Error('Invalid identity file');
  }
  return c;
}
export async function projectRoot(cwd: string): Promise<string> {
  const start = await realpath(cwd);
  const git = await processExec('git', ['-C', start, 'rev-parse', '--show-toplevel']).catch(() => undefined);
  if (git?.stdoutTruncated) throw new Error('Project root response truncated');
  const boundary = git?.code === 0 ? await realpath(git.stdout.trim()) : undefined;
  let current = start, manifestRoot: string | undefined;
  for (;;) {
    if (!boundary && !manifestRoot) for (const name of ['package.json', 'Cargo.toml', 'pyproject.toml']) {
      try { await access(join(current, name)); manifestRoot = current; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try { await access(join(current, '.reroute.json')); return current; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current === boundary) return current;
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return manifestRoot ?? start;
}
export const userConfigPath = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'reroute', 'config.json');
export async function loadUserConfig(): Promise<Config | undefined> {
  const config = await jsonFile<Config>(userConfigPath());
  return config === undefined ? undefined : validate(config);
}
/** Top-level project values replace defaults; named profiles replace whole profiles, never deep-merge policy. */
function overlay(base: Config | undefined, project: Partial<Config>): Config {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Invalid project configuration');
  if (project.profiles !== undefined && (!project.profiles || typeof project.profiles !== 'object' || Array.isArray(project.profiles))) throw new Error('Project profiles must be a named object');
  return validate({ ...defaults(), ...base, ...project, profiles: { ...base?.profiles, ...project.profiles } });
}
export async function loadConfig(cwd: string): Promise<{ root: string; config?: Config; source?: 'global' | 'project' | 'merged' }> {
  const root = await projectRoot(cwd), project = await jsonFile<Partial<Config>>(join(root, '.reroute.json'));
  const global = await loadUserConfig();
  if (project !== undefined) return { root, config: overlay(global, project), source: global ? 'merged' : 'project' };
  return { root, config: global, source: global ? 'global' : undefined };
}
export const saveConfig = (root: string, config: Config) => atomicJson(join(root, '.reroute.json'), validate(config));
export const saveUserConfig = (config: Config) => atomicJson(userConfigPath(), validate(config));
export async function saveProjectOverrides(root: string, patch: Partial<Config>): Promise<void> {
  const path = join(root, '.reroute.json'), old = await jsonFile<Partial<Config>>(path) ?? {};
  const candidate = { ...old, ...patch, ...(patch.profiles ? { profiles: { ...old.profiles, ...patch.profiles } } : {}) };
  overlay(await loadUserConfig(), candidate);
  await atomicJson(path, candidate);
}

// Consent is private local state, never a flag supplied by an untrusted project or a tool argument.
const authorizationPath = (root: string) => join(stateDir(), 'projects', hash(root) + '.json');
const authorizationTarget = (config: Config) => {
  const p = activeProfile(config);
  return hash(JSON.stringify([p.provider, p.credential ?? null, p.managed ? 'managed' : p.id, p.root ?? '', p.app ?? '', p.port ?? null, p.identityFile ?? null]));
};
interface ProjectConsent { version: 1; root: string; targets: string[] }
export async function projectAuthorized(root: string, config: Config): Promise<boolean> {
  root = await realpath(root);
  const path = authorizationPath(root); await noSymlink(path);
  const receipt = await jsonFile<ProjectConsent>(path);
  return receipt?.version === 1 && receipt.root === root && Array.isArray(receipt.targets) && receipt.targets.includes(authorizationTarget(config));
}
export async function authorizeProject(root: string, config: Config): Promise<void> {
  validate(config); root = await realpath(root);
  const path = authorizationPath(root); await noSymlink(path);
  const old = await jsonFile<ProjectConsent>(path);
  const targets = old?.version === 1 && old.root === root && Array.isArray(old.targets) ? old.targets.filter(t => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t)) : [];
  await atomicJson(path, { version: 1, root, targets: [...new Set([...targets, authorizationTarget(config)])] });
}
export async function revokeProject(root: string): Promise<void> {
  const path = authorizationPath(await realpath(root)); await noSymlink(path); await rm(path, { force: true });
}
export async function requireProjectAuthorization(root: string, config: Config): Promise<void> {
  if (!await projectAuthorized(root, config)) throw new Error('Project remote execution is not authorized; no source uploaded or compute started. Approve this project/account in /reroute, or run reroute authorize --yes after reviewing the source and costs.');
}
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
