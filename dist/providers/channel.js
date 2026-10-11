import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AsyncQueue } from '../core/queue.js';
import { RerouteError, invariant } from '../core/errors.js';
import { packageRoot } from '../platform/files.js';
let source;
export function workerArgv(payload) {
    source ??= readFileSync(join(packageRoot, 'assets', 'worker.py'), 'utf8');
    return ['python3', '-u', '-c', source, Buffer.from(JSON.stringify(payload)).toString('base64')];
}
async function channel(launch, runtime, payload) {
    const streamingRequest = payload.op === 'rpc';
    const raw = await launch(runtime, workerArgv(streamingRequest ? { op: 'rpc_stream', root: runtime.root } : { ...payload, root: runtime.root }));
    const queue = new AsyncQueue();
    const stdinAck = new AsyncQueue(8);
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void ready.catch(() => { });
    let gotResult = false, result, heartbeat;
    const startedTimer = setTimeout(() => { void raw.kill(); }, 30000);
    const send = (frame) => raw.write(Buffer.from(JSON.stringify(frame) + '\n'));
    if (payload.op === 'exec')
        heartbeat = setInterval(() => { void send({ type: 'ping' }).catch(() => { void raw.kill(); }); }, 10000);
    const done = (async () => {
        let line = '';
        const decoder = new StringDecoder('utf8');
        try {
            for await (const event of raw.events) {
                if (event.stream === 'stderr')
                    continue; // Native errors can contain auth URLs: never leak them.
                line += decoder.write(event.data);
                invariant(line.length <= 64 * 1024 * 1024, 'PROTOCOL_LIMIT', 'Remote protocol frame exceeded its limit');
                let boundary;
                while ((boundary = line.indexOf('\n')) >= 0) {
                    const text = line.slice(0, boundary);
                    line = line.slice(boundary + 1);
                    let packet;
                    try {
                        packet = JSON.parse(text);
                    }
                    catch {
                        throw new RerouteError('REMOTE_PROTOCOL', 'Unexpected remote output. Disable login banners and verify Python 3 on the runtime.');
                    }
                    invariant(packet && typeof packet.type === 'string', 'REMOTE_PROTOCOL', 'Malformed remote packet');
                    if (packet.type === 'started') {
                        clearTimeout(startedTimer);
                        readyResolve();
                    }
                    else if (packet.type === 'stdin_ack')
                        stdinAck.push(undefined);
                    else if (packet.type === 'output') {
                        invariant((packet.stream === 'stdout' || packet.stream === 'stderr') && typeof packet.data === 'string' && packet.data.length <= 100000, 'REMOTE_PROTOCOL', 'Invalid remote output frame');
                        queue.push({ type: 'output', stream: packet.stream, data: Buffer.from(packet.data, 'base64') });
                    }
                    else if (packet.type === 'exit') {
                        invariant(Number.isInteger(packet.code) && Number(packet.code) >= 0 && Number(packet.code) <= 255, 'REMOTE_PROTOCOL', 'Invalid execution exit code');
                        gotResult = true;
                        result = { code: packet.code, signal: packet.signal, timedOut: packet.timedOut === true, cancelled: packet.cancelled === true };
                        readyResolve();
                    }
                    else if (packet.type === 'rpc') {
                        gotResult = true;
                        result = packet.value;
                        readyResolve();
                    }
                    else if (packet.type === 'error')
                        throw new RerouteError('REMOTE_WORKER', `Remote workspace operation failed: ${String(packet.message).slice(0, 240)}`, 74);
                    else
                        throw new RerouteError('REMOTE_PROTOCOL', 'Unknown remote protocol packet');
                }
            }
            const transportCode = await raw.wait();
            invariant(gotResult && transportCode === 0, 'TRANSPORT_LOST', 'Remote transport ended without a confirmed result. No local fallback was used.');
            queue.end();
            return result;
        }
        catch (error) {
            readyReject(error);
            queue.end(error);
            await raw.kill().catch(() => { });
            throw error;
        }
        finally {
            stdinAck.end(new RerouteError('STDIN_CLOSED', 'Execution input is closed'));
            clearInterval(heartbeat);
            clearTimeout(startedTimer);
        }
    })();
    void done.catch(() => { });
    if (streamingRequest) {
        try {
            const data = Buffer.from(JSON.stringify(payload) + '\n');
            for (let i = 0; i < data.length; i += 32768)
                await raw.write(data.subarray(i, i + 32768));
            await raw.closeInput();
        }
        catch (error) {
            await raw.kill().catch(() => { });
            throw error;
        }
    }
    return { raw, ready, done, queue, stdinAck };
}
export async function execute(launch, runtime, request) {
    const c = await channel(launch, runtime, { ...request, op: 'exec' });
    await c.ready;
    let cancelled = false, cancellation;
    let inputChain = Promise.resolve();
    const acknowledgements = c.stdinAck[Symbol.asyncIterator]();
    const send = (frame) => c.raw.write(Buffer.from(JSON.stringify(frame) + '\n'));
    const input = (operation) => {
        const result = inputChain.then(operation);
        inputChain = result.catch(() => { });
        return result;
    };
    return {
        events: c.queue,
        wait: () => c.done,
        write: data => input(async () => {
            let pending = 0;
            for (let i = 0; i < data.length; i += 32768) {
                invariant(!cancelled, 'CANCELLED', 'Execution was cancelled');
                await send({ type: 'stdin', data: data.subarray(i, i + 32768).toString('base64') });
                if (++pending === 8) {
                    await acknowledgements.next();
                    pending--;
                }
            }
            while (pending-- > 0)
                await acknowledgements.next();
        }),
        endInput: () => Promise.race([input(() => send({ type: 'eof' })), c.done]).then(() => { }),
        cancel: () => cancellation ??= (async () => {
            cancelled = true;
            const timer = setTimeout(() => { void c.raw.kill().catch(() => { }); }, 5000);
            timer.unref();
            // Cancellation must not wait for stdin or a blocked transport write.
            void send({ type: 'cancel' }).catch(() => { });
            try {
                await c.done.catch(() => { });
            }
            finally {
                clearTimeout(timer);
            }
        })()
    };
}
async function rpc(launch, runtime, args) {
    const c = await channel(launch, runtime, { op: 'rpc', ...args });
    return c.done;
}
function manifest(value, policy) {
    invariant(value && typeof value === 'object' && !Array.isArray(value), 'REMOTE_PROTOCOL', 'Invalid source manifest');
    const entries = Object.entries(value);
    invariant(entries.length <= policy.maxFiles, 'REMOTE_PROTOCOL', 'Remote file count exceeds policy');
    for (const [, item] of entries) {
        invariant(item && typeof item === 'object' && typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash) && Number.isInteger(item.mode) && Number.isInteger(item.size) && item.size >= 0 && item.size <= policy.maxFileBytes, 'REMOTE_PROTOCOL', 'Malformed file metadata');
    }
    return value;
}
export function fileTransport(launch, runtime) {
    return {
        scan: async (policy) => manifest(await rpc(launch, runtime, { action: 'scan', policy }), policy),
        read: async (paths, policy) => {
            const result = await rpc(launch, runtime, { action: 'read', paths, policy });
            invariant(result && typeof result === 'object' && !Array.isArray(result), 'REMOTE_PROTOCOL', 'Invalid file response');
            const obj = result;
            invariant(paths.every(path => typeof obj[path] === 'string') && Object.keys(obj).every(p => paths.includes(p)), 'REMOTE_PROTOCOL', 'Unexpected file response');
            return obj;
        },
        apply: async (changes, policy) => {
            const result = await rpc(launch, runtime, { action: 'apply', changes, policy });
            invariant(result?.ok === true, 'REMOTE_PROTOCOL', 'Remote write was not confirmed');
        }
    };
}
