import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectConfiguration, projectSettings, localStatus, runtimeStatus, enableProject } from '../../dist/cli/manage.js';
import { Coordinator } from '../../dist/core/coordinator.js';
import { serve } from '../../dist/daemon/server.js';
import { SshProvider } from '../../dist/providers/ssh.js';
import { capture } from '../../dist/platform/process.js';
import { fixture, FixtureProvider as TestProvider } from '../helpers.mjs';

async function context(t, live = false) {
  const cleanup = [], f = await fixture({ after: fn => cleanup.push(fn) });
  const oldHome = process.env.REROUTE_HOME;
  const home = join(f.directory, 'home');
  process.env.REROUTE_HOME = home;
  const provider = new TestProvider(f.remote), core = new Coordinator(() => provider);
  t.mock.method(provider, 'status', async () => { throw new Error('configuration must not query a provider'); });
  const server = live ? await serve(core) : undefined;
  t.after(async () => {
    try { if (server) await server.close(); else await core.shutdown(); }
    finally {
      if (oldHome === undefined) delete process.env.REROUTE_HOME; else process.env.REROUTE_HOME = oldHome;
      for (const fn of cleanup.reverse()) await fn();
    }
  });
  return { ...f, home, core, provider };
}

test('shared settings and JSON local status have safe defaults without identity, daemon or writes', async t => {
  const f = await context(t);
  const settings = await projectSettings(f.local);
  assert.equal(settings.state, undefined);
  assert.equal(settings.root, f.local);
  assert.equal(settings.config.provider, 'daytona');
  assert.deepEqual(settings.config.authorization.paidProviders, []);
  assert.equal(settings.config.routing.mode, 'tasks');
  const status = await localStatus(f.local);
  assert.equal(status.enabled, false);
  assert.equal(status.status, 'not-created');
  assert.equal(status.coordinator, 'not running');
  assert.equal(status.remoteReadiness, 'UNVERIFIED');
  assert.equal(status.billing, 'UNKNOWN');
  assert.deepEqual(status.tasks, ['build', 'test', 'check', 'benchmark']);
  assert.deepEqual(await runtimeStatus(f.local), { status: 'not-created', stateSource: 'no recorded runtime', warning: undefined });
  const result = await capture(process.execPath, [resolve('bin/reroute.mjs'), 'status', '--json'], {
    cwd: f.local, env: { ...process.env, REROUTE_HOME: f.home }
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(status)));
  assert.deepEqual(await fs.readdir(f.local), []);
  await assert.rejects(fs.stat(f.home), { code: 'ENOENT' });
});

test('all five provider choices plan and enable through local IPC without remote activation or consent', async t => {
  const f = await context(t, true);
  for (const provider of ['ssh', 'daytona', 'skypilot', 'modal', 'e2b']) {
    const cwd = join(f.local, provider); await fs.mkdir(cwd);
    const choices = { provider, ...(provider === 'ssh' ? { host: 'fixture-host' } : {}) };
    const plan = await projectConfiguration(cwd, choices);
    assert.equal(plan.config.provider, provider);
    assert.deepEqual(plan.config.authorization.paidProviders, []);
    assert.deepEqual(await fs.readdir(cwd), [], provider + ' planning must not write');
    const result = await enableProject(cwd, choices);
    assert.equal(result.enabled, true);
    assert.equal(result.provider, provider);
    assert.equal(result.policyMode, 'tasks');
    assert.equal(result.paidAuthorized, false);
    const settings = await projectSettings(cwd);
    assert.equal(settings.state.project.id, result.project);
    assert.equal(settings.config.provider, provider);
    assert.equal(settings.state.runtime, undefined);
    assert.equal((await runtimeStatus(cwd)).status, 'not-created');
    const status = await localStatus(cwd);
    assert.equal(status.coordinator, 'running');
    assert.equal(status.status, 'not-created');
    assert.equal(status.paidAuthorized, provider === 'ssh');
  }
  assert.equal(f.provider.readyCount, 0);
  assert.equal(f.provider.status.mock.callCount(), 0);
  assert.deepEqual(f.provider.policies, []);
  assert.deepEqual(await fs.readdir(f.remote), []);
});

test('settings pre-fill stored provider, host and tasks from a nested directory; re-enable keeps identity', async t => {
  const f = await context(t, true);
  await fs.mkdir(join(f.local, '.git'));
  const nested = join(f.local, 'src'); await fs.mkdir(nested);
  await fs.writeFile(join(f.home, 'config.toml'), 'provider = "daytona"\n');
  await fs.writeFile(join(f.local, 'reroute.toml'), 'provider = "modal"\n[providers.ssh]\nhost = "project-host"\n');
  const state = await f.core.enable(f.local, 'ssh', {
    providers: { ssh: { host: 'saved-host' } }, routing: { mode: 'tasks', tasks: ['build', 'check'] }
  });
  state.enabled = false; await f.core.store.save(state);
  const settings = await projectSettings(nested);
  assert.equal(settings.root, f.local);
  assert.equal(settings.state.enabled, false);
  assert.equal(settings.config.provider, 'ssh');
  assert.equal(settings.config.providers.ssh.host, 'saved-host');
  assert.deepEqual(settings.config.routing.tasks, ['build', 'check']);
  const plan = await projectConfiguration(nested, {});
  assert.deepEqual(plan.config, settings.config);
  assert.deepEqual(plan.override, state.override);
  const result = await enableProject(f.local, {});
  assert.equal(result.project, state.project.id);
  assert.equal(result.provider, 'ssh');
  assert.equal((await projectSettings(nested)).state.enabled, true);
  assert.equal(f.provider.readyCount, 0);
});

test('provider choice preserves named grants; only explicit consent flags grant or revoke', async t => {
  const f = await context(t, true);
  const first = await enableProject(f.local, { provider: 'daytona', 'allow-paid': true });
  assert.equal(first.paidAuthorized, true);
  for (const provider of ['modal', 'e2b', 'skypilot']) {
    const plan = await projectConfiguration(f.local, { provider });
    assert.deepEqual(plan.config.authorization.paidProviders, ['daytona']);
    const result = await enableProject(f.local, { provider });
    assert.equal(result.project, first.project);
    assert.equal(result.paidAuthorized, false);
    assert.deepEqual((await projectSettings(f.local)).config.authorization.paidProviders, ['daytona']);
  }
  assert.equal((await enableProject(f.local, { provider: 'daytona' })).paidAuthorized, true);
  await assert.rejects(projectConfiguration(f.local, { 'allow-paid': true, 'revoke-paid': true }), { code: 'USAGE' });
  assert.deepEqual((await projectSettings(f.local)).config.authorization.paidProviders, ['daytona']);
  assert.equal((await enableProject(f.local, { 'revoke-paid': true })).paidAuthorized, false);
  assert.deepEqual((await projectSettings(f.local)).config.authorization.paidProviders, []);
  assert.equal(f.provider.readyCount, 0);
  assert.equal(f.provider.status.mock.callCount(), 0);
});

for (const [marker, code] of [['runtime', 'PROVIDER_CHANGE'], ['syncPending', 'SOURCE_PENDING']]) {
  test(`shared configuration and enable guard ${marker} before shim or identity writes`, async t => {
    const f = await context(t);
    const state = await f.core.enable(f.local, 'ssh', { providers: { ssh: { host: 'original-host' } } });
    if (marker === 'runtime') state.runtime = { ...f.runtime, id: 'original-runtime', projectId: state.project.id };
    else state.syncPending = true;
    await f.core.store.save(state);
    const identity = join(f.local, '.reroute', 'project.json');
    const before = await fs.readFile(identity);
    for (const operation of [projectConfiguration, enableProject]) {
      await assert.rejects(operation(f.local, { provider: 'modal' }), { code });
    }
    const plan = await projectConfiguration(f.local, { tasks: 'none' });
    assert.equal(plan.config.provider, 'ssh');
    assert.deepEqual(plan.config.routing.tasks, []);
    assert.deepEqual(await fs.readFile(identity), before);
    assert.deepEqual(await fs.readdir(f.home), ['projects']);
    const report = await localStatus(f.local);
    assert.equal(report.status, marker === 'runtime' ? 'unknown' : 'not-created');
    assert.equal(report.syncPending, marker === 'syncPending');
    assert.equal(report.coordinator, 'not running');
    const result = await capture(process.execPath, [resolve('bin/reroute.mjs'), 'status', '--json'], {
      cwd: f.local, env: { ...process.env, REROUTE_HOME: f.home }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(report)));
    assert.deepEqual(await fs.readFile(identity), before);
    assert.deepEqual(await fs.readdir(join(f.local, '.reroute')), ['project.json']);
    assert.deepEqual(await fs.readdir(f.home), ['projects']);
    assert.equal(f.provider.readyCount, 0);
  });
}

test('fresh identity cannot orphan an existing runtime through enableProject', async t => {
  const f = await context(t, true);
  const state = await f.core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture-host' } } });
  state.runtime = { ...f.runtime, projectId: state.project.id }; state.syncPending = true;
  await f.core.store.save(state);
  const before = await fs.readFile(join(f.local, '.reroute', 'project.json'));
  await assert.rejects(enableProject(f.local, { provider: 'modal', 'new-identity': true }), { code: 'PROJECT_RUNTIME' });
  assert.deepEqual(await fs.readFile(join(f.local, '.reroute', 'project.json')), before);
  assert.equal(f.provider.readyCount, 0);
});

test('SSH choice and task flags validate before any installation or state writes', async t => {
  const f = await context(t);
  for (const flags of [
    { provider: 'ssh' }, { provider: 'ssh', host: 'bad\nhost' }, { provider: 'ssh', host: 'bad\0host' },
    { provider: 'unknown' }, { provider: 'daytona', tasks: 'build,deploy' },
    { provider: 'daytona', tasks: '' }, { provider: 'daytona', tasks: 'build, test' }
  ]) await assert.rejects(enableProject(f.local, flags), { code: 'CONFIG' });
  for (const [tasks, expected] of [['none', []], ['build', ['build']], ['build,test,check,benchmark', ['build', 'test', 'check', 'benchmark']]]) {
    assert.deepEqual((await projectConfiguration(f.local, { provider: 'daytona', tasks })).config.routing.tasks, expected);
  }
  assert.equal((await projectConfiguration(f.local, { host: 'fixture-host' })).config.provider, 'ssh');
  assert.deepEqual(await fs.readdir(f.local), []);
  await assert.rejects(fs.stat(f.home), { code: 'ENOENT' });
});

test('runtimeStatus queries only a cloned recorded reference and reports unknown or errors without writes', async t => {
  const f = await context(t);
  const state = await f.core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture-host' } } });
  state.runtime = { ...f.runtime, projectId: state.project.id }; state.syncPending = true;
  await f.core.store.save(state);
  for (const method of ['ensureReady', 'destroy']) t.mock.method(SshProvider.prototype, method, async () => { throw new Error('must not activate or destroy'); });
  const identity = join(f.local, '.reroute', 'project.json'), before = await fs.readFile(identity);
  for (const expected of ['running', 'stopped', 'unknown', 'error']) {
    const status = t.mock.method(SshProvider.prototype, 'status', async runtime => {
      assert.deepEqual(runtime, state.runtime);
      runtime.root = '/mutated-fixture-only';
      if (expected === 'error') throw new Error('synthetic status failure');
      return expected;
    });
    const report = await runtimeStatus(f.local);
    assert.equal(report.status, expected === 'error' ? 'unknown' : expected);
    assert.equal(report.stateSource, expected === 'error' ? 'live query failed; remote unverified' : 'live provider query');
    if (expected === 'unknown') assert.match(report.warning, /no resource operation attempted/);
    if (expected === 'error') {
      assert.match(report.warning, /native provider authentication/);
      assert.doesNotMatch(report.warning, /synthetic status failure/);
    }
    assert.equal(status.mock.callCount(), 1);
    status.mock.restore();
    assert.deepEqual(await fs.readFile(identity), before);
  }
  assert.equal(SshProvider.prototype.ensureReady.mock.callCount(), 0);
  assert.equal(SshProvider.prototype.destroy.mock.callCount(), 0);
  assert.deepEqual(await fs.readdir(f.home), ['projects']);
});

test('nested non-Git project edits target the original identity and root TOML', async t => {
  const f = await context(t, true);
  await fs.writeFile(join(f.local, 'reroute.toml'), 'provider = "ssh"\n[providers.ssh]\nhost = "root-host"\n');
  const first = await enableProject(f.local, { provider: 'ssh', host: 'root-host' });
  const nested = join(f.local, 'source'); await fs.mkdir(nested);
  const second = await enableProject(nested, { tasks: 'test' });
  assert.equal(second.project, first.project);
  const settings = await projectSettings(nested);
  assert.equal(settings.root, f.local);
  assert.equal(settings.config.providers.ssh.host, 'root-host');
  assert.deepEqual(settings.config.routing.tasks, ['test']);
  assert.deepEqual(await fs.readdir(nested), []);
  assert.equal(f.provider.readyCount, 0);
});

test('non-TTY task-only setup requires a provider or an existing project and never waits for input', async t => {
  const f = await context(t);
  const result = await capture(process.execPath, [resolve('bin/reroute.mjs'), 'setup', '--tasks', 'test'], { cwd: f.local, env: { ...process.env, REROUTE_HOME: f.home }, timeoutMs: 3000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Select --provider PROVIDER/);
  assert.deepEqual(await fs.readdir(f.local), []);
  await assert.rejects(fs.stat(f.home), { code: 'ENOENT' });
});

test('changing SSH endpoint cannot strand a recorded workspace or pending source', async t => {
  const f = await context(t);
  const state = await f.core.enable(f.local, 'ssh', { providers: { ssh: { host: 'original-host' } } });
  state.runtime = { ...f.runtime, projectId: state.project.id }; state.syncPending = true;
  await f.core.store.save(state);
  const path = join(f.local, '.reroute', 'project.json'), original = await fs.readFile(path);
  await assert.rejects(projectConfiguration(f.local, { provider: 'ssh', host: 'different-host' }), { code: 'PROVIDER_CHANGE' });
  await assert.rejects(enableProject(f.local, { host: 'different-host' }), { code: 'PROVIDER_CHANGE' });
  assert.equal((await projectConfiguration(f.local, { host: 'original-host' })).config.providers.ssh.host, 'original-host');
  assert.deepEqual(await fs.readFile(path), original);
  assert.deepEqual(await fs.readdir(f.home), ['projects']);
  assert.equal(f.provider.readyCount, 0);
});
