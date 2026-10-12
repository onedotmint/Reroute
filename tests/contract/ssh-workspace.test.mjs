import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { providerFixture } from '../provider-fixtures.mjs';
import { fixture, policy, collect } from '../helpers.mjs';
import { Coordinator } from '../../dist/core/coordinator.js';
import { AsyncQueue } from '../../dist/core/queue.js';

const spec = { idleTimeoutMinutes: 1, env: {} };
const changedGeneration = '22222222-2222-4222-8222-222222222222';
async function boundary(t) {
  const cleanup = [], hooks = { after: fn => cleanup.push(fn) };
  const f = await fixture(hooks), { provider } = await providerFixture('ssh', f, hooks);
  t.after(async () => { for (const fn of cleanup.reverse()) await fn(); });
  const log = join(f.directory, 'ssh.jsonl'), failure = join(f.directory, 'ssh-failure');
  // Production SSH argv and Python are executed locally; no provider subclass or cloud call.
  await fs.writeFile(join(f.directory, 'bin', 'ssh'), `#!/usr/bin/env python3
import os,sys,json,shlex,socket,signal
log=${JSON.stringify(log)}; failure=${JSON.stringify(failure)}
def record(value):
 with open(log,'a') as f: f.write(json.dumps(value)+'\\n')
if os.path.exists(failure): sys.exit(int(open(failure).read()))
if '-N' in sys.argv:
 address=sys.argv[sys.argv.index('-L')+1]; port=int(address.split(':')[1])
 s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
 s.bind(('127.0.0.1',port)); s.listen()
 record({'op':'forward','port':port,'pid':os.getpid(),'address':address})
 def stop(*args):
  record({'op':'stop','port':port,'pid':os.getpid()}); s.close(); sys.exit(0)
 signal.signal(signal.SIGTERM,stop)
 while True:
  c,_=s.accept(); c.recv(4096)
  body=str(port).encode(); c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: '+str(len(body)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n'+body); c.close()
command=sys.argv[-1]; argv=shlex.split(command); program=argv[2] if len(argv)>2 else ''
op='initialize' if 'uuid' in program else 'destroy' if 'shutil.rmtree' in program else 'verify' if 'workspace identity changed' in program else 'control' if 'lstat' in program else 'worker'
record({'op':op})
os.execv('/bin/sh',['sh','-c',command])
`, { mode: 0o700 });
  const records = async () => (await fs.readFile(log, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; })).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...f, provider, records, failure, after: hooks.after };
}
const identityError = e => ['WORKSPACE_IDENTITY', 'WRONG_PROJECT', 'WRONG_PROVIDER'].includes(e.code);

async function damageWorkspace(root, damage) {
  const marker = join(root, '.reroute-runtime', 'owner.json');
  let sourceRoot = root;
  if (['missing-root', 'replacement-empty', 'symlink-root', 'dangling-root'].includes(damage)) {
    sourceRoot = root + '-original'; await fs.rename(root, sourceRoot);
    if (damage === 'replacement-empty') await fs.mkdir(root);
    if (damage === 'symlink-root') await fs.symlink(sourceRoot, root);
    if (damage === 'dangling-root') await fs.symlink(root + '-absent', root);
  } else if (damage === 'missing-marker') await fs.unlink(marker);
  else if (['missing-generation', 'changed-generation', 'changed-project'].includes(damage)) {
    const data = JSON.parse(await fs.readFile(marker, 'utf8'));
    if (damage === 'missing-generation') delete data.generation;
    if (damage === 'changed-generation') data.generation = changedGeneration;
    if (damage === 'changed-project') data.projectId = 'other-project';
    await fs.writeFile(marker, JSON.stringify(data));
  } else if (['symlink-marker', 'dangling-marker'].includes(damage)) {
    await fs.rename(marker, marker + '-original');
    await fs.symlink(damage === 'symlink-marker' ? marker + '-original' : marker + '-absent', marker);
  } else if (damage === 'symlink-marker-directory') {
    const directory = join(root, '.reroute-runtime');
    await fs.rename(directory, directory + '-original'); await fs.symlink(directory + '-original', directory);
  }
  return sourceRoot;
}

// Reuse an already-created file transport too: warm state must not authorize replacement disk.
for (const damage of ['missing-root', 'replacement-empty', 'missing-marker', 'missing-generation', 'changed-generation', 'changed-project', 'symlink-root', 'dangling-root', 'symlink-marker', 'dangling-marker', 'symlink-marker-directory']) {
  test(`SSH previous/exec/files/destroy fail closed on ${damage}, without owner repair`, async t => {
    const f = await boundary(t), runtime = await f.provider.ensureReady(f.project, spec);
    const original = structuredClone(runtime), files = f.provider.files(runtime);
    await fs.writeFile(join(runtime.root, 'valuable.txt'), 'original remote source');
    const sourceRoot = await damageWorkspace(runtime.root, damage);
    const marker = join(runtime.root, '.reroute-runtime', 'owner.json');
    const beforeMarker = await fs.readFile(marker).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    assert.equal(await f.provider.status(runtime), damage === 'missing-root' ? 'missing' : ['symlink-root', 'dangling-root'].includes(damage) ? 'unknown' : 'running');
    await assert.rejects(f.provider.ensureReady(f.project, spec, runtime), identityError);
    await assert.rejects(files.scan(policy), identityError);
    await assert.rejects(files.read(['valuable.txt'], policy), identityError);
    await assert.rejects(files.apply([{ path: 'MUST_NOT_EXIST', expected: null, data: Buffer.from('bad').toString('base64') }], policy), identityError);
    await assert.rejects(f.provider.exec(runtime, { argv: ['python3', '-c', "open('MUST_NOT_EXIST','w').write('bad')"], cwd: runtime.root, env: {} }), identityError);
    if (damage === 'missing-root') { await f.provider.destroy(runtime); assert.equal(await f.provider.status(runtime), 'missing'); }
    else await assert.rejects(f.provider.destroy(runtime));
    assert.deepEqual(runtime, original);
    assert.equal((await f.records()).filter(r => r.op === 'initialize').length, 1);
    assert.equal((await f.records()).filter(r => r.op === 'worker').length, 0);
    assert.equal(await fs.readFile(join(sourceRoot, 'valuable.txt'), 'utf8'), 'original remote source');
    assert.deepEqual(await fs.readFile(marker).catch(e => { if (e.code === 'ENOENT') return null; throw e; }), beforeMarker);
    await assert.rejects(fs.stat(join(sourceRoot, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
    if (damage === 'replacement-empty') assert.deepEqual(await fs.readdir(runtime.root), []);
    if (['symlink-root', 'dangling-root'].includes(damage)) assert.ok((await fs.lstat(runtime.root)).isSymbolicLink());
  });
}

for (const field of ['provider', 'project', 'id', 'root', 'configured-root', 'recorded-generation']) {
  test(`SSH wrong ${field} cannot adopt, execute, write or destroy a runtime`, async t => {
    const f = await boundary(t), runtime = await f.provider.ensureReady(f.project, spec), wrong = structuredClone(runtime);
    await fs.writeFile(join(runtime.root, 'valuable.txt'), 'keep');
    if (field === 'provider') wrong.provider = 'daytona';
    if (field === 'project') wrong.projectId = 'other-project';
    if (field === 'id') wrong.id = 'other-id';
    if (field === 'root') wrong.root = f.remote;
    if (field === 'recorded-generation') delete wrong.meta.workspaceGeneration;
    if (field === 'configured-root') {
      const other = join(f.directory, 'other', f.project.id);
      await fs.cp(runtime.root, other, { recursive: true }); wrong.root = other;
    }
    const snapshot = structuredClone(wrong);
    await assert.rejects(f.provider.ensureReady(f.project, spec, wrong), identityError);
    await assert.rejects(f.provider.files(wrong).scan(policy), identityError);
    await assert.rejects(f.provider.files(wrong).apply([{ path: 'valuable.txt', expected: null, data: null }], policy), identityError);
    await assert.rejects(f.provider.exec(wrong, { argv: ['python3', '-c', "open('MUST_NOT_EXIST','w').write('bad')"], cwd: wrong.root, env: {} }), identityError);
    await assert.rejects(f.provider.destroy(wrong));
    assert.deepEqual(wrong, snapshot);
    assert.equal(await fs.readFile(join(runtime.root, 'valuable.txt'), 'utf8'), 'keep');
    assert.equal((await f.records()).filter(r => r.op === 'initialize').length, 1);
  });
}

test('SSH valid previous preserves generation, real exec/files work, and destroy is idempotent', async t => {
  const f = await boundary(t), runtime = await f.provider.ensureReady(f.project, spec);
  assert.strictEqual(await f.provider.ensureReady(f.project, spec, runtime), runtime);
  const files = f.provider.files(runtime);
  await files.apply([{ path: 'source.txt', expected: null, data: Buffer.from('source').toString('base64') }], policy);
  assert.equal(Buffer.from((await files.read(['source.txt'], policy))['source.txt'], 'base64').toString(), 'source');
  assert.ok((await files.scan(policy))['source.txt']);
  const result = await collect(await f.provider.exec(runtime, { argv: ['python3', '-c', "print(open('source.txt').read())"], cwd: runtime.root, env: {} }));
  assert.equal(result.code, 0); assert.equal(result.stdout.toString(), 'source\n');
  await f.provider.destroy(runtime); await f.provider.destroy(runtime);
  assert.equal(await f.provider.status(runtime), 'missing');
  await assert.rejects(fs.stat(runtime.root), { code: 'ENOENT' });
  assert.equal((await f.records()).filter(r => r.op === 'initialize').length, 1);
});

test('SSH connectivity failure is unknown, never idempotent missing or permission to destroy', async t => {
  const f = await boundary(t), runtime = await f.provider.ensureReady(f.project, spec);
  await fs.writeFile(join(runtime.root, 'valuable.txt'), 'keep');
  await fs.writeFile(f.failure, '255');
  assert.equal(await f.provider.status(runtime), 'unknown');
  await assert.rejects(f.provider.destroy(runtime));
  await assert.rejects(f.provider.ensureReady(f.project, spec, runtime), identityError);
  assert.equal(await fs.readFile(join(runtime.root, 'valuable.txt'), 'utf8'), 'keep');
  assert.equal((await f.records()).filter(r => r.op === 'initialize').length, 1);
});

for (const damage of ['replacement-empty', 'missing-marker', 'missing-generation', 'changed-generation', 'symlink-root', 'symlink-marker']) {
  test(`pending SSH source survives ${damage}: no baseline reset, local deletion or repair`, async t => {
    const f = await boundary(t), oldHome = process.env.REROUTE_HOME;
    process.env.REROUTE_HOME = join(f.directory, 'home');
    const core = new Coordinator(() => f.provider);
    f.after(async () => { try { await core.shutdown(); } finally { if (oldHome === undefined) delete process.env.REROUTE_HOME; else process.env.REROUTE_HOME = oldHome; } });
    await core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture', remoteRoot: f.remote } } });
    await fs.writeFile(join(f.local, 'source.txt'), 'agreed source');
    await core.synchronize(f.local);
    const state = await core.start(f.local), original = structuredClone(state.runtime);
    const baseline = await fs.readFile(join(f.local, '.reroute', 'sync-base.json'));
    await fs.writeFile(join(state.runtime.root, 'pending.txt'), 'unreturned source');
    state.syncPending = true; await core.store.save(state);
    const sourceRoot = await damageWorkspace(state.runtime.root, damage);
    const cold = new Coordinator(() => f.provider);
    f.after(() => cold.shutdown());
    for (const coordinator of [core, cold]) {
      await assert.rejects(coordinator.synchronize(f.local), e => identityError(e) || e.code === 'RUNTIME_UNKNOWN');
      const saved = JSON.parse(await fs.readFile(join(f.local, '.reroute', 'project.json'), 'utf8'));
      assert.equal(saved.syncPending, true); assert.deepEqual(saved.runtime, original);
      assert.deepEqual(await fs.readFile(join(f.local, '.reroute', 'sync-base.json')), baseline);
      assert.equal(await fs.readFile(join(f.local, 'source.txt'), 'utf8'), 'agreed source');
      assert.equal(await fs.readFile(join(sourceRoot, 'pending.txt'), 'utf8'), 'unreturned source');
    }
    assert.equal((await f.records()).filter(r => r.op === 'initialize').length, 1);
    if (damage === 'replacement-empty') assert.deepEqual(await fs.readdir(state.runtime.root), []);
    if (damage === 'missing-marker') await assert.rejects(fs.stat(join(state.runtime.root, '.reroute-runtime', 'owner.json')), { code: 'ENOENT' });
  });
}

test('SSH non-directory parent is unknown, not an idempotently absent workspace', async t => {
  const f = await boundary(t), runtime = await f.provider.ensureReady(f.project, spec);
  await fs.rename(f.remote, f.remote + '-original'); await fs.writeFile(f.remote, 'not a directory');
  assert.equal(await f.provider.status(runtime), 'unknown');
  await assert.rejects(f.provider.destroy(runtime));
  assert.equal(await fs.readFile(f.remote, 'utf8'), 'not a directory');
  assert.ok(await fs.stat(join(f.remote + '-original', f.project.id, '.reroute-runtime', 'owner.json')));
});

async function unusedPort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const request = port => new Promise((resolve, reject) => {
  get(`http://127.0.0.1:${port}`, response => { let body = ''; response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve(body)); }).on('error', reject);
});

test('SSH -N replaces a changed preview port; delayed old diagnostics cleanup cannot evict the new tunnel', async t => {
  const f = await boundary(t), runtime = await f.provider.ensureReady(f.project, spec);
  let release, retiredQueue;
  const drained = new Promise(resolve => { release = resolve; });
  const originalIterator = AsyncQueue.prototype[Symbol.asyncIterator];
  // Deterministically delay only the old tunnel's final drain, not the native child exit.
  t.mock.method(AsyncQueue.prototype, Symbol.asyncIterator, function () {
    const queue = this, iterator = originalIterator.call(this); retiredQueue ??= queue;
    return { next: async () => { const item = await iterator.next(); if (item.done && queue === retiredQueue) await drained; return item; } };
  });
  f.after(async () => { release(); await f.provider.applyIdlePolicy(runtime, { active: false, minutes: 0 }); });
  const first = await unusedPort(); let second = await unusedPort(); while (second === first) second = await unusedPort();
  assert.equal(await f.provider.preview(runtime, first), `http://127.0.0.1:${first}`);
  assert.equal(await request(first), String(first));
  assert.equal(await f.provider.preview(runtime, first), `http://127.0.0.1:${first}`);
  assert.equal((await f.records()).filter(r => r.op === 'forward').length, 1);
  assert.equal(await f.provider.preview(runtime, second), `http://127.0.0.1:${second}`);
  const records = await f.records();
  assert.deepEqual(records.filter(r => r.op === 'forward').map(r => r.port), [first, second]);
  assert.ok(records.findIndex(r => r.op === 'stop' && r.port === first) < records.findIndex(r => r.op === 'forward' && r.port === second));
  await assert.rejects(request(first), { code: 'ECONNREFUSED' });
  assert.equal(await request(second), String(second));
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.provider.preview(runtime, second), `http://127.0.0.1:${second}`);
  assert.equal((await f.records()).filter(r => r.op === 'forward').length, 2);
  await f.provider.applyIdlePolicy(runtime, { active: false, minutes: 0 });
  await assert.rejects(request(second), { code: 'ECONNREFUSED' });
});
