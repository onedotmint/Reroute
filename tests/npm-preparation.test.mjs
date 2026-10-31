import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, authorizeProject } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
import { processExec } from '../dist/util.js';

// COMPONENT ONLY: real supervisor/processes and an injected local Provider, never SSH or cloud.
async function fixture(t, { stub = '11.21.1', probeCode = 0, hang = false, locks = 'shrink', nested = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'reroute-npm-preparation-'));
  const root = join(base, 'project'), bin = join(base, 'bin'), home = join(base, 'home');
  for (const path of [root, bin, home]) await mkdir(path);
  const overrides = {
    HOME: home, XDG_CONFIG_HOME: join(base, 'config'), REROUTE_STATE_DIR: join(base, 'state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(base, 'gitconfig'),
  };
  await writeFile(overrides.GIT_CONFIG_GLOBAL, '');
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(base, { recursive: true, force: true });
  });
  const userConfig = join(base, 'user.npmrc'), globalConfig = join(base, 'global.npmrc');
  await writeFile(userConfig, ''); await writeFile(globalConfig, '');
  const env = {
    PATH: bin + ':' + process.env.PATH, HOME: home, ...overrides,
    NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_PROBE_LOG: join(base, 'npm-calls'), NPM_PROBE_PID: join(base, 'probe-pid'),
  };
  if (stub !== null) {
    await writeFile(join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.NPM_PROBE_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
if (argv[0] === '--version') {
  if (${hang}) {
    fs.writeFileSync(process.env.NPM_PROBE_PID, String(process.pid));
    console.error('NPM_PROBE_WAITING');
    setInterval(() => {}, 1000);
  } else {
    console.log(${JSON.stringify(stub)});
    process.exit(${probeCode});
  }
} else {
  fs.writeFileSync('CI_EXECUTED', 'yes');
}
`, { mode: 0o755 });
  }
  const pkg = { name: 'npm-preparation-fixture', version: '1.0.0', private: true, packageManager: 'npm@11.21.1' };
  const lock = JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } });
  const files = { 'package.json': JSON.stringify(pkg) };
  if (locks !== 'package') files['npm-shrinkwrap.json'] = lock;
  if (locks !== 'shrink') files['package-lock.json'] = lock;
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  const cwd = nested ? join(root, 'app') : root;
  if (nested) await mkdir(cwd);
  await writeFile(join(cwd, 'probe.cjs'), "require('node:fs').writeFileSync('EXECUTED', process.env.REROUTE_JOB_ID);\n");
  const config = { ...defaults(), active: 'fixture', profiles: { fixture: { provider: 'ssh', id: 'fixture', root: join(base, 'remote') } } };
  await authorizeProject(root, config);
  const provider = {
    profile: config.profiles.fixture, stdin: true, status: async () => 'running',
    exec: (command, options) => processExec('bash', ['-c', command], { ...options, env }),
    put: copyFile, get: copyFile, lifecycle: async () => assert.fail('local fixture only'),
  };
  return {
    root, cwd, env, files, nested,
    run: (options = {}) => runRemote('node probe.cjs', { root, cwd, config, provider, timeoutMs: 10000, ...options }),
    calls: async () => (await readFile(env.NPM_PROBE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

const absent = path => assert.rejects(readFile(path), { code: 'ENOENT' });
async function assertWork(f, result, ran) {
  const work = join(result.job.root, 'jobs', result.job.id, 'work');
  if (ran) assert.equal(await readFile(join(work, f.nested ? 'app' : '.', 'EXECUTED'), 'utf8'), result.job.id);
  else await absent(join(work, f.nested ? 'app' : '.', 'EXECUTED'));
  await absent(join(f.cwd, 'EXECUTED')); await absent(join(f.root, 'CI_EXECUTED'));
  for (const [name, content] of Object.entries(f.files)) {
    assert.equal(await readFile(join(f.root, name), 'utf8'), content, `local ${name}`);
    assert.equal(await readFile(join(work, name), 'utf8'), content, `task ${name}`);
  }
  return work;
}
const ci = ['ci', '--no-audit', '--no-fund'];

test('npm <=11 keeps shrinkwrap preparation, including dual locks discovered from a child directory', async t => {
  for (const stub of ['10.9.9', '11.21.1', '11.22.0-beta.1']) {
    for (const locks of ['shrink', 'both']) await t.test(`${stub}: ${locks}`, async t => {
      const f = await fixture(t, { stub, locks, nested: true }), result = await f.run();
      assert.equal(result.code, 0, result.stderr);
      const work = await assertWork(f, result, true), calls = await f.calls();
      assert.deepEqual(calls.map(call => call.argv), [['--version'], ci]);
      assert.ok(calls.every(call => call.cwd === join(result.job.root, 'work')));
      assert.equal(await readFile(join(work, 'CI_EXECUTED'), 'utf8'), 'yes');
    });
  }
});

test('unsupported, unparseable and failed npm probes refuse both layouts before ci or the main command', async t => {
  for (const [stub, probeCode] of [['12.0.0', 0], ['12.1.0-rc.1', 0], ['13.0.0', 0], ['11', 0], ['11.0.0\n12.0.0', 0], ['', 0], ['11.21.1', 9]]) {
    for (const locks of ['shrink', 'both']) await t.test(`${JSON.stringify(stub)} exit ${probeCode}: ${locks}`, async t => {
      const f = await fixture(t, { stub, probeCode, locks, nested: true }), result = await f.run();
      assert.equal(result.code, 1); assert.equal(result.job.status, 'exited');
      assert.match(result.stderr, /requires a verified npm <=11/);
      assert.match(result.stderr, /even beside package-lock.json/);
      const work = await assertWork(f, result, false);
      await absent(join(work, 'CI_EXECUTED'));
      assert.deepEqual((await f.calls()).map(call => call.argv), [['--version']]);
    });
  }
});

test('package-lock-only preparation does not probe or restrict npm 12', async t => {
  const f = await fixture(t, { stub: '12.0.0', locks: 'package' }), result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  const work = await assertWork(f, result, true);
  await absent(join(work, 'npm-shrinkwrap.json'));
  assert.deepEqual((await f.calls()).map(call => call.argv), [ci]);
});

test('a hung npm version probe is supervised, timed out or cancelled, and reaped before receipt publication', async t => {
  for (const cancel of [false, true]) await t.test(cancel ? 'cancel' : 'timeout', async t => {
    const f = await fixture(t, { hang: true, locks: 'both' }), controller = new AbortController();
    const result = await f.run({
      timeoutMs: cancel ? 10000 : 1000, signal: controller.signal,
      stderr: chunk => { if (cancel && chunk.toString().includes('NPM_PROBE_WAITING')) controller.abort(); },
    });
    assert.equal(result.code, cancel ? 130 : 124);
    assert.equal(result.job.status, cancel ? 'cancelled' : 'timed_out');
    const work = await assertWork(f, result, false);
    await absent(join(work, 'CI_EXECUTED'));
    const pid = Number(await readFile(f.env.NPM_PROBE_PID, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.deepEqual((await f.calls()).map(call => call.argv), [['--version']]);
  });
});

test('current real npm prepares dependency-free fixtures offline without changing source or choosing a fallback lock', async t => {
  for (const locks of ['shrink', 'both', 'package']) await t.test(locks, async t => {
    const f = await fixture(t, { stub: null, locks });
    const version = await processExec('npm', ['--version'], { cwd: f.root, env: f.env, timeoutMs: 5000 });
    assert.equal(version.code, 0, version.stderr);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+(?:[-+][\w.-]+)*$/);
    const major = Number(version.stdout.trim().split('.')[0]);
    const supported = locks === 'package' || major < 12;
    if (locks === 'both') {
      // An invalid alternate lock detects accidental fallback without fetching dependencies.
      const alternate = major < 12 ? 'package-lock.json' : 'npm-shrinkwrap.json';
      f.files[alternate] = '{ invalid alternate lock';
      await writeFile(join(f.root, alternate), f.files[alternate]);
    }
    t.diagnostic(`real npm ${version.stdout.trim()}, ${locks}`);
    const result = await f.run();
    assert.equal(result.code, supported ? 0 : 1, result.stderr);
    if (!supported) assert.match(result.stderr, /requires a verified npm <=11/);
    const work = await assertWork(f, result, supported);
    if (locks === 'shrink') {
      await absent(join(f.root, 'package-lock.json'));
      await absent(join(work, 'package-lock.json'));
    }
  });
});
