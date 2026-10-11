import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Synchronizer, scanLocal } from '../../dist/sync/sync.js';
import { execute } from '../../dist/providers/channel.js';
import { spawnRaw } from '../../dist/platform/process.js';
import { fixture, policy, exec, collect, transport } from '../helpers.mjs';
test('real worker preserves argv cwd env stdout stderr and nonzero exit',async t=>{
  const f=await fixture(t), handle=await exec(f.runtime,['python3','-c',"import os,sys,json; print(json.dumps([os.getcwd(),os.getenv('INLINE'),sys.argv[1]])); print('bad',file=sys.stderr); sys.exit(17)","quote'\nspace"],{env:{INLINE:'value'}});
  const result=await collect(handle); assert.equal(result.code,17); assert.equal(result.stderr.toString(),'bad\n');
  assert.deepEqual(JSON.parse(result.stdout.toString()),[f.remote,'value',"quote'\nspace"]);
});
test('binary stdin streams without UTF-8 corruption',async t=>{
  const f=await fixture(t), input=randomBytes(256*1024), handle=await exec(f.runtime,['python3','-c','import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())']);
  const result=await collect(handle,input); assert.equal(result.code,0); assert.deepEqual(result.stdout,input);
});
test('stdout arrives before the process exits',async t=>{
  const f=await fixture(t), handle=await exec(f.runtime,['python3','-u','-c',"import time; print('first'); time.sleep(.2); print('last')"]);
  await handle.endInput(); let done=false; void handle.wait().then(()=>done=true);
  let output=''; for await(const event of handle.events){if(!output)assert.equal(done,false);output+=event.data.toString();}
  assert.equal(output,'first\nlast\n'); assert.equal((await handle.wait()).code,0);
});
test('timeout kills real process and preserves classification',async t=>{
  const f=await fixture(t), handle=await exec(f.runtime,['python3','-c','import time;time.sleep(30)'],{timeoutMs:150});
  const result=await collect(handle);assert.equal(result.timedOut,true);assert.notEqual(result.code,0);
});
test('cancel kills process group and waits for cleanup',async t=>{
  const f=await fixture(t), marker=join(f.remote,'leak');
  const handle=await exec(f.runtime,['python3','-u','-c',`import subprocess,time; subprocess.Popen(['sh','-c','sleep 1; echo bad > ${marker}']); print('ready'); time.sleep(30)`]);
  await handle.endInput(); for await(const event of handle.events){if(event.data.toString().includes('ready'))void handle.cancel();}
  const result=await handle.wait();assert.equal(result.cancelled,true);
  await new Promise(r=>setTimeout(r,1200));await assert.rejects(fs.stat(marker),{code:'ENOENT'});
});
test('transport disappearance fails closed rather than returns success',async t=>{
  const f=await fixture(t); const launch=async()=>spawnRaw('python3',['-c','import sys;sys.exit(9)']);
  await assert.rejects(()=>execute(launch,f.runtime,{argv:['true'],cwd:f.remote,env:{}}),/without a confirmed result/);
});
test('source push, remote formatter/lockfile pull, runtime cache exclusion',async t=>{
  const f=await fixture(t), sync=new Synchronizer(f.local,policy), files=transport(f.runtime);
  await fs.writeFile(join(f.local,'source.txt'),'original');await fs.writeFile(join(f.local,'.env'),'DO_NOT_TRANSFER');
  await fs.mkdir(join(f.local,'node_modules'));await fs.writeFile(join(f.local,'node_modules/a'),'large cache');
  assert.deepEqual(await sync.reconcile(files),{pushed:1,pulled:0});
  await fs.writeFile(join(f.remote,'source.txt'),'formatted');await fs.writeFile(join(f.remote,'package-lock.json'),'{}');
  await fs.mkdir(join(f.remote,'target'));await fs.writeFile(join(f.remote,'target/a'),'compiled');
  assert.deepEqual(await sync.reconcile(files),{pushed:0,pulled:2});
  assert.equal(await fs.readFile(join(f.local,'source.txt'),'utf8'),'formatted');
  await assert.rejects(fs.stat(join(f.remote,'.env')),{code:'ENOENT'});await assert.rejects(fs.stat(join(f.local,'target')),{code:'ENOENT'});
  assert.deepEqual(await sync.reconcile(files),{pushed:0,pulled:0});
});
test('large file transfer uses stdin, not operating-system argv limits',async t=>{
  const f=await fixture(t), data=randomBytes(1024*1024+123), sync=new Synchronizer(f.local,policy);
  await fs.writeFile(join(f.local,'large.dat'),data);await sync.reconcile(transport(f.runtime));
  assert.deepEqual(await fs.readFile(join(f.remote,'large.dat')),data);
});
test('divergent changes stay intact with saved conflict evidence and explicit resolution',async t=>{
  const f=await fixture(t), sync=new Synchronizer(f.local,policy), files=transport(f.runtime);
  await fs.writeFile(join(f.local,'x'),'base');await sync.reconcile(files);
  await fs.writeFile(join(f.local,'x'),'local');await fs.writeFile(join(f.remote,'x'),'remote');
  await assert.rejects(()=>sync.reconcile(files),error=>error.code==='SYNC_CONFLICT');
  assert.equal(await fs.readFile(join(f.local,'x'),'utf8'),'local');assert.equal(await fs.readFile(join(f.remote,'x'),'utf8'),'remote');
  const [dir]=await fs.readdir(join(f.local,'.reroute/conflicts'));assert.equal(await fs.readFile(join(f.local,'.reroute/conflicts',dir,'remote','x'),'utf8'),'remote');
  await sync.acceptLocal(files);assert.equal(await fs.readFile(join(f.remote,'x'),'utf8'),'local');
});
test('deletions propagate both directions only when other side is unchanged',async t=>{
  const f=await fixture(t),sync=new Synchronizer(f.local,policy),files=transport(f.runtime);
  await fs.writeFile(join(f.local,'x'),'x');await fs.writeFile(join(f.local,'y'),'y');await sync.reconcile(files);
  await fs.rm(join(f.local,'x'));await fs.rm(join(f.remote,'y'));await sync.reconcile(files);
  await assert.rejects(fs.stat(join(f.remote,'x')),{code:'ENOENT'});await assert.rejects(fs.stat(join(f.local,'y')),{code:'ENOENT'});
});
test('remote guarded write rejects stale hashes, traversal and secret paths',async t=>{
  const f=await fixture(t),files=transport(f.runtime);
  await fs.writeFile(join(f.remote,'x'),'new');
  for(const change of [{path:'x',expected:null,data:'eA=='},{path:'../outside',expected:null,data:'eA=='},{path:'.env',expected:null,data:'eA=='},...['.reroute','.reroute-runtime','.outboard','.outboard-runtime'].map(dir=>({path:dir+'/state.json',expected:null,data:'eA=='}))]) await assert.rejects(()=>files.apply([change],policy));
  assert.equal(await fs.readFile(join(f.remote,'x'),'utf8'),'new');
});
test('local source limits and remote symlinks are explicit errors',async t=>{
  const f=await fixture(t);await fs.writeFile(join(f.local,'x'),'12345');
  await assert.rejects(()=>scanLocal(f.local,{...policy,maxFileBytes:4}),/exceeds sync limit/);
  await fs.symlink('/etc/passwd',join(f.remote,'outside'));await assert.rejects(()=>transport(f.runtime).scan(policy));
});
test('remote unconfirmed protocol cannot fabricate a successful command',async t=>{
  const f=await fixture(t),launch=async()=>spawnRaw('python3',['-c',`print('this is a banner, not Reroute')`]);
  await assert.rejects(()=>execute(launch,f.runtime,{argv:['true'],cwd:f.remote,env:{}}),/Unexpected remote output/);
});
