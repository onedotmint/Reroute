import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { providerFixture } from '../provider-fixtures.mjs';
import { fixture,policy,collect } from '../helpers.mjs';
import { DEFAULT_CONFIG } from '../../dist/config/config.js';
import { Synchronizer } from '../../dist/sync/sync.js';
import { skyTask } from '../../dist/providers/skypilot.js';
import { Coordinator } from '../../dist/core/coordinator.js';
for(const id of ['daytona','ssh','skypilot','modal','e2b']) test(id+' shared provider contract (native boundary fixtures, not live)',async t=>{
  const f=await fixture(t),{provider,records}=await providerFixture(id,f,t),spec={...DEFAULT_CONFIG.runtime};
  const runtime=await provider.ensureReady(f.project,spec);
  assert.equal(runtime.provider,id);assert.equal(runtime.projectId,f.project.id);assert.equal(typeof runtime.id,'string');
  assert.equal(await provider.status(runtime),'running');
  const again=await provider.ensureReady(f.project,spec,runtime);assert.equal(again.id,runtime.id);
  const sync=new Synchronizer(f.local,policy);await fs.writeFile(join(f.local,'source.txt'),'source');await sync.reconcile(provider.files(runtime));
  const handle=await provider.exec(runtime,{argv:['python3','-c',"import sys,pathlib; assert pathlib.Path('source.txt').read_text()=='source'; print(sys.stdin.read()); print('stderr',file=sys.stderr); pathlib.Path('lockfile').write_text('generated'); sys.exit(7)"],cwd:runtime.root,env:{}});
  const result=await collect(handle,'input');assert.equal(result.code,7);assert.equal(result.stdout.toString(),'input\n');assert.equal(result.stderr.toString(),'stderr\n');
  await sync.reconcile(provider.files(runtime));assert.equal(await fs.readFile(join(f.local,'lockfile'),'utf8'),'generated');
  const long=await provider.exec(runtime,{argv:['python3','-u','-c',"import time;print('ready');time.sleep(30)"],cwd:runtime.root,env:{}});
  await long.endInput();for await(const e of long.events){if(e.data.toString().includes('ready'))void long.cancel();}assert.equal((await long.wait()).cancelled,true);
  await provider.applyIdlePolicy(runtime,{active:true,minutes:10});await provider.applyIdlePolicy(runtime,{active:false,minutes:10});
  if(id==='daytona'){assert.equal(records.created.length,1);assert.deepEqual(records.idle.slice(-2),[0,10]);assert.equal(records.created[0].autoStopInterval,10);}
  if(id==='e2b'){assert.equal(records.created[0].lifecycle.onTimeout,'pause');assert.equal(records.created[0].timeoutMs,3600000);}
  if(id==='modal'){assert.ok(records.created[0].volumes[f.remote]);assert.equal(records.created[0].timeoutMs,86400000);}
  // Do not test automatic cloud provisioning in this suite. All native APIs above are fixtures.
  const unsupported=['cpu','diskGiB','spot','region'].find(k=>!provider.capabilities.resources.includes(k));
  if(unsupported)await assert.rejects(()=>provider.ensureReady(f.project,{...spec,[unsupported]:unsupported==='spot'?true:unsupported==='region'?'test':4}),/cannot honor/);
  await provider.destroy(runtime);await provider.destroy(runtime);
});
test('SkyPilot native resource units and provider-specific options',()=>{
  const task=skyTask({id:'x',root:'/local',name:'x'},{idleTimeoutMinutes:10,env:{CI:'1'},cpu:4,memoryMiB:8192,diskGiB:30,gpu:{type:'A100',count:2},spot:true},{infra:'aws',instanceType:'p4',diskTier:'high'});
  assert.equal(task.resources.memory,8);assert.equal(task.resources.disk_size,30);assert.equal(task.resources.use_spot,true);
});

test('graceful coordinator shutdown terminates Modal instead of abandoning its idle timer', async t => {
  const f = await fixture(t), oldHome = process.env.REROUTE_HOME;
  process.env.REROUTE_HOME = join(f.directory, 'home');
  const { provider, records } = await providerFixture('modal', f, t), core = new Coordinator(() => provider);
  t.after(async () => { await core.shutdown(); if (oldHome === undefined) delete process.env.REROUTE_HOME; else process.env.REROUTE_HOME = oldHome; });
  await core.enable(f.local, 'modal', {});
  const state = await core.start(f.local);
  assert.equal(provider.capabilities.nativeIdle, false);
  assert.equal(records.created[0].timeoutMs, 86400000);
  await core.shutdown();
  assert.equal(records.deleted, 1);
  assert.equal(await provider.status(state.runtime), 'stopped');
});
