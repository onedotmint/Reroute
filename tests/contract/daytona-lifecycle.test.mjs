import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { DaytonaProvider } from '../../dist/providers/daytona.js';
import { Lifecycle } from '../../dist/core/lifecycle.js';
import { fixture, launch } from '../helpers.mjs';

const spec = { idleTimeoutMinutes: 1, env: {} };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function boundary(t) {
  const f = await fixture(t), calls = { create: 0, start: 0, stop: 0, delete: 0, initialize: 0, refresh: 0, autoStop: [], autoDelete: [] };
  let nativeTimer, refreshError, exists = false;
  const sandbox = { id: 'original-sandbox', labels: { 'reroute.project': f.project.id }, sandboxClass: 'container', gpu: 0, spot: false, autoDeleteInterval: 120, state: 'started',
    async setAutoDeleteInterval(value) { calls.autoDelete.push(value); this.autoDeleteInterval = value; },
    async setAutostopInterval(value) { calls.autoStop.push(value); this.autoStopInterval = value; resetTimer(); },
    async refreshActivity() { calls.refresh++; if (refreshError) throw refreshError; resetTimer(); },
    async start(timeout) { assert.equal(timeout, 60); calls.start++; this.state = 'started'; resetTimer(); },
    async stop(timeout) { assert.equal(timeout, 60); calls.stop++; this.state = 'stopped'; clearTimeout(nativeTimer); },
  };
  function resetTimer() {
    clearTimeout(nativeTimer);
    if (sandbox.state === 'started' && sandbox.autoStopInterval > 0) {
      nativeTimer = setTimeout(() => { sandbox.state = 'stopped'; }, sandbox.autoStopInterval * 60000);
      nativeTimer.unref();
    }
  }
  class Daytona {
    async get(id) { assert.ok(id === sandbox.id || id === 'reroute-' + f.project.id); if (!exists) throw new DaytonaNotFoundError('missing', 404); return sandbox; }
    async create(params) { calls.create++; exists = true; await sandbox.setAutoDeleteInterval(params.autoDeleteInterval); await sandbox.setAutostopInterval(params.autoStopInterval); return sandbox; }
    async delete() { calls.delete++; }
  }
  class Provider extends DaytonaProvider {
    async launch(runtime, argv) { return launch(runtime, argv); }
    async initialize(runtime) { calls.initialize++; return super.initialize({ ...runtime, root: f.remote }); }
  }
  class DaytonaNotFoundError extends Error { constructor(message, statusCode) { super(message); this.statusCode = statusCode; } }
  const provider = new Provider({}, async () => ({ Daytona, DaytonaNotFoundError }));
  t.after(() => clearTimeout(nativeTimer));
  const runtime = await provider.ensureReady(f.project, spec);
  assert.equal(calls.create, 1); calls.create = 0; // Subsequent checks assert that recovery never creates another sandbox.
  return { ...f, calls, provider, sandbox, runtime, setRefreshError(error) { refreshError = error; } };
}

test('long active leases refresh real activity, crash leaves finite native stop and original source can restore', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await boundary(t), errors = [];
  await fs.writeFile(join(f.remote, 'pending.txt'), 'unsynchronized source');
  const lifecycle = new Lifecycle(f.provider, f.runtime, 1, () => {}, error => errors.push(error));
  t.after(() => lifecycle.dispose());
  await lifecycle.acquire(); // Keep the pending-source lease unreleased, as on a daemon crash.
  for (let minute = 0; minute < 480; minute++) { t.mock.timers.tick(60000); await flush(); }
  assert.equal(f.sandbox.state, 'started'); assert.equal(f.calls.refresh, 481);
  assert.ok(f.calls.autoStop.every(value => value >= 5)); assert.ok(f.calls.autoDelete.every(value => value === -1));
  lifecycle.dispose(); const refreshes = f.calls.refresh;
  t.mock.timers.tick(5 * 60000); await flush();
  assert.equal(f.calls.refresh, refreshes); assert.equal(f.sandbox.state, 'stopped');
  assert.equal(await f.provider.status(f.runtime), 'stopped');
  const restored = await f.provider.restore(f.project, spec, f.runtime);
  assert.strictEqual(restored, f.runtime); assert.equal(restored.meta.workspaceGeneration, f.runtime.meta.workspaceGeneration);
  assert.equal(await fs.readFile(join(f.remote, 'pending.txt'), 'utf8'), 'unsynchronized source');
  assert.equal(f.calls.start, 1); assert.equal(f.calls.create, 0); assert.equal(f.calls.initialize, 1); assert.deepEqual(errors, []);
});

test('activity refresh failure is propagated and cannot indefinitely extend the native timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await boundary(t), failure = new Error('refresh network failure'), errors = [];
  const lifecycle = new Lifecycle(f.provider, f.runtime, 1, () => {}, error => errors.push(error));
  t.after(() => lifecycle.dispose());
  await lifecycle.acquire(); f.setRefreshError(failure);
  t.mock.timers.tick(60000); await flush();
  assert.deepEqual(errors, [failure]); assert.equal(lifecycle.active, 1);
  t.mock.timers.tick(5 * 60000); await flush();
  assert.equal(f.sandbox.state, 'stopped'); assert.equal(f.calls.refresh, 2);
});

for (const state of ['stopped', 'archived', 'started']) test(`restore verifies the original ${state} workspace without initialize`, async t => {
  const f = await boundary(t); f.sandbox.state = state;
  assert.equal(await f.provider.status(f.runtime), state === 'started' ? 'running' : state);
  assert.strictEqual(await f.provider.restore(f.project, spec, f.runtime), f.runtime);
  assert.equal(f.calls.initialize, 1); assert.equal(f.calls.create, 0); assert.equal(f.calls.start, state === 'started' ? 0 : 1);
});

for (const damage of ['missing-root', 'missing-marker', 'missing-generation', 'changed-project', 'changed-generation', 'symlink-root', 'symlink-marker']) test(`restore fails closed on ${damage}, without repairing disk identity`, async t => {
  const f = await boundary(t), marker = join(f.remote, '.reroute-runtime', 'owner.json');
  const before = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (damage === 'missing-root') await fs.rm(f.remote, { recursive: true });
  if (damage === 'missing-marker') await fs.unlink(marker);
  if (damage === 'missing-generation') { delete before.generation; await fs.writeFile(marker, JSON.stringify(before)); }
  if (damage === 'changed-project') { before.projectId = 'other-project'; await fs.writeFile(marker, JSON.stringify(before)); }
  if (damage === 'changed-generation') { before.generation = '22222222-2222-4222-8222-222222222222'; await fs.writeFile(marker, JSON.stringify(before)); }
  if (damage === 'symlink-root') { await fs.rename(f.remote, f.remote + '-original'); await fs.symlink(f.remote + '-original', f.remote); }
  if (damage === 'symlink-marker') { await fs.rename(marker, marker + '-original'); await fs.symlink(marker + '-original', marker); }
  f.sandbox.state = 'stopped';
  await assert.rejects(f.provider.restore(f.project, spec, f.runtime), e => e.code === 'WORKSPACE_IDENTITY');
  assert.equal(f.calls.initialize, 1); assert.equal(f.calls.create, 0); assert.equal(f.calls.delete, 0);
  if (damage === 'missing-root') await assert.rejects(fs.stat(f.remote), { code: 'ENOENT' });
  if (damage === 'missing-marker') await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  if (damage.startsWith('changed-') || damage === 'missing-generation') assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), before);
});

test('missing recorded generation fails before starting or touching native timers', async t => {
  const f = await boundary(t); f.sandbox.state = 'stopped';
  const previous = f.calls.autoStop.length;
  await assert.rejects(f.provider.restore(f.project, spec, { ...f.runtime, meta: {} }), /generation is missing/);
  assert.equal(f.calls.start, 0); assert.equal(f.calls.autoStop.length, previous);
});

for (const mismatch of ['provider', 'project', 'id', 'label']) test(`runtime ${mismatch} mismatch blocks restore, lifecycle and destruction`, async t => {
  const f = await boundary(t), runtime = { ...f.runtime };
  if (mismatch === 'provider') runtime.provider = 'e2b';
  if (mismatch === 'project') runtime.projectId = 'other-project';
  if (mismatch === 'id') f.sandbox.id = 'other-sandbox';
  if (mismatch === 'label') f.sandbox.labels = { 'reroute.project': 'other-project' };
  const timers = f.calls.autoStop.length;
  await assert.rejects(f.provider.restore(f.project, spec, runtime));
  await assert.rejects(f.provider.applyIdlePolicy(runtime, { active: false, minutes: 0 }));
  await assert.rejects(f.provider.destroy(runtime));
  assert.equal(f.calls.start, 0); assert.equal(f.calls.stop, 0); assert.equal(f.calls.delete, 0); assert.equal(f.calls.autoStop.length, timers);
});

for (const unsafe of [{ gpu: 1 }, { spot: true }, { autoDeleteInterval: 0 }, { sandboxClass: 'linux-vm' }, { sandboxClass: 'windows' }, { sandboxClass: undefined }, { autoDestroyAt: '2099-01-01T00:00:00Z' }]) test(`unsupported existing sandbox is rejected before any lifecycle/destruction side effect: ${JSON.stringify(unsafe)}`, async t => {
  const f = await boundary(t); Object.assign(f.sandbox, unsafe);
  const timers = f.calls.autoStop.length;
  await assert.rejects(f.provider.restore(f.project, spec, f.runtime), e => e.code === 'UNSUPPORTED_CAPABILITY');
  await assert.rejects(f.provider.applyIdlePolicy(f.runtime, { active: false, minutes: 0 }), e => e.code === 'UNSUPPORTED_CAPABILITY');
  await assert.rejects(f.provider.destroy(f.runtime), e => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.equal(f.calls.start, 0); assert.equal(f.calls.stop, 0); assert.equal(f.calls.delete, 0); assert.equal(f.calls.autoStop.length, timers);
});

for (const state of ['unknown', 'error', undefined, 'starting', 'paused']) test(`unsafe ${state} state does not start or renew`, async t => {
  const f = await boundary(t); f.sandbox.state = state;
  assert.equal(await f.provider.status(f.runtime), 'unknown');
  const timers = f.calls.autoStop.length;
  await assert.rejects(f.provider.restore(f.project, spec, f.runtime), /not safely startable/);
  await assert.rejects(f.provider.applyIdlePolicy(f.runtime, { active: true, minutes: 1 }), /unsafe/);
  assert.equal(f.calls.autoStop.length, timers); assert.equal(f.calls.start, 0);
});

for (const resources of [{ gpu: { type: 'H100', count: 1 } }, { spot: true }]) test(`unsupported Daytona request is rejected before loading SDK: ${JSON.stringify(resources)}`, async () => {
  const provider = new DaytonaProvider({}, async () => { throw new Error('SDK must not load'); });
  await assert.rejects(provider.ensureReady({ id: 'p' }, { ...spec, ...resources }), /GPU\/Spot/);
});
for (const autoDeleteMinutes of [0, 1, 120, -2]) test(`autoDeleteMinutes=${autoDeleteMinutes} is fail-closed`, async () => {
  const provider = new DaytonaProvider({ autoDeleteMinutes }, async () => { throw new Error('SDK must not load'); });
  await assert.rejects(provider.ensureReady({ id: 'p' }, spec), /must be -1/);
});

test('a pre-existing named sandbox without recorded generation cannot be reinitialized or adopted', async t => {
  const f = await boundary(t), timers = f.calls.autoStop.length;
  await fs.unlink(join(f.remote, '.reroute-runtime/owner.json'));
  await assert.rejects(f.provider.ensureReady(f.project, spec), e => e.code === 'WORKSPACE_IDENTITY' && e.message.includes('Recover its original project state'));
  assert.equal(f.calls.initialize, 1); assert.equal(f.calls.create, 0); assert.equal(f.calls.start, 0);
  assert.equal(f.calls.autoStop.length, timers);
  await assert.rejects(fs.stat(join(f.remote, '.reroute-runtime/owner.json')), { code: 'ENOENT' });
});
