import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { home } from '../platform/files.js';
import { RerouteError, invariant, safeMessage, errorCode } from '../core/errors.js';
import { findProject, projectRoot } from '../core/projects.js';
import { loadConfig, PROVIDERS } from '../config/config.js';
import { activationEnv } from '../core/activation.js';
import { route, routingDecision, selectedEnvironment, unshimmedPath } from '../core/routing.js';
import { remoteRun, request, reloadDaemon } from '../daemon/client.js';
import { syncPreview } from '../sync/sync.js';
import { transformHook, type HookHost } from '../adapters/hooks.js';
import { projectConfiguration, enableProject, localStatus, runtimeStatus } from './manage.js';
import { setup, uninstall, doctor, authStatus, HARNESSES, type Harness, type UninstallHarness } from './setup.js';
const VERSION = '0.1.0-preview.1';
const HELP = `Reroute ${VERSION} - local source, remote project execution

  reroute                         Show local status (no activation or cloud calls)
  reroute setup [--provider PROVIDER] [--host SSH_ALIAS] [--harness pi,claude,codex] [--install-sdk daytona|modal|e2b]
    TTY: guided provider/routing setup. --non-interactive or --json: explicit flags.
    --tasks build,test,check,benchmark (or none); detected harnesses are never auto-installed.
  reroute uninstall [--harness pi,claude]  Remove unchanged owned adapters only
  reroute enable [--provider daytona|ssh|skypilot|modal|e2b] [--host SSH_ALIAS]
  reroute disable                 Stop this project's work and disable interception
   reroute status [--json] [--live]  Local metadata; --live explicitly queries provider
  reroute COMMAND [ARGS...]        Explicit remote argv execution; not a shell script
  reroute doctor [--fix] [--probe] Inspect host, adapters, auth, IPC and connectivity
  reroute explain [--json] -- COMMAND [ARGS...]  Explain transparent routing; no execution
  reroute exec [--timeout-ms N] -- COMMAND [ARGS...]
  reroute local -- COMMAND        Explicit local override (never automatic fallback)
  reroute enable --allow-paid      Authorize paid resources for this project/provider
  reroute enable --revoke-paid     Revoke authorization (not cloud stop/cleanup)
  reroute start | reroute stop [--destroy]
  reroute artifacts               Fetch configured build files into .reroute/artifacts/UUID
  reroute sync [--accept-local]    Reconcile source; explicit local conflict resolution
  reroute sync --dry-run [--json]  Inspect local sync scope only; no daemon/cloud/writes
  reroute dev [--port N] -- COMMAND [ARGS...]
  reroute dev logs [--follow] | reroute dev open | reroute dev stop
  reroute providers | reroute auth status | reroute auth reload
  reroute logs                    Local coordinator metadata log
  reroute daemon stop             Graceful coordinator stop; no machine shutdown
  reroute shell -- 'COMMAND'      Run a local shell with transparent runtime shims

Remote Python 3 is required. SSH/Daytona/SkyPilot also require local OpenSSH.
Use provider-native auth before setup. No provider SDKs/credentials are bundled.
Absolute executable paths, TTY applications, and unhooked tools are not intercepted.
See README.md and docs/HARNESSES.md before using an agent integration.
`;
interface Parsed { positionals: string[]; flags: Record<string,string|boolean>; command: string[] }
function parse(args: string[]): Parsed {
  const boundary = args.indexOf('--'), before = boundary < 0 ? args : args.slice(0,boundary);
  const flags: Record<string,string|boolean> = {}, positionals: string[] = [];
  const values = new Set(['provider','host','harness','install-sdk','timeout-ms','port','tasks']);
  const booleans = new Set(['fix','probe','destroy','accept-local','new-identity','no-adapters','allow-codex-hook','follow','json','dry-run','help','allow-paid','revoke-paid','live','non-interactive']);
  for (let i = 0; i < before.length; i++) {
    const item = before[i]!;
    if (!item.startsWith('--')) { positionals.push(item); continue; }
    const key = item.slice(2);
    if (values.has(key)) { invariant(before[i+1] !== undefined && !before[i+1]!.startsWith('--'), 'USAGE', `Missing value for --${key}`); flags[key] = before[++i]!; }
    else { invariant(booleans.has(key), 'USAGE', `Unknown option --${key}`); flags[key] = true; }
  }
  return { flags, positionals, command: boundary < 0 ? [] : args.slice(boundary+1) };
}
const print = (value: unknown) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function numberFlag(value: string|boolean|undefined): number|undefined {
  if (value === undefined) return undefined; const num = Number(value);
  invariant(Number.isSafeInteger(num) && num > 0, 'USAGE', 'Numeric option must be a positive integer'); return num;
}
async function native(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  invariant(argv.length > 0 && argv.every(x => !x.includes('\0')), 'USAGE', 'Provide a command after --');
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd: process.cwd(), env, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
    let escalation: NodeJS.Timeout|undefined;
    const signal = (name: NodeJS.Signals) => {
      try { if (child.pid) process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid, name); } catch { /* already exited */ }
      if (!escalation) { escalation = setTimeout(() => { try { if (child.pid) process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid,'SIGKILL'); } catch { /* gone */ } }, 3000); escalation.unref(); }
    };
    const interrupt = () => signal('SIGINT'), terminate = () => signal('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    const cleanup = () => { clearTimeout(escalation); process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',terminate); };
    child.once('error', () => { cleanup(); reject(new RerouteError('SPAWN', `Cannot start ${argv[0]}`, 127)); });
    child.once('close', (code, sig) => { cleanup(); resolve(code ?? (sig === 'SIGINT' ? 130 : 143)); });
  });
}
function localEnv(): NodeJS.ProcessEnv { return { ...process.env, PATH: unshimmedPath(process.env.PATH, join(home(),'shims')), REROUTE_LOCAL: '1' }; }
async function runRemote(argv: string[], timeoutMs?: number, explicit = true): Promise<number> {
  invariant(argv.length > 0, 'USAGE', 'Provide a command after --');
  const state = await findProject(process.cwd()); invariant(state?.enabled, 'NOT_ENABLED', 'Run reroute enable first. reroute local -- COMMAND is the explicit local override.');
  const config = await loadConfig(state.project.root, { ...state.override, provider: state.provider });
  const result = await remoteRun({ cwd: process.cwd(), argv, env: selectedEnvironment(process.env, config.routing.envAllow), timeoutMs, explicit });
  return result.timedOut ? 124 : result.cancelled ? 130 : result.code;
}
async function hook(host: string|undefined): Promise<void> {
  invariant(['claude','codex','cursor'].includes(host ?? ''), 'HOOK_PROTOCOL', 'Unknown hook host');
  let data = ''; for await (const chunk of process.stdin) { data += chunk.toString(); invariant(data.length <= 1024*1024,'HOOK_PROTOCOL','Hook packet too large'); }
  let packet: unknown; try { packet = JSON.parse(data); } catch { throw new RerouteError('HOOK_PROTOCOL','Malformed hook JSON',2); }
  // Always wrap the ordinary shell, including cd into another project. Shims alone
  // decide project activation at execution time. Non-runtime tools are unchanged.
  print(transformHook(host as HookHost, packet));
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  let op = args[0];
  try {
    if (op === '--help' || op === '-h') { print(HELP); return; }
    if (!op) op = 'status';
    const internal = new Set(['setup','uninstall','enable','disable','status','doctor','explain','exec','local','start','stop','sync','artifacts','dev','providers','auth','logs','daemon','shell','hook','shim']);
    if (!internal.has(op) && !op.startsWith('-')) {
      invariant(/^[A-Za-z0-9_+./-]+$/.test(op), 'USAGE', 'Use reroute exec -- COMMAND for explicit argv; shorthand is not a shell script');
      process.exitCode = await runRemote(args); return;
    }
    if (op === '--version' || op === '-v') { print(VERSION); return; }
    if (op === 'hook') { await hook(args[1]); return; }
    if (op === 'shim') {
      const argv = args.slice(1); invariant(argv.length > 0,'USAGE','Missing shim command');
      if (process.env.REROUTE_LOCAL === '1' || process.env.REROUTE_REMOTE === '1') { process.exitCode = await native(argv, localEnv()); return; }
      const state = await findProject(process.cwd());
      if (!state?.enabled) { process.exitCode = await native(argv, localEnv()); return; }
      const config = await loadConfig(state.project.root, { ...state.override, provider: state.provider });
      process.exitCode = route(argv,config.routing.commands,config.routing) === 'local' ? await native(argv,localEnv()) : await runRemote(argv,undefined,false); return;
    }
    const p = parse(args.slice(1)), flags = p.flags, cwd = process.cwd();
    if (flags.help) { print(HELP); return; }
    if (flags['allow-paid'] || flags['revoke-paid']) invariant(op === 'setup' || op === 'enable', 'USAGE', 'Paid authorization belongs to setup/enable, not execution or inspection');
    if (flags.destroy) invariant(op === 'stop', 'USAGE', '--destroy is only valid with stop');
    if (['setup','enable','uninstall','status','stop','start','disable','providers','artifacts','doctor','logs'].includes(op)) invariant(p.positionals.length === 0 && p.command.length === 0, 'USAGE', `${op} does not accept a program. Internal commands take priority; use reroute exec -- PROGRAM for a name collision.`);
    switch (op) {
      case 'setup': case 'uninstall': {
        const selected = typeof flags.harness === 'string' ? flags.harness.split(',') : undefined;
        invariant(!selected || selected.every(x => HARNESSES.includes(x as Harness) || (op === 'uninstall' && x === 'omp')), 'USAGE','Unknown harness');
        if (op === 'uninstall') { print(await uninstall({ harnesses: selected as UninstallHarness[]|undefined })); return; }
        if (process.stdin.isTTY && process.stdout.isTTY && !flags['non-interactive'] && !flags.json) {
          const { setupWizard } = await import('./wizard.js');
          if (!(await setupWizard(cwd, flags))) { process.exitCode = 130; return; }
        }
        // Validate project choices before installing any explicitly selected adapter.
        const configureProject = !!(flags.provider || flags.host || flags.tasks);
        if (flags.tasks && !flags.provider && !flags.host) invariant(await findProject(cwd), 'USAGE', 'Select --provider PROVIDER (and --host ALIAS for SSH) before setting --tasks');
        if (configureProject) await projectConfiguration(cwd, flags);
        const report = await setup({ harnesses: selected as Harness[]|undefined, install: flags['install-sdk'] as string|undefined, skipAdapters: flags['no-adapters'] === true, allowCodexHook: flags['allow-codex-hook'] === true });
        const project = configureProject ? await enableProject(cwd, flags) : { enabled: (await findProject(cwd))?.enabled ?? false, next: 'reroute setup --provider ssh --host ALIAS (or --provider daytona)' };
        print({ ...(report as Record<string, unknown>), project, next: 'reroute; reroute cargo test; reroute stop' }); return;
      }
      case 'enable': {
        print(await enableProject(cwd, flags)); return;
      }
      case 'explain': {
        invariant(p.command.length > 0 && p.command.every(x => !x.includes('\0')), 'USAGE', 'Provide a command after --');
        const state = await findProject(cwd), root = state?.project.root ?? await projectRoot(cwd);
        const config = await loadConfig(root, state ? { ...state.override, provider: state.provider } : {});
        const policy = routingDecision(p.command, config.routing.commands, config.routing);
        const intercepted = !/[\\/]/.test(p.command[0]!) && config.routing.commands.includes(policy.executable);
        const override = process.env.REROUTE_LOCAL === '1' ? 'explicit-local' : process.env.REROUTE_REMOTE === '1' ? 'already-remote' : undefined;
        const reason = override ?? (!state?.enabled ? 'project-not-enabled' : !intercepted ? 'not-intercepted-by-path-shim' : policy.rule);
        const report = {
          version: 1, mode: 'transparent-path-routing', argv: p.command, executable: policy.executable,
          projectRoot: root, enabled: state?.enabled ?? false, provider: config.provider,
          policyRoute: policy.route, matchedRule: policy.rule, intercepted,
          route: !override && state?.enabled && intercepted ? policy.route : 'local', reason,
          remoteReadiness: 'UNVERIFIED', policyMode: config.routing.mode ?? 'tasks',
          migration: config.routing.mode === 'legacy' ? 'Legacy executable policy retained. Set routing.mode = "tasks" and use exact local/remote argv prefixes to migrate.' : undefined,
          limitations: [
            'Only PATH shim lookup in an activated shell is modeled; absolute/relative executable paths and overridden PATH bypass shims.',
            'Shell wrappers, aliases, package script bodies and nested commands are not parsed; a remote script can run Git/publish/deploy remotely.',
            'Unhooked tools are outside this interception boundary. Explicit reroute exec is a different entry point and still rejects control commands.',
            'No execution, daemon contact, resource creation or remote conflict/readiness check was performed. Remote failure never implies local fallback.'
          ]
        };
        print(flags.json ? report : [
          `Route: ${report.route} (${report.reason})`, `Rule: ${report.matchedRule}; configured policy: ${report.policyRoute}`,
          `Project: ${root}; enabled: ${report.enabled}; provider: ${report.provider}`,
          `PATH shim eligible: ${intercepted}; remote readiness: UNVERIFIED`, ...report.limitations
        ].join('\n')); return;
      }
      case 'exec': process.exitCode = await runRemote(p.command, numberFlag(flags['timeout-ms'])); return;
      case 'local': process.exitCode = await native(p.command, localEnv()); return;
      case 'shell': {
        invariant(p.command.length === 1, 'USAGE', 'reroute shell -- requires one quoted shell command');
        invariant(process.platform !== 'win32' || process.env.REROUTE_SHELL, 'WINDOWS_SHELL', 'Native Windows shell bridging requires REROUTE_SHELL pointing to Git Bash. WSL is the supported default.');
        process.exitCode = await native([process.env.REROUTE_SHELL ?? '/bin/bash','-c',p.command[0]!], activationEnv()); return;
      }
      case 'sync': {
        if (!flags['dry-run']) { print(await request({ op, cwd, acceptLocal: flags['accept-local'] === true })); return; }
        invariant(!flags['accept-local'] && !flags.destroy && p.command.length === 0 && p.positionals.length === 0, 'USAGE', 'sync --dry-run cannot accept changes or a command');
        const state = await findProject(cwd), root = state?.project.root ?? await projectRoot(cwd);
        const config = await loadConfig(root, state ? { ...state.override, provider: state.provider } : {});
        const report = await syncPreview(root, config.sync);
        print(flags.json ? report : [
          `Local-only sync preview: ${report.readiness.ready ? 'READY' : 'NOT READY'}`,
          `Included: ${report.files.count} files, ${report.files.bytes} bytes; limits: ${report.files.limits.maxFiles} files / ${report.files.limits.maxFileBytes} bytes per file`,
          ...report.included.map(item => `INCLUDE ${JSON.stringify(item.path)} (${item.bytes} bytes)`),
          ...report.excluded.map(item => `EXCLUDE ${JSON.stringify(item.path)} (${item.reason}${item.pattern ? ': ' + item.pattern : ''})`),
          ...report.symlinks.map(path => `SYMLINK ${JSON.stringify(path)} (not followed)`),
          ...report.unsupportedTypes.map(item => `UNSUPPORTED ${JSON.stringify(item.path)} (${item.type})`),
          ...report.sensitiveNameRisks.map(item => `NAME RISK ${JSON.stringify(item.path)} (${item.excluded ? 'excluded' : 'included; review before upload'})`),
          ...report.errors.map(item => `ERROR ${JSON.stringify(item.path)} [${item.code}]: ${item.message}`),
          'Excluded directories are pruned, not recursively enumerated. Filename risk checks are not DLP.',
          'No content hashes, remote conflict/readiness checks, daemon, resource creation or source/state writes.'
        ].join('\n'));
        process.exitCode = report.readiness.ready ? 0 : 65; return;
      }
      case 'status': {
        const report = { ...await localStatus(cwd), ...(flags.live ? await runtimeStatus(cwd) : {}) };
        print(flags.json ? report : [`Project: ${report.project?.root ?? cwd} (${report.enabled ? 'enabled' : 'disabled'})`, `Provider: ${report.provider ?? 'not configured'}; runtime: ${report.runtime ?? 'not created'}; remote state: ${report.status}`, `Tasks: ${report.active ?? 'UNKNOWN'}; sync pending: ${report.syncPending === true ? 'YES — run reroute sync' : 'no recorded pending source'}`, `Coordinator: ${report.coordinator}; paid authorization: ${report.paidAuthorized ? 'yes / not required for SSH' : 'not granted'}; billing: UNKNOWN`, ...(report.warning ? [`Attention: ${report.warning}`] : []), `Next: ${report.enabled ? 'reroute cargo test | reroute sync | reroute stop' : 'reroute setup --provider ssh --host ALIAS (or --provider daytona)'}`].join('\n')); return;
      }
      case 'artifacts': print(await request({ op, cwd })); return;
      case 'stop': {
        const before = await findProject(cwd);
        await request({ op, cwd, destroy: flags.destroy === true });
        print({ provider: before?.provider, runtime: before?.runtime?.id, action: !before?.runtime ? 'no-recorded-runtime' : flags.destroy ? 'native-destroy-confirmed' : 'native-stop-policy-confirmed', syncPending: (await findProject(cwd))?.syncPending === true, billing: 'UNKNOWN', note: before?.provider === 'ssh' ? (flags.destroy ? 'Only the verified Reroute workspace directory was removed; SSH host stays running.' : 'SSH work/tunnels stopped; the host and workspace remain.') : 'Native runtime operation completed. Retained disks/volumes/archives may still incur charges; verify native resources and billing. No zero-cost guarantee.' }); return;
      }
      case 'disable': case 'start':
        print(await request({ op, cwd })); return;
      case 'doctor': print(await doctor(cwd, flags.fix === true, flags.probe === true)); return;
      case 'providers': print({ providers:PROVIDERS, details:'docs/PROVIDERS.md', note:'Daytona default; SSH never provisions or shuts down its host; resource capabilities are validated.' }); return;
      case 'auth':
        if (p.positionals[0] === 'reload') { await reloadDaemon(); print({ ...(await setup({skipAdapters:true}) as object), daemon: await request({op:'ping'}, false) }); }
        else print(await authStatus()); return;
      case 'daemon': invariant(p.positionals[0] === 'stop','USAGE','Use reroute daemon stop'); print(await request({op:'shutdown'},false)); return;
      case 'logs':
        try { print((await fs.readFile(join(home(),'logs/daemon.jsonl'),'utf8')).split('\n').slice(-100).join('\n')); }
        catch (error) { if (errorCode(error) !== 'ENOENT') throw error; print('No coordinator log yet'); } return;
      case 'dev': {
        const action = p.positionals[0];
        if (action === 'stop') { print(await request({op:'dev.stop',cwd})); return; }
        if (action === 'logs') {
          let prior = '';
          do { const text = await request({op:'dev.logs',cwd}) as string; process.stdout.write(text.startsWith(prior) ? text.slice(prior.length) : text); prior = text; if (flags.follow) await sleep(500); } while (flags.follow); return;
        }
        if (action === 'open') {
          const url = await request({op:'dev.preview',cwd}); invariant(typeof url === 'string' && /^https?:\/\//.test(url),'PREVIEW_URL','Invalid preview URL'); print(url);
          if (process.env.REROUTE_NO_OPEN !== '1') {
            const command = process.platform === 'darwin' ? ['open',url] : process.platform === 'win32' ? ['rundll32','url.dll,FileProtocolHandler',url] : ['xdg-open',url];
            await native(command,localEnv()).catch(() => print('Open the URL above in your browser.'));
          } return;
        }
        invariant(!action && p.command.length > 0,'USAGE','Use reroute dev --port PORT -- COMMAND');
        const state = await findProject(cwd); const config = await loadConfig(state?.project.root ?? cwd,state?.override);
        print(await request({ op:'dev.start',cwd,argv:p.command,env:selectedEnvironment(process.env,config.routing.envAllow),timeoutMs:numberFlag(flags['timeout-ms']),port:numberFlag(flags.port) }));
        print('Dev session started. reroute dev logs --follow streams logs; reroute dev stop releases its runtime lease.'); return;
      }
      default: throw new RerouteError('USAGE', `Unknown command: ${op}. Run reroute --help`, 64);
    }
  } catch (error) {
    console.error(`Reroute: ${safeMessage(error)}`);
    process.exitCode = op === 'hook' ? 2 : error instanceof RerouteError ? error.exitCode : 70;
  }
}
