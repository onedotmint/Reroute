import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig, ProviderId, RuntimeSpec, Capabilities } from '../core/contracts.js';
import { errorCode, invariant, RerouteError } from '../core/errors.js';
import { RUNTIME_COMMANDS, TASK_CATEGORIES, isSecretName } from '../core/routing.js';
import { home } from '../platform/files.js';
import { parseTOML } from './toml.js';
import { validSyncPattern } from '../sync/sync.js';
import { validArtifactPath } from '../sync/artifacts.js';
export const PROVIDERS: ProviderId[] = ['daytona','ssh','skypilot','modal','e2b'];
export const DEFAULT_CONFIG: ProjectConfig = {
  provider: 'daytona', runtime: { idleTimeoutMinutes: 10, env: {} }, providers: {},
  sync: { excludes: [], maxFileBytes: 16 * 1024 * 1024, maxFiles: 20000 },
  authorization: { paidProviders: [] },
  artifacts: { paths: [], maxFileBytes: 16 * 1024 * 1024 },
  routing: { commands: RUNTIME_COMMANDS, envAllow: [], mode: 'tasks', local: [], remote: [] }
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
  known(input, ['provider','runtime','providers','sync','routing','artifacts','authorization'], 'top-level');
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
      if (key === 'port' || key === 'sshPort') invariant(Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535, 'CONFIG', `${id}.${key} must be an integer port 1..65535`);
      else if (key === 'autoDeleteMinutes') invariant(value === -1, 'CONFIG', 'Daytona source workspaces require autoDeleteMinutes = -1 (disabled); auto-delete can destroy pending source');
      else if (['port','sshPort','timeoutMs','cpuLimit','memoryLimitMiB','autoArchiveMinutes'].includes(key)) invariant(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'CONFIG', `${id}.${key} must be a nonnegative number`);
      else if (key === 'ports') invariant(Array.isArray(value) && value.every(v => Number.isInteger(v) && v > 0 && v <= 65535), 'CONFIG', `${id}.ports must contain valid port numbers`);
      else if (key === 'secrets') invariant(Array.isArray(value) && value.every(v => typeof v === 'string' && v.length > 0), 'CONFIG', `${id}.secrets must contain native secret names, not values`);
      else if (key === 'volumes') invariant(Array.isArray(value) && value.every(v => object(v) && typeof v.volumeId === 'string' && typeof v.mountPath === 'string' && v.mountPath.startsWith('/') && Object.keys(v).every(k => ['volumeId','mountPath','subpath'].includes(k)) && (v.subpath === undefined || typeof v.subpath === 'string')), 'CONFIG', `${id}.volumes must contain volumeId, absolute mountPath and optional subpath`);
      else if (key === 'autoPause') invariant(typeof value === 'boolean', 'CONFIG', 'autoPause must be boolean');
      else invariant(typeof value === 'string', 'CONFIG', `${id}.${key} must be a string`);
    }
  }
  const sync = input.sync; known(sync, ['excludes','maxFileBytes','maxFiles','hashMode'], 'sync');
  if (sync.hashMode !== undefined) invariant(sync.hashMode === 'strict' || sync.hashMode === 'metadata', 'CONFIG', 'sync.hashMode must be strict or metadata');
  invariant(Array.isArray(sync.excludes) && sync.excludes.every(validSyncPattern), 'CONFIG', 'sync.excludes supports literals, *, ?, and complete ** path segments; brackets, braces, negation and backslashes are unsupported');
  for (const key of ['maxFileBytes','maxFiles']) invariant(Number.isSafeInteger(sync[key]) && Number(sync[key]) > 0, 'CONFIG', `sync.${key} must be a positive safe integer`);
  if (input.authorization !== undefined) {
    invariant(object(input.authorization), 'CONFIG', 'authorization must be a table');
    known(input.authorization, ['paidProviders'], 'authorization');
    invariant(Array.isArray(input.authorization.paidProviders) && input.authorization.paidProviders.every(id => PROVIDERS.includes(id as ProviderId)), 'CONFIG', 'authorization.paidProviders must contain provider names');
  }
  if (input.artifacts !== undefined) {
    invariant(object(input.artifacts), 'CONFIG', 'artifacts must be a table');
    known(input.artifacts, ['paths','maxFileBytes'], 'artifacts');
    invariant(Array.isArray(input.artifacts.paths) && input.artifacts.paths.length <= 100 && input.artifacts.paths.every(validArtifactPath) && new Set(input.artifacts.paths).size === input.artifacts.paths.length, 'CONFIG', 'artifacts.paths must be unique exact files under a supported build directory; no credentials/globs');
    invariant(Number.isSafeInteger(input.artifacts.maxFileBytes) && Number(input.artifacts.maxFileBytes) > 0 && Number(input.artifacts.maxFileBytes) <= 32 * 1024 * 1024, 'CONFIG', 'artifacts.maxFileBytes must be 1..33554432');
  }
  const routing = input.routing; known(routing, ['commands','envAllow','mode','tasks','local','remote'], 'routing');
  if (routing.mode !== undefined) invariant(['tasks','legacy'].includes(String(routing.mode)), 'CONFIG', 'routing.mode must be tasks or legacy');
  if (routing.tasks !== undefined) invariant(Array.isArray(routing.tasks) && routing.tasks.every(task => TASK_CATEGORIES.includes(task)), 'CONFIG', 'routing.tasks must contain build, test, check or benchmark');
  for (const key of ['local','remote']) if (routing[key] !== undefined) invariant(Array.isArray(routing[key]) && (routing[key] as unknown[]).every(prefix => Array.isArray(prefix) && prefix.length > 0 && prefix.every(arg => typeof arg === 'string' && arg.length > 0 && !/[\0\r\n]/.test(arg)) && /^[A-Za-z0-9_+.-]+$/.test(prefix[0]) && !['.','..'].includes(prefix[0])), 'CONFIG', `routing.${key} must be arrays of exact argv prefixes`);
  for (const key of ['commands','envAllow']) invariant(Array.isArray(routing[key]) && (routing[key] as unknown[]).every(x => typeof x === 'string'), 'CONFIG', `routing.${key} must be a string array`);
  invariant((routing.commands as string[]).every(x => /^[A-Za-z0-9_+.-]+$/.test(x) && x !== '.' && x !== '..'), 'CONFIG', 'Runtime command names must be basenames');
  return input as unknown as ProjectConfig;
}
async function readConfig(path: string): Promise<Record<string, unknown>> {
  try { return parseTOML(await fs.readFile(path, 'utf8')); }
  catch (error) { if (errorCode(error) === 'ENOENT') return {}; throw error; }
}
export async function loadConfig(root?: string, override: Record<string, unknown> = {}): Promise<ProjectConfig> {
  let custom = await readConfig(join(home(), 'config.toml'));
  if (root) custom = merge(custom, await readConfig(join(root, 'reroute.toml')));
  custom = merge(custom, override);
  // Preserve old explicit executable policies; migration to tasks is a deliberate setting.
  if (object(custom.routing) && custom.routing.commands !== undefined && custom.routing.mode === undefined) custom = merge(custom, { routing: { mode: 'legacy' } });
  return validateConfig(merge(structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>, custom));
}
export function assertCapabilities(spec: RuntimeSpec, cap: Capabilities, provider: string): void {
  for (const key of ['cpu','memoryMiB','diskGiB','gpu','region','image','spot'] as const) {
    if (spec[key] !== undefined && !cap.resources.includes(key)) throw new RerouteError('UNSUPPORTED_CAPABILITY', `${provider} cannot honor runtime.${key}. Remove the field or select another provider.`);
  }
}
