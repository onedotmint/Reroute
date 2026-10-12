import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Coordinator } from '../../dist/core/coordinator.js';
import { fixture, FixtureProvider } from '../helpers.mjs';

async function context(t) {
  const cleanup=[], f=await fixture({after:fn=>cleanup.push(fn)}), provider=new FixtureProvider(f.remote); provider.id='daytona';
  const oldHome=process.env.REROUTE_HOME;process.env.REROUTE_HOME=join(f.directory,'home');
  const original=provider.ensureReady.bind(provider);
  provider.ensureReady=async(...args)=>({...await original(...args),provider:'daytona',meta:{workspaceGeneration:'11111111-1111-4111-8111-111111111111'}});
  const core=new Coordinator(()=>provider); t.after(async()=>{
    try { await core.shutdown(); } finally { if(oldHome===undefined)delete process.env.REROUTE_HOME;else process.env.REROUTE_HOME=oldHome;for(const fn of cleanup.reverse())await fn(); }
  });
  return {...f,provider,core};
}
test('credentials and enable are not paid consent; denial precedes provider side effects',async t=>{
  const f=await context(t); await f.core.enable(f.local,'daytona',{});
  let status=0;f.provider.status=async()=>{status++;return 'running';};
  await assert.rejects(f.core.run({cwd:f.local,argv:['python3','-c','pass'],env:{}}),e=>e.code==='PAID_CONSENT');
  assert.equal(f.provider.readyCount,0);assert.equal(status,0);assert.deepEqual(f.provider.policies,[]);
  assert.equal((await f.core.status(f.local)).runtime,undefined);
  const before=(await f.core.store.all())[0].project.id;
  await f.core.enable(f.local,'daytona',{authorization:{paidProviders:['daytona']}});
  assert.equal((await f.core.store.all())[0].project.id,before);assert.equal(f.provider.readyCount,0);
  assert.equal((await f.core.run({cwd:f.local,argv:['python3','-c','pass'],env:{}})).code,0);
});
test('consent is provider-specific and pending migration never resumes compute',async t=>{
  const f=await context(t);await f.core.enable(f.local,'daytona',{authorization:{paidProviders:['modal']}});
  await assert.rejects(f.core.start(f.local),e=>e.code==='PAID_CONSENT');assert.equal(f.provider.readyCount,0);
  await f.core.enable(f.local,'daytona',{authorization:{paidProviders:['daytona']}});await f.core.start(f.local);
  const state=await f.core.store.all();state[0].syncPending=true;await f.core.store.save(state[0]);
  const cold=new Coordinator(()=>f.provider);t.after(()=>cold.shutdown());
  let restored=0;f.provider.state='stopped';f.provider.restore=async()=>{restored++;throw new Error('must not restore during setup');};
  await cold.status(f.local);await cold.enable(f.local,'daytona',{authorization:{paidProviders:[]}});
  assert.equal(restored,0);assert.equal((await cold.status(f.local)).syncPending,true);
  await assert.rejects(cold.synchronize(f.local),e=>e.code==='PAID_CONSENT');assert.equal(restored,0);
});
test('revoking consent does not prevent safe stop of already-running paid work',async t=>{
  const f=await context(t);await f.core.enable(f.local,'daytona',{authorization:{paidProviders:['daytona']}});await f.core.start(f.local);
  await f.core.enable(f.local,'daytona',{authorization:{paidProviders:[]}});
  await f.core.stop(f.local);assert.equal(f.provider.policies.at(-1).minutes,0);
  await assert.rejects(f.core.start(f.local),e=>e.code==='PAID_CONSENT');
});
test('ordinary stop of a clean stopped runtime never starts it for reconciliation',async t=>{
  const f=await context(t);await f.core.enable(f.local,'daytona',{authorization:{paidProviders:['daytona']}});await f.core.start(f.local);
  f.provider.state='stopped';let restores=0;f.provider.restore=async()=>{restores++;throw new Error('must not restart');};
  await f.core.stop(f.local);assert.equal(restores,0);assert.equal(f.provider.readyCount,1);
});

test('cold core enable validates the same config boundary before persisting identity or secrets',async t=>{
  const f=await context(t);
  await assert.rejects(f.core.enable(f.local,'daytona',{runtime:{env:{DAYTONA_API_KEY:'synthetic-not-a-real-key'}}}),e=>e.code==='SECRET_CONFIG');
  const { promises: fs }=await import('node:fs');
  await assert.rejects(fs.stat(join(f.local,'.reroute')), {code:'ENOENT'});assert.equal(f.provider.readyCount,0);
});
