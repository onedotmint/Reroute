import net from 'node:net';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION } from '../core/contracts.js';
import { Coordinator } from '../core/coordinator.js';
import { createProvider } from '../providers/index.js';
import { RerouteError, invariant, safeMessage, errorCode } from '../core/errors.js';
import { home, privateDir, atomicWrite, writeJSON } from '../platform/files.js';
import { isSecretName, isControlEnv } from '../core/routing.js';
import { PROVIDERS, loadConfig } from '../config/config.js';
import { endpoint, send, lines } from './protocol.js';
import { log } from '../core/logging.js';
function runInput(p) {
    invariant(typeof p.cwd === 'string' && Array.isArray(p.argv) && p.argv.length > 0 && p.argv.length < 4096 && p.argv.every(x => typeof x === 'string' && !x.includes('\0')), 'IPC_PROTOCOL', 'Invalid execution request');
    invariant(p.env && typeof p.env === 'object' && !Array.isArray(p.env), 'IPC_PROTOCOL', 'Invalid execution environment');
    for (const [key, value] of Object.entries(p.env))
        invariant(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !isSecretName(key) && !isControlEnv(key) && typeof value === 'string', 'IPC_PROTOCOL', 'Unsafe environment forwarding');
    if (p.timeoutMs !== undefined)
        invariant(typeof p.timeoutMs === 'number' && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0, 'IPC_PROTOCOL', 'Invalid execution timeout');
    return { cwd: p.cwd, argv: p.argv, env: p.env, timeoutMs: p.timeoutMs };
}
export async function serve(coordinator = new Coordinator(createProvider)) {
    await privateDir(home());
    if (process.platform !== 'win32')
        await privateDir(dirname(endpoint()));
    const tokenPath = join(home(), 'ipc-token');
    let token;
    try {
        token = await fs.readFile(tokenPath, 'utf8');
    }
    catch (error) {
        if (errorCode(error) !== 'ENOENT')
            throw error;
        token = randomBytes(32).toString('hex');
        await atomicWrite(tokenPath, token);
    }
    invariant(/^[a-f0-9]{64}$/.test(token), 'IPC_AUTH', 'Invalid local IPC credential; do not overwrite it while another daemon may be active');
    const sockets = new Set();
    let closing = false, closePromise;
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        let authenticated = false, handle, completed = false;
        const abort = new AbortController();
        let inputChain = Promise.resolve();
        const reject = (error) => {
            if (completed)
                return;
            completed = true;
            abort.abort();
            void send(socket, { type: 'error', code: error instanceof RerouteError ? error.code : 'REMOTE_FAILURE', message: safeMessage(error), exitCode: error instanceof RerouteError ? error.exitCode : 70 }).finally(() => socket.end()).catch(() => { });
        };
        const authenticationTimeout = setTimeout(() => { if (!authenticated)
            socket.destroy(); }, 5000);
        authenticationTimeout.unref();
        socket.once('close', () => { clearTimeout(authenticationTimeout); if (!completed)
            abort.abort(); });
        socket.on('error', () => abort.abort());
        lines(socket, packet => {
            if (completed)
                return;
            if (authenticated) {
                if (packet.type === 'cancel') {
                    abort.abort();
                    return;
                }
                inputChain = inputChain.then(async () => {
                    if (abort.signal.aborted)
                        return;
                    invariant(handle, 'IPC_PROTOCOL', 'Input arrived before execution was ready');
                    if (packet.type === 'stdin') {
                        invariant(typeof packet.data === 'string' && packet.data.length < 100000, 'IPC_PROTOCOL', 'Invalid stdin frame');
                        await handle.write(Buffer.from(packet.data, 'base64'));
                    }
                    else if (packet.type === 'eof')
                        await handle.endInput();
                    else
                        throw new RerouteError('IPC_PROTOCOL', 'Unknown execution input');
                }).catch(error => { if (!abort.signal.aborted)
                    reject(error); });
                return;
            }
            try {
                const supplied = Buffer.from(String(packet.token ?? ''));
                invariant(packet.v === PROTOCOL_VERSION && supplied.length === Buffer.byteLength(token) && timingSafeEqual(supplied, Buffer.from(token)), 'IPC_AUTH', 'IPC authentication/version mismatch');
                authenticated = true;
                clearTimeout(authenticationTimeout);
            }
            catch (error) {
                reject(error);
                return;
            }
            void (async () => {
                invariant(!closing || packet.op === 'shutdown', 'DAEMON_STOPPING', 'Daemon is shutting down; new work is not accepted');
                const cwd = typeof packet.cwd === 'string' ? packet.cwd : process.cwd();
                let value;
                switch (packet.op) {
                    case 'ping':
                        value = { version: PROTOCOL_VERSION, pid: process.pid };
                        break;
                    case 'enable': {
                        invariant(PROVIDERS.includes(packet.provider), 'CONFIG', 'Invalid provider');
                        const override = packet.override && typeof packet.override === 'object' ? packet.override : {};
                        await loadConfig(cwd, { ...override, provider: packet.provider });
                        value = await coordinator.enable(cwd, packet.provider, override, packet.fresh === true);
                        break;
                    }
                    case 'disable':
                        value = await coordinator.disable(cwd);
                        break;
                    case 'start':
                        value = await coordinator.start(cwd);
                        break;
                    case 'stop':
                        value = await coordinator.stop(cwd, packet.destroy === true);
                        break;
                    case 'status':
                        value = await coordinator.status(cwd);
                        break;
                    case 'sync':
                        value = await coordinator.synchronize(cwd, packet.acceptLocal === true);
                        break;
                    case 'run': {
                        const result = await coordinator.run(runInput(packet), { signal: abort.signal,
                            onHandle: h => { handle = h; void send(socket, { type: 'ready' }).catch(() => abort.abort()); },
                            onOutput: event => send(socket, { type: 'output', stream: event.stream, data: event.data.toString('base64') }) });
                        completed = true;
                        await send(socket, { type: 'exit', ...result });
                        socket.end();
                        return;
                    }
                    case 'dev.start':
                        if (packet.port !== undefined)
                            invariant(Number.isInteger(packet.port) && Number(packet.port) > 0 && Number(packet.port) <= 65535, 'CONFIG', 'Invalid preview port');
                        value = await coordinator.devStart(runInput(packet), packet.port);
                        break;
                    case 'dev.stop':
                        value = await coordinator.devStop(cwd);
                        break;
                    case 'dev.logs':
                        value = await coordinator.devLogs(cwd);
                        break;
                    case 'dev.preview':
                        value = await coordinator.devPreview(cwd);
                        break;
                    case 'shutdown':
                        value = { stopping: true };
                        if (!closing) {
                            closing = true;
                            setTimeout(() => { void close(); }, 50);
                        }
                        break;
                    default: throw new RerouteError('IPC_PROTOCOL', 'Unknown daemon operation');
                }
                completed = true;
                await send(socket, { type: 'result', value: value ?? null });
                socket.end();
            })().catch(reject);
        }, reject);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint(), () => { server.removeListener('error', reject); resolve(); }); });
    if (process.platform !== 'win32')
        await fs.chmod(endpoint(), 0o600);
    await writeJSON(join(home(), 'daemon.json'), { pid: process.pid, protocol: PROTOCOL_VERSION });
    await log('daemon_started');
    // Recovery never blocks accepting commands; per-project operations use their own lane.
    void coordinator.recover().catch(() => log('recovery_failed'));
    function close() {
        closing = true;
        return closePromise ??= (async () => {
            await coordinator.shutdown();
            const closed = new Promise(resolve => server.close(() => resolve()));
            for (const socket of sockets)
                socket.destroy();
            await closed;
            if (process.platform !== 'win32')
                await fs.rm(endpoint(), { force: true });
            await fs.rm(join(home(), 'daemon.json'), { force: true });
            process.removeListener('SIGTERM', terminate);
            process.removeListener('SIGINT', terminate);
        })();
    }
    const terminate = () => { void close(); };
    process.on('SIGTERM', terminate);
    process.on('SIGINT', terminate);
    return { close };
}
