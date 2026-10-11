import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { home } from '../platform/files.js';
import { RerouteError, invariant } from '../core/errors.js';
export function endpoint() {
    const fingerprint = createHash('sha256').update(home() + ':' + userInfo().username).digest('hex').slice(0, 20);
    if (process.platform === 'win32')
        return `\\\\.\\pipe\\reroute-${fingerprint}`;
    const local = join(home(), 'daemon.sock');
    return local.length < 95 ? local : join(tmpdir(), `reroute-${process.getuid?.() ?? 'user'}-${fingerprint}`, 'daemon.sock');
}
export async function send(socket, packet) {
    invariant(!socket.destroyed, 'CLIENT_DISCONNECTED', 'Client disconnected');
    if (!socket.write(JSON.stringify(packet) + '\n'))
        await new Promise((resolve, reject) => {
            const cleanup = () => { socket.removeListener('drain', drained); socket.removeListener('close', closed); socket.removeListener('error', failed); };
            const drained = () => { cleanup(); resolve(); };
            const failed = (error) => { cleanup(); reject(error); };
            const closed = () => failed(new RerouteError('CLIENT_DISCONNECTED', 'Client disconnected during output'));
            socket.once('drain', drained);
            socket.once('close', closed);
            socket.once('error', failed);
            if (socket.destroyed)
                closed();
        });
}
export function lines(socket, handle, onError) {
    let pending = '';
    const decoder = new StringDecoder('utf8');
    socket.on('data', (chunk) => {
        try {
            pending += decoder.write(chunk);
            invariant(pending.length <= 1024 * 1024, 'IPC_LIMIT', 'IPC frame is too large');
            let index;
            while ((index = pending.indexOf('\n')) >= 0) {
                const text = pending.slice(0, index);
                pending = pending.slice(index + 1);
                const packet = JSON.parse(text);
                invariant(packet && typeof packet === 'object' && !Array.isArray(packet), 'IPC_PROTOCOL', 'Invalid IPC packet');
                handle(packet);
            }
        }
        catch (error) {
            onError(error instanceof RerouteError ? error : new RerouteError('IPC_PROTOCOL', 'Invalid JSON protocol'));
        }
    });
}
