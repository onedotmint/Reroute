import net from 'node:net';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '../core/contracts.js';
import { RerouteError, errorCode, invariant } from '../core/errors.js';
import { home, daemonPath, privateDir, readJSON, writeJSON } from '../platform/files.js';
import { endpoint, lines, send } from './protocol.js';
function connect(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(endpoint());
        const timeout = setTimeout(() => { socket.destroy(); reject(new RerouteError('DAEMON_TIMEOUT', 'Daemon connection timed out')); }, timeoutMs);
        socket.once('connect', () => { clearTimeout(timeout); resolve(socket); });
        socket.once('error', error => { clearTimeout(timeout); reject(error); });
    });
}
export async function request(packet, autostart = true) {
    if (autostart)
        await ensureDaemon();
    return exchange(packet, packet.op === 'ping' ? 2000 : 30 * 60000);
}
async function exchange(packet, timeoutMs) {
    const socket = await connect(Math.min(2000, timeoutMs));
    let token;
    try {
        token = await fs.readFile(join(home(), 'ipc-token'), 'utf8');
    }
    catch (error) {
        socket.destroy();
        if (errorCode(error) === 'ENOENT')
            throw new RerouteError('IPC_AUTH', 'Missing local IPC credential for a reachable daemon');
        throw error;
    }
    return new Promise((resolve, reject) => {
        let finished = false;
        const timer = setTimeout(() => { socket.destroy(); if (!finished)
            reject(new RerouteError('DAEMON_TIMEOUT', 'Daemon request timed out')); }, timeoutMs);
        const fail = (error) => { finished = true; clearTimeout(timer); socket.destroy(); reject(error); };
        lines(socket, result => {
            if (result.type !== 'result' && result.type !== 'error')
                return;
            finished = true;
            clearTimeout(timer);
            socket.end();
            if (result.type === 'error')
                reject(new RerouteError(String(result.code), String(result.message), Number(result.exitCode) || 70));
            else
                resolve(result.value);
        }, fail);
        socket.on('error', fail);
        socket.on('close', () => { clearTimeout(timer); if (!finished)
            reject(new RerouteError('DAEMON_LOST', 'Daemon disconnected before confirming the operation')); });
        void send(socket, { ...packet, token, v: PROTOCOL_VERSION }).catch(fail);
    });
}
export async function ensureDaemon() { await startDaemon(false); }
export async function reloadDaemon() { await startDaemon(true); }
function processAlive(pid) {
    invariant(Number.isInteger(pid) && pid > 0, 'IPC_PROTOCOL', 'Invalid daemon process ID');
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (errorCode(error) === 'ESRCH')
            return false;
        if (errorCode(error) === 'EPERM')
            return true;
        throw error;
    }
}
async function ping(timeoutMs = 2000) {
    try {
        const value = await exchange({ op: 'ping' }, timeoutMs);
        invariant(value && Number.isInteger(value.pid) && Number(value.pid) > 0, 'IPC_PROTOCOL', 'Invalid daemon readiness response');
        return { pid: Number(value.pid) };
    }
    catch (error) {
        if (errorCode(error) === 'DAEMON_STOPPING') {
            const previous = await readJSON(join(home(), 'daemon.json'));
            invariant(previous && Number.isInteger(previous.pid) && previous.pid > 0, 'IPC_PROTOCOL', 'Shutting-down daemon has no valid process record');
            return { pid: previous.pid, stopping: true };
        }
        if (['ENOENT', 'ECONNREFUSED'].includes(errorCode(error) ?? ''))
            return undefined;
        throw error;
    }
}
async function startDaemon(forceReload, timeoutMs = 10000) {
    if (!forceReload) {
        const ready = await ping();
        if (ready && !ready.stopping)
            return;
    }
    await privateDir(home());
    const lock = join(home(), 'daemon-start.lock');
    let acquired = false;
    try {
        const lockDeadline = Date.now() + timeoutMs;
        while (Date.now() < lockDeadline) {
            try {
                await fs.mkdir(lock, { mode: 0o700 });
                acquired = true;
                await writeJSON(join(lock, 'owner.json'), { pid: process.pid });
                break;
            }
            catch (error) {
                if (acquired || errorCode(error) !== 'EEXIST')
                    throw error;
                if (!forceReload) {
                    const ready = await ping(Math.min(2000, Math.max(1, lockDeadline - Date.now())));
                    if (ready && !ready.stopping)
                        return;
                }
                try {
                    const owner = await readJSON(join(lock, 'owner.json'));
                    if (owner ? !processAlive(owner.pid) : Date.now() - (await fs.stat(lock)).mtimeMs > 5000)
                        await fs.rm(lock, { recursive: true, force: true });
                }
                catch (error) {
                    if (errorCode(error) !== 'ENOENT')
                        throw error;
                }
                await sleep(100);
            }
        }
        if (!acquired)
            throw new RerouteError('DAEMON_LOCK', 'Another daemon startup or reload is stuck. Run reroute doctor --fix.');
        const ready = await ping();
        if (ready && !ready.stopping && !forceReload)
            return;
        const previous = await readJSON(join(home(), 'daemon.json'));
        if (forceReload && ready) {
            if (!ready.stopping) {
                const result = await exchange({ op: 'shutdown' }, timeoutMs);
                invariant(result?.stopping === true, 'IPC_PROTOCOL', 'Daemon did not confirm shutdown');
            }
            // Keep the startup lock until the old process has exited, not just its socket.
            const stopDeadline = Date.now() + timeoutMs;
            while (processAlive(ready.pid)) {
                if (Date.now() >= stopDeadline)
                    throw new RerouteError('DAEMON_RELOAD_TIMEOUT', 'Old daemon did not exit before the reload deadline; no replacement was started.');
                await sleep(100);
            }
        }
        if (previous && processAlive(previous.pid))
            throw new RerouteError('DAEMON_UNREACHABLE', 'A coordinator process is alive but its IPC is not responding. Inspect rerouted; refusing to create a duplicate.');
        if (process.platform !== 'win32')
            await fs.rm(endpoint(), { force: true });
        const child = spawn(process.execPath, [daemonPath()], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
        let spawnError;
        child.on('error', error => { spawnError = error; });
        child.unref();
        const startDeadline = Date.now() + timeoutMs;
        while (Date.now() < startDeadline) {
            await sleep(100);
            if (spawnError)
                throw spawnError;
            const started = await ping(Math.min(2000, Math.max(1, startDeadline - Date.now())));
            if (started && !started.stopping) {
                invariant(started.pid === child.pid, 'DAEMON_START', 'Readiness came from a different daemon process');
                return;
            }
        }
        throw new RerouteError('DAEMON_START', 'Daemon did not become ready. Run rerouted in a terminal to inspect startup.');
    }
    finally {
        if (acquired)
            await fs.rm(lock, { recursive: true, force: true });
    }
}
export async function remoteRun(packet) {
    await ensureDaemon();
    const socket = await connect();
    const token = await fs.readFile(join(home(), 'ipc-token'), 'utf8');
    return new Promise((resolve, reject) => {
        let completed = false, ready = false, inputStarted = false;
        const cancel = () => { void send(socket, { type: 'cancel' }).catch(() => { }); };
        const cleanup = () => { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); if (inputStarted) {
            process.stdin.pause();
            if (!process.stdin.isTTY)
                process.stdin.destroy();
        } };
        process.on('SIGINT', cancel);
        process.on('SIGTERM', cancel);
        lines(socket, event => {
            if (event.type === 'ready' && !ready) {
                ready = true;
                if (process.stdin.isTTY) {
                    void send(socket, { type: 'eof' });
                }
                else {
                    inputStarted = true;
                    void (async () => {
                        for await (const data of process.stdin) {
                            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
                            for (let i = 0; i < buffer.length; i += 32768)
                                await send(socket, { type: 'stdin', data: buffer.subarray(i, i + 32768).toString('base64') });
                        }
                        if (!socket.destroyed)
                            await send(socket, { type: 'eof' });
                    })().catch(() => { if (!completed)
                        cancel(); });
                }
            }
            else if (event.type === 'output') {
                const stream = event.stream === 'stderr' ? process.stderr : process.stdout;
                if (!stream.write(Buffer.from(String(event.data), 'base64'))) {
                    socket.pause();
                    stream.once('drain', () => socket.resume());
                }
            }
            else if (event.type === 'exit' || event.type === 'error') {
                completed = true;
                cleanup();
                socket.end();
                if (event.type === 'error')
                    reject(new RerouteError(String(event.code), String(event.message), Number(event.exitCode) || 70));
                else
                    resolve({ code: Number(event.code), cancelled: event.cancelled === true, timedOut: event.timedOut === true, signal: typeof event.signal === 'string' ? event.signal : undefined });
            }
        }, error => { cleanup(); socket.destroy(); reject(error); });
        socket.on('error', error => { cleanup(); reject(error); });
        socket.on('close', () => { cleanup(); if (!completed)
            reject(new RerouteError('DAEMON_LOST', 'Execution lost its coordinator; no local fallback was used')); });
        void send(socket, { ...packet, op: 'run', token, v: PROTOCOL_VERSION }).catch(reject);
    });
}
