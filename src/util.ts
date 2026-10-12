import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ExecOptions, ExecResult } from './types.js';
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export const shell = (args: string[]) => args.map(quote).join(' ');
export function inside(root: string, path: string): boolean { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); }
export function safeRelative(p: string): string {
  if (!p || isAbsolute(p) || p.includes('\\') || /[\0-\x1f\x7f]/.test(p) || p.split('/').some(x => !x || x === '.' || x === '..')) throw new Error(`Unsafe relative path: ${JSON.stringify(p)}`);
  return p;
}
export async function noSymlink(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Symlink path refused: ${current}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await noSymlink(path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
}
export async function jsonFile<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
/** Bounded capture; streaming callbacks receive every byte. A disconnected client never proves remote cancellation. */
export function processExec(program: string, args: string[], options: ExecOptions & { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) return reject(new Error('Aborted before process start'));
    const child = spawn(program, args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
    let outBytes = 0, errBytes = 0;
    let stdout = '', stderr = '', stopped: string | undefined, force: NodeJS.Timeout | undefined;
    const capture = (old: string, text: string) => (old + text).slice(-1024 * 1024);
    child.stdout.on('data', (b: Buffer) => { outBytes += b.length; stdout = capture(stdout, outDecoder.write(b)); options.stdout?.(b); });
    child.stderr.on('data', (b: Buffer) => { errBytes += b.length; stderr = capture(stderr, errDecoder.write(b)); options.stderr?.(b); });
    const kill = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch {} };
    const stop = (reason: string) => { stopped = reason; kill('SIGTERM'); force = setTimeout(() => kill('SIGKILL'), 1000); force.unref(); };
    const abort = () => stop('Client operation aborted; remote state must be checked');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = options.timeoutMs ? setTimeout(() => stop('Client operation timed out; remote state must be checked'), options.timeoutMs) : undefined;
    child.stdin.on('error', () => {});
    if (options.stdin) options.stdin.pipe(child.stdin); else child.stdin.end();
    const clean = () => { if (timer) clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', abort); options.stdin?.unpipe(child.stdin); options.stdin?.pause(); };
    child.once('error', e => { clean(); reject(e); });
    child.once('close', (code, signal) => { clean(); if (stopped) reject(new Error(stopped)); else resolvePromise({ code: code ?? (signal === 'SIGINT' ? 130 : 128), stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end(), stdoutTruncated: outBytes > 1024 * 1024, stderrTruncated: errBytes > 1024 * 1024 }); });
  });
}
export async function requireSuccess(p: Promise<ExecResult>): Promise<ExecResult> {
  const r = await p; if (r.code !== 0) throw new Error(`Command failed (${r.code}): ${r.stderr || r.stdout}`); return r;
}

/** Forward stdin with backpressure; stop reading immediately when the remote process exits. */
export function feedInput(source: NodeJS.ReadableStream, write: (chunk: Buffer) => Promise<unknown>, end: () => Promise<unknown>) {
  let resolveDone!: () => void, rejectDone!: (e: unknown) => void, stopped = false;
  let queue: Promise<unknown> = Promise.resolve();
  const done = new Promise<void>((resolve, reject) => { resolveDone=resolve; rejectDone=reject; });
  const clean = () => { source.pause(); source.removeListener('data', data); source.removeListener('end', ended); source.removeListener('error', failed); };
  const failed = (e: unknown) => { if(stopped)return;stopped=true;clean();rejectDone(e); };
  const data = (chunk: Buffer | string) => {
    source.pause(); queue=queue.then(()=>stopped?undefined:write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))).then(()=>{if(!stopped)source.resume();});
    void queue.catch(failed);
  };
  const ended = () => { void queue.then(()=>stopped?undefined:end()).then(()=>{if(!stopped){stopped=true;clean();resolveDone();}},failed); };
  source.on('error',failed);source.on('end',ended);source.on('data',data);
  return {done,stop(){if(!stopped){stopped=true;clean();resolveDone();}}};
}
