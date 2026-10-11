import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncPreview, scanLocal, excluded, validSyncPattern } from '../../dist/sync/sync.js';
import { DEFAULT_CONFIG, validateConfig } from '../../dist/config/config.js';

const policy = { excludes: [], maxFileBytes: 100, maxFiles: 100 };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'reroute-preview-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, path, content = 'abc') {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content);
}
function python(body, input) {
  const worker = new URL('../../assets/worker.py', import.meta.url).pathname;
  const result = spawnSync('python3', ['-B', '-c', `import json,sys\nns={'__name__':'worker_test'}\nwith open(sys.argv[1]) as source: exec(compile(source.read(), sys.argv[1], 'exec'),ns)\ndata=json.load(sys.stdin)\n${body}`, worker], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const cases = [
  ['*.txt', 'nested/a.txt', true], ['src/*.txt', 'src/a.txt', true],
  ['src/*.txt', 'src/nested/a.txt', false], ['a?b', 'a/b', false],
  ['src/?/x', 'src/é/x', true], ['src/?/x', 'src/😀/x', true],
  ['src/?/x', 'src/ab/x', false], ['**/*.txt', 'a.txt', true],
  ['**/*.txt', 'a/b/c.txt', true], ['src/**/x', 'src/x', true],
  ['src/**/x', 'src/a/b/x', true], ['src/**', 'src/a/b', true],
  ['notes/', 'a/notes/file', true], ['src/data/', 'src/data/nested/file', true],
  ['src/data', 'other/src/data/file', false], ['a+b.txt', 'a+b.txt', true],
  ['a(b).txt', 'axb.txt', false], ['*.txt', 'file.txt\n', false],
  ['**', 'nested/new\nline', true], ['**/*.txt', 'nested/new\nline.txt', true]
];
test('limited globs have identical slash, globstar, literal and unicode semantics in TS/Python', () => {
  const expected = cases.map(([, , match]) => match);
  assert.deepEqual(cases.map(([pattern, path]) => excluded(path, { ...policy, excludes: [pattern] })), expected);
  assert.deepEqual(python("print(json.dumps([ns['excluded'](path, dict(data['policy'], excludes=[pattern])) for pattern,path,_ in data['cases']]))", { policy, cases }), expected);
});

test('config and worker reject unsupported patterns, preserving safe existing patterns', async t => {
  const invalid = ['', '[ab]', '{a,b}', '!secret', 'a\\b', 'a\0b', 'a\nb', '../x', '/root', 'a//b', './a', 'a/**b', '***', 'a/***/b', '@(a|b)', '?(a)', '*(a)', '+(a)'];
  const valid = ['*.mp4', 'data', '*.local-notes', '.env.*', '*', '?', '**', '**/*.txt', 'src/**/x', 'data/', 'src/data/', 'a+b(c).txt'];
  for (const pattern of invalid) {
    assert.equal(validSyncPattern(pattern), false, pattern);
    const config = structuredClone(DEFAULT_CONFIG); config.sync.excludes = [pattern];
    assert.throws(() => validateConfig(config), error => error.code === 'CONFIG');
  }
  for (const pattern of valid) {
    assert.equal(validSyncPattern(pattern), true, pattern);
    const config = structuredClone(DEFAULT_CONFIG); config.sync.excludes = [pattern];
    assert.deepEqual(validateConfig(config).sync.excludes, [pattern]);
  }
  assert.deepEqual(python("print(json.dumps([ns['valid_sync_pattern'](p) for p in data]))", [...invalid, ...valid]), [...invalid.map(() => false), ...valid.map(() => true)]);
  const root = await fixture(t), bad = { ...policy, excludes: ['!secret'] };
  assert.equal((await syncPreview(root, bad)).errors[0].code, 'CONFIG');
  await assert.rejects(scanLocal(root, bad), error => error.code === 'CONFIG');
  assert.equal(python("try:\n ns['scan'](data['root'], data['policy'])\nexcept ValueError as e:\n print(json.dumps(str(e)))", { root, policy: bad }), 'UNSUPPORTED_SYNC_PATTERN');
});

test('preview is stable, metadata-only and cannot write, hash or read baseline/secrets', async t => {
  const root = await fixture(t);
  for (const path of ['z.txt', 'a/source.txt', 'api-token.txt', '.env', 'nested/private.KEY', 'nested/credentials.json', '.reroute/sync-base.json', '.outboard/state.json', '.ssh/id_rsa', 'node_modules/secret.txt', 'notes/private.txt']) await put(root, path);
  const p = { ...policy, excludes: ['notes/'] };
  const original = new Map();
  for (const name of ['readFile', 'writeFile', 'mkdir', 'rename', 'unlink', 'rm', 'rmdir', 'chmod', 'open', 'copyFile']) {
    original.set(name, fs[name]);
    fs[name] = async () => assert.fail(`preview must not call fs.${name}`);
  }
  const hash = crypto.createHash;
  crypto.createHash = () => assert.fail('preview must not hash'); syncBuiltinESMExports();
  let result;
  try {
    result = await syncPreview(root, p);
    assert.equal(JSON.stringify(await syncPreview(root, p)), JSON.stringify(result));
  } finally {
    for (const [name, fn] of original) fs[name] = fn;
    crypto.createHash = hash; syncBuiltinESMExports();
  }
  assert.deepEqual(result.included, ['a/source.txt', 'api-token.txt', 'z.txt'].map(path => ({ path, reason: 'included', bytes: 3 })));
  assert.equal(result.files.count, 3); assert.equal(result.files.bytes, 9);
  assert.deepEqual(result.files.limits, { maxFiles: 100, maxFileBytes: 100 });
  assert.deepEqual(result.readiness, { scope: 'local-only', ready: true, remote: 'not-checked' });
  assert.equal(result.scope, 'local-only'); assert.equal('conflicts' in result, false);
  assert.deepEqual(result.errors, []);
  assert.ok(result.excluded.some(row => row.path === '.env' && row.reason === 'minimum-security'));
  assert.ok(result.excluded.some(row => row.path === '.reroute' && row.reason === 'minimum-exclusion'));
  assert.ok(result.excluded.some(row => row.path === 'notes' && row.reason === 'policy-exclusion' && row.pattern === 'notes/'));
  assert.ok(result.sensitiveNameRisks.some(row => row.path === 'api-token.txt' && !row.excluded));
  assert.ok(result.sensitiveNameRisks.some(row => row.path === '.env' && row.excluded));
  assert.equal(await fs.readFile(join(root, '.reroute/sync-base.json'), 'utf8'), 'abc');
  assert.deepEqual((await fs.readdir(root)).sort(), ['.env', '.outboard', '.reroute', '.ssh', 'a', 'api-token.txt', 'nested', 'node_modules', 'notes', 'z.txt']);
});

test('preview and both scanners share exclusions and never read/hash excluded contents', async t => {
  const root = await fixture(t);
  const secrets = ['.env', '.env.production', '.npmrc', 'nested/credentials.json', 'nested/private.pem', 'nested/id_ed25519', '.aws/credentials', '.reroute/sync-base.json', '.outboard/state', 'node_modules/cache'];
  for (const path of [...secrets, 'src/a.txt', 'src/nested/a.txt', 'notes/file', 'keep']) await put(root, path);
  const p = { ...policy, excludes: ['src/*.txt', 'notes/'] }, allowed = ['keep', 'src/nested/a.txt'];
  const read = fs.readFile, reads = [];
  fs.readFile = async (path, ...args) => {
    const rel = String(path).slice(root.length + 1); reads.push(rel);
    assert.ok(allowed.includes(rel), `must not read excluded ${rel}`);
    return read(path, ...args);
  };
  try {
    assert.deepEqual(Object.keys(await scanLocal(root, p)), allowed);
    assert.deepEqual((await syncPreview(root, p)).included.map(row => row.path), allowed);
  } finally { fs.readFile = read; }
  assert.deepEqual(reads, allowed);
  const remote = python("old=ns['digest']\ndef guarded(path,*args,**kwargs):\n rel=ns['os'].path.relpath(path,data['root']).replace(ns['os'].sep,'/')\n assert rel in data['allowed'],rel\n return old(path,*args,**kwargs)\nns['digest']=guarded\nprint(json.dumps(sorted(ns['scan'](data['root'],data['policy']))))", { root, policy: p, allowed });
  assert.deepEqual(remote, allowed);
  for (const path of secrets) assert.equal(excluded(path, policy), true, `minimum exclusion: ${path}`);
});

test('limits, symlinks, unsupported types and unreadable paths are actionable, not crashes', async t => {
  const root = await fixture(t), outside = await fixture(t);
  await put(root, 'a', '12345'); await put(root, 'b', '12'); await put(outside, 'hidden', 'never inspect');
  await fs.symlink(outside, join(root, 'link')); await fs.symlink('/missing', join(root, 'dangling'));
  await fs.symlink(outside, join(root, '.env'));
  assert.equal(spawnSync('mkfifo', [join(root, 'pipe')]).status, 0);
  await fs.mkdir(join(root, 'unreadable')); await put(root, 'unreadable/nope');
  const readdir = fs.readdir, access = fs.access;
  fs.readdir = async (path, ...args) => {
    assert.notEqual(String(path), outside, 'must not follow directory links');
    if (String(path) === join(root, 'unreadable')) throw Object.assign(new Error('private error'), { code: 'EACCES' });
    return readdir(path, ...args);
  };
  fs.access = async (path, ...args) => {
    if (String(path) === join(root, 'b')) throw Object.assign(new Error('private error'), { code: 'EACCES' });
    return access(path, ...args);
  };
  let result;
  try { result = await syncPreview(root, { ...policy, maxFiles: 1, maxFileBytes: 4 }); }
  finally { fs.readdir = readdir; fs.access = access; }
  assert.equal(result.files.count, 2); assert.equal(result.files.bytes, 7);
  assert.equal(result.files.overFileCount, true); assert.deepEqual(result.files.oversized, ['a']);
  assert.deepEqual(result.symlinks, ['.env', 'dangling', 'link']);
  assert.deepEqual(result.unsupportedTypes, [{ path: 'pipe', type: 'fifo' }]);
  assert.deepEqual(result.errors.map(row => [row.path, row.code]), [['.', 'TOO_MANY_FILES'], ['a', 'FILE_TOO_LARGE'], ['b', 'EACCES'], ['dangling', 'SYMLINK'], ['link', 'SYMLINK'], ['pipe', 'SOURCE_TYPE'], ['unreadable', 'EACCES']]);
  assert.ok(result.errors.every(row => row.message && !row.message.includes('private error')));
  assert.equal(result.readiness.ready, false);
  assert.equal(result.included.some(row => row.path.includes('hidden')), false);
  assert.equal(result.errors.some(row => row.path === '.env'), false, 'minimum exclusion still wins for links');
});

test('missing, non-directory and symlink roots return local readiness errors without traversal', async t => {
  const root = await fixture(t);
  await put(root, 'file'); await put(root, 'subdir/hidden'); await fs.symlink(root, join(root, 'link'));
  for (const [path, code] of [['missing', 'ENOENT'], ['file', 'SOURCE_TYPE'], ['link', 'SYMLINK'], ['link/subdir', 'SYMLINK']]) {
    const result = await syncPreview(join(root, path), policy);
    assert.equal(result.readiness.ready, false); assert.equal(result.errors[0].code, code);
    assert.deepEqual(result.included, []);
  }
});
