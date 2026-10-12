import { constants } from 'node:fs';
import { open, lstat, readdir, readFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import ignore from 'ignore';
import { hash, processExec, safeRelative, noSymlink } from './util.js';
import type { Entry, Snapshot } from './types.js';
const excluded = new Set(['.git','.hg','.svn','node_modules','target','dist','build','.next','.nuxt','.venv','venv','__pycache__','.cache','.pytest_cache','.mypy_cache','.ruff_cache','.tox','.turbo','.gradle','.idea','.ssh','.aws','.azure','.config','.reroute','.reroute.json','.DS_Store']);
const sensitive = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519|ecdsa)(?:\.pub)?|credentials(?:\..*)?|secrets?(?:\..*)?)$|\.(?:pem|key|p12|pfx|keystore)$/i;
export const excludedPath = (p: string) => p.split('/').some(x => excluded.has(x) || sensitive.test(x));
async function list(root: string): Promise<string[]> {
  const custom = ignore();
  try { custom.add(await readFile(join(root, '.rerouteignore'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const git = await processExec('git', ['-C', root, 'rev-parse', '--show-toplevel']).catch(() => undefined);
  let paths: string[];
  if (git?.code === 0 && await realpath(git.stdout.trim()) === root) {
    // Never accept a truncated index as a complete source snapshot.
    const candidates = await processExec('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (candidates.code !== 0 || candidates.stdoutTruncated || candidates.stdout.includes('\ufffd')) throw new Error('Git input index unavailable, not UTF-8, or exceeds the 1 MiB safety limit; no task started');
    paths = candidates.stdout.split('\0').filter(Boolean);
  } else {
    try { custom.add(await readFile(join(root, '.gitignore'), 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    paths = [];
    const walk = async (prefix: string) => {
      for (const ent of await readdir(join(root, prefix), { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${ent.name}` : ent.name;
        safeRelative(path);
        if (excludedPath(path) || custom.ignores(path) || (ent.isDirectory() && custom.ignores(path + '/'))) continue;
        if (ent.isDirectory()) await walk(path); else paths.push(path);
      }
    };
    await walk('');
  }
  const result: string[] = [];
  for (const p of [...new Set(paths)].sort()) {
    safeRelative(p); if (excludedPath(p) || custom.ignores(p)) continue;
    try {
      const s = await lstat(join(root, p));
      if (!s.isFile()) throw new Error(`Only regular source files are supported (no symlinks or submodules): ${p}`);
      result.push(p);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return result;
}
async function fingerprint(root: string, path: string, destination?: string): Promise<Entry> {
  const full = join(root, path); await noSymlink(full);
  const source = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  const before = await source.stat({ bigint: true });
  if (!before.isFile()) { await source.close(); throw new Error(`Non-regular source: ${path}`); }
  let output;
  const digest = createHash('sha256');
  try {
    if (before.size > 256n * 1024n * 1024n) throw new Error(`Source file exceeds 256 MiB: ${path}; exclude non-source inputs with .rerouteignore`);
    if (destination) { await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); output = await open(destination, 'wx', Number(before.mode & 0o777n)); }
    const buffer = Buffer.allocUnsafe(256 * 1024); let n;
    while ((n = (await source.read(buffer, 0, buffer.length, null)).bytesRead) > 0) {
      digest.update(buffer.subarray(0, n));
      if (output) { let written = 0; while (written < n) written += (await output.write(buffer, written, n - written, null)).bytesWritten; }
    }
    const after = await source.stat({ bigint: true });
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error(`Source changed while copying: ${path}`);
    return { path, sha256: digest.digest('hex'), size: Number(after.size), mode: Number(after.mode & 0o777n) };
  } finally { await source.close(); await output?.close(); }
}
/** Two full reads detect edits, additions and deletions. This is a verified copy, not a filesystem-level atomic snapshot. */
export async function snapshot(rootInput: string, options: { afterCopy?: () => Promise<void>; signal?: AbortSignal } = {}): Promise<Snapshot> {
  const start = performance.now(), root = await realpath(rootInput), dir = await mkdtemp(join(tmpdir(), 'reroute-input-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const paths = await list(root), files: Entry[] = [];
    let bytes = 0;
    for (const path of paths) {
      options.signal?.throwIfAborted();
      const entry = await fingerprint(root, path, join(dir, path)); bytes += entry.size;
      if (bytes > 512 * 1024 * 1024) throw new Error('Source input exceeds 512 MiB; exclude non-source files');
      files.push(entry);
    }
    await options.afterCopy?.();
    if (JSON.stringify(paths) !== JSON.stringify(await list(root))) throw new Error('Source file set changed while preparing input; no task started');
    for (const entry of files) {
      options.signal?.throwIfAborted();
      if (JSON.stringify(entry) !== JSON.stringify(await fingerprint(root, entry.path))) throw new Error(`Source changed while preparing input: ${entry.path}; no task started`);
    }
    const digest = hash(JSON.stringify(files));
    const cacheKey = hash(JSON.stringify(files.filter(f => /(^|\/)(Cargo.lock|package-lock.json|pnpm-lock.yaml|yarn.lock|bun.lockb?|uv.lock|poetry.lock|requirements.*\.txt|rust-toolchain(?:\.toml)?|\.nvmrc|\.python-version)$/.test(f.path))));
    return { dir, files, bytes, digest, cacheKey, milliseconds: performance.now() - start, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
