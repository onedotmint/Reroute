import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, copyFile } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { tmpdir } from 'node:os';

const execute = promisify(execFile);
const hostRoot = process.env.REROUTE_TEST_DSH_ROOT;
const pnpm = process.env.REROUTE_TEST_PNPM;
const source = resolve('.');

test('real Harness installs the packed bundle, calls native/PTC tools and removes it without cloud or models', {
  skip: !hostRoot || !pnpm ? 'Set REROUTE_TEST_DSH_ROOT and REROUTE_TEST_PNPM to existing installations' : false,
  timeout: 240000,
}, async t => {
  const manifest = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.1-rc.5');
  const temp = await mkdtemp(join(tmpdir(), 'reroute-dsh-install-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const home = join(temp, 'home'), profile = join(home, 'profiles', 'probe'), project = join(temp, 'project');
  for (const dir of [profile, project, join(temp, 'bin')]) await mkdir(dir, { recursive: true });
  await symlink(resolve(pnpm), join(temp, 'bin', process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'));
  const env = {
    PATH: join(temp, 'bin') + delimiter + process.env.PATH, HOME: temp, USERPROFILE: temp, CI: 'true',
    DSH_HOME: home, DSH_AGENTS_HOME: join(temp, 'agents'), DSH_TELEMETRY_DISABLED: '1', COREPACK_ENABLE_NETWORK: '0',
    XDG_CONFIG_HOME: join(temp, 'config'), XDG_STATE_HOME: join(temp, 'state'), XDG_CACHE_HOME: join(temp, 'cache'),
    REROUTE_STATE_DIR: join(temp, 'reroute-state'), npm_config_userconfig: join(temp, 'npmrc'),
    npm_config_globalconfig: join(temp, 'global-npmrc'), npm_config_registry: 'https://registry.npmjs.org/',
    PROBE_HOST_ROOT: resolve(hostRoot),
  };
  await writeFile(env.npm_config_userconfig, ''); await writeFile(env.npm_config_globalconfig, '');
  const run = async (program, args, cwd = project) => {
    try { return await execute(program, args, { cwd, env, timeout: 150000, maxBuffer: 8 * 1024 * 1024 }); }
    catch (error) { assert.fail(`${program} ${args.join(' ')}: ${error.stderr || error.stdout || error.message}`); }
  };
  const packed = JSON.parse((await run('npm', ['pack', '--json', '--pack-destination', temp], source)).stdout);
  const packageInfo = Array.isArray(packed) ? packed[0] : packed['@onedotmint/reroute'];
  for (const path of ['dist/dsh.js', 'dist/tools.js', 'cordis.patch.yml']) assert.ok(packageInfo.files.some(file => file.path === path), path);
  assert.ok(!packageInfo.files.some(file => file.path.includes('node_modules/')));
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'reroute-dsh-integration', private: true, dsh: { profile: { bundles: [] } } }));
  const cli = join(hostRoot, 'lib', 'bin.js');
  await run(process.execPath, [cli, 'plugin', '--profile', 'probe', 'add', join(temp, packageInfo.filename), '--ignore-scripts']);
  const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(installed.dsh.profile.bundles, ['@onedotmint/reroute']);
  for (const name of ['dsh-tools', 'cordis', 'dsh-fs']) await assert.rejects(access(join(profile, 'node_modules', '@deepseek-ai', name)), { code: 'ENOENT' });

  const runner = join(temp, 'runner.mjs');
  await writeFile(runner, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
const require = createRequire(join(process.env.PROBE_HOST_ROOT, 'package.json'));
const { createToolResultMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href);
export const name = 'reroute-installed-checks';
export const inject = ['tools','sessions','appReady','appExit'];
export function apply(ctx) {
  ctx.effect(() => ctx.appReady.onReady(() => {
    check(ctx).then(() => ctx.appExit(0)).catch(error => { console.error(error); ctx.appExit(1); });
  }));
}
async function check(ctx) {
  assert.ok(ctx.tools.get('reroute_run')); assert.ok(ctx.tools.get('reroute_status'));
  const session = ctx.sessions.create('installed-session', { meta: { cwd: process.cwd() } });
  session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
  const agent = { id: session.id, session, ctx: ctx.root, inject() {} };
  let index = 0;
  async function call(name, args) {
    const callId = 'installed-' + ++index;
    session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) });
    const result = await ctx.tools.execute({ callId, name, arguments: args, agent, signal: new AbortController().signal });
    session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({ callId, content: result.content, isError: result.isError }) }, { surfaceOp: 'append' });
    return result;
  }
  const checks = ['installed bundle registers both production tools with host SDK'];
  if (process.env.PROBE_MODE === 'native') {
    const missing = await call('reroute_run', { command: 'cargo test' });
    assert.equal(missing.isError, false, JSON.stringify(missing));
    assert.equal(missing.value.status, 'not_started'); assert.match(missing.value.reason, /not-configured/);
    await writeFile(join(process.cwd(), '.reroute.json'), JSON.stringify({ version:3, active:'fixture', mode:'auto',
      profiles:{ fixture:{ provider:'ssh',id:'offline.invalid' } },tasks:['test'],remote:[],local:[],timeoutSeconds:10 }));
    const local = await call('reroute_run', { command: 'git status' });
    assert.equal(local.value.status, 'not_started'); assert.match(local.value.reason, /control-or-side-effect/);
    const unauthorized = await call('reroute_run', { command: 'cargo test' });
    assert.equal(unauthorized.value.status, 'not_started'); assert.match(unauthorized.value.reason, /authorization.*missing/);
    const unknown = await call('reroute_status', { jobId:'00000000-0000-4000-8000-000000000000' });
    assert.equal(unknown.value.remoteConfirmed, false); assert.equal(unknown.value.recordedStatus, null);
    const recovery = await call('reroute_status', {}); assert.equal(recovery.isError, true);
    checks.push('real shared boundary refuses missing config, local commands and missing consent', 'unknown status stays unconfirmed; no invented recovery Job');
  } else {
    const result = await call('run_code', { description:'Validate installed Reroute without executing a task',
      code:'const run = await tools.reroute_run({command:"git status"}); const status = await tools.reroute_status({jobId:"00000000-0000-4000-8000-000000000000"}); return {run,status};' });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.result.run.status, 'not_started');
    assert.equal(result.value.result.status.remoteConfirmed, false);
    checks.push('real Node PTC calls installed production adapter and retains JSON results');
  }
  await writeFile(process.env.PROBE_RESULT, JSON.stringify({ mode:process.env.PROBE_MODE, checks, modelCalls:0, providerCalls:0 }) + '\\n');
}
`);
  const baseRows = [
    { id: 'prompt', name: '@deepseek-ai/dsh-system-prompt' },
    { id: 'sessions', name: '@deepseek-ai/dsh-session' },
    { id: 'projections', name: '@deepseek-ai/dsh-session-projection' },
    { id: 'fs', name: '@deepseek-ai/dsh-fs-local', config: { cwd: project } },
    { id: 'cwd', name: '@deepseek-ai/dsh-working-directory', config: { defaultDirectory: project } },
    { id: 'policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: project } },
    { id: 'approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: 'ask' } },
    { id: 'subprocess', name: '@deepseek-ai/dsh-subprocess-local' },
    { id: 'sandbox', name: '@deepseek-ai/dsh-sandbox-local' },
    { id: 'ptc-runtime', name: '@deepseek-ai/dsh-ptc-runtime-node', config: { timeoutMs: 10000, maxTimeoutMs: 20000 } },
    { id: 'runner', name: runner },
  ];
  const results = [];
  for (const mode of ['native', 'ptc']) {
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [...baseRows, { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode } }] }]));
    env.PROBE_MODE = mode; env.PROBE_RESULT = join(temp, mode + '.json');
    await run(process.execPath, [cli, '--profile', 'probe']);
    results.push(JSON.parse(await readFile(env.PROBE_RESULT, 'utf8')));
  }
  await run(process.execPath, [cli, 'plugin', '--profile', 'probe', 'remove', '@onedotmint/reroute', '--ignore-scripts']);
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles, []);
  const artifacts = join(source, '.artifacts'); await mkdir(artifacts, { recursive: true });
  await copyFile(join(temp, packageInfo.filename), join(artifacts, packageInfo.filename));
  await writeFile(join(artifacts, 'dsh-integration.json'), JSON.stringify({ hostVersion: manifest.version, node: process.version,
    tarball: packageInfo.filename, integrity: packageInfo.integrity, installed: true, removed: true, hostSdksNotInstalled: true,
    fixtureOnly: true, realEngineExecution: false, results }, null, 2) + '\n');
});
