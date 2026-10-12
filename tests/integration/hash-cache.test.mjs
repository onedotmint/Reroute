import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HashCache } from '../../dist/sync/hash-cache.js';

const limit = 1024 * 1024;
const timestamp = 1_700_000_000.123456;
const digest = data => createHash('sha256').update(data).digest('hex');
const linux = { skip: process.platform !== 'linux' };
async function fixture(t, content = 'AAAA') {
  const root = await fs.mkdtemp(join(tmpdir(), 'reroute-hash-cache-'));
  const previousHome = process.env.HOME;
  process.env.HOME = join(root, 'home');
  await fs.mkdir(process.env.HOME);
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'source');
  await fs.writeFile(path, content);
  await fs.utimes(path, timestamp, timestamp);
  return { root, path, cache: new HashCache() };
}
function observe(t) {
  const open = fs.open.bind(fs);
  const state = { reads: 0, bytes: 0, maxChunk: 0, flags: [], beforeOpen: undefined, beforeRead: undefined };
  t.mock.method(fs, 'open', async (path, flags, ...args) => {
    state.flags.push(flags);
    if (state.beforeOpen) await state.beforeOpen(path);
    const file = await open(path, flags, ...args), read = file.read.bind(file);
    t.mock.method(file, 'read', async (...args) => {
      if (state.beforeRead) await state.beforeRead(path);
      state.reads++;
      state.maxChunk = Math.max(state.maxChunk, args[2]);
      const result = await read(...args);
      state.bytes += result.bytesRead;
      return result;
    });
    return file;
  });
  return state;
}
function ext4(t) { t.mock.method(fs, 'statfs', async () => ({ type: 0xef53n })); }
async function assertPrecise(t, path) {
  const st = await fs.lstat(path, { bigint: true });
  if (st.mtimeNs % 1_000_000_000n === 0n || st.ctimeNs % 1_000_000_000n === 0n) {
    t.skip('Fixture filesystem has coarse timestamps');
    return false;
  }
  return true;
}

test('strict is the default and streams unchanged files again in bounded chunks', async t => {
  const data = Buffer.alloc(200_000, 7), { path, cache } = await fixture(t, data), io = observe(t);
  const first = await cache.scan(path, limit), reads = io.reads;
  assert.deepEqual(first, { hash: digest(data), size: data.length, mode: (await fs.lstat(path)).mode & 0o777 });
  assert.deepEqual(await cache.scan(path, limit), first);
  assert.ok(io.reads > reads);
  assert.equal(io.bytes, 2 * data.length);
  assert.ok(io.maxChunk <= 64 * 1024);
  if (process.platform === 'linux') assert.ok(io.flags.every(flags => (flags & constants.O_NOFOLLOW) !== 0));
});

test('metadata reuse is explicit, opens the file to check identity, and returns copies', linux, async t => {
  const { path, cache } = await fixture(t);
  if (!await assertPrecise(t, path)) return;
  ext4(t); const io = observe(t);
  const first = await cache.scan(path, limit, 'metadata'), reads = io.reads, opens = io.flags.length;
  first.hash = 'mutated'; first.size = 0; first.mode = 0;
  const second = await cache.scan(path, limit, 'metadata');
  assert.equal(second.hash, digest('AAAA'));
  assert.equal(second.size, 4);
  assert.equal(io.reads, reads);
  assert.equal(io.flags.length, opens + 1);
  second.hash = 'also mutated';
  assert.equal((await cache.scan(path, limit, 'metadata')).hash, digest('AAAA'));
  await cache.scan(path, limit);
  assert.ok(io.reads > reads, 'strict must not reuse a metadata record');
});

test('unconfirmed filesystems and statfs failure always stream, even in metadata mode', async t => {
  const { path, cache } = await fixture(t), io = observe(t);
  t.mock.method(fs, 'statfs', async () => ({ type: 0x794c7630n }));
  await cache.scan(path, limit, 'metadata'); const reads = io.reads;
  await cache.scan(path, limit, 'metadata'); assert.ok(io.reads > reads);
  t.mock.method(fs, 'statfs', async () => { throw new Error('unsupported'); });
  const beforeFailure = io.reads;
  await cache.scan(path, limit, 'metadata'); assert.ok(io.reads > beforeFailure);
});

test('coarse whole-second timestamps disable metadata reuse', linux, async t => {
  const { path, cache } = await fixture(t);
  await fs.utimes(path, 1_700_000_000, 1_700_000_000);
  ext4(t); const io = observe(t);
  await cache.scan(path, limit, 'metadata'); const reads = io.reads;
  await cache.scan(path, limit, 'metadata'); assert.ok(io.reads > reads);
});

test('same-size edits with restored mtime are detected by ctime', linux, async t => {
  const { path, cache } = await fixture(t);
  ext4(t);
  const first = await cache.scan(path, limit, 'metadata'), st = await fs.lstat(path, { bigint: true });
  await fs.writeFile(path, 'BBBB'); await fs.utimes(path, timestamp, timestamp);
  assert.equal((await fs.lstat(path, { bigint: true })).mtimeNs, st.mtimeNs, 'mtime restored exactly');
  const second = await cache.scan(path, limit, 'metadata');
  assert.notEqual(second.hash, first.hash); assert.equal(second.hash, digest('BBBB'));
});

test('rapid same-size replacements and mode changes invalidate previous hashes', linux, async t => {
  const { root, path, cache } = await fixture(t); ext4(t);
  await cache.scan(path, limit, 'metadata');
  for (let i = 0; i < 12; i++) {
    const data = String(i).padStart(4, '0'), replacement = join(root, 'replacement');
    await fs.writeFile(replacement, data); await fs.utimes(replacement, timestamp, timestamp);
    await fs.rename(replacement, path);
    assert.equal((await cache.scan(path, limit, 'metadata')).hash, digest(data));
  }
  await fs.chmod(path, 0o600);
  assert.equal((await cache.scan(path, limit, 'metadata')).mode, 0o600);
});

test('a new instance has no restored cache; prune and clear require another stream', linux, async t => {
  const { root, path, cache } = await fixture(t);
  if (!await assertPrecise(t, path)) return;
  const other = join(root, 'other'); await fs.writeFile(other, 'BBBB');
  ext4(t); const io = observe(t);
  await cache.scan(path, limit, 'metadata'); await cache.scan(other, limit, 'metadata');
  cache.prune([path]); let reads = io.reads;
  await cache.scan(path, limit, 'metadata'); assert.equal(io.reads, reads);
  await cache.scan(other, limit, 'metadata'); assert.ok(io.reads > reads);
  reads = io.reads;
  await new HashCache().scan(path, limit, 'metadata'); assert.ok(io.reads > reads);
  cache.clear(); reads = io.reads;
  await cache.scan(path, limit, 'metadata'); assert.ok(io.reads > reads);
});

test('malformed in-memory records fall back to hashing rather than becoming source evidence', linux, async t => {
  const { path, cache } = await fixture(t);
  if (!await assertPrecise(t, path)) return;
  ext4(t); const io = observe(t);
  await cache.scan(path, limit, 'metadata');
  // TypeScript privacy is not a runtime trust boundary; this is deliberate corruption, not a public API.
  const original = cache.records.get(path);
  for (const entry of [null, { hash: 'bad', size: 4, mode: 0o644 }, { ...original.entry, hash: '0'.repeat(64) }, { ...original.entry, size: 5 }, { ...original.entry, mode: -1 }]) {
    cache.records.set(path, { fingerprint: original.fingerprint, entry });
    const reads = io.reads;
    assert.equal((await cache.scan(path, limit, 'metadata')).hash, digest('AAAA'));
    assert.ok(io.reads > reads);
  }
});

test('limits are checked before cache hits; symlinks and directories are rejected', async t => {
  const { root, path, cache } = await fixture(t); ext4(t);
  await cache.scan(path, limit, 'metadata');
  await assert.rejects(cache.scan(path, 3, 'metadata'), { code: 'FILE_TOO_LARGE' });
  await assert.rejects(cache.scan(root, limit), { code: 'SOURCE_TYPE' });
  if (process.platform !== 'win32') {
    const link = join(root, 'link'); await fs.symlink(path, link);
    await assert.rejects(cache.scan(link, limit), { code: 'SOURCE_TYPE' });
  }
  await assert.rejects(cache.scan(path, 0), { code: 'CONFIG' });
});

test('mutation during a streamed scan is rejected even with the original mtime restored', async t => {
  const { path, cache } = await fixture(t), io = observe(t);
  io.beforeRead = async () => {
    io.beforeRead = undefined;
    await fs.writeFile(path, 'BBBB'); await fs.utimes(path, timestamp, timestamp);
  };
  await assert.rejects(cache.scan(path, limit), { code: 'SYNC_RACE' });
  assert.equal((await cache.scan(path, limit)).hash, digest('BBBB'));
});

test('replacement between path stat and stream open cannot seed the cache', async t => {
  const { root, path, cache } = await fixture(t), replacement = join(root, 'replacement');
  await fs.writeFile(replacement, 'BBBB'); const io = observe(t);
  io.beforeOpen = async () => { io.beforeOpen = undefined; await fs.rename(replacement, path); };
  await assert.rejects(cache.scan(path, limit), { code: 'SYNC_RACE' });
  assert.equal((await cache.scan(path, limit)).hash, digest('BBBB'));
});

test('a metadata hit still rejects replacement between path stat and fd open', linux, async t => {
  const { root, path, cache } = await fixture(t);
  if (!await assertPrecise(t, path)) return;
  ext4(t); await cache.scan(path, limit, 'metadata');
  const replacement = join(root, 'replacement'); await fs.writeFile(replacement, 'BBBB');
  const io = observe(t);
  io.beforeOpen = async () => { io.beforeOpen = undefined; await fs.rename(replacement, path); };
  await assert.rejects(cache.scan(path, limit, 'metadata'), { code: 'SYNC_RACE' });
  assert.equal(io.reads, 0);
  assert.equal((await cache.scan(path, limit, 'metadata')).hash, digest('BBBB'));
});

test('unknown nanosecond metadata disables reuse rather than trusting a cache', linux, async t => {
  const { path, cache } = await fixture(t), lstat = fs.lstat.bind(fs);
  ext4(t); const io = observe(t);
  t.mock.method(fs, 'lstat', async (...args) => {
    const st = await lstat(...args);
    return Object.assign(Object.create(st), { birthtimeNs: undefined });
  });
  await cache.scan(path, limit, 'metadata'); const reads = io.reads;
  await cache.scan(path, limit, 'metadata'); assert.ok(io.reads > reads);
});

test('strict open does not follow a symlink swapped in after lstat', linux, async t => {
  const { root, path, cache } = await fixture(t), target = join(root, 'target');
  await fs.writeFile(target, 'BBBB'); const io = observe(t);
  io.beforeOpen = async () => {
    io.beforeOpen = undefined;
    await fs.unlink(path); await fs.symlink(target, path);
  };
  await assert.rejects(cache.scan(path, limit), { code: 'ELOOP' });
  assert.equal(io.reads, 0);
});
