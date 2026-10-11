import { promises as fs } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { invariant, errorCode } from '../core/errors.js';
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export function home(): string { return resolve(process.env.REROUTE_HOME || join(homedir(), '.reroute')); }
export function cliPath(): string { return join(packageRoot, 'bin', 'reroute.mjs'); }
export function daemonPath(): string { return join(packageRoot, 'bin', 'rerouted.mjs'); }
export function hash(data: string | Buffer): string { return createHash('sha256').update(data).digest('hex'); }
export async function exists(path: string): Promise<boolean> {
  try { await fs.access(path); return true; } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
export async function privateDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  const st = await fs.lstat(path);
  invariant(st.isDirectory() && !st.isSymbolicLink(), 'UNSAFE_STATE', `State directory is not a real directory: ${path}`);
  if (process.platform !== 'win32') await fs.chmod(path, 0o700);
}
export async function atomicWrite(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.reroute-tmp-${randomUUID()}.tmp`);
  try { await fs.writeFile(temp, data, { mode, flag: 'wx' }); await fs.rename(temp, path); }
  finally { await fs.rm(temp, { force: true }); }
}
export async function readJSON<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error; }
}
export function writeJSON(path: string, data: unknown): Promise<void> { return atomicWrite(path, JSON.stringify(data, null, 2) + '\n'); }
export function contained(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}
export function safeRelative(path: string): void {
  invariant(path.length > 0 && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && path.split('/').every(p => !['..', '.', '', '__proto__', 'prototype', 'constructor'].includes(p)), 'UNSAFE_PATH', 'Unsafe synchronized path');
}
/** Reject symlink parents both when scanning and immediately before writes. */
export async function safePath(root: string, rel: string): Promise<string> {
  safeRelative(rel);
  let path = root;
  for (const part of rel.split('/')) {
    path = join(path, part);
    try { invariant(!(await fs.lstat(path)).isSymbolicLink(), 'SYMLINK', 'Refusing to follow a synchronized symlink'); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  }
  return path;
}
