import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture } from '../../dist/platform/process.js';
import { routingDecision, route } from '../../dist/core/routing.js';
import { fixture } from '../helpers.mjs';

const cli = resolve('bin/reroute.mjs');
async function context(t, enabled = true) {
  const f = await fixture(t), state = { version: 1, enabled, provider: 'daytona', override: {}, project: { id: randomUUID(), root: f.local, name: 'fixture' } };
  const directory = join(f.local, '.reroute'); await fs.mkdir(directory);
  const identity = join(directory, 'project.json'); await fs.writeFile(identity, JSON.stringify(state));
  const home = join(f.directory, 'absent-home');
  const env = { ...process.env, REROUTE_HOME: home, REROUTE_LOCAL: '', REROUTE_REMOTE: '' };
  const run = (...args) => capture(process.execPath, [cli, ...args], { cwd: f.local, env });
  const before = await fs.readFile(identity);
  const unchanged = async () => {
    assert.deepEqual(await fs.readFile(identity), before);
    assert.deepEqual(await fs.readdir(directory), ['project.json']);
    await assert.rejects(fs.stat(home), { code: 'ENOENT' });
  };
  return { ...f, run, env, unchanged };
}

for (const [argv, expected, rule] of [
  [['pnpm', 'test'], 'remote', 'configured-runtime-command'],
  [['git', 'status'], 'local', 'control-command'],
  [['npm', 'publish'], 'local', 'identity-subcommand'],
  [['pnpm', 'config', 'set'], 'local', 'identity-subcommand'],
  [['bash', '-c', 'pnpm test'], 'local', 'not-configured-runtime-command'],
  [['env', 'pnpm', 'test'], 'local', 'not-configured-runtime-command']
]) test('read-only explain: ' + argv.join(' '), async t => {
  const f = await context(t), result = await f.run('explain', '--json', '--', ...argv);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, 1); assert.equal(report.route, expected); assert.equal(report.matchedRule, rule);
  assert.deepEqual(report.argv, argv); assert.equal(report.remoteReadiness, 'UNVERIFIED');
  assert.equal(route(argv), report.policyRoute); assert.deepEqual(routingDecision(argv).rule, rule);
  assert.ok(report.limitations.some(x => x.includes('package script bodies')));
  await f.unchanged();
});

test('explain does not spawn even a configured executable or start a daemon', async t => {
  const f = await context(t);
  const result = await f.run('explain', '--json', '--', 'python3', '-c', "open('MUST_NOT_EXIST','w').write('bad')");
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).route, 'remote');
  await assert.rejects(fs.stat(join(f.local, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
  await f.unchanged();
});

test('absolute executables distinguish routing policy from interception bypass', async t => {
  const f = await context(t), result = await f.run('explain', '--json', '--', '/usr/bin/python3', '-c', 'pass');
  const report = JSON.parse(result.stdout);
  assert.equal(report.policyRoute, 'remote'); assert.equal(report.intercepted, false); assert.equal(report.route, 'local');
  assert.equal(report.reason, 'not-intercepted-by-path-shim'); await f.unchanged();
});

test('disabled project is local without erasing the configured remote policy', async t => {
  const f = await context(t, false), result = await f.run('explain', '--json', '--', 'pnpm', 'test');
  const report = JSON.parse(result.stdout); assert.equal(report.route, 'local'); assert.equal(report.policyRoute, 'remote');
  assert.equal(report.reason, 'project-not-enabled'); await f.unchanged();
});

test('configured control commands remain forced local; readable explanation works', async t => {
  const f = await context(t); await fs.writeFile(join(f.local, 'reroute.toml'), '[routing]\ncommands = ["git", "custom-runtime"]\n');
  const result = await f.run('explain', '--', 'git', 'status');
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /Route: local \(control-command\)/);
  const custom = JSON.parse((await f.run('explain', '--json', '--', 'custom-runtime')).stdout);
  assert.equal(custom.route, 'remote'); await f.unchanged();
});

test('explain validates the delimiter command and never acts on arbitrary positionals', async t => {
  const f = await context(t), result = await f.run('explain', 'pnpm', 'test');
  assert.notEqual(result.code, 0); assert.match(result.stderr, /command after --/); await f.unchanged();
});

for (const [key, reason] of [['REROUTE_LOCAL', 'explicit-local'], ['REROUTE_REMOTE', 'already-remote']]) test('explain preserves the shim override: ' + key, async t => {
  const f = await context(t);
  const result = await capture(process.execPath, [cli, 'explain', '--json', '--', 'pnpm', 'test'], { cwd: f.local, env: { ...f.env, [key]: '1' } });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout); assert.equal(report.route, 'local'); assert.equal(report.reason, reason);
  assert.equal(report.policyRoute, 'remote'); await f.unchanged();
});

test('CLI dry-run is a stable local-only report without daemon, baseline or writes', async t => {
  const f = await context(t);
  await fs.writeFile(join(f.local, 'source.txt'), 'synthetic source');
  await fs.writeFile(join(f.local, '.env'), 'FAKE_SECRET=not-read');
  const first = await f.run('sync', '--dry-run', '--json'), second = await f.run('sync', '--dry-run', '--json');
  assert.equal(first.code, 0, first.stderr); assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout); assert.equal(report.scope, 'local-only'); assert.equal(report.readiness.remote, 'not-checked');
  assert.deepEqual(report.included.map(item => item.path), ['source.txt']);
  assert.ok(report.excluded.some(item => item.path === '.env' && item.reason === 'minimum-security'));
  assert.equal(report.files.bytes, Buffer.byteLength('synthetic source')); await f.unchanged();
  const readable = await f.run('sync', '--dry-run'); assert.match(readable.stdout, /INCLUDE "source.txt"/); assert.match(readable.stdout, /EXCLUDE ".env"/);
  await f.unchanged();
});

test('CLI dry-run reports blockers and rejects an explicit change request without writes', async t => {
  const f = await context(t);
  await fs.symlink('/tmp', join(f.local, 'link'));
  const result = await f.run('sync', '--dry-run', '--json');
  assert.equal(result.code, 65, result.stderr); assert.equal(JSON.parse(result.stdout).readiness.ready, false);
  assert.deepEqual(JSON.parse(result.stdout).symlinks, ['link']);
  const mutate = await f.run('sync', '--dry-run', '--accept-local');
  assert.notEqual(mutate.code, 0); assert.match(mutate.stderr, /cannot accept changes/); await f.unchanged();
});

test('CLI read-only preflight also works before enable or setup', async t => {
  const f = await context(t); await fs.rm(join(f.local, '.reroute'), { recursive: true });
  const explain = await f.run('explain', '--json', '--', 'pnpm', 'test');
  assert.equal(explain.code, 0, explain.stderr); assert.equal(JSON.parse(explain.stdout).reason, 'project-not-enabled');
  const dryRun = await f.run('sync', '--dry-run', '--json');
  assert.equal(dryRun.code, 0, dryRun.stderr); assert.equal(JSON.parse(dryRun.stdout).files.count, 0);
  await assert.rejects(fs.stat(join(f.local, '.reroute')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(f.env.REROUTE_HOME), { code: 'ENOENT' });
});

for (const args of [['uninstall'], ['uninstall', '--harness', 'pi']]) test('CLI uninstall without a recorded installation is harmless: ' + args.join(' '), async t => {
  const f = await context(t), result = await f.run(...args);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).removed, []);
  await f.unchanged();
});
