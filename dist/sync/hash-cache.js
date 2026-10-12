import { promises as fs, constants } from 'node:fs';
import { invariant } from '../core/errors.js';
import { hashFile } from '../platform/file-stream.js';
function fingerprint(st) {
    return [st.dev, st.ino, st.size, st.mode, st.birthtimeNs, st.mtimeNs, st.ctimeNs].join(':');
}
function validEntry(entry, st) {
    if (!entry || typeof entry !== 'object')
        return false;
    const value = entry;
    return typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash)
        && Number.isSafeInteger(value.size) && BigInt(value.size) === st.size
        && value.mode === Number(st.mode & 511n);
}
async function reusable(path, st) {
    if (process.platform !== 'linux' || typeof st.mtimeNs !== 'bigint' || typeof st.ctimeNs !== 'bigint' || typeof st.birthtimeNs !== 'bigint'
        || st.mtimeNs % 1000000000n === 0n || st.ctimeNs % 1000000000n === 0n)
        return false;
    try {
        return (await fs.statfs(path, { bigint: true })).type === 0xef53n;
    }
    catch {
        return false;
    }
}
/** In-process only; metadata reuse is opt-in, never a persisted source of truth. */
export class HashCache {
    records = new Map();
    verified = new WeakSet();
    async scan(path, maxBytes, mode = 'strict') {
        try {
            invariant(Number.isSafeInteger(maxBytes) && maxBytes > 0 && (mode === 'strict' || mode === 'metadata'), 'CONFIG', 'Invalid hash scan policy');
            const before = await fs.lstat(path, { bigint: true });
            invariant(before.isFile(), 'SOURCE_TYPE', 'Synchronized path must be a regular file');
            invariant(before.size <= BigInt(maxBytes), 'FILE_TOO_LARGE', 'File exceeds sync limit');
            const key = fingerprint(before), canReuse = mode === 'metadata' && await reusable(path, before);
            const cached = this.records.get(path);
            if (canReuse && cached && this.verified.has(cached) && cached.fingerprint === key && validEntry(cached.entry, before)) {
                const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                try {
                    const opened = await file.stat({ bigint: true });
                    const named = await fs.lstat(path, { bigint: true });
                    invariant(opened.isFile() && named.isFile() && fingerprint(opened) === key && fingerprint(named) === key, 'SYNC_RACE', 'File changed during cached content validation');
                    return { ...cached.entry };
                }
                finally {
                    await file.close();
                }
            }
            const entry = await hashFile(path, maxBytes, before);
            invariant(validEntry(entry, before), 'SYNC_RACE', 'File changed during hash scan');
            if (canReuse) {
                const record = Object.freeze({ fingerprint: key, entry: Object.freeze({ ...entry }) });
                this.verified.add(record);
                this.records.set(path, record);
            }
            else
                this.records.delete(path);
            return { ...entry };
        }
        catch (error) {
            this.records.delete(path);
            throw error;
        }
    }
    /** Call only after a complete successful tree scan, with the included absolute paths. */
    prune(paths) {
        const live = new Set(paths);
        for (const path of this.records.keys())
            if (!live.has(path))
                this.records.delete(path);
    }
    clear() { this.records.clear(); }
}
