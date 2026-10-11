import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig, ProviderId, RuntimeSpec, Capabilities } from '../core/contracts.js';
import { errorCode, invariant, RerouteError } from '../core/errors.js';
import { RUNTIME_COMMANDS, isSecretName } from '../core/routing.js';
import { home } from '../platform/files.js';
import { parseTOML } from './toml.js';
export const PROVIDERS: ProviderId[] = ['daytona','ssh','skypilot','modal','e2b'];
export const DEFAULT_CONFIG: ProjectConfig = {
  provider: 'daytona', runtime: { idleTimeoutMinutes: 10, env: {} }, providers: {},
  sync: { excludes: [], maxFileBytes: 16 * 1024 * 1024, maxFiles: 20000 },
  routing: { commands: RUNTIME_COMMANDS, envAllow: [] }
};
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function merge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const result = { ...a };
  for (const [key, value] of Object.entries(b)) {
    invariant(!['__proto__','constructor','prototype'].includes(key), 'CONFIG', 'Unsafe configuration key');
    result[key] = object(value) && object(result[key]) ? merge(result[key] as Record<string, unknown>, value) : value;
  }
  return result;
}
function known(table: Record<string, unknown>, keys: string[], label: string): void {
  for (const key of Object.keys(table)) invariant(keys.includes(key), 'CONFIG', `Unknown ${label} setting: ${key}`);
}
const OPTIONS: Record<ProviderId, string[]> = {
  ssh: ['host','user','port','remoteRoot','bootstrap'],
  daytona: ['snapshot','target','volumes','autoArchiveMinutes','autoDeleteMinutes','sshHost','sshPort'],
  skypilot: ['infra','instanceType','diskTier','remoteRoot','bootstrap'],
  modal: ['app','timeoutMs','ports','volume','volumeMount','cpuLimit','memoryLimitMiB','secrets'],
  e2b: ['template','timeoutMs','autoPause']
};
export function validateConfig(input: unknown): ProjectConfig {
  invariant(object(input), 'CONFIG', 'Configuration must be a table');
  known(input, ['provider','runtime','providers','sync','routing'], 'top-level');
  invariant(PROVIDERS.includes(input.provider as ProviderId), 'CONFIG', 'Provider must be daytona, ssh, skypilot, modal or e2b');
  invariant(object(input.runtime) && object(input.providers) && object(input.sync) && object(input.routing), 'CONFIG', 'Invalid configuration table');
  const runtime = input.runtime;
  known(runtime, ['cpu','memoryMiB','diskGiB','gpu','region','image','spot','idleTimeoutMinutes','env'], 'runtime');
  for (const key of ['cpu','memoryMiB','diskGiB','idleTimeoutMinutes']) if (runtime[key] !== undefined) invariant(typeof runtime[key] === 'number' && Number.isFinite(runtime[key]) && Number(runtime[key]) > 0, 'CONFIG', `runtime.${key} must be positive`);
  for (const key of ['region','image']) if (runtime[key] !== undefined) invariant(typeof runtime[key] === 'string' && String(runtime[key]).length > 0, 'CONFIG', `runtime.${key} must be a string`);
  if (runtime.spot !== undefined) invariant(typeof runtime.spot === 'boolean', 'CONFIG', 'spot must be boolean');
  if (runtime.gpu !== undefined) {
    invariant(object(runtime.gpu), 'CONFIG', 'gpu must be a table'); known(runtime.gpu, ['type','count'], 'gpu');
    if (runtime.gpu.type !== undefined) invariant(typeof runtime.gpu.type === 'string', 'CONFIG', 'gpu.type must be a string');
    if (runtime.gpu.count !== undefined) invariant(Number.isInteger(runtime.gpu.count) && Number(runtime.gpu.count) > 0, 'CONFIG', 'gpu.count must be a positive integer');
  }
  invariant(object(runtime.env), 'CONFIG', 'runtime.env must be a table');
  for (const [key, value] of Object.entries(runtime.env)) invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !isSecretName(key), 'SECRET_CONFIG', 'Store credentials in native provider authentication/secrets, not Reroute config');
  for (const [id, options] of Object.entries(input.providers)) {
    invariant(PROVIDERS.includes(id as ProviderId) && object(options), 'CONFIG', 'Invalid provider options');
    known(options, OPTIONS[id as ProviderId], id);
    for (const [key, value] of Object.entries(options)) {
      if (['port','sshPort','timeoutMs','cpuLimit','memoryLimitMiB','autoArchiveMinutes','autoDeleteMinutes'].includes(key)) invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'CONFIG', `${id}.${key} must be a nonnegative number`);
      else if (key === 'ports') invariant(Array.isArray(value) && value.every(v => Number.isInteger(v) && v > 0 && v <= 65535), 'CONFIG', `${id}.ports must contain valid port numbers`);
      else if (key === 'secrets') invariant(Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0), 'CONFIG', `${id}.secrets must contain native secret names, not values`);
      else if (key === 'volumes') invariant(Array.isArray(value) && value.every(v => object(v) && typeof v.volumeId === 'string' && typeof v.mountPath === 'string' && v.mountPath.startsWith('/') && Object.keys(v).every(k => ['volumeId','mountPath','subpath'].includes(k)) && (v.subpath === undefined || typeof v.subpath === 'string')), 'CONFIG', `${id}.volumes must contain volumeId, absolute mountPath and optional subpath`);
      else if (key === 'autoPause') invariant(typeof value === 'boolean', 'CONFIG', 'autoPause must be boolean');
      else invariant(typeof value === 'string', 'CONFIG', `${id}.${key} must be a string`);
    }
  }
  const sync = input.sync; known(sync, ['excludes','maxFileBytes','maxFiles'], 'sync');
  invariant(Array.isArray(sync.excludes) && sync.excludes.every(x => typeof x === 'string' && !x.includes('..')), 'CONFIG', 'sync.excludes must be safe glob strings');
  for (const key of ['maxFileBytes','maxFiles']) invariant(Number.isInteger(sync[key]) && Number(sync[key]) > 0, 'CONFIG', `sync.${key} must be a positive integer`);
  const routing = input.routing; known(routing, ['commands','envAllow'], 'routing');
  for (const key of ['commands','envAllow']) invariant(Array.isArray(routing[key]) && (routing[key] as unknown[]).every(x => typeof x === 'string'), 'CONFIG', `routing.${key} must be a string array`);
  invariant((routing.commands as string[]).every(x => /^[A-Za-z0-9_+.-]+$/.test(x) && x !== '.' && x !== '..'), 'CONFIG', 'Runtime command names must be basenames');
  return input as unknown as ProjectConfig;
}
async function readConfig(path: string): Promise<Record<string, unknown>> {
  try { return parseTOML(await fs.readFile(path, 'utf8')); }
  catch (error) { if (errorCode(error) === 'ENOENT') return {}; throw error; }
}
export async function loadConfig(root?: string, override: Record<string, unknown> = {}): Promise<ProjectConfig> {
  let config = merge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, await readConfig(join(home(), 'config.toml')));
  if (root) config = merge(config, await readConfig(join(root, 'reroute.toml')));
  return validateConfig(merge(config, override));
}
export function assertCapabilities(spec: RuntimeSpec, cap: Capabilities, provider: string): void {
  for (const key of ['cpu','memoryMiB','diskGiB','gpu','region','image','spot'] as const) {
    if (spec[key] !== undefined && !cap.resources.includes(key)) throw new RerouteError('UNSUPPORTED_CAPABILITY', `${provider} cannot honor runtime.${key}. Remove the field or select another provider.`);
  }
}
