import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRerouteTool, panel, smoke } from '../dist/pi.js';
import { defaults, saveConfig, saveUserConfig, loadConfig, userConfigPath, projectAuthorized, authorizeProject, saveJob } from '../dist/config.js';

const isolated = await mkdtemp(join(tmpdir(), 'reroute-pi-consent-'));
process.env.XDG_CONFIG_HOME = join(isolated, 'config');
process.env.REROUTE_STATE_DIR = join(isolated, 'state');
after(() => rm(isolated, { recursive: true, force: true }));
beforeEach(() => rm(userConfigPath(), { force: true }));
const ssh = () => ({ ...defaults(), active: 'host', profiles: { host: { provider: 'ssh', id: 'offline.invalid' } } });
const managed = () => ({ ...defaults(), active: 'cloud', profiles: { cloud: {
  provider: 'daytona', id: 'auto', credential: 'reviewed-account', image: 'reviewed-toolchain:1', compute: { cpu: 1, memoryGiB: 2 },
  managed: { authorized: true, maxCpu: 2, maxMemoryGiB: 4, monthlyUsd: 3, maxTaskUsd: 0.5,
    cpuHourUsd: 0.0504, memoryGiBHourUsd: 0.0162, storageMonthUsd: 0.01, idleMinutes: 1 },
} } });
async function project(t, config = ssh()) {
  const root = await mkdtemp(join(isolated, 'project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"name":"consent-fixture"}');
  await saveConfig(root, config);
  return { root, config };
}
const success = () => ({ code: 0, stdout: 'ok', stderr: '', job: { id: 'fixture-job', status: 'exited' } });

test('managed config fields cannot authorize a project; headless execution refuses before calling the engine', async t => {
  const { root, config } = await project(t, managed());
  let calls = 0;
  const tool = createRerouteTool(async () => { calls++; return success(); });
  const result = await tool.execute('headless', { command: 'cargo test' }, undefined, undefined, {
    cwd: root, hasUI: false, ui: { confirm: () => { throw Error('No UI confirmation in print mode'); } },
  });
  assert.equal(result.details.status, 'not_started');
  assert.equal(result.details.jobId, null);
  assert.match(result.details.reason, /Nothing executed or uploaded/);
  assert.match(result.details.reason, /\/reroute.*authorize --yes/);
  assert.equal(await projectAuthorized(root, config), false);
  assert.equal(calls, 0);
});

test('routing precedes consent; declining confirmation never grants or executes', async t => {
  const { root, config } = await project(t);
  let calls = 0, confirmations = 0;
  const tool = createRerouteTool(async () => { calls++; return success(); });
  const ctx = { cwd: root, hasUI: true, ui: { confirm: async () => { confirmations++; return false; } } };
  const local = await tool.execute('local', { command: 'git status' }, undefined, undefined, ctx);
  assert.equal(local.details.status, 'not_started');
  assert.equal(confirmations, 0);
  for (let i = 0; i < 2; i++) {
    const refused = await tool.execute('denied', { command: 'cargo test' }, undefined, undefined, ctx);
    assert.equal(refused.details.status, 'not_started');
  }
  assert.equal(confirmations, 2);
  assert.equal(calls, 0);
  assert.equal(await projectAuthorized(root, config), false);
});

test('explicit canonical project/account/source/scripts/fees confirmation grants once, including across symlink cwd', async t => {
  const { root, config } = await project(t, managed());
  const alias = join(isolated, randomUUID());
  await symlink(root, alias, 'dir');
  t.after(() => rm(alias, { force: true }));
  let calls = 0, confirmations = 0;
  const tool = createRerouteTool(async (_command, options) => {
    calls++;
    assert.equal(await projectAuthorized(options.root, options.config), true);
    return success();
  });
  const ctx = { cwd: alias, hasUI: true, ui: { confirm: async (title, text) => {
    confirmations++;
    assert.match(title, /Authorize this project/);
    assert.ok(text.includes('Canonical project root: ' + root));
    assert.match(text, /daytona \/ reviewed-account/);
    assert.match(text, /Source code will be uploaded/);
    assert.match(text, /scripts and lifecycle hooks are trusted code/);
    assert.match(text, /fees; credit is unknown/);
    return true;
  } } };
  assert.equal((await tool.execute('first', { command: 'cargo test' }, undefined, undefined, ctx)).isError, false);
  assert.equal((await tool.execute('again', { command: 'cargo test' }, undefined, undefined, { cwd: root, hasUI: false })).isError, false);
  assert.equal(confirmations, 1);
  assert.equal(calls, 2);
  const changed = structuredClone(config);
  changed.profiles.cloud.credential = 'another-account';
  await saveConfig(root, changed);
  assert.equal((await tool.execute('changed', { command: 'cargo test' }, undefined, undefined, { cwd: root, hasUI: false })).details.status, 'not_started');
  assert.equal(calls, 2);
});

test('abort during confirmation cannot persist a grant or start work', async t => {
  const { root, config } = await project(t);
  const controller = new AbortController();
  const tool = createRerouteTool(async () => { throw Error('Must not execute after cancellation'); });
  const result = await tool.execute('abort', { command: 'cargo test' }, controller.signal, undefined, {
    cwd: root, hasUI: true, ui: { confirm: async () => { controller.abort(); return true; } },
  });
  assert.equal(result.details.status, 'cancelled');
  assert.equal(await projectAuthorized(root, config), false);
});

test('native onUpdate receives engine stages and the final structured result retains measured metrics', async t => {
  const { root, config } = await project(t);
  await authorizeProject(root, config);
  const updates = [], metrics = { inputBytes: 12, inputMs: 4, transferredBytes: 8, transferMs: 7, cacheKey: 'fixture', executionMs: 9, cacheHit: false, packMs: 2, archiveBytes: 6, uploadMs: 3, uploadedBytes: 6, remoteUnpackMs: 1, remoteVerifyMs: 2, cacheSaveMs: 5, cacheSaveBytes: 9, cleanupMs: 4, releaseMs: 8 };
  const tool = createRerouteTool(async (_command, options) => {
    options.onProgress({ stage: 'uploading', message: 'Uploading source archive' });
    return { ...success(), job: { ...success().job, metrics } };
  });
  const result = await tool.execute('progress', { command: 'cargo test' }, undefined, update => updates.push(update), { cwd: root });
  assert.equal(updates[0].details.status, 'uploading');
  assert.match(updates[0].content[0].text, /Uploading source archive/);
  assert.deepEqual(result.structuredContent.metrics, metrics);
  assert.match(result.content[0].text, /Measured: source 4 ms; transfer 7 ms \/ 8 B; execution 9 ms/);
  assert.ok(result.content[0].text.includes('pack 2 ms / 6 B; upload 3 ms / 6 B; remote unpack/verify 1/2 ms'));
  assert.ok(result.content[0].text.includes('cache save 5 ms / 9 B; cleanup/release 4/8 ms'));
  assert.ok(result.content[0].text.includes('cache restore ? ms / ? B'));
});

test('panel distinguishes saved credentials, session connection, project authorization and local actual task receipts', async t => {
  const { root, config } = await project(t);
  const own = randomUUID(), foreign = randomUUID();
  for (const [id, project] of [[own, root], [foreign, join(root, 'another-project')]]) await saveJob({
    id, project, profile: config.profiles.host, root: '/remote', command: 'cargo test', cwd: '.', createdAt: new Date().toISOString(), status: 'exited', code: 0,
  });
  const selections = ['Overview', 'Recent jobs', 'Close'], titles = [], notices = [];
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Panel must not make implicit cloud calls'); };
  t.after(() => { globalThis.fetch = fetch; });
  await panel({ cwd: root, hasUI: true, ui: {
    select: async title => { titles.push(title); return selections.shift(); }, notify: text => notices.push(text),
    confirm: async () => { throw Error('Viewing status cannot authorize or run tasks'); },
  } });
  assert.match(titles[0], /Credential source: .*saved is not authenticated/);
  assert.match(titles[0], /Connection \(this session\): not checked this session/);
  assert.match(titles[0], /Project remote authorization: NOT authorized/);
  assert.match(titles[0], /Successful actual tasks \(local receipts\): 1/);
  assert.match(notices[0], /No cloud calls made/);
  assert.ok(notices[1].includes(own));
  assert.ok(!notices.join('\n').includes(foreign));
});

test('panel grants and revokes without running a task; revocation leaves recorded jobs alone', async t => {
  const { root, config } = await project(t);
  const selections = ['Authorize project remote execution', 'Revoke project authorization', 'Close'], titles = [];
  let confirmations = 0;
  await panel({ cwd: root, hasUI: true, ui: {
    select: async title => { titles.push(title); return selections.shift(); },
    confirm: async () => { confirmations++; return true; }, notify: () => {},
  } });
  assert.match(titles[1], /Project remote authorization: authorized/);
  assert.match(titles[2], /Project remote authorization: NOT authorized/);
  assert.equal(confirmations, 2);
  assert.equal(await projectAuthorized(root, config), false);
});

test('global provider switch edits user defaults only; project exceptions persist only changed keys', async t => {
  const root = await mkdtemp(join(isolated, 'global-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = ssh();
  config.profiles.cloud = { provider: 'daytona', id: 'existing-sandbox' };
  await saveUserConfig(config);
  const selections = ['Manage providers', 'Switch active provider', 'cloud', 'Close'];
  await panel({ cwd: root, hasUI: true, ui: { select: async () => selections.shift(), notify: () => {} } });
  assert.equal(JSON.parse(await readFile(userConfigPath(), 'utf8')).active, 'cloud');
  await assert.rejects(readFile(join(root, '.reroute.json')), /ENOENT/);
  const exceptions = ['Project overrides', 'Routing mode', 'local', 'Close'];
  await panel({ cwd: root, hasUI: true, ui: { select: async () => exceptions.shift(), notify: () => {} } });
  assert.deepEqual(JSON.parse(await readFile(join(root, '.reroute.json'), 'utf8')), { mode: 'local' });
  assert.equal(JSON.parse(await readFile(userConfigPath(), 'utf8')).mode, 'auto');
  assert.equal((await loadConfig(root)).source, 'merged');
});

test('optional smoke requires an independent cost confirmation and project approval before engine execution', async t => {
  const { root, config } = await project(t, managed());
  let calls = 0, confirmations = 0;
  const notices = [];
  const ctx = { cwd: root, hasUI: true, ui: { confirm: async (title, text) => {
    confirmations++;
    if (confirmations === 1) {
      assert.match(title, /optional billable smoke/);
      assert.match(text, /Offline cost estimate: \$[0-9.]+ conservative reservation/);
      assert.match(text, /30 seconds/);
      assert.match(text, /Source is uploaded/);
    } else assert.match(title, /Authorize this project/);
    return true;
  }, notify: text => notices.push(text) } };
  await smoke(ctx, root, config, async (command, options) => {
    calls++;
    assert.match(command, /python3.*-c.*REROUTE_SMOKE_OK/);
    assert.equal(options.timeoutMs, 30000);
    assert.equal(await projectAuthorized(root, config), true);
    return success();
  });
  assert.equal(confirmations, 2);
  assert.equal(calls, 1);
  assert.match(notices.join('\n'), /Smoke task: exited/);
});

test('declining smoke cost or project confirmation executes nothing and cannot silently grant', async t => {
  for (const approveCost of [false, true]) {
    const { root, config } = await project(t, managed());
    let confirmations = 0, calls = 0;
    await smoke({ cwd: root, hasUI: true, ui: {
      confirm: async () => ++confirmations === 1 && approveCost, notify: () => {},
    } }, root, config, async () => { calls++; return success(); });
    assert.equal(calls, 0);
    assert.equal(await projectAuthorized(root, config), false);
    assert.equal(confirmations, approveCost ? 2 : 1);
  }
});

test('project consent and smoke confirmation do not bypass the managed paid-creation policy', async t => {
  const config = managed();
  config.profiles.cloud.managed.authorized = false;
  const { root } = await project(t, config);
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Unauthorized smoke must never contact cloud'); };
  t.after(() => { globalThis.fetch = fetch; });
  await assert.rejects(smoke({ cwd: root, hasUI: true, ui: { confirm: async () => true, notify: () => {} } }, root, config), /not authorized/);
});


test('smoke infrastructure failure retains job identity and never retries', async t => {
  const { root, config } = await project(t);
  let calls = 0;
  await assert.rejects(smoke({ cwd: root, hasUI: true, ui: { confirm: async () => true, notify: () => {} } }, root, config,
    async (_command, options) => {
      calls++;
      options.onJob({ id: 'uncertain-smoke', status: 'unknown' });
      throw Error('transport lost');
    }), /Job ID: uncertain-smoke.*Inspect with reroute_status[\s\S]*Never retried locally/);
  assert.equal(calls, 1);
});
