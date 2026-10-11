import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Coordinator } from '../../dist/core/coordinator.js';
import { Lifecycle } from '../../dist/core/lifecycle.js';
import { SerialLane } from '../../dist/core/queue.js';
import { fixture, FixtureProvider } from '../helpers.mjs';
async function context(t) {
  const cleanup = [], f=await fixture({ after: fn => cleanup.push(fn) }), old=process.env.REROUTE_HOME;process.env.REROUTE_HOME=join(f.directory,'home');
  const provider=new FixtureProvider(f.remote),core=new Coordinator(()=>provider);
  t.after(async () => {
    try { await core.shutdown(); }
    finally { if(old===undefined)delete process.env.REROUTE_HOME;else process.env.REROUTE_HOME=old; for (const fn of cleanup.reverse()) await fn(); }
  });
  await core.store.enable(f.local,'ssh',{providers:{ssh:{host:'fixture'}}});
  return {...f,provider,core};
}
test('two agents share one runtime and serialize source mutations',async t=>{
  const f=await context(t);await fs.writeFile(join(f.local,'count'),'0');
  const input={cwd:f.local,argv:['python3','-c',"import pathlib,time; p=pathlib.Path('count');n=int(p.read_text());time.sleep(.1);p.write_text(str(n+1))"],env:{}};
  const result=await Promise.all([f.core.run(input),f.core.run(input)]);
  assert.deepEqual(result.map(x=>x.code),[0,0]);assert.equal(f.provider.readyCount,1);
  assert.equal(await fs.readFile(join(f.local,'count'),'utf8'),'2');
  assert.equal((await f.core.status(f.local)).active,0);
});
test('runtime failures never execute the local command',async t=>{
  const f=await context(t);f.provider.ensureReady=async()=>{throw new Error('fixture unavailable');};
  await assert.rejects(()=>f.core.run({cwd:f.local,argv:['python3','-c',"open('MUST_NOT_EXIST','w').write('local')"],env:{}}));
  await assert.rejects(fs.stat(join(f.local,'MUST_NOT_EXIST')),{code:'ENOENT'});
});
test('abort propagates to process and releases active lease',async t=>{
  const f=await context(t),abort=new AbortController();
  const result=await f.core.run({cwd:f.local,argv:['python3','-u','-c',"import time; print('ready');time.sleep(30)"],env:{}},{signal:abort.signal,onOutput:()=>abort.abort()});
  assert.equal(result.cancelled,true);assert.equal((await f.core.status(f.local)).active,0);
  assert.equal(f.provider.policies.at(-1).active,false);
});
test('nonzero command still reconciles its generated source',async t=>{
  const f=await context(t);const result=await f.core.run({cwd:f.local,argv:['python3','-c',"import sys;open('new.lock','w').write('generated');sys.exit(19)"],env:{}});
  assert.equal(result.code,19);assert.equal(await fs.readFile(join(f.local,'new.lock'),'utf8'),'generated');
});
test('destroy and recreate cannot interpret an empty runtime as local deletion',async t=>{
  const f=await context(t);await fs.writeFile(join(f.local,'source'),'valuable');
  await f.core.run({cwd:f.local,argv:['python3','-c','pass'],env:{}});await f.core.stop(f.local,true);
  f.provider.state='running';await f.core.run({cwd:f.local,argv:['python3','-c',"assert open('source').read()=='valuable'"],env:{}});
  assert.equal(await fs.readFile(join(f.local,'source'),'utf8'),'valuable');
});
test('dev lease survives client response and stops explicitly',async t=>{
  const f=await context(t);await f.core.devStart({cwd:f.local,argv:['python3','-u','-c',"import time;print('listening');time.sleep(30)"],env:{}},3000);
  let logs=''; const deadline=Date.now()+5000;
  while(!(logs=await f.core.devLogs(f.local)).includes('listening') && Date.now()<deadline) await sleep(20);
  assert.match(logs,/listening/);assert.equal((await f.core.status(f.local)).active,1);
  await f.core.devStop(f.local);assert.equal((await f.core.status(f.local)).active,0);
  assert.equal(f.provider.policies.at(-1).active,false);
});
test('idle callback queued before a new lease cannot stop active work',async()=>{
  const records=[],lane=new SerialLane();let idle=0;
  const provider={applyIdlePolicy:async(_r,p)=>{records.push({...p});}};
  const lifecycle=new Lifecycle(provider,{},0.001,()=>idle++,e=>{throw e;},op=>lane.run(op));
  await lifecycle.arm();
  await lane.run(async()=>{const release=await lifecycle.acquire();await sleep(90);assert.equal(idle,0);await release();});
  await sleep(100);assert.equal(idle,1);assert.equal(records.at(-1).minutes,0);lifecycle.dispose();
});

for (const action of ['stop', 'shutdown']) {
  test(`${action} cancels active and queued foreground/dev commands`, { timeout: 12000 }, async t => {
    const f = await context(t);
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const running = f.core.run({ cwd: f.local, argv: ['python3', '-u', '-c', "import time;print('ready');time.sleep(30)"], env: {} },
      { onOutput: event => { if (event.data.toString().includes('ready')) ready(); } });
    await started;
    const queued = f.core.run({ cwd: f.local, argv: ['python3', '-c', "open('MUST_NOT_EXIST','w').write('queued')"], env: {} });
    const queuedDev = f.core.devStart({ cwd: f.local, argv: ['python3', '-c', "open('DEV_MUST_NOT_EXIST','w').write('queued')"], env: {} });
    const rejected = [queued, queuedDev].map(promise => assert.rejects(promise, error => error.code === 'CANCELLED'));
    const before = Date.now();
    if (action === 'stop') await f.core.stop(f.local); else await f.core.shutdown();
    await Promise.all(rejected);
    assert.equal((await running).cancelled, true);
    assert.ok(Date.now() - before < 5000);
    for (const name of ['MUST_NOT_EXIST', 'DEV_MUST_NOT_EXIST']) await assert.rejects(fs.stat(join(f.remote, name)), { code: 'ENOENT' });
    if (action === 'stop') {
      assert.equal((await f.core.run({ cwd: f.local, argv: ['python3', '-c', 'pass'], env: {} })).code, 0);
    } else {
      await assert.rejects(f.core.run({ cwd: f.local, argv: ['python3', '-c', 'pass'], env: {} }), error => error.code === 'CANCELLED');
    }
  });
}

test('stop invalidates a command still preparing its runtime', { timeout: 12000 }, async t => {
  const f = await context(t);
  const ensure = f.provider.ensureReady.bind(f.provider);
  let ready, release;
  const preparing = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.provider.ensureReady = async (...args) => { ready(); await gate; return ensure(...args); };
  const running = f.core.run({ cwd: f.local, argv: ['python3', '-c', "open('MUST_NOT_EXIST','w').write('prepared')"], env: {} });
  const rejected = assert.rejects(running, error => error.code === 'CANCELLED');
  await preparing;
  const stopping = f.core.stop(f.local);
  // Wait until stop has reached the existing entry before releasing preparation.
  await sleep(50);
  release();
  await Promise.all([stopping, rejected]);
  await assert.rejects(fs.stat(join(f.remote, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
});

test('stop cancels an already-running dev and foreground command before dev cleanup', { timeout: 12000 }, async t => {
  const f = await context(t);
  await f.core.devStart({ cwd: f.local, argv: ['python3', '-u', '-c', "import time;print('dev-ready');time.sleep(30)"], env: {} });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = f.core.run({ cwd: f.local, argv: ['python3', '-u', '-c', "import pathlib,time;print('ready');time.sleep(3);pathlib.Path('MUST_NOT_EXIST').write_text('after stop')"], env: {} },
    { onOutput: event => { if (event.data.toString().includes('ready')) ready(); } });
  await started;
  const before = Date.now();
  await f.core.stop(f.local);
  assert.equal((await running).cancelled, true);
  assert.ok(Date.now() - before < 2500);
  await assert.rejects(fs.stat(join(f.remote, 'MUST_NOT_EXIST')), { code: 'ENOENT' });
  assert.equal((await f.core.status(f.local)).active, 0);
});

for (const action of ['stop', 'shutdown']) {
  for (const kind of ['foreground', 'dev']) {
    test(`${action} can cancel ${kind} while EOF never settles`, { timeout: 10000 }, async t => {
      const f = await context(t);
      let ready, ended;
      const preparing = new Promise(resolve => { ready = resolve; });
      const done = new Promise(resolve => { ended = resolve; });
      const events = { async *[Symbol.asyncIterator]() { await done; } };
      let cancelled = 0;
      f.provider.exec = async () => {
        await fs.writeFile(join(f.remote, 'generated.lock'), 'during startup');
        return { events, write: async () => {}, endInput: () => { ready(); return new Promise(() => {}); },
          wait: () => done, cancel: async () => { cancelled++; ended({ code: 143, cancelled: true }); } };
      };
      const input = { cwd: f.local, argv: ['python3', '-c', 'pass'], env: {} };
      const starting = kind === 'dev' ? f.core.devStart(input) : f.core.run(input);
      const outcome = starting.then(result => ({ result }), error => ({ error }));
      await preparing;
      if (action === 'stop') await f.core.stop(f.local); else await f.core.shutdown();
      const result = await outcome;
      assert.ok(cancelled > 0);
      if (kind === 'dev') assert.equal(result.error?.code, 'CANCELLED');
      else assert.equal(result.result?.cancelled, true);
      assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'during startup');
      assert.equal((await f.core.status(f.local)).active, 0);
    });
  }
}

for (const kind of ['foreground', 'dev']) {
  test(`destroy during ${kind} provider startup preserves generated source`, { timeout: 10000 }, async t => {
    const f = await context(t);
    let started, release, ended;
    const preparing = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const done = new Promise(resolve => { ended = resolve; });
    t.after(() => release());
    f.provider.exec = async () => {
      await fs.writeFile(join(f.remote, 'generated.lock'), 'during startup');
      started(); await gate;
      return { events: { async *[Symbol.asyncIterator]() { await done; } }, write: async () => {}, endInput: async () => {},
        wait: () => done, cancel: async () => { ended({ code: 143, cancelled: true }); } };
    };
    try {
      const input = { cwd: f.local, argv: ['python3', '-c', 'pass'], env: {} };
      const outcome = (kind === 'dev' ? f.core.devStart(input) : f.core.run(input)).then(result => ({ result }), error => ({ error }));
      await preparing;
      const stopping = f.core.stop(f.local, true);
      const entry = await [...f.core.entries.values()][0];
      while (!entry.stopping) await sleep(1);
      release(); await stopping;
      assert.equal((await outcome).error?.code, 'CANCELLED');
      assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'during startup');
      await assert.rejects(fs.stat(f.remote), { code: 'ENOENT' });
    } finally { release(); }
  });
}

test('destroy refuses unresolved source conflicts and preserves the runtime', async t => {
  const f = await context(t);
  await fs.writeFile(join(f.local, 'source'), 'base');
  await f.core.run({ cwd: f.local, argv: ['python3', '-c', 'pass'], env: {} });
  await fs.writeFile(join(f.local, 'source'), 'local');
  await fs.writeFile(join(f.remote, 'source'), 'remote');
  await assert.rejects(f.core.stop(f.local, true), error => error.code === 'SYNC_CONFLICT');
  assert.equal(await fs.readFile(join(f.local, 'source'), 'utf8'), 'local');
  assert.equal(await fs.readFile(join(f.remote, 'source'), 'utf8'), 'remote');
  assert.ok((await f.core.status(f.local)).runtime);
});

test('new identity cannot discard an owned runtime, even on a cold coordinator', async t => {
  const f = await context(t), state = await f.core.start(f.local);
  const id = state.project.id, runtime = state.runtime.id;
  const cold = new Coordinator(() => f.provider);
  t.after(() => cold.shutdown());
  for (const core of [f.core, cold]) {
    for (const provider of ['ssh', 'daytona']) {
      await assert.rejects(core.enable(f.local, provider, {}, true), error => error.code === 'PROJECT_RUNTIME');
      assert.equal((await core.status(f.local)).project.id, id);
      assert.equal((await core.status(f.local)).runtime, runtime);
    }
  }
  assert.equal((await f.core.store.all()).length, 1);
});

test('new identity retires only its owned index and recovery ignores legacy stale indexes', async t => {
  const f = await context(t), state = structuredClone(await f.core.start(f.local));
  await f.core.stop(f.local, true);
  const next = await f.core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture' } } }, true);
  assert.notEqual(next.project.id, state.project.id);
  assert.deepEqual((await f.core.store.all()).map(item => item.project.id), [next.project.id]);
  await fs.writeFile(join(process.env.REROUTE_HOME, 'projects', state.project.id + '.json'), JSON.stringify(state));
  f.provider.state = 'running';
  const readyCount = f.provider.readyCount;
  await f.core.recover();
  assert.equal(f.provider.readyCount, readyCount);
  assert.equal((await f.core.status(f.local)).runtime, undefined);
});

test('copied project can acquire a new identity without destroying the original runtime', async t => {
  const f = await context(t), original = await f.core.start(f.local);
  const copy = join(f.directory, 'copy');
  await fs.mkdir(join(copy, '.reroute'), { recursive: true });
  await fs.copyFile(join(f.local, '.reroute/project.json'), join(copy, '.reroute/project.json'));
  const next = await f.core.enable(copy, 'ssh', { providers: { ssh: { host: 'fixture' } } }, true);
  assert.notEqual(next.project.id, original.project.id);
  assert.equal(next.runtime, undefined);
  assert.equal((await f.core.status(f.local)).runtime, original.runtime.id);
  assert.equal((await f.core.store.all()).length, 2);
});

test('graceful shutdown keeps the configured idle deadline when the provider owns it', async t => {
  const f = await context(t);
  f.provider.capabilities.nativeIdle = true;
  f.provider.capabilities.idle = 'stop';
  await f.core.start(f.local);
  await f.core.shutdown();
  assert.deepEqual(f.provider.policies.at(-1), { active: false, minutes: 10 });
});

for (const nativeIdle of [false, true]) {
  test(`failed return sync holds local and native idle cleanup (nativeIdle=${nativeIdle}) until recovery`, async t => {
    const f = await context(t);
    f.provider.capabilities.nativeIdle = nativeIdle;
    f.provider.capabilities.idle = 'terminate';
    await f.core.enable(f.local, 'ssh', { providers: { ssh: { host: 'fixture' } }, runtime: { idleTimeoutMinutes: 0.001 } });
    const files = f.provider.files.bind(f.provider), idle = f.provider.applyIdlePolicy.bind(f.provider);
    let blocked = true;
    f.provider.files = runtime => {
      const transport = files(runtime);
      return { ...transport, scan: async policy => {
        const manifest = await transport.scan(policy);
        if (blocked && manifest['generated.lock']) throw new Error('injected return-sync failure');
        return manifest;
      } };
    };
    f.provider.applyIdlePolicy = async (runtime, policy) => { await idle(runtime, policy); if (!policy.active && policy.minutes === 0) await f.provider.destroy(runtime); };
    await assert.rejects(f.core.run({ cwd: f.local, argv: ['python3', '-c', "open('generated.lock','w').write('valuable')"], env: {} }));
    assert.equal((await f.core.status(f.local)).syncPending, true);
    assert.equal(JSON.parse(await fs.readFile(join(f.local, '.reroute/project.json'))).syncPending, true);
    await sleep(150);
    assert.equal(await fs.readFile(join(f.remote, 'generated.lock'), 'utf8'), 'valuable');
    assert.equal(f.provider.policies.some(policy => !policy.active), false);
    blocked = false;
    await f.core.synchronize(f.local);
    assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'valuable');
    assert.equal((await f.core.status(f.local)).syncPending, false);
    await sleep(150);
    await assert.rejects(fs.stat(f.remote), { code: 'ENOENT' });
  });
}

test('pending source survives shutdown/recovery without rearming destructive native idle', async t => {
  const f = await context(t);
  f.provider.capabilities.nativeIdle = true;
  f.provider.capabilities.idle = 'terminate';
  const files = f.provider.files.bind(f.provider);
  let blocked = true;
  f.provider.files = runtime => {
    const transport = files(runtime);
    return { ...transport, scan: async policy => {
      const manifest = await transport.scan(policy);
      if (blocked && manifest['generated.lock']) throw new Error('injected return-sync failure');
      return manifest;
    } };
  };
  await assert.rejects(f.core.run({ cwd: f.local, argv: ['python3', '-c', "open('generated.lock','w').write('valuable')"], env: {} }));
  await f.core.shutdown();
  assert.equal(f.provider.policies.some(policy => !policy.active), false);
  const cold = new Coordinator(() => f.provider), readyCount = f.provider.readyCount;
  try {
    await cold.recover();
    assert.equal(f.provider.readyCount, readyCount, 'pending recovery must reuse the recorded runtime without ensureReady');
    assert.equal((await cold.status(f.local)).syncPending, true);
    assert.equal(f.provider.policies.some(policy => !policy.active), false);
    blocked = false;
    await cold.synchronize(f.local);
    assert.equal(await fs.readFile(join(f.local, 'generated.lock'), 'utf8'), 'valuable');
    assert.equal((await cold.status(f.local)).syncPending, false);
  } finally { await cold.shutdown(); }
});

for (const status of ['stopped', 'unknown']) {
  test(`destroy refuses to skip source reconciliation for a ${status} runtime`, async t => {
    const f = await context(t), state = await f.core.start(f.local);
    await fs.writeFile(join(f.remote, 'generated.lock'), 'valuable');
    f.provider.state = status;
    await assert.rejects(f.core.stop(f.local, true), error => error.code === (status === 'unknown' ? 'RUNTIME_UNKNOWN' : 'SOURCE_PENDING'));
    assert.equal(await fs.readFile(join(f.remote, 'generated.lock'), 'utf8'), 'valuable');
    assert.equal((await f.core.status(f.local)).runtime, state.runtime.id);
  });
}
