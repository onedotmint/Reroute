import { promises as fs, constants, type Dirent } from 'node:fs';
import { join, dirname, resolve, parse, sep } from 'node:path';
import { isSecretName } from '../core/routing.js';
import { randomUUID } from 'node:crypto';
import type { FileEntry, Manifest, FileTransport, SyncPolicy, FileChange } from '../core/contracts.js';
import { invariant, errorCode, RerouteError } from '../core/errors.js';
import { hash, readJSON, writeJSON, safePath, safeRelative, privateDir } from '../platform/files.js';
import { hashFile, stageDownload, copyVerified } from '../platform/file-stream.js';
import { HashCache } from './hash-cache.js';
// Legacy state must stay private even before users finish the rename migration.
const EXCLUDED = new Set(['.git','.reroute','.reroute-runtime','.outboard','.outboard-runtime','node_modules','target','.venv','venv','dist','build','.next','.nuxt','.turbo','coverage','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.cache','.gradle','.idea','.ssh','.aws','.azure','.kube','.gnupg','.npm','.rustup','.claude','.codex','.cursor','.pi','.omp','.dsh','gcloud']);
const SECRET_FILES = new Set(['.npmrc','.pypirc','.netrc','.git-credentials','credentials','credentials.json','secrets.json','id_rsa','id_ed25519','id_ecdsa','service-account.json','application_default_credentials.json','.modal.toml','auth.json']);
// A basename pattern matches at any depth; path patterns match from the root, including ancestors.
export function validSyncPattern(value: unknown): value is string {
  if (typeof value !== 'string' || !value || /[\[\]{}!\\\x00-\x1f\x7f]/.test(value) || /[?*+@]\(/.test(value) || value.includes('..') || value.startsWith('/')) return false;
  const parts = value.replace(/\/$/, '').split('/');
  return parts.every(p => p !== '' && p !== '.' && (!p.includes('**') || p === '**'));
}
function glob(pattern: string): RegExp {
  invariant(validSyncPattern(pattern), 'CONFIG', 'Unsupported sync pattern; use literals, *, ?, or a complete ** path segment');
  const parts = pattern.replace(/\/$/, '').split('/');
  const source = parts.map((part, i) => part === '**' ? (i === parts.length - 1 ? '[\\s\\S]*' : '(?:[^/]+/)*') : part.replace(/[.+^$()|]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + (i < parts.length - 1 ? '/' : '')).join('');
  return new RegExp('^' + source + '$(?![\\s\\S])', 'u');
}
type Exclusion = { reason: 'minimum-security' | 'minimum-exclusion' | 'policy-exclusion'; pattern?: string };
function exclusion(path: string, policy: SyncPolicy): Exclusion | undefined {
  const parts = path.split('/');
  if (parts.some(p => SECRET_FILES.has(p) || p === '.env' || p.startsWith('.env.') || /\.(pem|key|p12|pfx|keystore)$/i.test(p))) return { reason: 'minimum-security' };
  if (parts.some(p => EXCLUDED.has(p) || p.startsWith('.reroute-tmp-'))) return { reason: 'minimum-exclusion' };
  for (const pattern of policy.excludes) {
    const matcher = glob(pattern), normalized = pattern.replace(/\/$/, '');
    const candidates = normalized.includes('/') ? parts.map((_, i) => parts.slice(0, i + 1).join('/')) : parts;
    if (candidates.some(p => matcher.test(p))) return { reason: 'policy-exclusion', pattern };
  }
  return undefined;
}
export function excluded(path: string, policy: SyncPolicy): boolean { return exclusion(path, policy) !== undefined; }
function validatePolicy(policy: SyncPolicy): void {
  invariant(policy.hashMode === undefined || policy.hashMode === 'strict' || policy.hashMode === 'metadata', 'CONFIG', 'Invalid sync hash mode');
  invariant(Array.isArray(policy.excludes) && policy.excludes.every(validSyncPattern), 'CONFIG', 'Unsupported sync pattern; use literals, *, ?, or a complete ** path segment');
  invariant(Number.isSafeInteger(policy.maxFiles) && policy.maxFiles > 0 && Number.isSafeInteger(policy.maxFileBytes) && policy.maxFileBytes > 0, 'CONFIG', 'Sync limits must be positive safe integers');
}
/** Shared traversal prunes excluded directories before looking inside them. */
async function walkLocal(root: string, policy: SyncPolicy, visit: (rel: string, entry: Dirent, reason?: Exclusion) => Promise<void>, failed?: (rel: string, error: unknown) => void): Promise<void> {
  const attempt = async (rel: string, action: () => Promise<void>) => {
    try { await action(); } catch (error) { if (!failed) throw error; failed(rel, error); }
  };
  async function walk(dir: string, prefix: string): Promise<void> {
    await fs.access(dir, constants.R_OK | constants.X_OK);
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const rel = prefix + entry.name, reason = exclusion(rel, policy);
      await attempt(rel, async () => {
        await visit(rel, entry, reason);
        if (!reason && entry.isDirectory()) await walk(await safePath(root, rel), rel + '/');
      });
    }
  }
  await attempt('.', async () => {
    validatePolicy(policy);
    root = resolve(root);
    // Check ancestors in order, without resolving any link target or enumerating it.
    let ancestor = parse(root).root;
    for (const part of root.slice(ancestor.length).split(sep).filter(Boolean)) {
      ancestor = join(ancestor, part);
      invariant(!(await fs.lstat(ancestor)).isSymbolicLink(), 'SYMLINK', 'Choose a real directory, not a symlink, as the source root');
    }
    invariant((await fs.lstat(root)).isDirectory(), 'SOURCE_TYPE', 'Source root must be a directory');
    await walk(root, '');
  });
}
export async function scanLocal(root: string, policy: SyncPolicy, cache = new HashCache()): Promise<Manifest> {
  root = resolve(root);
  const result: Manifest = Object.create(null); let count = 0;
  await walkLocal(root, policy, async (rel, entry, reason) => {
    if (reason || entry.isDirectory()) return;
    invariant(entry.isFile(), 'SOURCE_TYPE', `Unsupported source file (symlinks are not followed): ${rel}`);
    const path = await safePath(root, rel);
    result[rel] = await cache.scan(path, policy.maxFileBytes, policy.hashMode);
    invariant(++count <= policy.maxFiles, 'TOO_MANY_FILES', 'Source tree exceeds file-count limit');
  });
  cache.prune(Object.keys(result).map(path => join(resolve(root), path)));
  return result;
}
export interface SyncPreview {
  scope: 'local-only';
  included: { path: string; reason: 'included'; bytes: number }[];
  excluded: ({ path: string } & Exclusion)[];
  files: { count: number; bytes: number; limits: { maxFiles: number; maxFileBytes: number }; overFileCount: boolean; oversized: string[] };
  symlinks: string[];
  unsupportedTypes: { path: string; type: string }[];
  sensitiveNameRisks: { path: string; excluded: boolean; reason: 'sensitive-name-only' }[];
  readiness: { scope: 'local-only'; ready: boolean; remote: 'not-checked' };
  errors: { path: string; code: string; message: string }[];
}
/** Read-only metadata snapshot: no content reads, hashes, baseline, provider or remote checks. */
export async function syncPreview(root: string, policy: SyncPolicy): Promise<SyncPreview> {
  const result: SyncPreview = {
    scope: 'local-only', included: [], excluded: [],
    files: { count: 0, bytes: 0, limits: { maxFiles: policy.maxFiles, maxFileBytes: policy.maxFileBytes }, overFileCount: false, oversized: [] },
    symlinks: [], unsupportedTypes: [], sensitiveNameRisks: [],
    readiness: { scope: 'local-only', ready: false, remote: 'not-checked' }, errors: []
  };
  const report = (path: string, code: string, message: string) => { result.errors.push({ path, code, message }); };
  await walkLocal(root, policy, async (rel, entry, reason) => {
    if (reason?.reason === 'minimum-security' || isSecretName(entry.name)) result.sensitiveNameRisks.push({ path: rel, excluded: !!reason, reason: 'sensitive-name-only' });
    if (entry.isSymbolicLink()) result.symlinks.push(rel);
    const unsupported = !entry.isSymbolicLink() && !entry.isDirectory() && !entry.isFile();
    if (unsupported) result.unsupportedTypes.push({ path: rel, type: entry.isFIFO() ? 'fifo' : entry.isSocket() ? 'socket' : entry.isBlockDevice() ? 'block-device' : entry.isCharacterDevice() ? 'character-device' : 'unknown' });
    if (reason) { result.excluded.push({ path: rel, ...reason }); return; }
    if (entry.isSymbolicLink()) { report(rel, 'SYMLINK', 'Remove the link or explicitly exclude it; symlinks are not followed'); return; }
    if (unsupported) { report(rel, 'SOURCE_TYPE', 'Exclude or replace this entry with a regular file or directory'); return; }
    const path = await safePath(root, rel);
    if (entry.isDirectory()) return;
    const info = await fs.lstat(path);
    invariant(info.isFile(), 'SOURCE_TYPE', 'Source changed type during preview; retry');
    result.included.push({ path: rel, reason: 'included', bytes: info.size });
    result.files.count++; result.files.bytes += info.size;
    if (info.size > policy.maxFileBytes) {
      result.files.oversized.push(rel);
      report(rel, 'FILE_TOO_LARGE', 'Exclude or shrink this file, or raise sync.maxFileBytes');
    }
    await fs.access(path, constants.R_OK);
  }, (rel, error) => {
    const code = errorCode(error) ?? 'SOURCE_SCAN';
    report(rel, code, code === 'CONFIG' ? 'Use supported sync patterns and positive safe-integer limits' : code === 'EACCES' || code === 'EPERM' ? 'Grant read/search permission or exclude this path, then retry' : code === 'SYMLINK' ? 'Choose a real source directory without symlink ancestors' : 'Source could not be inspected; check its path/type and retry');
  });
  result.files.overFileCount = result.files.count > policy.maxFiles;
  if (result.files.overFileCount) report('.', 'TOO_MANY_FILES', 'Exclude unneeded files or raise sync.maxFiles');
  result.readiness.ready = result.errors.length === 0;
  // No timestamps, absolute paths or OS error text; JSON ordering is deterministic.
  const compare = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  for (const rows of [result.included, result.excluded, result.unsupportedTypes, result.sensitiveNameRisks, result.errors]) rows.sort(compare);
  result.symlinks.sort(); result.files.oversized.sort();
  return result;
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
    return (await hashFile(destination)).hash;
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
async function applyLocal(root: string, path: string, expected: string | null, temp: string | undefined, mode: number, policy: SyncPolicy): Promise<void> {
  const check = async () => invariant(await currentHash(root, path) === expected, 'SYNC_RACE', `Local source changed during reconciliation: ${path}`);
  await check();
  if (expected !== null) {
    const backup = await safePath(root, '.reroute/backups/' + randomUUID());
    await privateDir(dirname(backup));
    await copyVerified(await safePath(root, path), backup, expected);
  }
  if (temp === undefined) {
    await check();
    if (expected !== null) await fs.unlink(await safePath(root, path));
    return;
  }
  const destination = await safePath(root, path);
  try { if ((await fs.lstat(destination)).isDirectory()) await removeEmptyDirectories(root, path, policy); }
  catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
  await fs.mkdir(dirname(destination), { recursive: true }); await safePath(root, path);
  try {
    await fs.chmod(temp, mode & 0o777);
    // Check after backup/temp preparation, not just before its asynchronous writes.
    await check(); await fs.rename(temp, destination);
  } finally { await fs.rm(temp, { force: true }); }
}
/** Three-way, crash-recoverable, incremental reconciliation. Call under a project lane. */
export class Synchronizer {
  private readonly hashes = new HashCache();
  private hashIdentity?: string;
  private resetRemote = true;
  resetHashes(): void { this.hashes.clear(); this.resetRemote = true; }
  constructor(private readonly root: string, private readonly policy: SyncPolicy) {}
  async reconcile(transport: FileTransport): Promise<{ pushed: number; pulled: number }> {
    if (this.resetRemote || this.hashIdentity !== transport.hashIdentity) {
      this.hashes.clear(); transport.invalidateHashes?.();
      this.hashIdentity = transport.hashIdentity; this.resetRemote = false;
    }
    try { return await this.reconcileFiles(transport); }
    catch (error) { this.resetHashes(); transport.invalidateHashes?.(); throw error; }
  }
  private async reconcileFiles(transport: FileTransport): Promise<{ pushed: number; pulled: number }> {
    const baselinePath = join(this.root, '.reroute', 'sync-base.json');
    const savedBase = await readJSON<Manifest>(baselinePath) ?? {}, base: Manifest = Object.create(null);
    for (const [path, entry] of Object.entries(savedBase)) { safeRelative(path); if (!excluded(path, this.policy)) base[path] = entry; }
    const local = await scanLocal(this.root, this.policy, this.hashes), remote = await transport.scan(this.policy);
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
          const destination = await safePath(conflictDir, 'remote/' + path);
          const temp = await stageDownload(transport, path, this.policy, destination, remote[path]);
          try { await safePath(conflictDir, 'remote/' + path); await fs.rename(temp, destination); }
          finally { await fs.rm(temp, { force: true }); }
        }
      }
      await writeJSON(join(conflictDir, 'conflicts.json'), { paths: plan.conflicts, base, local, remote });
      throw new RerouteError('SYNC_CONFLICT', `Source conflict; no divergent user file was overwritten. Inspect ${conflictDir}, reconcile both versions, then run reroute sync --accept-local to explicitly choose local source.`, 73);
    }
    // Both sides finish planned deletions before any file/directory replacement writes.
    for (const deleting of [true, false]) {
      for (const path of plan.pull.filter(path => !remote[path] === deleting)) {
        const temp = remote[path] ? await stageDownload(transport, path, this.policy, await safePath(this.root, path), remote[path]) : undefined;
        try { await applyLocal(this.root, path, local[path]?.hash ?? null, temp, remote[path]?.mode ?? 0o644, this.policy); }
        finally { if (temp) await fs.rm(temp, { force: true }); }
      }
      // Reuse guarded RPC batches; cap memory and keep each larger supported file alone.
      let changes: FileChange[] = [], bytes = 0;
      const flush = async () => { if (changes.length) { await transport.apply(changes, this.policy); changes = []; bytes = 0; } };
      for (const path of plan.push.filter(path => !local[path] === deleting)) {
        invariant(await currentHash(this.root, path) === (local[path]?.hash ?? null), 'SYNC_RACE', `Local source changed during transfer: ${path}`);
        const data = local[path] ? await fs.readFile(await safePath(this.root, path)) : undefined;
        if (data) invariant(hash(data) === local[path]!.hash, 'SYNC_RACE', `Local source changed during transfer: ${path}`);
        const change: FileChange = { path, expected: remote[path]?.hash ?? null, data: data ? data.toString('base64') : null, mode: local[path]?.mode };
        const size = Buffer.byteLength(JSON.stringify(change));
        if (changes.length && (changes.length >= 128 || bytes + size > 4 * 1024 * 1024)) await flush();
        changes.push(change); bytes += size;
        if (changes.length >= 128 || bytes >= 4 * 1024 * 1024) await flush();
      }
      await flush();
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
