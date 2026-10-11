import { join } from 'node:path';
import { home } from './files.js';
import { unshimmedPath } from '../core/routing.js';
import { spawn } from 'node:child_process';
import { AsyncQueue } from '../core/queue.js';
import { RerouteError } from '../core/errors.js';
export function spawnRaw(command, args, options = {}) {
    const queue = new AsyncQueue();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? { ...process.env, PATH: unshimmedPath(process.env.PATH, join(home(), 'shims')), REROUTE_LOCAL: '1' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let closed = false;
    let timer;
    function signal(sig) {
        if (closed || !child.pid)
            return;
        try {
            process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig);
        }
        catch { /* already gone */ }
    }
    const done = new Promise((resolve, reject) => {
        child.stdout.on('data', (data) => queue.push({ type: 'output', stream: 'stdout', data }));
        child.stderr.on('data', (data) => queue.push({ type: 'output', stream: 'stderr', data }));
        child.stdin.on('error', () => { });
        child.once('error', () => { closed = true; clearTimeout(timer); const e = new RerouteError('SPAWN', `Cannot start ${command}. Run reroute doctor.`, 127); queue.end(e); reject(e); });
        child.once('close', (code, sig) => { closed = true; clearTimeout(timer); queue.end(); resolve(code ?? (sig === 'SIGINT' ? 130 : 143)); });
    });
    void done.catch(() => { });
    if (options.timeoutMs)
        timer = setTimeout(() => { signal('SIGTERM'); setTimeout(() => signal('SIGKILL'), 1000).unref(); }, options.timeoutMs);
    return {
        events: queue,
        write: data => new Promise((resolve, reject) => {
            if (closed || child.stdin.destroyed) {
                reject(new RerouteError('STDIN_CLOSED', 'Execution input is closed'));
                return;
            }
            child.stdin.write(data, error => error ? reject(error) : resolve());
        }),
        closeInput: async () => { if (!child.stdin.destroyed)
            child.stdin.end(); },
        wait: () => done,
        kill: async () => { signal('SIGTERM'); const timer = setTimeout(() => signal('SIGKILL'), 1000); timer.unref(); await done.catch(() => { }); clearTimeout(timer); }
    };
}
export async function capture(command, args, options = {}) {
    const raw = spawnRaw(command, args, options);
    await raw.closeInput();
    let stdout = '', stderr = '', bytes = 0;
    for await (const event of raw.events) {
        bytes += event.data.length;
        if (bytes > (options.limit ?? 4 * 1024 * 1024)) {
            await raw.kill();
            throw new RerouteError('OUTPUT_LIMIT', 'Control command output exceeded its limit');
        }
        if (event.stream === 'stdout')
            stdout += event.data.toString();
        else
            stderr += event.data.toString();
    }
    return { code: await raw.wait(), stdout, stderr };
}
export function quote(value) { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export function shellCommand(argv) { return argv.map(quote).join(' '); }
