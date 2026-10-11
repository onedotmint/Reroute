import { promises as fs } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { invariant, errorCode } from '../core/errors.js';
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export function home() { return resolve(process.env.REROUTE_HOME || join(homedir(), '.reroute')); }
export function cliPath() { return join(packageRoot, 'bin', 'reroute.mjs'); }
export function daemonPath() { return join(packageRoot, 'bin', 'rerouted.mjs'); }
export function hash(data) { return createHash('sha256').update(data).digest('hex'); }
export async function exists(path) {
    try {
        await fs.access(path);
        return true;
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return false;
        throw error;
    }
}
export async function privateDir(path) {
    await fs.mkdir(path, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(path);
    invariant(st.isDirectory() && !st.isSymbolicLink(), 'UNSAFE_STATE', `State directory is not a real directory: ${path}`);
    if (process.platform !== 'win32')
        await fs.chmod(path, 0o700);
}
export async function atomicWrite(path, data, mode = 0o600) {
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.reroute-tmp-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temp, data, { mode, flag: 'wx' });
        await fs.rename(temp, path);
    }
    finally {
        await fs.rm(temp, { force: true });
    }
}
export async function readJSON(path) {
    try {
        return JSON.parse(await fs.readFile(path, 'utf8'));
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return undefined;
        throw error;
    }
}
export function writeJSON(path, data) { return atomicWrite(path, JSON.stringify(data, null, 2) + '\n'); }
export function contained(root, path) {
    const rel = relative(resolve(root), resolve(path));
    return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
export function safeRelative(path) {
    invariant(path.length > 0 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && path.split('/').every(p => !['..', '.', '', '__proto__', 'prototype', 'constructor'].includes(p)), 'UNSAFE_PATH', 'Unsafe synchronized path');
}
/** Reject symlink parents both when scanning and immediately before writes. */
export async function safePath(root, rel) {
    safeRelative(rel);
    let path = root;
    for (const part of rel.split('/')) {
        path = join(path, part);
        try {
            invariant(!(await fs.lstat(path)).isSymbolicLink(), 'SYMLINK', 'Refusing to follow a synchronized symlink');
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
    }
    return path;
}
