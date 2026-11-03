import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'shell-quote';
import { z } from 'zod';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools';
import Sessions, { Session } from '@deepseek-ai/dsh-session';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import FsLocal from '@deepseek-ai/dsh-fs-local';
import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
import SandboxPolicy, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import Approval, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import PlanMode from '@deepseek-ai/dsh-plan-mode';
import { name, inject, apply, registerHarness } from '../dist/dsh.js';
import { runRemote, inspectJob } from '../dist/engine.js';
import {
  defaults, saveConfig, authorizeProject, projectAuthorized, revokeProject,
  getJob, saveJob, jobPath,
} from '../dist/config.js';

// Component coverage: real Cordis services and native tool pipeline, no model or cloud Provider.
async function completed(command, options, patch = {}) {
  const job = {
    id: randomUUID(), project: options.root, profile: options.config.profiles[options.config.active],
    root: '/tmp/reroute-dsh-fixture', command, cwd: '.', createdAt: new Date().toISOString(),
    status: 'exited', code: 0, ...patch,
  };
  await saveJob(job);
  options.onJob?.(job);
  return { code: job.code ?? 125, stdout: 'fixture output', stderr: '', job };
}

async function fixture(t, options = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'reroute-dsh-')));
  const root = join(base, 'project');
  await mkdir(root);
  const oldState = process.env.REROUTE_STATE_DIR, oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.REROUTE_STATE_DIR = join(base, 'state');
  process.env.XDG_CONFIG_HOME = join(base, 'config');
  const ctx = new Context();
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally {
      if (oldState === undefined) delete process.env.REROUTE_STATE_DIR; else process.env.REROUTE_STATE_DIR = oldState;
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = oldConfig;
      await rm(base, { recursive: true, force: true });
    }
  });
  const config = { ...defaults(), active: 'fixture', profiles: {
    fixture: { provider: 'ssh', id: 'fixture.invalid', root: '/tmp/reroute-dsh-fixture' },
  } };
  await writeFile(join(root, 'package.json'), '{"name":"dsh-fixture"}');
  if (options.configured !== false) await saveConfig(root, config);
  if (options.authorized !== false) await authorizeProject(root, config);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools, { mode: 'native' });
  await ctx.plugin(Sessions);
  await ctx.plugin(SessionProjections);
  // The full agent-loop normally owns this projection; the fixture only opens/closes turns.
  ctx.sessionProjections.register({
    key: 'turnBoundary', stateVersion: 1,
    stateSchema: z.object({ openTurnStartSeq: z.number().nullable(), lastStepStartSeq: z.null(), lastStepBoundary: z.null(), lastTurn: z.number() }),
    init: () => ({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }),
    apply: (state, event) => event.type === 'turn/start'
      ? { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn }
      : event.type === 'turn/end' ? { ...state, openTurnStartSeq: null } : state,
  });
  await ctx.plugin(FsLocal, { cwd: root });
  await ctx.plugin(WorkingDirectory, { defaultDirectory: root });
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root });
  await ctx.plugin(Approval, { policy: 'ask' });
  await ctx.plugin(PlanMode, { section: 'Fixture plan mode: review only, do not execute.' });
  const approvals = [], executions = [];
  if (options.answer !== null) ctx.on('approval/request', async request => {
    approvals.push(request);
    return options.answer ? options.answer(request) : 'allowed-once';
  }, { global: true });
  const execute = async (command, runOptions) => {
    executions.push({ command, options: runOptions });
    return (options.execute ?? completed)(command, runOptions);
  };
  const inspect = options.inspect ?? (async () => assert.fail('Unexpected status query'));
  const mount = () => ctx.plugin({ name: 'test-reroute', inject, apply: ctx => registerHarness(ctx, execute, inspect) });
  const plugin = await mount();
  let ordinal = 0;
  const agent = (cwd = root) => {
    const session = ctx.sessions.create(undefined, { meta: { cwd } });
    session.append('turn/start', { turn: 1 });
    return { id: session.id, session, ctx: ctx.root, inject() {} };
  };
  const caller = agent();
  const call = (tool, args = {}, who = caller, signal = new AbortController().signal) => ctx.tools.execute({
    callId: `dsh-${++ordinal}`, name: tool, arguments: args, agent: who ?? undefined,
    signal: AbortSignal.any([signal, t.signal]),
  });
  return {
    base, root, config, ctx, plugin, mount, agent, caller, call, approvals, executions,
    run: (args = { command: 'cargo test' }, who = caller, signal) => call('reroute_run', args, who, signal),
    status: (args = {}, who = caller, signal) => call('reroute_status', args, who, signal),
  };
}

const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
function canonical(result) {
  assert.equal(result.isError, false, text(result));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.value));
  assert.deepEqual(JSON.parse(result.content[0].text), result.value);
  assert.deepEqual(JSON.parse(JSON.stringify(result.value)), result.value);
  for (const key of ['content', 'details', 'structuredContent', 'isError']) assert.equal(key in result.value, false);
  return result.value;
}
function refused(result, reason) {
  const value = canonical(result);
  assert.equal(value.status, 'not_started');
  assert.equal(value.exitCode, null);
  assert.equal(value.jobId, null);
  assert.match(value.reason, reason);
  return value;
}
function hostError(result, reason) {
  assert.equal(result.isError, true, text(result));
  assert.equal(result.value, undefined);
  assert.match(text(result), reason);
}
const confirmStored = async (id, action, options) => {
  assert.equal(action, 'status');
  const job = await getJob(id);
  assert.equal(options.project, job.project);
  assert.ok(options.signal instanceof AbortSignal);
  options.onConfirmed(job);
  return job;
};

// No dsh CLI, user npm-cache path, model, full agentLoop, or live remote credentials are needed.
test('Harness exports/registers native tools with canonical JSON through the real pre/post/result pipeline', async t => {
  assert.equal(typeof name, 'string');
  assert.equal(typeof apply, 'function');
  assert.deepEqual(inject, ['tools', 'fs', 'workingDirectory', 'sandboxPolicy', 'approval', 'systemPrompt']);
  const metrics = { inputBytes: 12, inputMs: 4, executionMs: 9, cacheHit: false };
  const f = await fixture(t, { execute: (command, options) => completed(command, options, { metrics }) });
  const schemas = f.ctx.tools.schemas();
  const run = schemas.find(tool => tool.name === 'reroute_run');
  const status = schemas.find(tool => tool.name === 'reroute_status');
  assert.deepEqual(Object.keys(run.parameters.properties), ['command', 'timeout', 'cpu', 'memoryGiB']);
  assert.deepEqual(run.parameters.required, ['command']);
  assert.equal(run.parameters.additionalProperties, undefined); // SDK parameter DSL is open by default.
  assert.deepEqual(Object.keys(status.parameters.properties), ['jobId']);
  assert.deepEqual(status.parameters.required ?? [], []);
  assert.equal(status.parameters.additionalProperties, undefined);
  assert.equal(run.execute, undefined);
  assert.equal(f.ctx.tools.get('bash'), undefined);
  const stages = [];
  f.ctx.on('tools/pre-execute', async (_exec, next) => { stages.push('pre'); return next(); });
  f.ctx.on('tools/post-execute', async (_exec, result, next) => {
    stages.push('post'); assert.equal(result.value.status, 'exited'); return next();
  });
  f.ctx.on('tools/result', (_exec, result) => { stages.push('result'); assert.ok(Object.isFrozen(result.value)); });
  const value = canonical(await f.run());
  assert.deepEqual(stages, ['pre', 'post', 'result']);
  assert.equal(value.status, 'exited'); assert.equal(value.exitCode, 0);
  assert.equal(value.stdout, 'fixture output'); assert.equal(value.stderr, '');
  assert.equal(value.reason, null); assert.equal(value.outputTruncated, false);
  assert.deepEqual(value.metrics, metrics); assert.ok(Object.isFrozen(value.metrics));
  assert.equal((await getJob(value.jobId)).project, f.root);
  assert.equal(f.approvals.length, 1); assert.equal(f.executions.length, 1);
  assert.match(f.approvals[0].reason, /Upload canonical project/);
  assert.ok(f.approvals[0].reason.includes(f.root));
  assert.match(f.approvals[0].reason, /trusted project scripts.*fees/);
});

test('routing, missing configuration and missing CLI project consent execute nothing and never grant consent', async t => {
  const f = await fixture(t, { authorized: false });
  for (const [command, reason] of [
    ['git status', /control-or-side-effect-command/], ['npm publish', /control-or-side-effect-command/],
    ['echo hello', /unknown-task/], ['cargo test | tee log', /complex-or-ambiguous-shell/],
    ['cargo test && cargo build', /complex-or-ambiguous-shell/],
  ]) refused(await f.run({ command }), reason);
  refused(await f.run(), /authorization.*approval.*missing/i);
  assert.equal(await projectAuthorized(f.root, f.config), false);
  await saveConfig(f.root, { ...f.config, mode: 'local' });
  refused(await f.run(), /local-mode/);
  await rm(join(f.root, '.reroute.json'));
  refused(await f.run(), /not-configured/);
  assert.equal(f.executions.length, 0); assert.equal(f.approvals.length, 0);
});

test('native argument validation and numeric boundaries reject before execution or approval', async t => {
  const f = await fixture(t);
  for (const args of [{}, { command: 5 }, { command: 'cargo test', cpu: '2' }]) {
    hostError(await f.run(args), /command|cpu|extra|argument|propert/i);
  }
  for (const args of [
    { command: ' ' }, { command: 'cargo test', timeout: 0 }, { command: 'cargo test', timeout: -1 },
    { command: 'cargo test', timeout: 86401 }, { command: 'cargo test', cpu: 0 },
    { command: 'cargo test', memoryGiB: -0.5 },
  ]) {
    const value = canonical(await f.run(args));
    assert.equal(value.status, 'failed'); assert.equal(value.jobId, null);
    assert.match(value.reason, /blank|timeout|positive/);
  }
  // The SDK rejects non-lossless JSON before the adapter can consume it.
  for (const key of ['timeout', 'cpu', 'memoryGiB']) for (const number of [NaN, Infinity, -Infinity]) {
    hostError(await f.run({ command: 'cargo test', [key]: number }), /JSON|finite|serializ|number/i);
  }
  assert.equal(f.executions.length, 0); assert.equal(f.approvals.length, 0);
  canonical(await f.run({ command: 'cargo test', timeout: 0.25, cpu: 0.125, memoryGiB: 0.5 }));
  const first = f.executions[0].options;
  assert.equal(first.timeoutMs, 250); assert.deepEqual(first.compute, { cpu: 0.125, memoryGiB: 0.5 });
  canonical(await f.run({ command: 'cargo test', timeout: 86400 }));
  assert.equal(f.executions[1].options.timeoutMs, 86400000);
  canonical(await f.run());
  assert.equal(f.executions[2].options.timeoutMs, undefined);
  assert.equal(f.executions[2].options.compute, undefined);
  canonical(await f.run({ command: 'cargo test', cwd: '/foreign', root: '/foreign', boundary: '/' }));
  assert.equal(f.executions[3].options.root, f.root);
  assert.equal(f.executions[3].options.cwd, f.root);
});

for (const outcome of ['rejected', 'unavailable', 'never']) {
  test(`real Harness approval ${outcome} fails closed, independent of existing project consent`, async t => {
    const f = await fixture(t, { answer: outcome === 'unavailable' ? null : () => 'rejected' });
    if (outcome === 'never') setApprovalPolicy(f.caller.session, 'never');
    refused(await f.run(), /authorization.*approval.*missing/i);
    assert.equal(f.executions.length, 0);
    assert.equal(f.approvals.length, outcome === 'rejected' ? 1 : 0);
    assert.equal(await projectAuthorized(f.root, f.config), true);
  });
}

test('allowed-once is requested afresh, and native pre-execute denial never enters Reroute', async t => {
  const f = await fixture(t);
  canonical(await f.run()); canonical(await f.run());
  assert.equal(f.approvals.length, 2); assert.equal(f.executions.length, 2);
  const release = f.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'deployment policy denied' }));
  hostError(await f.run(), /deployment policy denied/);
  release();
  assert.equal(f.approvals.length, 2); assert.equal(f.executions.length, 2);
  hostError(await f.run({ command: 'cargo test' }, null), /calling Agent Session/);
  hostError(await f.status({}, null), /calling Agent Session/);
  assert.equal(f.executions.length, 2);
});

test('pre-abort and cancellation while awaiting approval cannot start work', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, { answer: async request => {
    entered.resolve();
    await new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }));
    return 'allowed-once';
  } });
  const pre = new AbortController(); pre.abort();
  hostError(await f.run(undefined, f.caller, pre.signal), /abort|cancel/i);
  assert.equal(f.approvals.length, 0);
  const control = new AbortController();
  const pending = f.run(undefined, f.caller, control.signal);
  await entered.promise; control.abort();
  hostError(await pending, /abort|cancel/i);
  assert.equal(f.executions.length, 0);
});

for (const change of ['cwd', 'read-only', 'plan', 'revoke']) {
  test(`approval cannot authorize stale ${change} state`, async t => {
    let f;
    f = await fixture(t, { answer: async () => {
      if (change === 'cwd') await f.ctx.workingDirectory.set(f.caller, join(f.root, 'nested'));
      if (change === 'read-only') setSandboxMode(f.caller.session, 'read-only');
      if (change === 'plan') f.ctx.planMode.set(f.caller, true);
      if (change === 'revoke') await revokeProject(f.root);
      return 'allowed-once';
    } });
    await mkdir(join(f.root, 'nested'));
    const value = canonical(await f.run());
    assert.ok(['failed', 'not_started'].includes(value.status));
    assert.equal(value.jobId, null); assert.equal(f.executions.length, 0);
    assert.equal(f.approvals.length, 1);
  });
}

test('cwd, workspace and canonical aliases allow nested local work without widening the original boundary', async t => {
  const f = await fixture(t);
  const nested = join(f.root, 'nested'), alias = join(f.base, 'alias');
  await mkdir(nested); await symlink(f.root, alias, 'dir');
  const caller = f.agent(alias);
  await f.ctx.workingDirectory.set(caller, join(alias, 'nested'));
  canonical(await f.run(undefined, caller));
  assert.equal(f.executions[0].options.root, f.root);
  assert.equal(f.executions[0].options.cwd, nested);
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: caller.session }).workspaceRoot, alias);
  const sibling = join(f.base, 'project-other'); await mkdir(sibling);
  await f.ctx.workingDirectory.set(caller, sibling);
  hostError(await f.run(undefined, caller), /outside.*workspace/i);
  assert.equal(f.executions.length, 1);
});

test('outer configuration is not inherited across the workspace search boundary', async t => {
  const f = await fixture(t);
  const nested = join(f.root, 'package'); await mkdir(nested);
  // A malformed ancestor would throw if the adapter read it before bounding discovery.
  await writeFile(join(f.root, '.reroute.json'), '{PRIVATE_OUTSIDE_CONFIG');
  refused(await f.run(undefined, f.agent(nested)), /not-configured/);
  assert.equal(f.approvals.length, 0); assert.equal(f.executions.length, 0);
});

test('monorepo workspace narrower than Git root refuses before upload/approval, even with an inner config', async t => {
  const f = await fixture(t);
  await promisify(execFile)('git', ['init', '--quiet', f.root]);
  const nested = join(f.root, 'package'); await mkdir(nested);
  await saveConfig(nested, f.config); await authorizeProject(nested, f.config);
  const value = canonical(await f.run(undefined, f.agent(nested)));
  assert.equal(value.status, 'failed'); assert.equal(value.jobId, null);
  assert.match(value.reason, /Git project root.*outside.*boundary/);
  assert.equal(f.executions.length, 0); assert.equal(f.approvals.length, 0);
  canonical(await f.run());
  assert.equal(f.executions.length, 1);
});

for (const mapping of ['missing', 'different-world']) {
  test(`execution-world mapping ${mapping} cannot use a same-named host directory`, async t => {
    const f = await fixture(t);
    t.mock.method(f.ctx.fs, 'processPathFromHostPath', path => mapping === 'missing' ? undefined : '/remote' + path);
    hostError(await f.run(), /host-local|execution-world mapping/);
    hostError(await f.status({ jobId: randomUUID() }), /host-local|execution-world mapping/);
    assert.equal(f.executions.length, 0); assert.equal(f.approvals.length, 0);
  });
}

test('read-only, active plan and pending plan block new runs but permit scoped status without execution consent', async t => {
  const f = await fixture(t, { inspect: confirmStored });
  const run = canonical(await f.run());
  await revokeProject(f.root);
  setSandboxMode(f.caller.session, 'read-only');
  hostError(await f.run(), /read-only|plan mode/);
  assert.equal(canonical(await f.status({ jobId: run.jobId })).remoteConfirmed, true);
  setSandboxMode(f.caller.session, 'workspace-write');
  f.caller.session.append('plan/mode', { active: true });
  assert.equal(f.ctx.planMode.get(f.caller).active, true);
  hostError(await f.run(), /plan mode/);
  assert.equal(canonical(await f.status()).jobId, run.jobId);
  f.caller.session.append('plan/mode', { active: false });
  assert.equal(f.ctx.planMode.set(f.caller, true), 'queued');
  assert.deepEqual(f.ctx.planMode.get(f.caller), { active: false, pending: true });
  hostError(await f.run(), /plan mode/);
  assert.equal(f.executions.length, 1); assert.equal(f.approvals.length, 1);
});

test('bounded canonical output keeps split UTF-8 and truncation/metrics rather than a Pi result envelope', async t => {
  const f = await fixture(t, { execute: async (command, options) => {
    if (command === 'cargo build') return {
      ...await completed(command, options), stdout: 'x'.repeat(60000) + 'tail', stdoutTruncated: true,
    };
    const bytes = Buffer.from('你好');
    options.stdout(bytes.subarray(0, 2)); options.stdout(bytes.subarray(2));
    options.stderr(Buffer.from('diagnostic'));
    return completed(command, options, { metrics: { executionMs: 3 } });
  } });
  const utf8 = canonical(await f.run());
  assert.equal(utf8.stdout, '你好'); assert.equal(utf8.stderr, 'diagnostic');
  assert.equal(utf8.outputTruncated, false); assert.deepEqual(utf8.metrics, { executionMs: 3 });
  const value = canonical(await f.run({ command: 'cargo build' }));
  assert.equal(value.stdout.length, 8192); assert.ok(value.stdout.endsWith('tail'));
  assert.equal(value.outputTruncated, true);
});

for (const scenario of ['success', 'nonzero', 'timed_out', 'unknown', 'transport', 'upload']) {
  test(`real runRemote with mock Provider: ${scenario} preserves identity, closes, never retries locally`, async t => {
    let runs = 0, closed = 0;
    const actions = [];
    const receipt = scenario === 'nonzero' ? { status: 'exited', code: 7 }
      : scenario === 'timed_out' ? { status: 'timed_out', code: 124 } : { status: 'exited', code: 0 };
    const provider = {
      stdin: false, status: async () => 'running', close: async () => { closed++; },
      put: async () => { if (scenario === 'upload') throw Error('upload lost'); },
      exec: async (command, options) => {
        const action = parse(command)[3]; actions.push(action);
        if (action === 'stage') return { code: 0, stdout: '{"needed":[]}', stderr: '' };
        if (action === 'run') {
          runs++; options.stdout(Buffer.from('stdout')); options.stderr(Buffer.from('stderr'));
          if (scenario === 'transport') throw Error('transport lost');
          return { code: receipt.code, stdout: 'stdout', stderr: 'stderr' };
        }
        if (action === 'status') {
          if (['unknown', 'upload', 'transport'].includes(scenario)) throw Error('status lost');
          return { code: 0, stdout: JSON.stringify(receipt), stderr: '' };
        }
        return { code: 0, stdout: '{}', stderr: '' };
      },
    };
    const f = await fixture(t, { execute: (command, options) => runRemote(command, { ...options, provider }) });
    await writeFile(join(f.root, 'Makefile'), 'test:\n\ttouch LOCAL_RETRY_MARKER\n');
    const value = canonical(await f.run({ command: 'make test', timeout: 1 }));
    const uncertain = ['unknown', 'transport', 'upload'].includes(scenario);
    assert.equal(value.status, uncertain ? 'unknown' : receipt.status);
    assert.equal(value.exitCode, uncertain ? 125 : receipt.code);
    assert.match(value.jobId, /^[0-9a-f-]{36}$/);
    assert.equal((await getJob(value.jobId)).project, f.root);
    assert.equal(closed, 1); assert.equal(runs, scenario === 'upload' ? 0 : 1);
    assert.equal(actions.filter(action => action === 'run').length, runs);
    if (scenario !== 'upload') { assert.equal(value.stdout, 'stdout'); assert.equal(value.stderr, 'stderr'); }
    if (scenario === 'transport') assert.match(value.reason, /Transport\/output failed/);
    if (scenario === 'upload') assert.match(value.reason, /upload lost/);
    await assert.rejects(readFile(join(f.root, 'LOCAL_RETRY_MARKER')), /ENOENT/);
  });
}

test('native cancellation reaches real core, awaits Provider close, annotates hidden Job ID and recovers via status({})', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), releaseClose = Promise.withResolvers(), closing = Promise.withResolvers();
  let closed = false, observedAbort = false, runCalls = 0;
  let receipt = { status: 'running' };
  const provider = {
    stdin: false, status: async () => 'running', put: async () => {},
    close: async () => { closing.resolve(); await releaseClose.promise; closed = true; },
    exec: async (command, options) => {
      const action = parse(command)[3];
      if (action === 'stage') return { code: 0, stdout: '{"needed":[]}', stderr: '' };
      if (action === 'run') {
        runCalls++; entered.resolve();
        return new Promise(resolve => options.signal.addEventListener('abort', () => {
          observedAbort = true; resolve({ code: 130, stdout: '', stderr: '' });
        }, { once: true }));
      }
      if (action === 'cancel') receipt = { status: 'cancelled', code: 130 };
      return { code: 0, stdout: action === 'status' || action === 'cancel' ? JSON.stringify(receipt) : '{}', stderr: '' };
    },
  };
  t.after(() => releaseClose.resolve());
  const f = await fixture(t, {
    execute: (command, options) => runRemote(command, { ...options, provider }),
    inspect: (id, action, options) => inspectJob(id, action, { ...options, provider }),
  });
  await writeFile(join(f.root, 'Makefile'), 'test:\n\ttouch LOCAL_RETRY_MARKER\n');
  const control = new AbortController();
  let settled = false;
  const pending = f.run({ command: 'make test' }, f.caller, control.signal).then(result => { settled = true; return result; });
  await entered.promise; control.abort(new Error('fixture user cancellation'));
  await closing.promise;
  assert.equal(observedAbort, true); assert.equal(settled, false); assert.equal(closed, false);
  releaseClose.resolve();
  const result = await pending;
  assert.equal(closed, true); assert.equal(result.isError, true); assert.equal(result.value, undefined);
  assert.equal(result.error.info.code, TOOL_ABORTED);
  const jobId = text(result).match(/Job ID: ([0-9a-f-]{36})/)?.[1];
  assert.ok(jobId, 'finalizeContent must retain identity after SDK removes canonical value');
  assert.match(text(result), /does not prove remote termination/);
  assert.equal((await getJob(jobId)).status, 'cancelled');
  assert.equal(canonical(await f.status()).jobId, jobId);
  assert.equal(runCalls, 1);
  await assert.rejects(readFile(join(f.root, 'LOCAL_RETRY_MARKER')), /ENOENT/);
});

test('unload aborts and drains owned work, unregisters both tools, and rejects overlapping same-Session runs', { timeout: 10000 }, async t => {
  const entered = Promise.withResolvers(), aborted = Promise.withResolvers(), release = Promise.withResolvers();
  let cleaned = false;
  t.after(() => release.resolve());
  const f = await fixture(t, { execute: async (command, options) => {
    const result = await completed(command, options, { status: 'cancelled', code: 130 });
    entered.resolve();
    await new Promise(resolve => options.signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
    await release.promise; cleaned = true;
    return result;
  } });
  const pending = f.run(); await entered.promise;
  hostError(await f.run(), /Another Reroute run is active/);
  assert.equal(f.executions.length, 1);
  let disposed = false;
  const disposing = f.plugin.dispose().then(() => { disposed = true; });
  await aborted.promise;
  assert.equal(disposed, false); assert.equal(cleaned, false);
  release.resolve(); await disposing;
  assert.equal(cleaned, true);
  assert.equal(canonical(await pending).status, 'cancelled');
  assert.equal(f.ctx.tools.get('reroute_run'), undefined);
  assert.equal(f.ctx.tools.get('reroute_status'), undefined);
});

test('implicit latest-run recovery is Session-object/project scoped; explicit IDs survive adapter reload', async t => {
  const f = await fixture(t, { inspect: confirmStored });
  const first = canonical(await f.run());
  assert.equal(canonical(await f.status()).jobId, first.jobId);
  const second = canonical(await f.run());
  assert.equal(canonical(await f.status()).jobId, second.jobId);
  const newCaller = f.agent();
  hostError(await f.status({}, newCaller), /No recoverable.*live Session/);
  // Reusing a durable session ID is not reusing the same live Session object.
  const resumed = { ...f.caller, session: Session.create(f.caller.id, undefined, f.caller.session.header) };
  hostError(await f.status({}, resumed), /No recoverable.*live Session/);
  assert.equal(canonical(await f.status({ jobId: first.jobId }, newCaller)).jobId, first.jobId);
  const nested = join(f.root, 'independent'); await mkdir(nested); await saveConfig(nested, f.config);
  await f.ctx.workingDirectory.set(f.caller, nested);
  hostError(await f.status(), /No recoverable.*project/);
  const foreign = canonical(await f.status({ jobId: second.jobId }));
  assert.equal(foreign.recordedStatus, null); assert.equal(foreign.remoteConfirmed, false);
  await f.ctx.workingDirectory.set(f.caller, f.root);
  await f.plugin.dispose();
  await f.mount();
  hostError(await f.status(), /No recoverable.*live Session/);
  assert.equal(canonical(await f.status({ jobId: second.jobId })).jobId, second.jobId);
});

test('status never leaks invalid, mismatched or foreign records and accepts canonical project aliases', async t => {
  let inspections = 0;
  const f = await fixture(t, { inspect: async (...args) => { inspections++; return confirmStored(...args); } });
  const job = (await completed('cargo test', { root: f.root, config: f.config })).job;
  for (const jobId of ['', '../escape', randomUUID()]) {
    const value = canonical(await f.status({ jobId }));
    assert.equal(value.recordedStatus, null); assert.equal(value.exitCode, null);
    assert.equal(value.remoteConfirmed, false); assert.match(value.error, /Invalid job ID|Unknown job ID/);
  }
  await writeFile(jobPath(job.id), JSON.stringify({ ...job, id: randomUUID() }));
  assert.equal(canonical(await f.status({ jobId: job.id })).recordedStatus, null);
  const other = join(f.base, 'foreign'); await mkdir(other);
  await saveJob({ ...job, project: other, code: 23, error: 'PRIVATE_DIAGNOSTIC' });
  const foreign = await f.status({ jobId: job.id });
  assert.equal(canonical(foreign).recordedStatus, null);
  assert.doesNotMatch(text(foreign), /PRIVATE_DIAGNOSTIC|foreign/);
  assert.equal(inspections, 0);
  await saveJob(job);
  const alias = join(f.base, 'alias'); await symlink(f.root, alias, 'dir');
  assert.equal(canonical(await f.status({ jobId: job.id }, f.agent(alias))).remoteConfirmed, true);
  assert.equal(inspections, 1);
});

for (const scenario of ['confirmed-nonzero', 'resource-online-only', 'unreachable', 'unknown', 'malformed', 'transport', 'save-failed']) {
  test(`status distinguishes recorded history from real inspectJob remote confirmation: ${scenario}`, async t => {
    const calls = [];
    const provider = {
      status: async () => { calls.push('resource status'); return scenario === 'unreachable' ? 'stopped' : 'running'; },
      exec: async command => {
        const action = parse(command)[3]; assert.equal(action, 'status'); calls.push(action);
        if (scenario === 'transport') throw Error('status transport lost');
        return { code: 0, stdout: JSON.stringify(scenario === 'unknown' ? { status: 'unknown' }
          : scenario === 'malformed' ? { status: 'exited' } : { status: 'exited', code: 7 }), stderr: '' };
      },
      close: async () => { calls.push('close'); },
      put: async () => assert.fail('status must not upload'),
      get: async () => assert.fail('status must not download'),
      lifecycle: async () => assert.fail('status must not start/resume resources'),
    };
    const f = await fixture(t, { authorized: false, inspect: async (id, action, options) => {
      if (scenario !== 'save-failed') return inspectJob(id, action, { ...options, provider });
      const state = process.env.REROUTE_STATE_DIR;
      try {
        return await inspectJob(id, action, { ...options, provider, onConfirmed: job => {
          options.onConfirmed(job);
          process.env.REROUTE_STATE_DIR = join(f.base, 'blocked-state');
        } });
      } finally { process.env.REROUTE_STATE_DIR = state; }
    } });
    if (scenario === 'save-failed') await writeFile(join(f.base, 'blocked-state'), 'not a directory');
    const job = (await completed('cargo test', { root: f.root, config: f.config }, {
      status: 'exited', code: 0, error: 'historical diagnostic',
      ...(scenario === 'resource-online-only' ? { profile: { provider: 'e2b', id: 'existing-fixture' } } : {}),
    })).job;
    const value = canonical(await f.status({ jobId: job.id }));
    assert.equal(value.recordedStatus, 'exited'); assert.equal(value.recordedExitCode, 0);
    assert.equal(value.recordedError, 'historical diagnostic');
    const confirmed = ['confirmed-nonzero', 'save-failed'].includes(scenario);
    assert.equal(value.remoteConfirmed, confirmed); assert.equal(value.remoteStatus, confirmed ? 'exited' : null);
    assert.equal(value.exitCode, confirmed ? 7 : 0);
    if (scenario === 'confirmed-nonzero') assert.equal(value.error, null);
    else assert.ok(value.error);
    if (scenario === 'save-failed') {
      assert.match(value.error, /ENOTDIR/);
      assert.deepEqual(await getJob(job.id), job);
    }
    assert.equal('project' in value, false); assert.equal('profile' in value, false);
    assert.deepEqual(calls, ['resource status', ...(['resource-online-only', 'unreachable'].includes(scenario) ? [] : ['status']), 'close']);
    assert.equal(f.executions.length, 0); assert.equal(f.approvals.length, 0);
    assert.equal(await projectAuthorized(f.root, f.config), false);
  });
}
