import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileTransport } from '../../dist/providers/channel.js';
import { spawnRaw } from '../../dist/platform/process.js';
import { Synchronizer } from '../../dist/sync/sync.js';
import { fixture, policy } from '../helpers.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const metadata = { ...policy, hashMode: 'metadata' };
// Only telemetry is injected: the production scanner and cache execute unchanged.
export const tracePythonReads = source => `import os, sys, json, base64, atexit
r5_root = json.loads(base64.b64decode(sys.argv[1]))['root']
r5_reads = [0]
r5_fdopen = os.fdopen
class R5File:
 def __init__(self, file, path): self.file, self.path = file, path
 def __getattr__(self, name): return getattr(self.file, name)
 def __enter__(self): self.file.__enter__(); return self
 def __exit__(self, *args): return self.file.__exit__(*args)
 def read(self, *args):
  data = self.file.read(*args)
  if self.path.startswith(r5_root + '/'): r5_reads[0] += len(data)
  return data
def r5_open(fd, *args, **kwargs):
 try: path = os.readlink('/proc/self/fd/' + str(fd))
 except OSError: path = ''
 return R5File(r5_fdopen(fd, *args, **kwargs), path)
os.fdopen = r5_open
atexit.register(lambda: sys.stderr.write('R5READS:' + str(r5_reads[0]) + '\\n'))
` + source;
function counted(runtime) {
  const state = { reads: [], requests: [], mutate: undefined };
  const files = fileTransport(async (_runtime, argv) => {
    const args = [...argv]; args[3] = tracePythonReads(args[3]); const raw = spawnRaw(args[0], args.slice(1));
    return { ...raw, write: async data => {
      const request = JSON.parse(data.toString()); state.requests.push(request);
      if (state.mutate) { state.mutate(request); data = Buffer.from(JSON.stringify(request) + '\n'); }
      return raw.write(data);
    }, events: { async *[Symbol.asyncIterator]() {
      let stderr = '';
      for await (const event of raw.events) { if (event.stream === 'stderr') stderr += event.data.toString(); yield event; }
      state.reads.push(Number(stderr.match(/R5READS:(\d+)/)?.[1]));
    } } };
  }, runtime);
  return { files, state };
}

test('remote metadata cache reuses verified hashes only in a supported precise filesystem', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.remote, 'x'), 'AAAA');
  const { files, state } = counted(f.runtime);
  const first = await files.scan(metadata); assert.equal(state.reads.at(-1), 4);
  assert.deepEqual(await files.scan(metadata), first);
  const supported = Object.keys(state.requests.at(-1).cache.files).length > 0;
  assert.equal(state.reads.at(-1), supported ? 0 : 4);
  await files.scan(policy); assert.equal(state.reads.at(-1), 4, 'strict always rehashes');
  await files.scan(metadata); assert.equal(state.reads.at(-1), 4, 'strict discards the reusable cache');
  files.invalidateHashes(); await files.scan(metadata); assert.equal(state.reads.at(-1), 4);
  await counted(f.runtime).files.scan(metadata); // New transport may reuse only this exact runtime object.
  await counted({ ...f.runtime, meta: { ...f.runtime.meta } }).files.scan(metadata);
});

test('remote same-size restored-mtime edits, rapid replacements and mode changes are not hidden', async t => {
  const f = await fixture(t), path = join(f.remote, 'x'); await fs.writeFile(path, 'AAAA');
  const { files } = counted(f.runtime); await files.scan(metadata);
  const before = await fs.stat(path); await fs.writeFile(path, 'BBBB'); await fs.utimes(path, before.atime, before.mtime);
  assert.equal((await files.scan(metadata)).x.hash, hash('BBBB'));
  for (let i = 0; i < 8; i++) {
    const data = String(i).padStart(4, '0'), other = join(f.remote, 'other');
    await fs.writeFile(other, data); await fs.rename(other, path);
    assert.equal((await files.scan(metadata)).x.hash, hash(data));
  }
  await fs.chmod(path, 0o751); assert.equal((await files.scan(metadata)).x.mode, 0o751);
});

for (const corrupt of ['hash', 'key', 'record', 'cache']) test(`remote ${corrupt} cache corruption falls back to real content`, async t => {
  const f = await fixture(t); await fs.writeFile(join(f.remote, 'x'), 'AAAA');
  const { files, state } = counted(f.runtime); await files.scan(metadata);
  state.mutate = request => {
    if (corrupt === 'hash' && request.cache.files.x) request.cache.files.x.entry.hash = '0'.repeat(64);
    if (corrupt === 'key') request.cache.key = '0'.repeat(64);
    if (corrupt === 'record') request.cache.files = { x: { stamp: [], entry: null, mac: 'bad' } };
    if (corrupt === 'cache') request.cache = {};
  };
  assert.equal((await files.scan(metadata)).x.hash, hash('AAAA'));
  assert.equal(state.reads.at(-1), 4);
});

test('remote cache binds runtime root and generation; abnormal failure requires a new content scan', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.remote, 'x'), 'AAAA');
  const { files, state } = counted(f.runtime); await files.scan(metadata); await files.scan(metadata);
  f.runtime.meta.workspaceGeneration = 'changed'; await files.scan(metadata); assert.equal(state.reads.at(-1), 4);
  const other = join(f.directory, 'other'); await fs.mkdir(other); await fs.writeFile(join(other, 'x'), 'BBBB');
  f.runtime.root = other; assert.equal((await files.scan(metadata)).x.hash, hash('BBBB')); assert.equal(state.reads.at(-1), 4);
  await fs.symlink(join(other, 'x'), join(other, 'link')); await assert.rejects(files.scan(metadata));
  await fs.unlink(join(other, 'link')); await files.scan(metadata); assert.equal(state.reads.at(-1), 4);
});

test('failed reconciliation and cold/recovery reset discard both local and remote reusable state', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.local, 'x'), 'AAAA'); await fs.writeFile(join(f.remote, 'x'), 'AAAA');
  const { files, state } = counted(f.runtime), sync = new Synchronizer(f.local, metadata);
  await sync.reconcile(files); await sync.reconcile(files);
  sync.resetHashes(); await sync.reconcile(files); assert.equal(state.reads.at(-1), 4);
  const failing = { ...files, scan: async p => { await files.scan(p); throw new Error('interrupted after scan'); } };
  await assert.rejects(sync.reconcile(failing), /interrupted/);
  await sync.reconcile(files); assert.equal(state.reads.at(-1), 4);
  await fs.writeFile(join(f.local, 'x'), 'local'); await fs.writeFile(join(f.remote, 'x'), 'remote');
  await assert.rejects(sync.reconcile(files), { code: 'SYNC_CONFLICT' });
  assert.equal(await fs.readFile(join(f.local, 'x'), 'utf8'), 'local');
  assert.equal(await fs.readFile(join(f.remote, 'x'), 'utf8'), 'remote');
});

test('shared scan directory handles detect replacement and never follow the substitute symlink', async t => {
  const f = await fixture(t), sub = join(f.remote, 'sub'), outside = join(f.directory, 'outside');
  await fs.mkdir(sub); await fs.mkdir(outside); await fs.writeFile(join(sub, 'x'), 'source'); await fs.writeFile(join(outside, 'x'), 'must not read');
  const files = fileTransport(async (_runtime, argv) => {
    const args = [...argv];
    args[3] = `import os
r5_original = os.fdopen
r5_changed = [False]
class ReplacingFile:
 def __init__(self, file, path): self.file, self.path = file, path
 def __getattr__(self, name): return getattr(self.file, name)
 def __enter__(self): self.file.__enter__(); return self
 def __exit__(self, *args): return self.file.__exit__(*args)
 def read(self, *args):
  assert not self.path.startswith(${JSON.stringify(outside)}), 'OUTSIDE_FILE_READ'
  data = self.file.read(*args)
  if data and self.path.startswith(${JSON.stringify(sub)}) and not r5_changed[0]:
   r5_changed[0] = True
   os.rename(${JSON.stringify(sub)}, ${JSON.stringify(join(f.remote, 'retained'))})
   os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(sub)})
  return data
def replacing_fdopen(fd, *args, **kwargs):
 path = os.readlink('/proc/self/fd/' + str(fd))
 return ReplacingFile(r5_original(fd, *args, **kwargs), path)
os.fdopen = replacing_fdopen
` + args[3];
    return spawnRaw(args[0], args.slice(1));
  }, f.runtime);
  await assert.rejects(files.scan(policy), error => /Not a directory|SYMLINK|DIRECTORY_CHANGED/.test(error.message) && !error.message.includes('OUTSIDE_FILE_READ'));
  assert.equal(await fs.readFile(join(f.remote, 'retained/x'), 'utf8'), 'source');
  assert.equal(await fs.readFile(join(outside, 'x'), 'utf8'), 'must not read');
});
