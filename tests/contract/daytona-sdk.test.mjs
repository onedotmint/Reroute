import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaytonaProvider } from '../../dist/providers/daytona.js';
import { loadSdk } from '../../dist/providers/common.js';
import { SDKS } from '../../dist/cli/setup.js';
import { fixture } from '../helpers.mjs';
// Real vendor errors, not mock names/status fields. This module does not construct a client.
import {
  DaytonaNotFoundError, DaytonaAuthenticationError, DaytonaForbiddenError,
  DaytonaRateLimitError, DaytonaInternalServerError, DaytonaConnectionError,
  DaytonaConnectionTimeoutError, DaytonaTimeoutError,
} from '../../.tools/node_modules/@daytona/sdk/esm/errors/DaytonaError.js';

const project = { id: 'sdk-project', name: 'sdk-project', root: '/local' };
const spec = { idleTimeoutMinutes: 10, env: { CI: '1' } };
const runtime = { provider: 'daytona', projectId: project.id, id: 'sandbox-id', root: '/remote', meta: { workspaceGeneration: '11111111-1111-4111-8111-111111111111' } };
function boundary({ getError, state = 'started', createdState = 'started', startState = 'started', options = {}, snapshotMetadata = { sandboxClass: 'container', resources: { cpu: 2 } } } = {}) {
  const calls = { config: [], get: [], create: [], start: [], stop: [], delete: [], idle: [], autoDelete: [], refresh: 0, verified: 0, initialized: 0 };
  const sandbox = {
    id: runtime.id, state, labels: { 'reroute.project': project.id }, sandboxClass: 'container', gpu: 0, spot: false, autoDeleteInterval: -1,
    async start(timeout) { calls.start.push(timeout); this.state = startState; },
    async stop(timeout) { calls.stop.push(timeout); this.state = 'stopped'; },
    async setAutostopInterval(minutes) { calls.idle.push(minutes); },
    async setAutoDeleteInterval(minutes) { calls.autoDelete.push(minutes); this.autoDeleteInterval = minutes; },
    async refreshActivity() { calls.refresh++; },
    async createSshAccess() { return { token: 'short-lived', sshCommand: 'ssh short-lived@ssh.app.daytona.io', expiresAt: new Date(Date.now() + 1800000) }; },
    async getPreviewLink() { return { url: 'https://preview.daytona.invalid', token: 'private-preview-token' }; },
    async getSignedPreviewUrl(port, expires) { assert.equal(port, 3000); assert.equal(expires, 300); return { url: 'https://preview.daytona.invalid', token: 'private-preview-token' }; },
  };
  class Daytona {
    constructor(config) { calls.config.push(config); }
    snapshot = { get: async () => snapshotMetadata };
    async get(id) { calls.get.push(id); if (getError) throw getError; return sandbox; }
    async create(params, options) { calls.create.push({ params, options }); sandbox.state = createdState; return sandbox; }
    async delete(sandbox, timeout) { calls.delete.push({ sandbox, timeout }); }
  }
  class Provider extends DaytonaProvider {
    async initialize(runtime) { calls.initialized++; return runtime; }
    async verifyWorkspace(runtime) { calls.verified++; return runtime; }
  }
  return { provider: new Provider(options, async () => ({ Daytona, DaytonaNotFoundError })), calls, sandbox };
}

test('Daytona setup pins the actual installed npm package', async () => {
  const installed = JSON.parse(await fs.readFile(new URL('../../.tools/node_modules/@daytona/sdk/package.json', import.meta.url), 'utf8'));
  assert.equal(installed.name, '@daytona/sdk');
  assert.equal(installed.version, '0.223.1');
  assert.equal(SDKS.daytona, `${installed.name}@${installed.version}`);
});

const failures = [
  new DaytonaAuthenticationError('401', 401), new DaytonaForbiddenError('403', 403),
  new DaytonaRateLimitError('429', 429), new DaytonaInternalServerError('500', 500),
  new DaytonaConnectionError('network'), new DaytonaConnectionTimeoutError('transport timeout'),
  new DaytonaTimeoutError('gateway timeout', 504),
  Object.assign(new Error('untyped 404'), { statusCode: 404 }),
  Object.assign(new Error('misleading name'), { name: 'SandboxNotFoundError', status: 404 }),
  new DaytonaNotFoundError('no authoritative HTTP status'),
  new DaytonaNotFoundError('contradictory status', 403),
];
for (const error of failures) test(`Daytona get failure is not missing: ${error.constructor.name} ${error.statusCode ?? 'transport'}`, async () => {
  const { provider, calls } = boundary({ getError: error });
  await assert.rejects(provider.ensureReady(project, spec, runtime), e => e === error);
  await assert.rejects(provider.status(runtime), e => e === error);
  await assert.rejects(provider.destroy(runtime), e => e === error);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.delete, []);
  assert.deepEqual(calls.start, []);
  assert.equal(calls.initialized, 0);
});

test('only real typed HTTP 404 provisions; create has a 60-second operation timeout', async () => {
  const { provider, calls } = boundary({ getError: new DaytonaNotFoundError('missing', 404) });
  assert.equal(await provider.status(runtime), 'missing');
  await provider.destroy(runtime);
  assert.deepEqual(calls.delete, []);
  assert.equal((await provider.ensureReady(project, spec)).id, runtime.id);
  assert.equal(calls.get.at(-1), 'reroute-' + project.id);
  assert.deepEqual(calls.config, [{ target: undefined, requestTimeoutMs: 30000 }]);
  assert.deepEqual(calls.create, [{ params: { name: 'reroute-' + project.id, labels: { 'reroute.project': project.id }, envVars: spec.env, autoStopInterval: 10, autoDeleteInterval: -1, ttlMinutes: 0, ephemeral: false, spot: false }, options: { timeout: 60 } }]);
});

test('Daytona image/resource and snapshot create shapes remain explicit', async () => {
  const getError = new DaytonaNotFoundError('missing', 404);
  const image = boundary({ getError, options: { autoArchiveMinutes: 60, autoDeleteMinutes: -1, volumes: [{ volumeId: 'v', mountPath: '/data', subpath: 'results' }] } });
  await image.provider.ensureReady(project, { ...spec, image: 'python:3.12-slim', cpu: 4, memoryMiB: 8192, diskGiB: 30, spot: false, region: 'us' });
  const params = image.calls.create[0].params;
  assert.equal(params.image, 'python:3.12-slim');
  assert.deepEqual(params.resources, { cpu: 4, memory: 8, disk: 30 });
  assert.equal(params.autoArchiveInterval, 60); assert.equal(params.autoDeleteInterval, -1); assert.equal(params.ttlMinutes, 0);
  assert.equal(params.spot, false); assert.deepEqual(params.volumes, [{ volumeId: 'v', mountPath: '/data', subpath: 'results' }]);
  assert.equal(image.calls.config[0].target, 'us');
  const snapshot = boundary({ getError, options: { snapshot: 'snapshot-id' } });
  await snapshot.provider.ensureReady(project, spec);
  assert.equal(snapshot.calls.create[0].params.snapshot, 'snapshot-id');
  assert.equal('resources' in snapshot.calls.create[0].params, false);
  await assert.rejects(snapshot.provider.ensureReady(project, { ...spec, cpu: 1 }), /snapshot resources are fixed/);
  const unsupported = boundary({ getError });
  await assert.rejects(unsupported.provider.ensureReady(project, { ...spec, gpu: { type: 'A100' } }), /GPU\/Spot/);
  assert.deepEqual(unsupported.calls.config, []);
});

for (const state of [undefined, 'error', 'build_failed', 'unknown', 'starting', 'destroyed', 'paused', 'unexpected']) {
  test(`Daytona unsafe state fails closed: ${state}`, async () => {
    const { provider, calls, sandbox } = boundary();
    sandbox.state = state;
    await assert.rejects(provider.ensureReady(project, spec, runtime), /not safely startable/);
    assert.deepEqual(calls.create, []); assert.deepEqual(calls.start, []); assert.deepEqual(calls.delete, []);
    assert.equal(calls.initialized, 0);
  });
}

test('Daytona creation/start must report started before workspace initialization', async () => {
  const created = boundary({ getError: new DaytonaNotFoundError('missing', 404), createdState: 'error' });
  await assert.rejects(created.provider.ensureReady(project, spec), /not ready/);
  assert.equal(created.calls.initialized, 0);
  const started = boundary({ state: 'stopped', startState: 'starting' });
  await assert.rejects(started.provider.ensureReady(project, spec, runtime), /not ready/);
  assert.deepEqual(started.calls.start, [60]); assert.equal(started.calls.initialized, 0);
});

for (const state of ['stopped', 'archived']) test(`Daytona ${state} start and idle stop are bounded with finite native timers`, async () => {
  const { provider, calls } = boundary({ state });
  await provider.ensureReady(project, spec, runtime);
  assert.deepEqual(calls.start, [60]);
  await provider.applyIdlePolicy(runtime, { active: true, minutes: 10 });
  await provider.applyIdlePolicy(runtime, { active: false, minutes: 2.2 });
  await provider.applyIdlePolicy(runtime, { active: false, minutes: 0 });
  assert.deepEqual(calls.idle, [10, 10, 3, 1]); assert.deepEqual(calls.autoDelete, [-1, -1, -1, -1]); assert.equal(calls.refresh, 1); assert.deepEqual(calls.stop, [60]);
  await provider.destroy(runtime);
  assert.equal(calls.delete[0].timeout, 60);
  assert.equal(await provider.preview(runtime, 3000), 'https://preview.daytona.invalid');
});

test('SDK loader reports the corrected Daytona install command without hiding import failures', async t => {
  const f = await fixture(t), oldHome = process.env.REROUTE_HOME;
  process.env.REROUTE_HOME = join(f.directory, 'home');
  t.after(() => { if (oldHome === undefined) delete process.env.REROUTE_HOME; else process.env.REROUTE_HOME = oldHome; });
  await assert.rejects(loadSdk('@daytona/sdk'), e => e.code === 'SDK_MISSING' && e.message.includes('--install-sdk daytona'));
  const dir = join(process.env.REROUTE_HOME, 'sdk', 'node_modules', 'broken-sdk');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'broken-sdk', type: 'module', main: 'index.js' }));
  await fs.writeFile(join(dir, 'index.js'), "import 'missing-sdk-transitive-dependency';\n");
  await assert.rejects(loadSdk('broken-sdk'), e => e.code === 'ERR_MODULE_NOT_FOUND');
  const scope = join(process.env.REROUTE_HOME, 'sdk', 'node_modules', '@daytona');
  await fs.mkdir(scope, { recursive: true });
  await fs.symlink(fileURLToPath(new URL('../../.tools/node_modules/@daytona/sdk', import.meta.url)), join(scope, 'sdk'), 'junction');
  // Exercise the real package's CommonJS resolution path, but never construct/authenticate the client.
  const realSdk = await loadSdk('@daytona/sdk');
  assert.equal(typeof realSdk.Daytona, 'function');
  assert.equal(typeof realSdk.DaytonaNotFoundError, 'function');
});

for (const snapshotMetadata of [{ sandboxClass: 'linux-vm', resources: {} }, { sandboxClass: 'container', resources: { gpu: { count: 1 } } }, { sandboxClass: 'container' }, { resources: {} }]) test('unsafe snapshot metadata fails before provisioning: ' + JSON.stringify(snapshotMetadata), async () => {
  const f = boundary({ getError: new DaytonaNotFoundError('missing', 404), options: { snapshot: 'unsafe' }, snapshotMetadata });
  await assert.rejects(f.provider.ensureReady(project, spec), e => e.code === 'UNSUPPORTED_CAPABILITY');
  assert.equal(f.calls.create.length, 0); assert.equal(f.calls.initialized, 0);
});
