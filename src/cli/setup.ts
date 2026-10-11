import { promises as fs, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, delimiter, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { exists, home, atomicWrite, privateDir, packageRoot, cliPath, readJSON, writeJSON, hash } from '../platform/files.js';
import { capture, shellCommand } from '../platform/process.js';
import { installShims } from '../core/activation.js';
import { unshimmedPath } from '../core/routing.js';
import { request, ensureDaemon } from '../daemon/client.js';
import { loadConfig } from '../config/config.js';
import { findProject } from '../core/projects.js';
import { RerouteError, invariant, errorCode, safeMessage } from '../core/errors.js';
import { createProvider } from '../providers/index.js';
export const HARNESSES = ['pi','omp','claude','codex','deepseek','opencode','cursor'] as const;
export type Harness = typeof HARNESSES[number];
export const SDKS: Record<string, string> = { daytona: '@daytona/sdk@0.223.1', modal: 'modal@0.11.0', e2b: 'e2b@2.52.1' };
export function agentHome(): string { return process.env.REROUTE_AGENT_HOME ?? homedir(); }
export async function binary(name: string): Promise<string | undefined> {
  for (const folder of unshimmedPath(process.env.PATH, join(home(), 'shims')).split(delimiter)) {
    for (const suffix of process.platform === 'win32' ? ['.exe','.cmd',''] : ['']) {
      const path = join(folder, name + suffix);
      try { await fs.access(path, constants.X_OK); return path; } catch { /* not here */ }
    }
  }
  return undefined;
}
export async function detectHarnesses(): Promise<Harness[]> {
  const paths: Record<Harness, string[]> = { pi: ['.pi/agent'], omp: ['.omp/agent','.omp'], claude: ['.claude'], codex: ['.codex'], deepseek: ['.dsh'], opencode: ['.config/opencode'], cursor: ['.cursor'] };
  const found: Harness[] = [];
  for (const id of HARNESSES) if (await binary(id === 'deepseek' ? 'dsh' : id) || (await Promise.all(paths[id].map(p => exists(join(agentHome(), p))))).some(Boolean)) found.push(id);
  return found;
}
const managedMarker = '// Managed by Reroute';
type OwnedAdapter = { harness: Harness; path: string } & ({ kind: 'file'; hash: string } | { kind: 'hook'; event: string; entry: Record<string, unknown> });
type Ownership = { commands: string[]; entries: OwnedAdapter[] };
// Never follow a replaced extension, config, registry or parent directory symlink.
async function safeAdapterPath(path: string): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { invariant(!(await fs.lstat(current)).isSymbolicLink(), 'ADAPTER_CONFLICT', `Refusing adapter symlink: ${current}`); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
async function ownership(): Promise<Ownership> {
  const path = join(home(), 'installed-hooks.json'); await safeAdapterPath(path);
  const value = await readJSON<Partial<Ownership>>(path);
  invariant(value === undefined || (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.commands) && value.commands.every(command => typeof command === 'string') &&
    (value.entries === undefined || (Array.isArray(value.entries) && value.entries.every(entry => entry && HARNESSES.includes(entry.harness) && typeof entry.path === 'string' &&
      (entry.kind === 'file' ? typeof entry.hash === 'string' : entry.kind === 'hook' && typeof entry.event === 'string' && entry.entry && typeof entry.entry === 'object' && !Array.isArray(entry.entry)))))),
    'ADAPTER_CONFIG', 'Invalid adapter ownership registry; left unchanged');
  return { commands: value?.commands ?? [], entries: value?.entries ?? [] };
}
async function saveOwnership(value: Ownership): Promise<void> {
  const path = join(home(), 'installed-hooks.json'); await safeAdapterPath(path); await writeJSON(path, value);
}
async function managedFile(id: Harness, path: string, content: string): Promise<void> {
  path = resolve(path); await safeAdapterPath(path);
  const registry = await ownership(), owned = registry.entries.find(entry => entry.harness === id && entry.path === path && entry.kind === 'file');
  if (await exists(path)) {
    invariant(owned?.kind === 'file' && hash(await fs.readFile(path)) === owned.hash, 'ADAPTER_CONFLICT', `Refusing to replace unowned or modified file: ${path}`);
  }
  const text = managedMarker + '\n' + content;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await atomicWrite(path, text);
  registry.entries = registry.entries.filter(entry => entry.path !== path);
  registry.entries.push({ harness: id, path, kind: 'file', hash: hash(text) }); await saveOwnership(registry);
}
/** Merge only an owned hook; do not rewrite unrelated entries or corrupt JSON. */
export async function mergeHookFile(path: string, host: 'claude'|'codex'|'cursor'): Promise<void> {
  path = resolve(path); await safeAdapterPath(path);
  const registry = await ownership();
  let settings: Record<string, unknown> = {};
  if (await exists(path)) {
    try { settings = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>; }
    catch { throw new RerouteError('ADAPTER_CONFIG', `Invalid JSON in ${path}; original file was left unchanged`); }
  }
  invariant(settings && typeof settings === 'object' && !Array.isArray(settings), 'ADAPTER_CONFIG', 'Hook settings must be an object');
  const hooks = settings.hooks ?? {};
  invariant(hooks && typeof hooks === 'object' && !Array.isArray(hooks), 'ADAPTER_CONFIG', 'hooks must be an object');
  const map = hooks as Record<string, unknown>, event = host === 'cursor' ? 'preToolUse' : 'PreToolUse';
  const previous = map[event] ?? [];
  invariant(Array.isArray(previous), 'ADAPTER_CONFIG', 'Hook event must be an array');
  const command = shellCommand([process.execPath, cliPath(), 'hook', host]);
  const owned = registry.entries.filter(entry => entry.harness === host && entry.path === path && entry.kind === 'hook');
  const cleaned = [...previous];
  for (const entry of owned) {
    const index = cleaned.findIndex(item => entry.kind === 'hook' && isDeepStrictEqual(item, entry.entry));
    invariant(index >= 0 || !(await exists(path)), 'ADAPTER_CONFLICT', `Owned hook was changed or removed: ${path}`);
    if (index >= 0) cleaned.splice(index, 1);
  }
  invariant(!cleaned.some(item => {
    const value = item as { command?: string; hooks?: { command?: string }[] } | null;
    return value && (host === 'cursor' ? value.command === command : Array.isArray(value.hooks) && value.hooks.some(hook => hook?.command === command));
  }), 'ADAPTER_CONFLICT', `Refusing to claim an unowned hook: ${path}`);
  const entry = host === 'cursor' ? { command, failClosed: true } : { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] };
  cleaned.push(entry);
  map[event] = cleaned; settings.hooks = map;
  if (host === 'cursor') settings.version ??= 1;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await exists(path)) { const backup = path + '.reroute-backup'; await safeAdapterPath(backup); if (!(await exists(backup))) { await fs.copyFile(path, backup); await fs.chmod(backup, 0o600); } }
  await atomicWrite(path, JSON.stringify(settings, null, 2) + '\n');
  registry.commands = [...new Set([...registry.commands, command])];
  registry.entries = registry.entries.filter(entry => !(entry.harness === host && entry.path === path));
  registry.entries.push({ harness: host, path, kind: 'hook', event, entry }); await saveOwnership(registry);
}
export async function installHarness(id: Harness): Promise<string> {
  const url = (name: string) => JSON.stringify(pathToFileURL(join(packageRoot, 'adapters', name + '.mjs')).href);
  switch (id) {
    case 'pi': {
      const path = join(agentHome(), '.pi/agent/extensions/reroute.ts');
      await managedFile(id, path, `import * as sdk from '@earendil-works/pi-coding-agent';\nimport { registerPi } from ${url('pi')};\nexport default pi => registerPi(pi, sdk);\n`); return path;
    }
    case 'omp': { const path = join(agentHome(), '.omp/agent/extensions/reroute.ts'); await managedFile(id, path, `export { default } from ${url(id)};\n`); return path; }
    case 'claude': { const path = join(agentHome(), '.claude/settings.json'); await mergeHookFile(path, id); return path; }
    case 'codex': { const path = join(agentHome(), '.codex/hooks.json'); await mergeHookFile(path, id); return path; }
    case 'cursor': { const path = join(agentHome(), '.cursor/hooks.json'); await mergeHookFile(path, id); return path; }
    case 'opencode': {
      // v2 plugin declaration is documented in HARNESSES.md; avoid overwriting a v1 config.
      const path = join(home(), 'adapters/opencode.mjs'); await managedFile(id, path, `export { default } from ${url(id)};\n`); return `${path} (add to OpenCode v2 plugin configuration; see HARNESSES.md)`;
    }
    case 'deepseek': {
      const path = join(home(), 'adapters/deepseek.mjs');
      await managedFile(id, path, `import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';\nimport { rerouteExecutor } from ${url(id)};\nexport default rerouteExecutor(LocalBashExecutor);\n`);
      return `${path} (replace dsh-bash-local in the DSH composition; see HARNESSES.md)`;
    }
  }
}
function adapterPath(id: Harness): string {
  const paths: Record<Harness, string> = {
    pi: join(agentHome(), '.pi/agent/extensions/reroute.ts'), omp: join(agentHome(), '.omp/agent/extensions/reroute.ts'),
    claude: join(agentHome(), '.claude/settings.json'), codex: join(agentHome(), '.codex/hooks.json'), cursor: join(agentHome(), '.cursor/hooks.json'),
    opencode: join(home(), 'adapters/opencode.mjs'), deepseek: join(home(), 'adapters/deepseek.mjs'),
  };
  return resolve(paths[id]);
}
async function ownedState(entry: OwnedAdapter): Promise<'INSTALLED' | 'MISSING' | 'MODIFIED' | 'UNSAFE'> {
  const hookHost = ['claude', 'codex', 'cursor'].includes(entry.harness);
  if (entry.path !== adapterPath(entry.harness) || (entry.kind === 'hook') !== hookHost ||
    (entry.kind === 'hook' && entry.event !== (entry.harness === 'cursor' ? 'preToolUse' : 'PreToolUse'))) return 'UNSAFE';
  try {
    await safeAdapterPath(entry.path);
    const content = await fs.readFile(entry.path);
    if (entry.kind === 'file') return hash(content) === entry.hash ? 'INSTALLED' : 'MODIFIED';
    const settings = JSON.parse(content.toString()) as { hooks?: Record<string, unknown> } | null;
    const items = settings?.hooks?.[entry.event];
    return Array.isArray(items) && items.some(item => isDeepStrictEqual(item, entry.entry)) ? 'INSTALLED' : 'MODIFIED';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'MISSING';
    return 'UNSAFE';
  }
}
export interface UninstallOptions { harnesses?: Harness[] }
export interface UninstallResult {
  removed: string[];
  preserved: { harness: Harness; path: string; reason: string }[];
  warnings: string[];
}
/** Remove only recorded, unchanged adapters; never remove settings, backups or runtime state. */
export async function uninstall(options: UninstallOptions = {}): Promise<UninstallResult> {
  invariant(options.harnesses === undefined || (Array.isArray(options.harnesses) && options.harnesses.every(id => HARNESSES.includes(id))), 'CONFIG', 'Unknown harness');
  const registry = await ownership(), result: UninstallResult = { removed: [], preserved: [], warnings: [] };
  const selected = new Set(options.harnesses ?? HARNESSES), retained: OwnedAdapter[] = [];
  for (const entry of registry.entries) {
    if (!selected.has(entry.harness)) { retained.push(entry); continue; }
    try {
      const state = await ownedState(entry);
      if (state === 'MODIFIED' || state === 'UNSAFE') {
        retained.push(entry); result.preserved.push({ harness: entry.harness, path: entry.path, reason: state }); continue;
      }
      if (state === 'INSTALLED') {
        await safeAdapterPath(entry.path);
        if (entry.kind === 'file') {
          invariant(hash(await fs.readFile(entry.path)) === entry.hash, 'ADAPTER_CONFLICT', 'Adapter changed during uninstall');
          await fs.unlink(entry.path);
        } else {
          const settings = await readJSON<{ hooks: Record<string, unknown[]> }>(entry.path);
          const items = settings?.hooks?.[entry.event], index = items?.findIndex(item => isDeepStrictEqual(item, entry.entry)) ?? -1;
          invariant(settings && items && index >= 0, 'ADAPTER_CONFLICT', 'Hook changed during uninstall');
          items.splice(index, 1); await atomicWrite(entry.path, JSON.stringify(settings, null, 2) + '\n');
        }
        result.removed.push(entry.path);
      }
    } catch (error) {
      retained.push(entry); result.preserved.push({ harness: entry.harness, path: entry.path, reason: safeMessage(error) });
    }
  }
  if (retained.length !== registry.entries.length) {
    registry.entries = retained; await saveOwnership(registry);
    try {
      const path = join(home(), 'setup.json'); await safeAdapterPath(path);
      const previous = await readJSON<{ installed?: Record<string, string> }>(path);
      if (previous?.installed) {
        invariant(typeof previous.installed === 'object' && !Array.isArray(previous.installed), 'ADAPTER_CONFIG', 'Invalid setup installation metadata');
        for (const id of selected) if (!retained.some(entry => entry.harness === id)) delete previous.installed[id];
        await writeJSON(path, previous);
      }
    } catch (error) { result.warnings.push('Setup metadata was left unchanged: ' + safeMessage(error)); }
  }
  if (registry.commands.length && !registry.entries.length && !result.removed.length) result.warnings.push('Legacy command history is not proof of ownership; unrecorded adapters were left unchanged.');
  return result;
}
export async function installSdk(provider: string): Promise<void> {
  invariant(SDKS[provider], 'CONFIG', 'SDK installation supports daytona, modal or e2b');
  const dir = join(home(), 'sdk'); await privateDir(dir);
  if (!(await exists(join(dir, 'package.json')))) await writeJSON(join(dir, 'package.json'), { name: 'reroute-user-sdk', private: true });
  const result = await capture(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install','--prefix',dir,'--save-exact','--ignore-scripts','--no-audit','--no-fund', SDKS[provider]!], { timeoutMs: 10 * 60000 });
  invariant(result.code === 0, 'SDK_INSTALL', 'SDK installation failed. Check network/registry access; no provider command has run.');
}
export async function authStatus(): Promise<Record<string, unknown>> {
  return {
    daytona: process.env.DAYTONA_API_KEY ? 'environment present (not verified)' : 'DAYTONA_API_KEY missing',
    e2b: process.env.E2B_API_KEY ? 'environment present (not verified)' : 'E2B_API_KEY missing',
    modal: process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET || await exists(join(homedir(), '.modal.toml')) ? 'native credentials present (not verified)' : 'native credentials missing',
    ssh: await binary('ssh') ? 'OpenSSH available; credentials remain in ssh-agent/config' : 'OpenSSH missing',
    skypilot: await binary('sky') ? 'SkyPilot CLI available; run sky check for cloud auth' : 'SkyPilot CLI missing',
  };
}
export async function setup(options: { harnesses?: Harness[]; install?: string; skipAdapters?: boolean; allowCodexHook?: boolean }): Promise<unknown> {
  await privateDir(home()); await installShims();
  if (options.install) await installSdk(options.install);
  const detected = await detectHarnesses(); const installed: Record<string, string> = {};
  const warnings: string[] = [];
  if (!options.skipAdapters) for (const id of options.harnesses ?? []) {
    if (id === 'codex' && !options.allowCodexHook) {
      warnings.push('Codex command rewriting requires an explicit allow decision. Not installed automatically; review docs/HARNESSES.md, then opt in with --allow-codex-hook.');
      continue;
    }
    installed[id] = await installHarness(id);
  }
  await ensureDaemon();
  const previous = await readJSON<{ installed: Record<string, string> }>(join(home(), 'setup.json'));
  await writeJSON(join(home(), 'setup.json'), { installed: { ...previous?.installed, ...installed }, detected, version: '0.1.0-preview.1' });
  return { detected, installed, warnings, auth: await authStatus(), daemon: await request({ op: 'ping' }), note: 'Detected harnesses are not installed automatically; use --harness explicitly. Restart configured harnesses. OpenCode/DSH need native plugin activation. Remote runtimes are created on first execution, not by setup.' };
}
export async function doctor(cwd: string, fix: boolean, probe: boolean): Promise<unknown> {
  const checks: { check: string; state: string; detail: unknown }[] = [];
  const add = (check: string, state: string, detail: unknown) => checks.push({ check, state, detail });
  add('host', process.platform === 'win32' ? 'EXPERIMENTAL' : 'OK', { node: process.version, platform: process.platform, home: home() });
  for (const name of ['ssh','python3','rsync','mutagen','sky']) add(name, await binary(name) ? 'FOUND' : 'MISSING', name === 'rsync' || name === 'mutagen' ? 'Optional; guarded native transfer is used' : 'Provider dependent');
  for (const [id, spec] of Object.entries(SDKS)) {
    try { const name = spec.replace(/@[^@/]+$/, ''); createRequire(join(home(), 'sdk/package.json')).resolve(name); add(id + ' SDK','FOUND',spec); }
    catch { add(id + ' SDK','MISSING',`reroute setup --install-sdk ${id}`); }
  }
  if (fix) await installShims();
  try {
    const registry = await ownership();
    for (const id of HARNESSES) {
      const entries = registry.entries.filter(entry => entry.harness === id);
      if (!entries.length) { add('harness ' + id, 'NOT INSTALLED', 'Explicit setup --harness required; discovery does not install adapters'); continue; }
      const states = await Promise.all(entries.map(ownedState));
      if (fix && states.every(state => state === 'INSTALLED' || state === 'MISSING')) {
        try { await installHarness(id); add('harness ' + id, 'INSTALLED', { explicit: true, paths: entries.map(entry => entry.path) }); }
        catch (error) { add('harness ' + id, 'NOT FIXED', safeMessage(error)); }
      } else add('harness ' + id, states.every(state => state === 'INSTALLED') ? 'INSTALLED' : states.includes('UNSAFE') ? 'UNSAFE' : states.includes('MODIFIED') ? 'MODIFIED' : 'MISSING',
        { explicit: true, paths: entries.map(entry => entry.path), note: 'Only unchanged owned adapters may be fixed' });
    }
  } catch (error) { add('adapter ownership', 'FAILED', safeMessage(error)); }
  try { if (fix) await ensureDaemon(); add('daemon','OK', await request({ op: 'ping' }, false)); }
  catch (error) { add('daemon','NOT RUNNING',safeMessage(error)); }
  add('harness discovery','INFO',await detectHarnesses()); add('auth','INFO',await authStatus());
  try {
    const state = await findProject(cwd), config = await loadConfig(state?.project.root ?? cwd, state ? { ...state.override, provider: state.provider } : {});
    add('config','OK', { provider: config.provider, project: state?.project.id, enabled: state?.enabled ?? false });
    if (state?.runtime) add('runtime', 'INFO', await request({ op: 'status', cwd }));
    if (probe) {
      if (config.provider === 'ssh') {
        const options = config.providers.ssh ?? {}, provider = createProvider(config);
        invariant(typeof options.host === 'string', 'CONFIG', 'Set SSH host with reroute enable --provider ssh --host ALIAS');
        const { sshArgs } = await import('../providers/ssh.js');
        const result = await capture('ssh', [...sshArgs(options as unknown as import('../providers/ssh.js').SshOptions), shellCommand(['python3','--version'])], { timeoutMs: 20000 });
        add('SSH batch reachability',result.code === 0 ? 'OK' : 'FAILED', result.code === 0 ? result.stdout.trim() : 'Host key/auth/connectivity or Python3 failed; no runtime created'); void provider;
      } else add('live probe','NOT RUN', 'Use explicit live tests; doctor never provisions billable runtimes');
    }
  } catch (error) { add('project','FAILED',safeMessage(error)); }
  return { checks, safeFixesOnly: true };
}
