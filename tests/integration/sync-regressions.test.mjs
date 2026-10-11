import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { Synchronizer, scanLocal } from '../../dist/sync/sync.js';
import { hash } from '../../dist/platform/files.js';
import { fixture, policy, transport } from '../helpers.mjs';

const baseline = f => join(f.local, '.reroute', 'sync-base.json');
async function put(root, path, text, mode = 0o751) {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), text);
  await fs.chmod(join(root, path), mode);
}
async function setup(t, path = 'part/a/x') {
  const f = await fixture(t);
  const files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
  await put(f.local, path, 'base');
  await sync.reconcile(files);
  return { ...f, files, sync };
}

test('new excludes forget only excluded baseline entries without deleting either copy', async t => {
  const f = await setup(t, 'notes.txt');
  await put(f.local, 'keep.txt', 'keep');
  await f.sync.reconcile(f.files);
  await put(f.remote, 'notes.txt', 'remote private note');
  await put(f.remote, 'keep.txt', 'updated');
  const sync = new Synchronizer(f.local, { ...policy, excludes: ['notes.txt'] });
  assert.deepEqual(await sync.reconcile(f.files), { pushed: 0, pulled: 1 });
  assert.equal(await fs.readFile(join(f.local, 'notes.txt'), 'utf8'), 'base');
  assert.equal(await fs.readFile(join(f.remote, 'notes.txt'), 'utf8'), 'remote private note');
  assert.equal(await fs.readFile(join(f.local, 'keep.txt'), 'utf8'), 'updated');
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(baseline(f))), 'notes.txt'), false);
  assert.deepEqual(await sync.reconcile(f.files), { pushed: 0, pulled: 0 });
});

test('current excluded remote entries are rejected, including accept-local, before saving them', async t => {
  const f = await setup(t, 'notes.txt');
  const saved = await fs.readFile(baseline(f), 'utf8');
  const entry = { hash: hash('secret'), size: 6, mode: 0o600 };
  const untrusted = { ...f.files, scan: async () => ({ '.env': entry }) };
  for (const method of ['reconcile', 'acceptLocal']) await assert.rejects(f.sync[method](untrusted), error => error.code === 'SYNC_POLICY');
  assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
});

test('illegal historical paths are rejected even if the new policy excludes them', async t => {
  const f = await setup(t, 'notes.txt');
  await fs.writeFile(baseline(f), JSON.stringify({ '../outside': { hash: hash('bad'), size: 3, mode: 0o600 } }));
  const sync = new Synchronizer(f.local, { ...policy, excludes: ['*'] });
  await assert.rejects(sync.reconcile(f.files), error => error.code === 'UNSAFE_PATH');
});

for (const direction of ['push', 'pull']) {
  for (const shape of ['directory-to-file', 'file-to-directory']) {
    test(`${direction} safely converts ${shape}, including nested empty directories`, async t => {
      const old = shape === 'directory-to-file' ? 'part/a/x' : 'part';
      const next = shape === 'directory-to-file' ? 'part' : 'part/a/x';
      const f = await setup(t, old);
      const source = direction === 'push' ? f.local : f.remote;
      const target = direction === 'push' ? f.remote : f.local;
      await fs.rm(join(source, 'part'), { recursive: true });
      await put(source, next, 'changed');
      await f.sync.reconcile(f.files);
      assert.equal(await fs.readFile(join(target, next), 'utf8'), 'changed');
      assert.equal((await fs.stat(join(target, next))).mode & 0o111, 0o111);
      const state = JSON.parse(await fs.readFile(baseline(f)));
      assert.deepEqual(Object.keys(state), [next]);
      assert.deepEqual(await f.sync.reconcile(f.files), { pushed: 0, pulled: 0 });
    });
  }
  for (const blocker of ['secret-file', 'excluded-directory', 'excluded-symlink']) {
    test(`${direction} conversion preserves ${blocker} instead of recursively deleting it`, async t => {
      const f = await setup(t);
      const source = direction === 'push' ? f.local : f.remote;
      const target = direction === 'push' ? f.remote : f.local;
      const saved = await fs.readFile(baseline(f), 'utf8');
      await fs.rm(join(source, 'part'), { recursive: true });
      await put(source, 'part', 'changed');
      const protectedPath = join(target, 'part', blocker === 'excluded-directory' ? '.ssh' : '.env');
      const outside = join(f.directory, 'outside');
      await fs.writeFile(outside, 'must stay');
      if (blocker === 'excluded-directory') await fs.mkdir(protectedPath);
      else if (blocker === 'excluded-symlink') await fs.symlink(outside, protectedPath);
      else await fs.writeFile(protectedPath, 'private');
      await assert.rejects(f.sync.reconcile(f.files));
      const stat = await fs.lstat(protectedPath);
      if (blocker === 'excluded-directory') assert.ok(stat.isDirectory());
      else if (blocker === 'excluded-symlink') assert.ok(stat.isSymbolicLink());
      else assert.equal(await fs.readFile(protectedPath, 'utf8'), 'private');
      assert.equal(await fs.readFile(outside, 'utf8'), 'must stay');
      assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
    });
  }
  test(`${direction} structural conflicts fail before changing user files`, async t => {
    const f = await setup(t);
    const source = direction === 'push' ? f.local : f.remote;
    const target = direction === 'push' ? f.remote : f.local;
    await fs.rm(join(source, 'part'), { recursive: true });
    await put(source, 'part', 'file');
    await put(target, 'part/y', 'new user file');
    await assert.rejects(f.sync.reconcile(f.files), error => error.code === 'SYNC_CONFLICT');
    assert.equal(await fs.readFile(join(source, 'part'), 'utf8'), 'file');
    assert.equal(await fs.readFile(join(target, 'part/a/x'), 'utf8'), 'base');
    assert.equal(await fs.readFile(join(target, 'part/y'), 'utf8'), 'new user file');
  });
}

for (const shape of ['directory-to-file', 'file-to-directory']) {
  test(`worker apply prepares ${shape} and applies deletions before out-of-order writes`, async t => {
    const f = await fixture(t), files = transport(f.runtime);
    const old = shape === 'directory-to-file' ? 'part/a/x' : 'part';
    const next = shape === 'directory-to-file' ? 'part' : 'part/a/x';
    await put(f.remote, old, 'base');
    await files.apply([
      { path: next, expected: null, data: Buffer.from('changed').toString('base64'), mode: 0o751 },
      { path: old, expected: hash('base'), data: null }
    ], policy);
    assert.equal(await fs.readFile(join(f.remote, next), 'utf8'), 'changed');
  });
}

test('worker refuses an unplanned nonempty directory or stale file type', async t => {
  const f = await fixture(t), files = transport(f.runtime);
  await put(f.remote, 'part/a/x', 'valuable');
  for (const expected of [null, hash('old file')]) {
    await assert.rejects(files.apply([{ path: 'part', expected, data: Buffer.from('overwrite').toString('base64') }], policy));
    assert.equal(await fs.readFile(join(f.remote, 'part/a/x'), 'utf8'), 'valuable');
  }
});

for (const action of ['write', 'delete']) {
  test(`local ${action} rechecks user edits after preparing its backup/temp file`, async t => {
    const f = await setup(t, 'x'), saved = await fs.readFile(baseline(f), 'utf8');
    if (action === 'write') await put(f.remote, 'x', 'remote'); else await fs.unlink(join(f.remote, 'x'));
    const write = fs.writeFile;
    let edited = false;
    fs.writeFile = async (path, ...args) => {
      const result = await write(path, ...args);
      const trigger = action === 'write' ? dirname(String(path)) === f.local && String(path).startsWith(join(f.local, '.reroute-tmp-')) : String(path).includes('/.reroute/backups/');
      if (!edited && trigger) { edited = true; await write(join(f.local, 'x'), 'user edit'); }
      return result;
    };
    try { await assert.rejects(f.sync.reconcile(f.files), error => error.code === 'SYNC_RACE'); }
    finally { fs.writeFile = write; }
    assert.equal(edited, true);
    assert.equal(await fs.readFile(join(f.local, 'x'), 'utf8'), 'user edit');
    assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
  });
}

test('push deletion refuses a local source recreated after scanning', async t => {
  const f = await setup(t, 'x');
  await fs.unlink(join(f.local, 'x'));
  const files = { ...f.files, scan: async p => {
    const manifest = await f.files.scan(p);
    await put(f.local, 'x', 'recreated');
    return manifest;
  } };
  await assert.rejects(f.sync.reconcile(files), error => error.code === 'SYNC_RACE');
  assert.equal(await fs.readFile(join(f.local, 'x'), 'utf8'), 'recreated');
  assert.equal(await fs.readFile(join(f.remote, 'x'), 'utf8'), 'base');
});

test('conversion retries after a partial failure without advancing the baseline', async t => {
  const f = await setup(t), saved = await fs.readFile(baseline(f), 'utf8');
  await fs.rm(join(f.local, 'part'), { recursive: true });
  await put(f.local, 'part', 'changed');
  const files = { ...f.files, apply: async (changes, p) => {
    if (changes.some(change => change.data !== null)) throw new Error('injected write failure');
    await f.files.apply(changes, p);
  } };
  await assert.rejects(f.sync.reconcile(files));
  assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
  await f.sync.reconcile(f.files);
  assert.equal(await fs.readFile(join(f.remote, 'part'), 'utf8'), 'changed');
});

for (const paths of [['x', 'x.remote/y'], ['conflicts.json', 'conflicts.json.remote/y']]) {
  test(`conflict evidence preserves ${paths.join(' and ')} separately from metadata`, async t => {
    const f = await fixture(t), files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
    for (const path of paths) await put(f.local, path, 'base ' + path);
    await sync.reconcile(files);
    const saved = await fs.readFile(baseline(f), 'utf8');
    for (const path of paths) {
      await put(f.local, path, 'local ' + path);
      await put(f.remote, path, 'remote ' + path);
    }
    await assert.rejects(sync.reconcile(files), error => error.code === 'SYNC_CONFLICT');
    const conflicts = join(f.local, '.reroute', 'conflicts');
    const dirs = await fs.readdir(conflicts);
    assert.equal(dirs.length, 1);
    const dir = join(conflicts, dirs[0]);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['conflicts.json', 'remote']);
    const metadata = JSON.parse(await fs.readFile(join(dir, 'conflicts.json'), 'utf8'));
    assert.deepEqual(metadata.paths.sort(), [...paths].sort());
    for (const path of paths) {
      assert.equal(await fs.readFile(join(dir, 'remote', path), 'utf8'), 'remote ' + path);
      assert.equal(metadata.base[path].hash, hash('base ' + path));
      assert.equal(metadata.local[path].hash, hash('local ' + path));
      assert.equal(metadata.remote[path].hash, hash('remote ' + path));
      assert.equal(await fs.readFile(join(f.local, path), 'utf8'), 'local ' + path);
      assert.equal(await fs.readFile(join(f.remote, path), 'utf8'), 'remote ' + path);
    }
    assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
  });
}

test('individually valid maxFiles=1 trees cannot merge past the limit or advance the baseline', async t => {
  const f = await setup(t, 'old'), saved = await fs.readFile(baseline(f), 'utf8');
  await fs.unlink(join(f.local, 'old'));
  await fs.unlink(join(f.remote, 'old'));
  await put(f.local, 'local-only', 'local');
  await put(f.remote, 'remote-only', 'remote');
  const tight = { ...policy, maxFiles: 1 };
  assert.deepEqual(Object.keys(await scanLocal(f.local, tight)), ['local-only']);
  assert.deepEqual(Object.keys(await f.files.scan(tight)), ['remote-only']);
  const guarded = {
    ...f.files,
    read: async () => assert.fail('over-limit merge must fail before reading transfer data'),
    apply: async () => assert.fail('over-limit merge must fail before remote mutation')
  };
  await assert.rejects(new Synchronizer(f.local, tight).reconcile(guarded), error => error.code === 'TOO_MANY_FILES');
  assert.deepEqual((await fs.readdir(f.local)).sort(), ['.reroute', 'local-only']);
  assert.deepEqual(await fs.readdir(f.remote), ['remote-only']);
  assert.equal(await fs.readFile(join(f.local, 'local-only'), 'utf8'), 'local');
  assert.equal(await fs.readFile(join(f.remote, 'remote-only'), 'utf8'), 'remote');
  await assert.rejects(fs.stat(join(f.local, '.reroute', 'backups')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
});

const longNames = ['a'.repeat(255), '界'.repeat(85)];
for (const direction of ['push', 'pull']) {
  test(`${direction} creates and replaces legal 255-byte filenames with executable modes`, async t => {
    const f = await fixture(t), files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
    const source = direction === 'push' ? f.local : f.remote;
    const target = direction === 'push' ? f.remote : f.local;
    const counts = { pushed: direction === 'push' ? 2 : 0, pulled: direction === 'pull' ? 2 : 0 };
    for (const name of longNames) {
      assert.equal(Buffer.byteLength(name), 255);
      await put(source, 'nested/' + name, 'created');
    }
    assert.deepEqual(await sync.reconcile(files), counts);
    for (const name of longNames) {
      assert.equal(await fs.readFile(join(target, 'nested', name), 'utf8'), 'created');
      assert.equal((await fs.stat(join(target, 'nested', name))).mode & 0o777, 0o751);
      await put(source, 'nested/' + name, 'replaced', 0o750);
    }
    assert.deepEqual(await sync.reconcile(files), counts);
    for (const name of longNames) {
      assert.equal(await fs.readFile(join(target, 'nested', name), 'utf8'), 'replaced');
      assert.equal((await fs.stat(join(target, 'nested', name))).mode & 0o777, 0o750);
    }
    assert.deepEqual((await fs.readdir(join(target, 'nested'))).sort(), [...longNames].sort());
    assert.deepEqual(await sync.reconcile(files), { pushed: 0, pulled: 0 });
  });
}

test('legal 255-byte conflict filenames retain remote copies without suffixes', async t => {
  const f = await fixture(t), files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
  for (const name of longNames) await put(f.local, 'nested/' + name, 'base');
  await sync.reconcile(files);
  const saved = await fs.readFile(baseline(f), 'utf8');
  for (const name of longNames) {
    await put(f.local, 'nested/' + name, 'local');
    await put(f.remote, 'nested/' + name, 'remote');
  }
  await assert.rejects(sync.reconcile(files), error => error.code === 'SYNC_CONFLICT');
  const conflicts = join(f.local, '.reroute', 'conflicts'), [dir] = await fs.readdir(conflicts);
  const metadata = JSON.parse(await fs.readFile(join(conflicts, dir, 'conflicts.json'), 'utf8'));
  assert.deepEqual(metadata.paths.sort(), longNames.map(name => 'nested/' + name).sort());
  for (const name of longNames) {
    const copy = join(conflicts, dir, 'remote', 'nested', name);
    assert.equal(await fs.readFile(copy, 'utf8'), 'remote');
    assert.equal((await fs.stat(copy)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(join(f.local, 'nested', name), 'utf8'), 'local');
    assert.equal(await fs.readFile(join(f.remote, 'nested', name), 'utf8'), 'remote');
  }
  assert.deepEqual((await fs.readdir(join(conflicts, dir, 'remote', 'nested'))).sort(), [...longNames].sort());
  assert.equal(await fs.readFile(baseline(f), 'utf8'), saved);
});

test('both scans exclude abandoned fixed-length temporary files, including nested ones', async t => {
  const f = await fixture(t), files = transport(f.runtime), sync = new Synchronizer(f.local, policy);
  const temp = '.reroute-tmp-12345678-1234-4123-8123-123456789abc.tmp';
  for (const root of [f.local, f.remote]) {
    await put(root, temp, 'incomplete');
    await put(root, 'nested/' + temp, 'incomplete');
  }
  const tight = { ...policy, maxFiles: 1, maxFileBytes: 1 };
  assert.deepEqual(Object.keys(await scanLocal(f.local, tight)), []);
  assert.deepEqual(Object.keys(await files.scan(tight)), []);
  await put(f.local, 'source', 'source');
  assert.deepEqual(await sync.reconcile(files), { pushed: 1, pulled: 0 });
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(baseline(f)))), ['source']);
  for (const root of [f.local, f.remote]) {
    assert.equal(await fs.readFile(join(root, temp), 'utf8'), 'incomplete');
    assert.equal(await fs.readFile(join(root, 'nested', temp), 'utf8'), 'incomplete');
  }
});
