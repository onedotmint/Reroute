import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Synchronizer } from '../../dist/sync/sync.js';
import { fixture, transport, policy } from '../helpers.mjs';

async function context(t) {
  const f=await fixture(t), files=transport(f.runtime), calls=[];
  const wrapped={...files,apply:async(changes,p)=>{calls.push(changes);return files.apply(changes,p);}};
  return {...f,files,calls,wrapped,sync:new Synchronizer(f.local,policy)};
}
test('small files use bounded existing apply batches; deletion batches precede writes',async t=>{
  const f=await context(t);
  for(let i=0;i<257;i++)await fs.writeFile(join(f.local,'file-'+i),'source-'+i);
  assert.equal((await f.sync.reconcile(f.wrapped)).pushed,257);assert.deepEqual(f.calls.map(x=>x.length),[128,128,1]);
  const base=JSON.parse(await fs.readFile(join(f.local,'.reroute/sync-base.json'),'utf8'));assert.equal(Object.keys(base).length,257);
  for(let i=0;i<257;i++)assert.equal(await fs.readFile(join(f.remote,'file-'+i),'utf8'),'source-'+i);
  f.calls.length=0;await fs.unlink(join(f.local,'file-0'));await fs.writeFile(join(f.local,'file-1'),'changed');
  await f.sync.reconcile(f.wrapped);assert.equal(f.calls[0][0].data,null);assert.notEqual(f.calls[1][0].data,null);
  assert.equal((await f.sync.reconcile(f.wrapped)).pushed,0);
});
test('batch byte limit bounds small files and permits one existing supported large file at a time',async t=>{
  const f=await context(t);
  for(let i=0;i<4;i++)await fs.writeFile(join(f.local,'file-'+i),Buffer.alloc(2*1024*1024,i));
  await f.sync.reconcile(f.wrapped);assert.deepEqual(f.calls.map(x=>x.length),[1,1,1,1]);
  for(const batch of f.calls)assert.ok(Buffer.byteLength(JSON.stringify(batch))<4*1024*1024);
});
test('a later batch failure retains the agreed baseline and retry converges without losing files',async t=>{
  const f=await context(t);await fs.writeFile(join(f.local,'base'),'base');await f.sync.reconcile(f.files);
  const baseline=await fs.readFile(join(f.local,'.reroute/sync-base.json'));
  for(let i=0;i<129;i++)await fs.writeFile(join(f.local,'new-'+i),'new');
  let applied=0;const failed={...f.files,apply:async(changes,p)=>{if(++applied===2)throw new Error('injected second batch loss');await f.files.apply(changes,p);}};
  await assert.rejects(f.sync.reconcile(failed),/second batch loss/);assert.equal(applied,2);
  assert.deepEqual(await fs.readFile(join(f.local,'.reroute/sync-base.json')),baseline);
  await f.sync.reconcile(f.files);assert.equal(Object.keys(await f.files.scan(policy)).length,130);
  assert.equal(await fs.readFile(join(f.local,'base'),'utf8'),'base');
});
