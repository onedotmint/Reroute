import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModalProvider } from '../dist/providers/modal.js';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'reroute-modal-contract-')),old=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(root,'private');
 t.after(async()=>{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;await rm(root,{recursive:true,force:true});});
 const calls=[],items=[];let next=0,loseResponse=false;
 const api={
  apps:{fromName:async(name,options)=>{calls.push(['app',name,options]);return {appId:'ap-owned'};}},
  volumes:{fromName:async(name,options)=>{calls.push(['volume',name,options]);return {volumeId:'vo-owned'};}},
  images:{fromRegistry:image=>{calls.push(['image',image]);return {image};},fromId:async id=>({imageId:id})},
  sandboxes:{
   list:async function*(query){calls.push(['list',query]);for(const sb of items)if(!sb.stopped)yield sb;},
   fromId:async id=>{calls.push(['get',id]);const sb=items.find(s=>s.sandboxId===id);if(!sb)throw Error('not found');return sb;},
   create:async(app,image,params)=>{
    calls.push(['create',app,image,params]);const sb={sandboxId:'sb-'+(++next),stopped:false,tags:params.tags,
     getTags:async()=>({...sb.tags}),poll:async()=>sb.stopped?0:null,
     terminate:async options=>{calls.push(['terminate',sb.sandboxId,options]);sb.stopped=true;return 0;},detach:()=>{},
    };
    items.push(sb);if(loseResponse)throw Error('creation response lost');return sb;
   },
  },close:()=>{},
 };
 const sdk={ModalClient:class{constructor(){return api;}}};
 const profile={provider:'modal',id:'auto',image:'toolchain:reviewed',compute:{cpu:.5,memoryGiB:1.5},managed:{authorized:true}};
 const request={name:'rr-fixture',owner:'owner-fixture',create:true,start:true,guardMinutes:12};
 const provider=()=>new ModalProvider({...profile},async()=>sdk);
 return {api,calls,items,profile,request,provider,set loseResponse(value){loseResponse=value;}};
}
test('Modal creates an owned app/Sandbox/Volume with physical-core and memory hard limits and bounded lifetime',async t=>{
 const f=await fixture(t),p=f.provider(),resolved=await p.ensureManaged(f.request);
 const params=f.calls.find(c=>c[0]==='create')[3];
 assert.equal(params.cpu,.5);assert.equal(params.cpuLimit,.5);assert.equal(params.memoryMiB,1536);assert.equal(params.memoryLimitMiB,1536);
 assert.equal(params.timeoutMs,720000);assert.equal(params.idleTimeoutMs,undefined);assert.equal(params.name,'rr-fixture');
 assert.equal(params.tags['reroute-owner'],'owner-fixture');assert.equal(params.tags['reroute-managed'],'v3');assert.ok(Number(params.tags['reroute-expires-at'])>Date.now());
 assert.deepEqual(params.volumes,{'/var/reroute-cache':{volumeId:'vo-owned'}});
 assert.equal(f.calls[0][2].createIfMissing,true);assert.equal(resolved.id,'sb-1');assert.equal(resolved.app,'rr-owner-fixture');
 await p.guard(6);const before=f.calls.length;await p.idle(5);
 assert.deepEqual(f.calls.slice(before),[['terminate','sb-1',{wait:true}]]);assert.equal(f.items[0].stopped,true);
});
test('Modal response loss is recovered by owned tags without a second create or app/Volume creation',async t=>{
 const f=await fixture(t);f.loseResponse=true;
 await assert.rejects(f.provider().ensureManaged(f.request),/response lost/);assert.equal(f.items.length,1);
 const p=f.provider();const result=await p.ensureManaged({...f.request,create:false,start:false});assert.equal(result.id,'sb-1');
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.calls.filter(c=>c[0]==='volume').length,1);
 assert.equal(f.calls.filter(c=>c[0]==='app').at(-1)[2].createIfMissing,false);
 assert.equal(f.calls.some(c=>c[0]==='terminate'),false);
});
test('Modal refuses unknown allocations, changed ownership/specs, duplicates and insufficient lifetime without a replacement grant',async t=>{
 const f=await fixture(t);await assert.rejects(f.provider().ensureManaged({...f.request,create:false,start:false}),/unconfirmed/);
 const p=f.provider();await p.ensureManaged(f.request);
 f.items[0].tags['reroute-expires-at']=String(Date.now()+1000);
 await assert.rejects(p.guard(6),/cannot be extended/);
 await assert.rejects(p.ensureManaged({...f.request,create:false}),/remaining lifetime/);
 assert.equal(f.calls.some(c=>c[0]==='terminate'),false);
 f.items[0].tags['reroute-owner']='foreign';await assert.rejects(p.ensureManaged({...f.request,start:false}),/mismatch/);
 f.items[0].tags['reroute-owner']='owner-fixture';f.items.push({...f.items[0],sandboxId:'sb-foreign'});
 await assert.rejects(p.ensureManaged({...f.request,start:false}),/Multiple/);
});
test('Modal confirmed stopped allocation can be explicitly recovered then replaced, not resumed in place',async t=>{
 const f=await fixture(t),p=f.provider();await p.ensureManaged(f.request);f.items[0].stopped=true;f.calls.length=0;
 const recovered=await p.ensureManaged({...f.request,create:false,start:false});assert.equal(recovered.id,'sb-1');
 assert.equal(f.calls.some(c=>c[0]==='create'),false);
 await assert.rejects(p.ensureManaged({...f.request,create:false}),/Recover/);
 const next=await p.ensureManaged({...f.request,create:false,replaceStopped:true});assert.equal(next.id,'sb-2');
 await p.lifecycle('stop');assert.equal(f.items[1].stopped,true);
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1);
});
test('Modal replacement of an expired running allocation confirms termination before new compute',async t=>{
 const f=await fixture(t),p=f.provider();await p.ensureManaged(f.request);f.items[0].tags['reroute-expires-at']=String(Date.now()+1000);f.calls.length=0;
 await p.ensureManaged({...f.request,create:false,replaceStopped:true});
 assert.ok(f.calls.findIndex(c=>c[0]==='terminate')<f.calls.findIndex(c=>c[0]==='create'));
});
test('legacy Modal resume cannot duplicate live or uncertain compute, and checkpoints precede creation',async t=>{
 const f=await fixture(t);const legacy={provider:'modal',id:'sb-old',app:'existing',snapshot:'im-saved'};
 f.items.push({sandboxId:'sb-old',stopped:false,poll:async()=>f.items[0].stopped?0:null,detach:()=>{}});
 const sdk={ModalClient:class{constructor(){return f.api;}}};
 const p=new ModalProvider(legacy,async()=>sdk),checkpoint=async patch=>Object.assign(legacy,patch);
 await assert.rejects(p.lifecycle('resume',checkpoint),/still running/);assert.equal(f.calls.some(c=>c[0]==='create'),false);
 f.items[0].stopped=true;f.loseResponse=true;
 await assert.rejects(p.lifecycle('resume',checkpoint),/response lost/);assert.match(legacy.pendingResume,/^rr-resume-/);
 const attempts=f.calls.filter(c=>c[0]==='create').length;
 await assert.rejects(p.lifecycle('resume',checkpoint),/unconfirmed/);assert.equal(f.calls.filter(c=>c[0]==='create').length,attempts);
});
test('Modal binary output preserves split UTF-8 and rounds only transport timeouts to SDK whole seconds',async t=>{
 const f=await fixture(t),bytes=Buffer.from('中文'),stream=()=>new ReadableStream({start(c){c.enqueue(bytes.subarray(0,2));c.enqueue(bytes.subarray(2));c.close();}});
 const sb={poll:async()=>null,exec:async(_argv,options)=>{assert.equal(options.timeoutMs,2000);return {stdout:stream(),stderr:stream(),stdin:new WritableStream(),wait:async()=>7};},detach:()=>{}};
 const p=new ModalProvider({provider:'modal',id:'sb-text'},async()=>({ModalClient:class{sandboxes={fromId:async()=>sb};close(){}}}));
 const result=await p.exec('false',{timeoutMs:1100});assert.equal(result.stdout,'中文');assert.equal(result.stderr,'中文');assert.equal(result.code,7);
});


test('Modal exec preserves image PATH instead of reading PATH-resetting login profiles', async t => {
 await fixture(t);
 const root = await mkdtemp(join(tmpdir(), 'reroute-modal-path-'));
 t.after(() => rm(root, { recursive: true, force: true }));
 const imageBin = join(root, 'image-bin'), loginHome = join(root, 'home'), cargoHome = join(root, 'scratch-cargo');
 for (const dir of [imageBin, loginHome, cargoHome]) await mkdir(dir);
 await writeFile(join(loginHome, '.bash_profile'), 'PATH=/usr/bin:/bin\nexport PATH\n');
 await writeFile(join(imageBin, 'rustc'), '#!/bin/sh\nprintf "IMAGE_RUST_OK:%s\\n" "$CARGO_HOME"\n', { mode: 0o700 });
 const sb = {
  poll: async () => null, detach() {},
  exec: async (argv, options) => {
   assert.equal(options.mode, 'binary');
   const child = spawn(argv[0], argv.slice(1), {
    env: { HOME: loginHome, PATH: imageBin + ':/usr/bin:/bin', CARGO_HOME: cargoHome },
    stdio: ['pipe', 'pipe', 'pipe'],
   });
   const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
   return { stdin: Writable.toWeb(child.stdin), stdout: Readable.toWeb(child.stdout), stderr: Readable.toWeb(child.stderr), wait: () => done };
  },
 };
 const p = new ModalProvider({ provider: 'modal', id: 'sb-path' }, async () => ({ ModalClient: class {
  sandboxes = { fromId: async () => sb }; close() {}
 } }));
 t.after(() => p.close());
 const result = await p.exec('rustc');
 assert.equal(result.code, 0, result.stderr);
 assert.equal(result.stdout, 'IMAGE_RUST_OK:' + cargoHome + '\n');
 assert.equal(result.stderr, '');
});
