import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Coordinator } from '../../dist/core/coordinator.js';
import { fixture, FixtureProvider } from '../helpers.mjs';
import { DEFAULT_CONFIG, validateConfig } from '../../dist/config/config.js';

async function context(t) {
  const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
  const oldHome = process.env.REROUTE_HOME;
  process.env.REROUTE_HOME = join(f.directory, 'home');
  const provider = new FixtureProvider(f.remote), core = new Coordinator(() => provider);
  const generation = randomUUID();
  let restores = 0;
  const ensure = provider.ensureReady.bind(provider);
  provider.ensureReady = async (...args) => {
    const runtime = await ensure(...args);
    runtime.meta.workspaceGeneration = generation;
    return runtime;
  };
  provider.restore = async (project, _spec, runtime) => {
    restores++;
    assert.equal(project.id, runtime.projectId);
    assert.equal(runtime.provider, provider.id);
    assert.equal(runtime.meta.workspaceGeneration, generation);
    provider.state = 'running';
    return structuredClone(runtime);
  };
  t.after(async () => {
    try { await core.shutdown(); }
    finally {
      if (oldHome === undefined) delete process.env.REROUTE_HOME; else process.env.REROUTE_HOME = oldHome;
      for (const fn of cleanup.reverse()) await fn();
    }
  });
  await core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture' } } });
  await fs.writeFile(join(f.local, 'source.txt'), 'baseline');
  await core.synchronize(f.local);
  const state = await core.start(f.local), baseline = await fs.readFile(join(f.local, '.reroute/sync-base.json'));
  const pending = async (status = 'stopped') => {
    state.syncPending = true;
    await core.store.save(state);
    provider.state = status;
  };
  const saved = async () => JSON.parse(await fs.readFile(join(f.local, '.reroute/project.json')));
  return { ...f, provider, core, state, baseline, pending, saved, restores: () => restores };
}

for (const status of ['stopped', 'archived']) {
  test(`original ${status} runtime resumes and pending source returns without recreation`, async t => {
    const f = await context(t), original = structuredClone(f.state.runtime), creates = f.provider.readyCount;
    await fs.writeFile(join(f.remote, 'generated.lock'), 'valuable');
    await f.pending(status);
    await f.core.synchronize(f.local);
    assert.equal(f.restores(), 1);
    assert.equal(f.provider.readyCount, creates);
    assert.deepEqual(f.state.runtime, original);
    assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'valuable');
    assert.equal((await f.saved()).syncPending, false);
  });
}

test('ordinary stopped-runtime start uses restoration of the same workspace after daemon recovery', async t => {
  const f = await context(t), id = f.state.runtime.id, creates = f.provider.readyCount;
  f.provider.state = 'stopped';
  const cold = new Coordinator(() => f.provider);
  t.after(() => cold.shutdown());
  await cold.start(f.local);
  assert.equal(f.restores(), 1);
  assert.equal(f.provider.readyCount, creates);
  assert.equal((await cold.status(f.local)).runtime, id);
});

for (const field of ['id', 'root', 'provider', 'projectId', 'workspaceGeneration']) {
  test(`restoration rejects changed ${field}, retaining pending marker and baseline`, async t => {
    const f = await context(t), original = structuredClone(f.state.runtime);
    await f.pending();
    f.provider.restore = async (_project, _spec, runtime) => {
      f.provider.state = 'running';
      if (field === 'workspaceGeneration') runtime.meta.workspaceGeneration = randomUUID();
      else runtime[field] = field === 'provider' ? 'daytona' : 'wrong';
      return runtime;
    };
    await assert.rejects(f.core.synchronize(f.local), e => e.code === 'WRONG_RUNTIME');
    assert.deepEqual(f.state.runtime, original, 'provider mutation must not mutate the stored reference');
    assert.equal((await f.saved()).syncPending, true);
    assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
  });
}

for (const status of ['missing', 'unknown']) {
  test(`pending ${status} runtime fails closed without restore or ensureReady`, async t => {
    const f = await context(t), creates = f.provider.readyCount;
    await f.pending(status);
    await assert.rejects(f.core.synchronize(f.local), e => e.code === (status === 'unknown' ? 'RUNTIME_UNKNOWN' : 'SOURCE_PENDING'));
    assert.equal(f.restores(), 0); assert.equal(f.provider.readyCount, creates);
    assert.equal((await f.saved()).syncPending, true);
    assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
  });
}

test('failed restoration gives actionable error and may safely retry the original runtime', async t => {
  const f = await context(t), restore = f.provider.restore, creates = f.provider.readyCount;
  await fs.writeFile(join(f.remote, 'generated.lock'), 'retained');
  await f.pending();
  f.provider.restore = async () => { throw new Error('network credentials must not leak'); };
  await assert.rejects(f.core.synchronize(f.local), e => e.code === 'RUNTIME_RESTORE' && e.message.includes('retry reroute sync') && !e.message.includes('credentials must not leak'));
  assert.equal((await f.saved()).syncPending, true);
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
  f.provider.restore = restore;
  await f.core.synchronize(f.local);
  assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'retained');
  assert.equal(f.provider.readyCount, creates);
  assert.equal((await f.saved()).syncPending, false);
});

test('restored source conflicts remain recoverable with evidence and explicit local choice', async t => {
  const f = await context(t);
  await fs.writeFile(join(f.local, 'source.txt'), 'local edit');
  await fs.writeFile(join(f.remote, 'source.txt'), 'remote edit');
  await f.pending('archived');
  for (let i = 0; i < 2; i++) await assert.rejects(f.core.synchronize(f.local), e => e.code === 'SYNC_CONFLICT' && e.exitCode === 73);
  assert.equal(f.restores(), 1);
  assert.equal((await f.saved()).syncPending, true);
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
  const conflicts = await fs.readdir(join(f.local, '.reroute/conflicts'));
  assert.equal(await fs.readFile(join(f.local, '.reroute/conflicts', conflicts[0], 'remote/source.txt'), 'utf8'), 'remote edit');
  await f.core.synchronize(f.local, true);
  assert.equal(await fs.readFile(join(f.remote, 'source.txt'), 'utf8'), 'local edit');
  assert.equal((await f.saved()).syncPending, false);
});

test('return-sync failure after resume retains pending state and retries without recreating', async t => {
  const f = await context(t), files = f.provider.files.bind(f.provider), creates = f.provider.readyCount;
  await fs.writeFile(join(f.remote, 'generated.lock'), 'retained');
  await f.pending();
  f.provider.files = runtime => ({ ...files(runtime), scan: async () => { throw new Error('network failure'); } });
  await assert.rejects(f.core.synchronize(f.local));
  assert.equal((await f.saved()).syncPending, true);
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
  f.provider.files = files;
  await f.core.synchronize(f.local);
  assert.equal(f.restores(), 1); assert.equal(f.provider.readyCount, creates);
  assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'retained');
  assert.equal((await f.saved()).syncPending, false);
});

test('shutdown during resume prevents new work and retains unreconciled source', async t => {
  const f = await context(t), restore = f.provider.restore, files = f.provider.files.bind(f.provider);
  await fs.writeFile(join(f.remote, 'generated.lock'), 'retained');
  await f.pending();
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const delay = new Promise(resolve => { finish = resolve; });
  f.provider.restore = async (...args) => { entered(); await delay; return restore(...args); };
  f.provider.files = runtime => ({ ...files(runtime), scan: async () => { throw new Error('return sync unavailable'); } });
  const rejected = assert.rejects(f.core.synchronize(f.local), e => e.code === 'CANCELLED');
  await started;
  const closing = f.core.shutdown();
  finish();
  await rejected; await closing;
  assert.equal((await f.saved()).syncPending, true);
  assert.equal(await fs.readFile(join(f.remote, 'generated.lock'), 'utf8'), 'retained');
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
});

test('background recovery reports stopped pending source without implicitly resuming compute', async t => {
  const f = await context(t);
  await f.pending('archived');
  await f.core.shutdown();
  const cold = new Coordinator(() => f.provider);
  try {
    await cold.recover();
    assert.equal(f.restores(), 0);
    assert.match((await cold.status(f.local)).warning, /reroute sync/);
    await cold.synchronize(f.local);
    assert.equal(f.restores(), 1);
    assert.equal((await f.saved()).syncPending, false);
  } finally { await cold.shutdown(); }
});

test('a provider without restore still requires explicit native resume for pending source', async t => {
  const f = await context(t);
  delete f.provider.restore;
  await f.pending();
  const creates = f.provider.readyCount;
  await assert.rejects(f.core.synchronize(f.local), e => e.code === 'SOURCE_PENDING' && e.message.includes('native tools'));
  assert.equal(f.provider.readyCount, creates);
  assert.equal((await f.saved()).syncPending, true);
});

test('project state rejects mismatched runtime ownership before any provider call', async t => {
  const f = await context(t), saved = await f.saved(), creates = f.provider.readyCount;
  saved.runtime.projectId = randomUUID();
  await fs.writeFile(join(f.local, '.reroute/project.json'), JSON.stringify(saved));
  await assert.rejects(f.core.synchronize(f.local), e => e.code === 'PROJECT_STATE');
  assert.equal(f.restores(), 0); assert.equal(f.provider.readyCount, creates);
});

test('Daytona source workspaces reject destructive auto-delete policy at the config boundary', () => {
  for (const value of [0, 1, 120, -2]) {
    const config = structuredClone(DEFAULT_CONFIG);
    config.providers.daytona = { autoDeleteMinutes: value };
    assert.throws(() => validateConfig(config), e => e.code === 'CONFIG' && e.message.includes('pending source'));
  }
  const config = structuredClone(DEFAULT_CONFIG);
  config.providers.daytona = { autoDeleteMinutes: -1 };
  assert.equal(validateConfig(config).providers.daytona.autoDeleteMinutes, -1);
});

test('explicit destroy resumes and reconciles stopped pending source before deletion', async t => {
  const f = await context(t);
  await fs.writeFile(join(f.remote, 'generated.lock'), 'valuable');
  await f.pending();
  await f.core.stop(f.local, true);
  assert.equal(f.restores(), 1);
  assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'valuable');
  assert.equal((await f.saved()).runtime, undefined);
  assert.equal((await f.saved()).syncPending, false);
  assert.equal(f.provider.state, 'missing');
});

test('failed identity verification is not bypassed when a provider leaves the runtime running', async t => {
  const f = await context(t), original = structuredClone(f.state.runtime);
  await f.pending();
  let attempts = 0;
  f.provider.restore = async (_p, _s, runtime) => {
    attempts++; f.provider.state = 'running';
    runtime.meta.workspaceGeneration = randomUUID();
    return runtime;
  };
  for (let i = 0; i < 2; i++) await assert.rejects(f.core.synchronize(f.local), e => e.code === 'WRONG_RUNTIME');
  assert.equal(attempts, 2);
  assert.deepEqual(f.state.runtime, original);
  assert.equal((await f.saved()).syncPending, true);
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute/sync-base.json')), f.baseline);
});

test('a failed pending-source renewal invalidates warmth so the next retry re-verifies and renews', async t => {
  const f = await context(t), files = f.provider.files.bind(f.provider), apply = f.provider.applyIdlePolicy.bind(f.provider);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await fs.writeFile(join(f.remote, 'generated.txt'), 'recover after renewal failure');
  f.provider.files = () => ({ ...files(f.state.runtime), scan: async () => { throw new Error('offline return-sync'); } });
  await assert.rejects(f.core.synchronize(f.local), /offline return-sync/);
  assert.equal((await f.saved()).syncPending, true);
  f.provider.applyIdlePolicy = async () => { throw new Error('offline renewal'); };
  t.mock.timers.tick(60000);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  f.provider.applyIdlePolicy = apply; f.provider.files = files;
  await f.core.synchronize(f.local);
  assert.equal(f.restores(), 1);
  assert.equal((await f.saved()).syncPending, false);
  assert.equal(await fs.readFile(join(f.local, 'generated.txt'), 'utf8'), 'recover after renewal failure');
});
