import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { home } from '../platform/files.js';
import { RerouteError, invariant, safeMessage, errorCode } from '../core/errors.js';
import { findProject, projectRoot } from '../core/projects.js';
import { loadConfig, merge, PROVIDERS } from '../config/config.js';
import { activationEnv, installShims } from '../core/activation.js';
import { route, selectedEnvironment, unshimmedPath } from '../core/routing.js';
import { remoteRun, request, reloadDaemon } from '../daemon/client.js';
import { transformHook } from '../adapters/hooks.js';
import { setup, doctor, authStatus, HARNESSES } from './setup.js';
const VERSION = '0.1.0-preview.1';
const HELP = `Reroute ${VERSION} - local source, remote project execution

  reroute setup [--harness pi,claude,codex] [--install-sdk daytona|modal|e2b]
  reroute enable [--provider daytona|ssh|skypilot|modal|e2b] [--host SSH_ALIAS]
  reroute disable                 Stop this project's work and disable interception
  reroute status                  Show project/runtime state
  reroute doctor [--fix] [--probe] Inspect host, adapters, auth, IPC and connectivity
  reroute exec [--timeout-ms N] -- COMMAND [ARGS...]
  reroute local -- COMMAND        Explicit local override (never automatic fallback)
  reroute start | reroute stop [--destroy]
  reroute sync [--accept-local]    Reconcile source; explicit local conflict resolution
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
function parse(args) {
    const boundary = args.indexOf('--'), before = boundary < 0 ? args : args.slice(0, boundary);
    const flags = {}, positionals = [];
    const values = new Set(['provider', 'host', 'harness', 'install-sdk', 'timeout-ms', 'port']);
    const booleans = new Set(['fix', 'probe', 'destroy', 'accept-local', 'new-identity', 'no-adapters', 'allow-codex-hook', 'follow', 'json', 'help']);
    for (let i = 0; i < before.length; i++) {
        const item = before[i];
        if (!item.startsWith('--')) {
            positionals.push(item);
            continue;
        }
        const key = item.slice(2);
        if (values.has(key)) {
            invariant(before[i + 1] !== undefined && !before[i + 1].startsWith('--'), 'USAGE', `Missing value for --${key}`);
            flags[key] = before[++i];
        }
        else {
            invariant(booleans.has(key), 'USAGE', `Unknown option --${key}`);
            flags[key] = true;
        }
    }
    return { flags, positionals, command: boundary < 0 ? [] : args.slice(boundary + 1) };
}
const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
function numberFlag(value) {
    if (value === undefined)
        return undefined;
    const num = Number(value);
    invariant(Number.isSafeInteger(num) && num > 0, 'USAGE', 'Numeric option must be a positive integer');
    return num;
}
async function native(argv, env) {
    invariant(argv.length > 0 && argv.every(x => !x.includes('\0')), 'USAGE', 'Provide a command after --');
    return new Promise((resolve, reject) => {
        const child = spawn(argv[0], argv.slice(1), { cwd: process.cwd(), env, stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true });
        let escalation;
        const signal = (name) => {
            try {
                if (child.pid)
                    process.platform === 'win32' ? child.kill(name) : process.kill(-child.pid, name);
            }
            catch { /* already exited */ }
            if (!escalation) {
                escalation = setTimeout(() => { try {
                    if (child.pid)
                        process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid, 'SIGKILL');
                }
                catch { /* gone */ } }, 3000);
                escalation.unref();
            }
        };
        const interrupt = () => signal('SIGINT'), terminate = () => signal('SIGTERM');
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        const cleanup = () => { clearTimeout(escalation); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); };
        child.once('error', () => { cleanup(); reject(new RerouteError('SPAWN', `Cannot start ${argv[0]}`, 127)); });
        child.once('close', (code, sig) => { cleanup(); resolve(code ?? (sig === 'SIGINT' ? 130 : 143)); });
    });
}
function localEnv() { return { ...process.env, PATH: unshimmedPath(process.env.PATH, join(home(), 'shims')), REROUTE_LOCAL: '1' }; }
async function runRemote(argv, timeoutMs) {
    invariant(argv.length > 0, 'USAGE', 'Provide a command after --');
    const state = await findProject(process.cwd());
    invariant(state?.enabled, 'NOT_ENABLED', 'Run reroute enable first. reroute local -- COMMAND is the explicit local override.');
    const config = await loadConfig(state.project.root, { ...state.override, provider: state.provider });
    const result = await remoteRun({ cwd: process.cwd(), argv, env: selectedEnvironment(process.env, config.routing.envAllow), timeoutMs });
    return result.timedOut ? 124 : result.cancelled ? 130 : result.code;
}
async function hook(host) {
    invariant(['claude', 'codex', 'cursor'].includes(host ?? ''), 'HOOK_PROTOCOL', 'Unknown hook host');
    let data = '';
    for await (const chunk of process.stdin) {
        data += chunk.toString();
        invariant(data.length <= 1024 * 1024, 'HOOK_PROTOCOL', 'Hook packet too large');
    }
    let packet;
    try {
        packet = JSON.parse(data);
    }
    catch {
        throw new RerouteError('HOOK_PROTOCOL', 'Malformed hook JSON', 2);
    }
    // Always wrap the ordinary shell, including cd into another project. Shims alone
    // decide project activation at execution time. Non-runtime tools are unchanged.
    print(transformHook(host, packet));
}
export async function main(args = process.argv.slice(2)) {
    let op = args[0];
    try {
        if (!op || op === '--help' || op === '-h') {
            print(HELP);
            return;
        }
        if (op === '--version' || op === '-v') {
            print(VERSION);
            return;
        }
        if (op === 'hook') {
            await hook(args[1]);
            return;
        }
        if (op === 'shim') {
            const argv = args.slice(1);
            invariant(argv.length > 0, 'USAGE', 'Missing shim command');
            if (process.env.REROUTE_LOCAL === '1' || process.env.REROUTE_REMOTE === '1') {
                process.exitCode = await native(argv, localEnv());
                return;
            }
            const state = await findProject(process.cwd());
            if (!state?.enabled) {
                process.exitCode = await native(argv, localEnv());
                return;
            }
            const config = await loadConfig(state.project.root, { ...state.override, provider: state.provider });
            process.exitCode = route(argv, config.routing.commands) === 'local' ? await native(argv, localEnv()) : await runRemote(argv);
            return;
        }
        const p = parse(args.slice(1)), flags = p.flags, cwd = process.cwd();
        if (flags.help) {
            print(HELP);
            return;
        }
        switch (op) {
            case 'setup': {
                const selected = typeof flags.harness === 'string' ? flags.harness.split(',') : undefined;
                invariant(!selected || selected.every(x => HARNESSES.includes(x)), 'USAGE', 'Unknown harness');
                print(await setup({ harnesses: selected, install: flags['install-sdk'], skipAdapters: flags['no-adapters'] === true, allowCodexHook: flags['allow-codex-hook'] === true }));
                return;
            }
            case 'enable': {
                const root = await projectRoot(cwd);
                const old = flags['new-identity'] ? undefined : await findProject(cwd);
                let override = old?.override ?? {};
                if (flags.host)
                    override = merge(override, { providers: { ssh: { host: flags.host } } });
                const config = await loadConfig(root, { ...override, ...(flags.provider ? { provider: flags.provider } : old ? { provider: old.provider } : flags.host ? { provider: 'ssh' } : {}) });
                await installShims(config.routing.commands);
                const state = await request({ op: 'enable', cwd, provider: config.provider, override, fresh: flags['new-identity'] === true });
                print({ enabled: true, provider: config.provider, project: state.project.id, note: 'Next intercepted runtime command will execute remotely. Restart your harness after initial setup.' });
                return;
            }
            case 'exec':
                process.exitCode = await runRemote(p.command, numberFlag(flags['timeout-ms']));
                return;
            case 'local':
                process.exitCode = await native(p.command, localEnv());
                return;
            case 'shell': {
                invariant(p.command.length === 1, 'USAGE', 'reroute shell -- requires one quoted shell command');
                invariant(process.platform !== 'win32' || process.env.REROUTE_SHELL, 'WINDOWS_SHELL', 'Native Windows shell bridging requires REROUTE_SHELL pointing to Git Bash. WSL is the supported default.');
                process.exitCode = await native([process.env.REROUTE_SHELL ?? '/bin/bash', '-c', p.command[0]], activationEnv());
                return;
            }
            case 'disable':
            case 'start':
            case 'stop':
            case 'status':
            case 'sync':
                print(await request({ op, cwd, destroy: flags.destroy === true, acceptLocal: flags['accept-local'] === true }));
                return;
            case 'doctor':
                print(await doctor(cwd, flags.fix === true, flags.probe === true));
                return;
            case 'providers':
                print({ providers: PROVIDERS, details: 'docs/PROVIDERS.md', note: 'Daytona default; SSH never provisions or shuts down its host; resource capabilities are validated.' });
                return;
            case 'auth':
                if (p.positionals[0] === 'reload') {
                    await reloadDaemon();
                    print(await setup({ skipAdapters: true }));
                }
                else
                    print(await authStatus());
                return;
            case 'daemon':
                invariant(p.positionals[0] === 'stop', 'USAGE', 'Use reroute daemon stop');
                print(await request({ op: 'shutdown' }, false));
                return;
            case 'logs':
                try {
                    print((await fs.readFile(join(home(), 'logs/daemon.jsonl'), 'utf8')).split('\n').slice(-100).join('\n'));
                }
                catch (error) {
                    if (errorCode(error) !== 'ENOENT')
                        throw error;
                    print('No coordinator log yet');
                }
                return;
            case 'dev': {
                const action = p.positionals[0];
                if (action === 'stop') {
                    print(await request({ op: 'dev.stop', cwd }));
                    return;
                }
                if (action === 'logs') {
                    let prior = '';
                    do {
                        const text = await request({ op: 'dev.logs', cwd });
                        process.stdout.write(text.startsWith(prior) ? text.slice(prior.length) : text);
                        prior = text;
                        if (flags.follow)
                            await sleep(500);
                    } while (flags.follow);
                    return;
                }
                if (action === 'open') {
                    const url = await request({ op: 'dev.preview', cwd });
                    invariant(typeof url === 'string' && /^https?:\/\//.test(url), 'PREVIEW_URL', 'Invalid preview URL');
                    print(url);
                    if (process.env.REROUTE_NO_OPEN !== '1') {
                        const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : ['xdg-open', url];
                        await native(command, localEnv()).catch(() => print('Open the URL above in your browser.'));
                    }
                    return;
                }
                invariant(!action && p.command.length > 0, 'USAGE', 'Use reroute dev --port PORT -- COMMAND');
                const state = await findProject(cwd);
                const config = await loadConfig(state?.project.root ?? cwd, state?.override);
                print(await request({ op: 'dev.start', cwd, argv: p.command, env: selectedEnvironment(process.env, config.routing.envAllow), timeoutMs: numberFlag(flags['timeout-ms']), port: numberFlag(flags.port) }));
                print('Dev session started. reroute dev logs --follow streams logs; reroute dev stop releases its runtime lease.');
                return;
            }
            default: throw new RerouteError('USAGE', `Unknown command: ${op}. Run reroute --help`, 64);
        }
    }
    catch (error) {
        console.error(`Reroute: ${safeMessage(error)}`);
        process.exitCode = op === 'hook' ? 2 : error instanceof RerouteError ? error.exitCode : 70;
    }
}
