import { promises as fs, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { exists, home, atomicWrite, privateDir, packageRoot, cliPath, readJSON, writeJSON } from '../platform/files.js';
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
async function managedFile(path: string, content: string): Promise<void> {
  if (await exists(path)) {
    invariant((await fs.readFile(path, 'utf8')).startsWith(managedMarker), 'ADAPTER_CONFLICT', `Refusing to replace non-Reroute file: ${path}`);
  }
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 }); await atomicWrite(path, managedMarker + '\n' + content);
}
/** Merge only an owned hook; do not rewrite unrelated entries or corrupt JSON. */
export async function mergeHookFile(path: string, host: 'claude'|'codex'|'cursor'): Promise<void> {
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
  // Exact owned entry only. Arbitrary commands merely containing "reroute" are not ours.
  const history = await readJSON<{ commands: string[] }>(join(home(), 'installed-hooks.json')) ?? { commands: [] };
  const owned = new Set([...history.commands, command]);
  const cleaned = previous.filter((item: unknown) => {
    if (!item || typeof item !== 'object') return true;
    const value = item as { command?: string; hooks?: { command?: string }[] };
    return host === 'cursor' ? !owned.has(value.command ?? '') : !(Array.isArray(value.hooks) && value.hooks.length === 1 && owned.has(value.hooks[0]?.command ?? ''));
  });
  cleaned.push(host === 'cursor' ? { command, failClosed: true } : { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] });
  map[event] = cleaned; settings.hooks = map;
  if (host === 'cursor') settings.version ??= 1;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await exists(path)) { const backup = path + '.reroute-backup'; if (!(await exists(backup))) { await fs.copyFile(path, backup); await fs.chmod(backup, 0o600); } }
  await atomicWrite(path, JSON.stringify(settings, null, 2) + '\n');
  await writeJSON(join(home(), 'installed-hooks.json'), { commands: [...owned] });
}
export async function installHarness(id: Harness): Promise<string> {
  const url = (name: string) => JSON.stringify(pathToFileURL(join(packageRoot, 'adapters', name + '.mjs')).href);
  switch (id) {
    case 'pi': {
      const path = join(agentHome(), '.pi/agent/extensions/reroute.ts');
      await managedFile(path, `import * as sdk from '@earendil-works/pi-coding-agent';\nimport { registerPi } from ${url('pi')};\nexport default pi => registerPi(pi, sdk);\n`); return path;
    }
    case 'omp': { const path = join(agentHome(), '.omp/agent/extensions/reroute.ts'); await managedFile(path, `export { default } from ${url(id)};\n`); return path; }
    case 'claude': { const path = join(agentHome(), '.claude/settings.json'); await mergeHookFile(path, id); return path; }
    case 'codex': { const path = join(agentHome(), '.codex/hooks.json'); await mergeHookFile(path, id); return path; }
    case 'cursor': { const path = join(agentHome(), '.cursor/hooks.json'); await mergeHookFile(path, id); return path; }
    case 'opencode': {
      // v2 plugin declaration is documented in HARNESSES.md; avoid overwriting a v1 config.
      const path = join(home(), 'adapters/opencode.mjs'); await managedFile(path, `export { default } from ${url(id)};\n`); return `${path} (add to OpenCode v2 plugin configuration; see HARNESSES.md)`;
    }
    case 'deepseek': {
      const path = join(home(), 'adapters/deepseek.mjs');
      await managedFile(path, `import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';\nimport { rerouteExecutor } from ${url(id)};\nexport default rerouteExecutor(LocalBashExecutor);\n`);
      return `${path} (replace dsh-bash-local in the DSH composition; see HARNESSES.md)`;
    }
  }
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
  if (!options.skipAdapters) for (const id of options.harnesses ?? detected) {
    if (id === 'codex' && !options.allowCodexHook) {
      warnings.push('Codex command rewriting requires an explicit allow decision. Not installed automatically; review docs/HARNESSES.md, then opt in with --allow-codex-hook.');
      continue;
    }
    installed[id] = await installHarness(id);
  }
  await ensureDaemon();
  await writeJSON(join(home(), 'setup.json'), { installed, detected, version: '0.1.0-preview.1' });
  return { detected, installed, warnings, auth: await authStatus(), daemon: await request({ op: 'ping' }), note: 'Restart configured harnesses. OpenCode/DSH need native plugin activation. Remote runtimes are created on first execution, not by setup.' };
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
  if (fix) { await installShims(); const previous = await readJSON<{ installed: Record<string,string> }>(join(home(), 'setup.json')); for (const id of Object.keys(previous?.installed ?? {})) if (HARNESSES.includes(id as Harness)) await installHarness(id as Harness); }
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
