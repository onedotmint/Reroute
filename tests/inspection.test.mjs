import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getEventListeners } from 'node:events';
import { inspectJob } from '../dist/engine.js';
import { getJob, jobPath, saveJob } from '../dist/config.js';

// COMPONENT ONLY: injected providers do not establish SSH/cloud live coverage.
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'reroute-inspection-'));
  const project = join(base, 'project'), other = join(base, 'other');
  await mkdir(project); await mkdir(other);
  const previous = process.env.REROUTE_STATE_DIR, state = join(base, 'state');
  process.env.REROUTE_STATE_DIR = state;
  t.after(async () => {
    if (previous === undefined) delete process.env.REROUTE_STATE_DIR;
    else process.env.REROUTE_STATE_DIR = previous;
    await rm(base, { recursive: true, force: true });
  });
  const job = { id: randomUUID(), project, profile: { provider: 'ssh', id: 'fixture' }, root: '/tmp/reroute-fixture',
    command: 'npm test', cwd: '.', createdAt: new Date().toISOString(), status: 'exited', code: 7, error: 'historical diagnostic' };
  await saveJob(job);
  const calls = [];
  const provider = {
    profile: job.profile, stdin: false,
    status: async () => { calls.push('status'); return 'running'; },
    exec: async (command, options) => {
      const match = command.match(/'(status|cancel)' '([A-Za-z0-9+/=]+)'$/);
      assert.ok(match, 'inspection must only issue a status or explicit cancel helper');
      assert.deepEqual(JSON.parse(Buffer.from(match[2], 'base64')), { root: job.root, id: job.id });
      assert.equal(options.timeoutMs, match[1] === 'cancel' ? 15000 : 120000);
      calls.push(match[1] + ' helper');
      return { code: 0, stdout: JSON.stringify({ status: 'exited', code: 0 }), stderr: '' };
    },
    close: async () => { calls.push('close'); },
    put: async () => assert.fail('inspection must not upload'),
    get: async () => assert.fail('inspection must not download'),
    sync: async () => assert.fail('inspection must not sync'),
    lifecycle: async () => assert.fail('inspection must not change lifecycle'),
  };
  return { base, project, other, state, job, provider, calls, inspect: (options = {}, action) => inspectJob(job.id, action, { provider, ...options }) };
}
const response = receipt => ({ code: 0, stdout: JSON.stringify(receipt), stderr: '' });
const turn = () => new Promise(resolve => setImmediate(resolve));

// Bound a regression independently of the signal being tested, and keep timeout signals' timers alive.
async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('inspection hung')), 1000); })]); }
  finally { clearTimeout(timer); }
}

test('inspection checks canonical project ownership and stored ID before touching a provider', async t => {
  const f = await fixture(t), alias = join(f.base, 'alias');
  for (const project of [f.other, join(f.base, 'missing')]) {
    await assert.rejects(f.inspect({ project }), { message: 'Job not found in this project' });
    assert.deepEqual(f.calls, []);
  }
  await assert.rejects(inspectJob(randomUUID(), 'status', { project: f.project, provider: f.provider }), { message: 'Job not found in this project' });
  await writeFile(jobPath(f.job.id), JSON.stringify({ ...f.job, id: randomUUID() }));
  await assert.rejects(f.inspect({ project: f.project }), { message: 'Job not found in this project' });
  await assert.rejects(f.inspect(), { message: 'Job not found in this project' });
  await writeFile(jobPath(f.job.id), JSON.stringify({ ...f.job, project: join(f.base, 'missing') }));
  await assert.rejects(f.inspect({ project: f.project }), { message: 'Job not found in this project' });
  // An invalid profile would fail provider creation if the scope check were skipped.
  await writeFile(jobPath(f.job.id), JSON.stringify({ ...f.job, project: f.other, profile: {} }));
  await assert.rejects(inspectJob(f.job.id, 'status', { project: f.project }), { message: 'Job not found in this project' });
  assert.deepEqual(f.calls, []);
  await saveJob(f.job); await symlink(f.project, alias);
  assert.equal((await f.inspect({ project: alias })).code, 0);
  assert.deepEqual(f.calls, ['status', 'status helper', 'close']);
});

test('default status and explicit cancel use only the existing helpers and close', async t => {
  const f = await fixture(t);
  await f.inspect();
  assert.deepEqual(f.calls, ['status', 'status helper', 'close']);
  f.calls.length = 0;
  await f.inspect({}, 'cancel');
  assert.deepEqual(f.calls, ['status', 'cancel helper', 'close']);
  f.calls.length = 0;
  await assert.rejects(f.inspect({}, 'boot'), /Invalid inspection action/);
  assert.deepEqual(f.calls, []);
});

test('only fresh valid receipts confirm; old code/error and unexpected remote fields cannot leak into the update', async t => {
  const f = await fixture(t);
  for (const receipt of [{ status: 'running' }, { status: 'preparing' }, { status: 'exited', code: 0 },
    { status: 'cancelled', code: 130 }, { status: 'timed_out', code: 124 }, { status: 'failed', code: 125, error: 'fresh error' }]) {
    await saveJob(f.job);
    f.provider.exec = async () => response({ ...receipt, id: 'wrong', project: f.other, command: 'poisoned' });
    let confirmed;
    const result = await f.inspect({ project: f.project, onConfirmed: job => {
      confirmed = { ...job };
      assert.deepEqual(JSON.parse(readFileSync(jobPath(f.job.id), 'utf8')), f.job, 'confirmation precedes persistence');
    } });
    assert.deepEqual(confirmed, result);
    assert.equal(result.status, receipt.status);
    assert.equal(result.code, receipt.code);
    assert.equal(result.error, receipt.error);
    assert.equal(result.id, f.job.id); assert.equal(result.project, f.project); assert.equal(result.command, f.job.command);
    assert.deepEqual(await getJob(f.job.id), result);
  }
});

test('unreachable resources return historical state with a diagnostic but never confirm or overwrite it', async t => {
  const f = await fixture(t);
  for (const state of ['unreachable', 'stopped', 'unknown']) {
    f.calls.length = 0;
    f.provider.status = async () => { f.calls.push('status'); return state; };
    const result = await f.inspect({ onConfirmed: () => assert.fail('resource state is not a receipt') });
    assert.equal(result.status, f.job.status); assert.equal(result.code, 7);
    assert.match(result.error, /Last recorded state shown/);
    assert.deepEqual(await getJob(f.job.id), f.job);
    assert.deepEqual(f.calls, ['status', 'close']);
  }
});

test('unknown receipt does not confirm or inherit historical completion', async t => {
  const f = await fixture(t);
  for (const receipt of [{ status: 'unknown' }, { status: 'unknown', code: 125, error: 'unconfirmed termination' }]) {
    await saveJob(f.job);
    f.provider.exec = async () => response(receipt);
    const result = await f.inspect({ onConfirmed: () => assert.fail('unknown is not confirmation') });
    assert.equal(result.status, 'unknown'); assert.equal(result.code, receipt.code);
    assert.ok(result.error); assert.notEqual(result.error, f.job.error);
    assert.deepEqual(await getJob(f.job.id), result);
  }
});

test('malformed, missing, truncated and structurally invalid receipts never confirm or change cached history', async t => {
  const f = await fixture(t);
  const invalid = [null, [], true, 'running', {}, { status: 'online' }, { status: 'exited' },
    ...[null, true, '0', 0.5, -1, 256, Number.MAX_SAFE_INTEGER + 1].map(code => ({ status: 'exited', code })),
    { status: 'running', code: 0 }, { status: 'preparing', code: 0 }, { status: 'exited', code: 0, error: {} }];
  const results = [...invalid.map(response), { code: 0, stdout: '', stderr: '' }, { code: 0, stdout: '{"status":', stderr: '' },
    { ...response({ status: 'exited', code: 0 }), stdoutTruncated: true }, { code: 125, stdout: '', stderr: 'missing receipt' }];
  for (const result of results) {
    f.provider.exec = async () => result;
    await assert.rejects(f.inspect({ onConfirmed: () => assert.fail('invalid receipt confirmed') }));
    assert.deepEqual(await getJob(f.job.id), f.job);
  }
  assert.equal(f.calls.filter(call => call === 'close').length, results.length);
});

test('a confirmed remote receipt remains distinguishable from local persistence failure', async t => {
  const f = await fixture(t), blocked = join(f.base, 'not-a-directory');
  await writeFile(blocked, 'blocked');
  let confirmed;
  await assert.rejects(f.inspect({ onConfirmed: job => { confirmed = { ...job }; process.env.REROUTE_STATE_DIR = blocked; } }), /ENOTDIR/);
  process.env.REROUTE_STATE_DIR = f.state;
  assert.equal(confirmed.status, 'exited'); assert.equal(confirmed.code, 0); assert.equal(confirmed.error, undefined);
  assert.deepEqual(await getJob(f.job.id), f.job);
  assert.equal(f.calls.at(-1), 'close');
});

test('already aborted inspection never queries the provider', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort();
  await assert.rejects(f.inspect({ signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(f.calls, []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort races hung resource status, cleans listeners and ignores late success/rejection without issuing a helper', async t => {
  const f = await fixture(t);
  for (const rejectLate of [false, true]) {
    f.calls.length = 0;
    const controller = new AbortController();
    let resolveStatus, rejectStatus, started;
    const entered = new Promise(resolve => { started = resolve; });
    f.provider.status = () => { f.calls.push('status'); started(); return new Promise((resolve, reject) => { resolveStatus = resolve; rejectStatus = reject; }); };
    const pending = f.inspect({ signal: controller.signal, onConfirmed: () => assert.fail('aborted status confirmed') });
    await entered; controller.abort();
    await assert.rejects(bounded(pending), { name: 'AbortError' });
    if (rejectLate) rejectStatus(Error('late transport failure')); else resolveStatus('running');
    await turn();
    assert.deepEqual(f.calls, ['status', 'close']);
    assert.deepEqual(await getJob(f.job.id), f.job);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('deadline abort races a hung helper exec, forwards signal and timeout, and ignores its late receipt', async t => {
  const f = await fixture(t), signal = AbortSignal.timeout(40);
  let resolveExec;
  f.provider.exec = (_command, options) => {
    f.calls.push('status helper');
    assert.equal(options.signal, signal); assert.equal(options.timeoutMs, 120000);
    return new Promise(resolve => { resolveExec = resolve; });
  };
  await assert.rejects(bounded(f.inspect({ signal, onConfirmed: () => assert.fail('late receipt confirmed') })), { name: 'TimeoutError' });
  resolveExec(response({ status: 'exited', code: 0 })); await turn();
  assert.deepEqual(f.calls, ['status', 'status helper', 'close']);
  assert.deepEqual(await getJob(f.job.id), f.job);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('provider errors close the connection and successful inspection removes abort listeners', async t => {
  const f = await fixture(t), controller = new AbortController();
  await f.inspect({ signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await saveJob(f.job);
  f.provider.exec = async () => { throw Error('transport failed'); };
  await assert.rejects(f.inspect({ signal: controller.signal }), /transport failed/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.calls.at(-1), 'close');
  assert.deepEqual(await getJob(f.job.id), f.job);
});

test('project-scoped E2B inspection never enters a connection path that may resume a paused sandbox', async t => {
  const f = await fixture(t);
  const { E2BProvider } = await import('../dist/providers/e2b.js');
  const calls = [];
  const sdk = { Sandbox: {
    getInfo: async () => { calls.push('getInfo'); return { state: 'running' }; },
    connect: async () => { calls.push('connect'); assert.fail('status must never connect/resume'); },
  }, CommandExitError: class extends Error {} };
  f.job.profile = { provider: 'e2b', id: 'existing-sandbox' }; await saveJob(f.job);
  const provider = new E2BProvider(f.job.profile, async () => sdk);
  const result = await inspectJob(f.job.id, 'status', { project: f.project, provider,
    onConfirmed: () => assert.fail('resource online is not task confirmation') });
  assert.equal(result.status, 'exited'); assert.equal(result.code, 7);
  assert.match(result.error, /may resume.*No connection attempted/);
  assert.deepEqual(calls, ['getInfo']); assert.deepEqual(await getJob(f.job.id), f.job);
});
