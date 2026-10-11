import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileEntry, Manifest, FileTransport, SyncPolicy, FileChange } from '../core/contracts.js';
import { invariant, errorCode, RerouteError } from '../core/errors.js';
import { atomicWrite, hash, readJSON, writeJSON, safePath, safeRelative, privateDir } from '../platform/files.js';
// Legacy state must stay private even before users finish the rename migration.
const EXCLUDED = new Set(['.git','.reroute','.reroute-runtime','.outboard','.outboard-runtime','node_modules','target','.venv','venv','dist','build','.next','.nuxt','.turbo','coverage','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.cache','.gradle','.idea','.ssh','.aws','.azure','.kube','.gnupg','.npm','.rustup','.claude','.codex','.cursor','.pi','.omp','.dsh','gcloud']);
const SECRET_FILES = new Set(['.npmrc','.pypirc','.netrc','.git-credentials','credentials','credentials.json','secrets.json','id_rsa','id_ed25519','id_ecdsa','service-account.json','application_default_credentials.json','.modal.toml','auth.json']);
function glob(pattern: string): RegExp { return new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'); }
export function excluded(path: string, policy: SyncPolicy): boolean {
  const parts = path.split('/');
  if (parts.some(p => EXCLUDED.has(p) || SECRET_FILES.has(p) || p.startsWith('.reroute-tmp-') || p === '.env' || p.startsWith('.env.') || /\.(pem|key|p12|pfx|keystore)$/i.test(p))) return true;
  return policy.excludes.some(p => glob(p).test(path) || parts.some(segment => glob(p).test(segment)));
}
export async function scanLocal(root: string, policy: SyncPolicy): Promise<Manifest> {
  const result: Manifest = Object.create(null);
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name; if (excluded(rel, policy)) continue;
      const path = await safePath(root, rel);
      if (entry.isDirectory()) await walk(path, rel + '/');
      else {
        invariant(entry.isFile(), 'SOURCE_TYPE', `Unsupported source file (symlinks are not followed): ${rel}`);
        const st = await fs.lstat(path);
        invariant(st.size <= policy.maxFileBytes, 'FILE_TOO_LARGE', `Source file exceeds sync limit: ${rel}`);
        const data = await fs.readFile(path);
        result[rel] = { hash: hash(data), size: data.length, mode: st.mode & 0o777 };
        invariant(Object.keys(result).length <= policy.maxFiles, 'TOO_MANY_FILES', 'Source tree exceeds file-count limit');
      }
    }
  }
  await walk(root, ''); return result;
}
function same(a?: FileEntry, b?: FileEntry): boolean { return a?.hash === b?.hash && (a === undefined || b === undefined || (a.mode & 0o111) === (b.mode & 0o111)); }
export interface SyncPlan { push: string[]; pull: string[]; conflicts: string[] }
export function planSync(base: Manifest, local: Manifest, remote: Manifest): SyncPlan {
  const plan: SyncPlan = { push: [], pull: [], conflicts: [] };
  for (const path of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[path], l = local[path], r = remote[path];
    if (same(l, r)) continue;
    if (same(b, l)) plan.pull.push(path);
    else if (same(b, r)) plan.push.push(path);
    else plan.conflicts.push(path);
  }
  return plan;
}
function validateManifestPaths(manifest: Manifest, policy: SyncPolicy): void {
  for (const path of Object.keys(manifest)) { safeRelative(path); invariant(!excluded(path, policy), 'SYNC_POLICY', 'Remote manifest attempted to include an excluded path'); }
}
async function currentHash(root: string, path: string): Promise<string | null> {
  try {
    const destination = await safePath(root, path), info = await fs.lstat(destination);
    if (info.isDirectory()) return null;
    invariant(info.isFile(), 'SOURCE_TYPE', 'Synchronized path is not a regular file');
    return hash(await fs.readFile(destination));
  } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(errorCode(error) ?? '')) return null; throw error; }
}
async function removeEmptyDirectories(root: string, path: string, policy: SyncPolicy): Promise<void> {
  const directories: string[] = [];
  async function visit(rel: string): Promise<void> {
    invariant(!excluded(rel, policy), 'SYNC_POLICY', 'Refusing to remove an excluded directory');
    const destination = await safePath(root, rel);
    invariant((await fs.lstat(destination)).isDirectory(), 'SYNC_DIRECTORY', `Directory contains unplanned content: ${rel}`);
    for (const name of await fs.readdir(destination)) await visit(rel + '/' + name);
    directories.push(rel);
  }
  await visit(path);
  for (const rel of directories) await fs.rmdir(await safePath(root, rel));
}
async function applyLocal(root: string, path: string, expected: string | null, data: Buffer | undefined, mode: number, policy: SyncPolicy): Promise<void> {
  const check = async () => invariant(await currentHash(root, path) === expected, 'SYNC_RACE', `Local source changed during reconciliation: ${path}`);
  await check();
  if (expected !== null) {
    const old = await fs.readFile(await safePath(root, path));
    invariant(hash(old) === expected, 'SYNC_RACE', `Local source changed before backup: ${path}`);
    await atomicWrite(join(root, '.reroute', 'backups', randomUUID()), old);
  }
  if (data === undefined) {
    await check();
    if (expected !== null) await fs.unlink(await safePath(root, path));
    return;
  }
  const destination = await safePath(root, path);
  try { if ((await fs.lstat(destination)).isDirectory()) await removeEmptyDirectories(root, path, policy); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  await fs.mkdir(dirname(destination), { recursive: true }); await safePath(root, path);
  const temp = join(dirname(destination), `.reroute-tmp-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, data, { flag: 'wx', mode: mode & 0o777 });
    await fs.chmod(temp, mode & 0o777);
    // Check after backup/temp preparation, not just before its asynchronous writes.
    await check(); await fs.rename(temp, destination);
  } finally { await fs.rm(temp, { force: true }); }
}
/** Three-way, crash-recoverable, incremental reconciliation. Call under a project lane. */
export class Synchronizer {
  constructor(private readonly root: string, private readonly policy: SyncPolicy) {}
  async reconcile(transport: FileTransport): Promise<{ pushed: number; pulled: number }> {
    const baselinePath = join(this.root, '.reroute', 'sync-base.json');
    const savedBase = await readJSON<Manifest>(baselinePath) ?? {}, base: Manifest = Object.create(null);
    for (const [path, entry] of Object.entries(savedBase)) { safeRelative(path); if (!excluded(path, this.policy)) base[path] = entry; }
    const local = await scanLocal(this.root, this.policy), remote = await transport.scan(this.policy);
    validateManifestPaths(remote, this.policy);
    const plan = planSync(base, local, remote), expected: Manifest = { ...local };
    for (const path of plan.pull) { if (remote[path]) expected[path] = remote[path]!; else delete expected[path]; }
    invariant(Object.keys(expected).length <= this.policy.maxFiles, 'TOO_MANY_FILES', 'Merged source tree exceeds file-count limit');
    // Individually valid files can still form an impossible merged tree (file + child).
    for (const path of Object.keys(expected)) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) { const parent = parts.slice(0, i).join('/'); if (Object.hasOwn(expected, parent)) plan.conflicts.push(parent, path); }
    }
    plan.conflicts = [...new Set(plan.conflicts)];
    if (plan.conflicts.length) {
      const conflictDir = join(this.root, '.reroute', 'conflicts', randomUUID()); await privateDir(conflictDir);
      for (const path of plan.conflicts) {
        if (remote[path]) {
          const files = await transport.read([path], this.policy); const data = Buffer.from(files[path]!, 'base64');
          invariant(hash(data) === remote[path]!.hash, 'SYNC_RACE', 'Remote file changed during conflict capture');
          await atomicWrite(join(conflictDir, 'remote', path), data);
        }
      }
      await writeJSON(join(conflictDir, 'conflicts.json'), { paths: plan.conflicts, base, local, remote });
      throw new RerouteError('SYNC_CONFLICT', `Source conflict; no divergent user file was overwritten. Inspect ${conflictDir}, reconcile both versions, then run reroute sync --accept-local to explicitly choose local source.`, 73);
    }
    // Both sides finish planned deletions before any file/directory replacement writes.
    for (const deleting of [true, false]) {
      for (const path of plan.pull.filter(path => !remote[path] === deleting)) {
        const data = remote[path] ? Buffer.from((await transport.read([path], this.policy))[path]!, 'base64') : undefined;
        if (data) invariant(hash(data) === remote[path]!.hash, 'SYNC_RACE', 'Remote source changed while being read');
        await applyLocal(this.root, path, local[path]?.hash ?? null, data, remote[path]?.mode ?? 0o644, this.policy);
      }
      for (const path of plan.push.filter(path => !local[path] === deleting)) {
        invariant(await currentHash(this.root, path) === (local[path]?.hash ?? null), 'SYNC_RACE', `Local source changed during transfer: ${path}`);
        const data = local[path] ? await fs.readFile(await safePath(this.root, path)) : undefined;
        if (data) invariant(hash(data) === local[path]!.hash, 'SYNC_RACE', `Local source changed during transfer: ${path}`);
        const change: FileChange = { path, expected: remote[path]?.hash ?? null, data: data ? data.toString('base64') : null, mode: local[path]?.mode };
        await transport.apply([change], this.policy);
      }
    }
    // Persist the agreed snapshot, not a fresh local scan that might include unsent edits.
    await writeJSON(baselinePath, expected);
    return { pushed: plan.push.length, pulled: plan.pull.length };
  }
  async acceptLocal(transport: FileTransport): Promise<void> {
    // Explicit conflict resolution acknowledges remote versions preserved in conflicts/.
    const remote = await transport.scan(this.policy);
    validateManifestPaths(remote, this.policy);
    await writeJSON(join(this.root, '.reroute', 'sync-base.json'), remote);
    await this.reconcile(transport);
  }
}
