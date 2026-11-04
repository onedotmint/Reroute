import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'shell-quote';
import { inject, registerHarness } from '../dist/dsh.js';
import { runRemote, inspectJob } from '../dist/engine.js';
import { defaults, saveConfig, authorizeProject, getJob } from '../dist/config.js';

const hostRoot = process.env.REROUTE_TEST_DSH_ROOT;
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

// Real Node PTC subprocess/bridge and real engine, but never a network Provider or model.
for (const cancellation of ['subcall', 'outer run_code']) {
  test(`real Node PTC ${cancellation} cancellation drains the allocated Job and recovers via status({})`, {
    skip: !hostRoot ? 'Set REROUTE_TEST_DSH_ROOT to an existing DSH 0.2.1-rc.5 installation' : false,
    timeout: 30000,
  }, async t => {
    assert.equal(JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8')).version, '0.2.1-rc.5');
    const require = createRequire(join(hostRoot, 'package.json'));
    const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)).href);
    const { Context } = await load('cordis');
    const { TOOL_ABORTED } = await load('dsh-tools');
    const { createToolResultMessage } = await load('dsh-llm');
    const ctx = new Context();
    const base = await realpath(await mkdtemp(join(tmpdir(), 'reroute-ptc-cancel-')));
    const root = join(base, 'project'); await mkdir(root);
    const oldState = process.env.REROUTE_STATE_DIR, oldConfig = process.env.XDG_CONFIG_HOME;
    process.env.REROUTE_STATE_DIR = join(base, 'state');
    process.env.XDG_CONFIG_HOME = join(base, 'config');
    const entered = Promise.withResolvers(), closing = Promise.withResolvers(), releaseClose = Promise.withResolvers();
    const control = new AbortController();
    t.after(async () => {
      control.abort(); releaseClose.resolve();
      try { await ctx.fiber.dispose(); }
      finally {
        if (oldState === undefined) delete process.env.REROUTE_STATE_DIR; else process.env.REROUTE_STATE_DIR = oldState;
        if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
        await rm(base, { recursive: true, force: true });
      }
    });
    for (const [name, config] of [
      ['dsh-system-prompt', {}], ['dsh-tools', { mode: 'ptc' }],
      ['dsh-session', {}], ['dsh-session-projection', {}],
      ['dsh-fs-local', { cwd: root }], ['dsh-working-directory', { defaultDirectory: root }],
      ['dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: root }],
      ['dsh-user-approval', { policy: 'ask' }],
      ['dsh-subprocess-local', {}], ['dsh-sandbox-local', {}],
      ['dsh-ptc-runtime-node', { timeoutMs: 10000, maxTimeoutMs: 20000 }],
    ]) await ctx.plugin((await load(name)).default, config);
    const config = { ...defaults(), active: 'fixture', profiles: {
      fixture: { provider: 'ssh', id: 'fixture.invalid', root: '/tmp/reroute-ptc-fixture' },
    } };
    await writeFile(join(root, 'package.json'), '{"name":"ptc-cancellation-fixture"}');
    await writeFile(join(root, 'Makefile'), 'test:\n\ttouch LOCAL_RETRY_MARKER\n');
    await saveConfig(root, config); await authorizeProject(root, config);
    let approvals = 0, runs = 0, closed = 0, observedAbort = false, jobId;
    let receipt = { status: 'running' };
    const actions = [];
    const provider = {
      stdin: false, status: async () => 'running', put: async () => {},
      close: async () => { closing.resolve(); await releaseClose.promise; closed++; },
      exec: async (command, options) => {
        const action = parse(command)[3]; actions.push(action);
        if (action === 'stage') return { code: 0, stdout: '{"needed":[]}', stderr: '' };
        if (action === 'run') {
          runs++; entered.resolve();
          return new Promise(resolve => options.signal.addEventListener('abort', () => {
            observedAbort = true; resolve({ code: 130, stdout: '', stderr: '' });
          }, { once: true }));
        }
        if (action === 'cancel') receipt = { status: 'cancelled', code: 130 };
        return { code: 0, stdout: ['status', 'cancel'].includes(action) ? JSON.stringify(receipt) : '{}', stderr: '' };
      },
    };
    ctx.on('approval/request', async () => { approvals++; return 'allowed-once'; }, { global: true });
    if (cancellation === 'subcall') ctx.on('tools/execute', async (exec, next) => {
      const original = exec.signal;
      if (exec.name === 'reroute_run') exec.signal = AbortSignal.any([original, control.signal]);
      try { return await next(); } finally { exec.signal = original; }
    }, { global: true });
    await ctx.plugin({ name: 'reroute-ptc-test', inject, apply: scope => registerHarness(scope,
      (command, options) => runRemote(command, { ...options, provider, onJob: job => { jobId = job.id; options.onJob?.(job); } }),
      (id, action, options) => inspectJob(id, action, { ...options, provider }),
    ) });
    const dispatches = [];
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/ptc-dispatch') dispatches.push(event);
    }, { global: true });
    const session = ctx.sessions.create(undefined, { meta: { cwd: root } });
    session.append('turn/start', { turn: 1 }); session.append('step/start', { turn: 1, step: 1 });
    const agent = { id: session.id, session, ctx: ctx.root, inject() {} };
    let index = 0;
    async function call(code, signal = new AbortController().signal) {
      const callId = 'ptc-cancel-' + ++index, args = { description: 'Isolated Reroute cancellation verification', code };
      session.append('tool/call', { turn: 1, step: 1, callId, name: 'run_code', arguments: JSON.stringify(args) });
      const result = await ctx.tools.execute({ callId, name: 'run_code', arguments: args, agent, signal: AbortSignal.any([signal, t.signal]) });
      session.append('tool/result', { turn: 1, step: 1,
        message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
      }, { surfaceOp: 'append' });
      return result;
    }
    let settled = false;
    const pending = call(`
      try { return { unexpected: await tools.reroute_run({ command: 'make test' }) }; }
      catch (error) { return { name: error.name, toolName: error.toolName, message: error.message }; }
    `, cancellation === 'outer run_code' ? control.signal : undefined).then(result => { settled = true; return result; });
    await entered.promise;
    assert.match(jobId, /^[0-9a-f-]{36}$/);
    control.abort(new Error('fixture user cancellation'));
    await closing.promise;
    assert.equal(observedAbort, true); assert.equal(settled, false); assert.equal(closed, 0);
    releaseClose.resolve();
    const result = await pending;
    assert.equal(closed, 1);
    if (cancellation === 'subcall') {
      assert.equal(result.isError, false, text(result));
      assert.equal(result.value.result.name, 'ToolCallError');
      assert.equal(result.value.result.toolName, 'reroute_run');
      assert.match(result.value.result.message, /abort|cancel/i);
      assert.ok(!JSON.stringify(result.value.result).includes(jobId), 'PTC error must not pretend to retain the canonical Job');
      assert.equal(result.value.result.unexpected, undefined);
    } else {
      assert.equal(result.isError, true, text(result));
      assert.equal(result.value, undefined);
      assert.equal(result.error.info.code, 'CODE_RUN_FAILED');
      assert.match(text(result), /code run failed \(abort\)/);
    }
    const cancelled = dispatches.find(event => event.data.name === 'reroute_run');
    assert.ok(cancelled, 'cancelled nested dispatch is logged before run_code settles');
    assert.equal(cancelled.data.isError, true); assert.equal(cancelled.data.error.code, TOOL_ABORTED);
    assert.ok(text(cancelled.data).includes(jobId), 'native dispatch text retains the allocated Job ID');
    assert.equal((await getJob(jobId)).status, 'cancelled');
    const beforeStatus = actions.length;
    const recovered = await call('return await tools.reroute_status({});');
    assert.equal(recovered.isError, false, text(recovered));
    assert.equal(recovered.value.result.jobId, jobId);
    assert.equal(recovered.value.result.recordedStatus, 'cancelled');
    assert.equal(recovered.value.result.remoteConfirmed, true);
    assert.equal(recovered.value.result.remoteStatus, 'cancelled');
    assert.equal(recovered.value.result.exitCode, 130);
    assert.deepEqual(actions.slice(beforeStatus), ['status']);
    assert.equal(runs, 1); assert.equal(approvals, 1); assert.equal(closed, 2);
    await assert.rejects(readFile(join(root, 'LOCAL_RETRY_MARKER')), /ENOENT/);
  });
}
