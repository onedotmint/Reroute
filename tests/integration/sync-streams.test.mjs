import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Synchronizer } from '../../dist/sync/sync.js';
import { fetchArtifacts } from '../../dist/sync/artifacts.js';
import { fixture, transport, policy } from '../helpers.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
const entry = data => ({ hash: digest(data), size: data.length, mode: 0o644 });
async function cleanTemps(root) {
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    assert.ok(!item.name.startsWith('.reroute-tmp-'), 'partial temporary file was not cleaned');
    if (item.isDirectory()) await cleanTemps(join(root, item.name));
  }
}
async function synced(t) {
  const f = await fixture(t), files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
  await fs.writeFile(join(f.local, 'x'), 'original'); await sync.reconcile(files);
  const saved = await fs.readFile(join(f.local, '.reroute/sync-base.json'));
  return { ...f, files, sync, saved };
}

for (const failure of ['truncated', 'wrong-hash', 'wrong-size', 'changed-mode', 'oversize', 'disconnect']) {
  test(`stream ${failure} never replaces source or advances baseline`, async t => {
    const f = await synced(t), data = Buffer.from('replacement');
    await fs.writeFile(join(f.remote, 'x'), data);
    const files = { ...f.files, download: async (_path, _policy, consume) => {
      await consume(failure === 'truncated' ? data.subarray(0, 3) : failure === 'oversize' ? Buffer.alloc(65537) : data);
      if (failure === 'disconnect') throw new Error('transport lost');
      return { ...entry(data), ...(failure === 'wrong-hash' ? { hash: '0'.repeat(64) } : failure === 'wrong-size' ? { size: 2 } : failure === 'changed-mode' ? { mode: 0o755 } : {}) };
    } };
    await assert.rejects(f.sync.reconcile(files));
    assert.equal(await fs.readFile(join(f.local, 'x'), 'utf8'), 'original');
    assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.saved);
    await cleanTemps(f.local);
    await f.sync.reconcile(f.files);
    assert.equal(await fs.readFile(join(f.local, 'x'), 'utf8'), 'replacement');
  });
}

test('worker stream rejects in-flight remote mutation even with restored mtime', async t => {
  const f = await fixture(t), path = join(f.remote, 'x');
  await fs.writeFile(path, Buffer.alloc(512 * 1024, 1)); const before = await fs.stat(path);
  let chunks = 0;
  await assert.rejects(transport(f.runtime).download('x', policy, async () => {
    if (++chunks === 1) {
      const fd = await fs.open(path, 'r+'); await fd.write(Buffer.from([2]), 0, 1, 128 * 1024); await fd.close();
      await fs.utimes(path, before.atime, before.mtime);
    }
  }), /CHANGED|RACE|changed/);
  assert.ok(chunks > 0);
});

test('worker stream is bounded and cannot read ahead of a blocked consumer', async t => {
  const f = await fixture(t); await fs.writeFile(join(f.remote, 'x'), Buffer.alloc(512 * 1024, 4));
  let release, started, count = 0;
  const first = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const reading = transport(f.runtime).download('x', policy, async data => {
    assert.ok(data.length <= 64 * 1024);
    if (++count === 1) { started(); await gate; }
  });
  await first; await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(count, 1); release();
  const result = await reading;
  assert.equal(count, 8); assert.equal(result.size, 512 * 1024);
});

test('failed stream consumer closes worker and is retryable', async t => {
  const f = await synced(t);
  await fs.writeFile(join(f.remote, 'x'), Buffer.alloc(256 * 1024, 7));
  const files = { ...f.files, download: (path, p, consume) => f.files.download(path, p, async data => {
    await consume(data); throw new Error('disk write failed');
  }) };
  await assert.rejects(f.sync.reconcile(files), /disk write failed/);
  assert.equal(await fs.readFile(join(f.local, 'x'), 'utf8'), 'original');
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.saved);
  await cleanTemps(f.local); await f.sync.reconcile(f.files);
  assert.equal((await fs.stat(join(f.local, 'x'))).size, 256 * 1024);
});

test('large pull, backup, conflict evidence and artifact do not use whole-file reads', async t => {
  const f = await fixture(t), p = { ...policy, maxFileBytes: 8 * 1024 * 1024 };
  const files = transport(f.runtime), sync = new Synchronizer(f.local, p);
  const data = Buffer.alloc(p.maxFileBytes, 6);
  await fs.writeFile(join(f.remote, 'x'), data);
  await fs.mkdir(join(f.remote, 'build'));
  await fs.writeFile(join(f.remote, 'build/artifact'), data);
  const read = fs.readFile;
  fs.readFile = async (path, ...args) => {
    assert.ok(![join(f.local, 'x'), join(f.remote, 'x')].includes(String(path)), 'whole-file source read');
    return read(path, ...args);
  };
  try {
    assert.deepEqual(await sync.reconcile(files), { pushed: 0, pulled: 1 });
    await fs.writeFile(join(f.remote, 'x'), Buffer.alloc(data.length, 7));
    assert.deepEqual(await sync.reconcile(files), { pushed: 0, pulled: 1 });
    const backups = await fs.readdir(join(f.local, '.reroute/backups'));
    assert.equal(backups.length, 1);
    assert.equal(digest(await read(join(f.local, '.reroute/backups', backups[0]))), digest(data));
    await fs.writeFile(join(f.local, 'x'), 'local change'); await fs.writeFile(join(f.remote, 'x'), data);
    await assert.rejects(sync.reconcile(files), error => error.code === 'SYNC_CONFLICT');
    const [conflict] = await fs.readdir(join(f.local, '.reroute/conflicts'));
    assert.equal(digest(await read(join(f.local, '.reroute/conflicts', conflict, 'remote/x'))), digest(data));
    const artifact = await fetchArtifacts(f.local, { paths: ['build/artifact'], maxFileBytes: p.maxFileBytes }, files);
    assert.equal(digest(await read(join(artifact.directory, 'build/artifact'))), digest(data));
    assert.equal((await fs.stat(join(artifact.directory, 'build/artifact'))).mode & 0o777, 0o600);
  } finally { fs.readFile = read; }
  await cleanTemps(f.local);
});

test('failed artifact stream leaves no apparently complete output', async t => {
  const f = await fixture(t), data = Buffer.from('partial');
  await assert.rejects(fetchArtifacts(f.local, { paths: ['build/x'], maxFileBytes: 10 }, { download: async (_path, _p, consume) => {
    await consume(data); throw new Error('disconnected');
  } }), /Artifact retrieval failed/);
  const [dir] = await fs.readdir(join(f.local, '.reroute/artifacts'));
  await assert.rejects(fs.stat(join(f.local, '.reroute/artifacts', dir, 'build/x')), { code: 'ENOENT' });
  await cleanTemps(f.local);
});

// Adversarial transports exercise the parser, not an injected download implementation.
const { fileTransport } = await import('../../dist/providers/channel.js');
const { AsyncQueue } = await import('../../dist/core/queue.js');
const oneByte = Buffer.from('a');
const startFrame = { type: 'file_start', path: 'x', size: 1, mode: 0o644 };
const chunkFrame = { type: 'file_chunk', path: 'x', seq: 0, data: 'YQ==' };
const endFrame = { type: 'file_end', path: 'x', seq: 1, ...entry(oneByte) };
const resultFrame = { type: 'file_result', path: 'x', ok: true };
for (const [name, packets, code = 0] of [
  ['missing confirmation', [startFrame, chunkFrame, endFrame]],
  ['duplicate chunk', [startFrame, chunkFrame, chunkFrame, endFrame, resultFrame]],
  ['out-of-order chunk', [chunkFrame, startFrame]],
  ['wrong path', [startFrame, { ...chunkFrame, path: 'y' }]],
  ['extra fields', [{ ...startFrame, untrusted: true }]],
  ['noncanonical base64', [startFrame, { ...chunkFrame, data: 'YQ' }]],
  ['wrong sequence', [startFrame, { ...chunkFrame, seq: 2 }]],
  ['wrong final hash', [startFrame, chunkFrame, { ...endFrame, hash: '0'.repeat(64) }]],
  ['unexpected post-confirmation output', [startFrame, chunkFrame, endFrame, resultFrame, startFrame]],
  ['nonzero transport exit', [startFrame, chunkFrame, endFrame, resultFrame], 1]
]) test(`file protocol rejects ${name}`, async () => {
  let killed = false;
  const raw = {
    events: (async function* () { for (const packet of packets) yield { stream: 'stdout', data: Buffer.from(JSON.stringify(packet) + '\n') }; })(),
    write: async () => {}, closeInput: async () => {}, wait: async () => code, kill: async () => { killed = true; }
  };
  const files = fileTransport(async () => raw, { root: '/fixture', id: 'fixture', projectId: 'fixture', provider: 'ssh', meta: {} });
  await assert.rejects(files.download('x', policy, async () => {}));
  assert.equal(killed, true);
});

test('file stream idle timeout also bounds a blocked disk consumer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = new AsyncQueue(); let killed = false, consumed;
  const consuming = new Promise(resolve => { consumed = resolve; });
  const raw = { events, write: async () => {}, closeInput: async () => {}, wait: async () => 0, kill: async () => { killed = true; events.end(); } };
  const files = fileTransport(async () => raw, { root: '/fixture', id: 'fixture', projectId: 'fixture', provider: 'ssh', meta: {} });
  const reading = files.download('x', policy, async () => { consumed(); await new Promise(() => {}); });
  const rejected = assert.rejects(reading, { code: 'TRANSPORT_TIMEOUT' });
  events.push({ stream: 'stdout', data: Buffer.from(JSON.stringify(startFrame) + '\n' + JSON.stringify(chunkFrame) + '\n') });
  await consuming; t.mock.timers.tick(30001); await rejected;
  assert.equal(killed, true);
});

test('valid bounded file frames may arrive together in one transport event', async () => {
  const path = Array.from({ length: 30 }, () => '\x01'.repeat(100)).join('/'), data = Buffer.alloc(65536, 9);
  const packets = [
    { type: 'file_start', path, size: data.length, mode: 0o644 },
    { type: 'file_chunk', path, seq: 0, data: data.toString('base64') },
    { type: 'file_end', path, seq: 1, ...entry(data) },
    { type: 'file_result', path, ok: true }
  ];
  const combined = Buffer.from(packets.map(packet => JSON.stringify(packet) + '\n').join(''));
  assert.ok(combined.length > 112 * 1024 && combined.length < 256 * 1024);
  let received = 0;
  const raw = { events: (async function* () { yield { stream: 'stdout', data: combined }; })(), write: async () => {}, closeInput: async () => {}, wait: async () => 0, kill: async () => {} };
  const files = fileTransport(async () => raw, { root: '/fixture', id: 'fixture', projectId: 'fixture', provider: 'ssh', meta: {} });
  assert.deepEqual(await files.download(path, policy, async chunk => { received += chunk.length; }), entry(data));
  assert.equal(received, data.length);
});

test('legacy artifact fallback enforces encoded size before allocating the decoded buffer', async t => {
  const f = await fixture(t), encoded = 'A'.repeat(16384), from = Buffer.from;
  t.mock.method(Buffer, 'from', (...args) => {
    assert.notEqual(args[0], encoded, 'oversized legacy payload must not be decoded');
    return from(...args);
  });
  await assert.rejects(fetchArtifacts(f.local, { paths: ['build/x'], maxFileBytes: 10 }, {
    readArtifact: async () => ({ data: encoded, size: 12288, hash: '0'.repeat(64), mode: 0o644 })
  }), /transfer limit/);
  await cleanTemps(f.local);
});
