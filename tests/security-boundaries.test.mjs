import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../dist/config.js';
import { runRemote, inspectJob } from '../dist/engine.js';
import { processExec } from '../dist/util.js';

// Offline real-process fixture, not proof of OS/container isolation or live cloud permissions.
async function fixture(t) {
 const base=await mkdtemp(join(tmpdir(),'reroute-security-')),old=process.env.REROUTE_STATE_DIR;
 process.env.REROUTE_STATE_DIR=join(base,'state');
 t.after(async()=>{if(old===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=old;await rm(base,{recursive:true,force:true});});
 const home=join(base,'remote-home');await mkdir(home);
 const profile={provider:'ssh',id:'offline',root:join(base,'remote')};
 const config={...defaults(),active:'security',profiles:{security:profile}};
 // A transport does not forward the local client's environment to the remote host.
 const env={PATH:process.env.PATH,HOME:home,LANG:'C.UTF-8'};
 const provider={profile,stdin:true,status:async()=> 'running',exec:(command,options)=>processExec('bash',['-c',command],{...options,env}),put:copyFile,get:copyFile};
 const a=join(base,'a'),b=join(base,'b');await mkdir(a);await mkdir(b);
 return {a,b,config,provider,run:(root,command,options={})=>runRemote(command,{root,cwd:root,config,provider,...options})};
}

test('fake local management credentials and sensitive files do not reach custom scripts',async t=>{
 const f=await fixture(t),name='DAYTONA_API_KEY',old=process.env[name];
 process.env[name]='FAKE_LOCAL_MANAGEMENT_TOKEN';
 t.after(()=>{if(old===undefined)delete process.env[name];else process.env[name]=old;});
 for(const name of ['.env','.env.production','.npmrc','id_ed25519','.git-credentials'])await writeFile(join(f.a,name),'FAKE_FILE_SECRET');
 await writeFile(join(f.a,'source.txt'),'local source');
 await writeFile(join(f.a,'custom.py'),`import os, pathlib
assert 'DAYTONA_API_KEY' not in os.environ
for name in ['.env','.env.production','.npmrc','id_ed25519','.git-credentials']:
    assert not pathlib.Path(name).exists(), name
pathlib.Path('source.txt').write_text('remote modification')
print('PRIVATE_BOUNDARY_OK')
`);
 const result=await f.run(f.a,'python3 custom.py');
 assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,'PRIVATE_BOUNDARY_OK\n');
 assert.equal(await readFile(join(f.a,'source.txt'),'utf8'),'local source');
});

test('project namespaces prevent accidental cache reuse and scoped job inspection rejects a foreign project',async t=>{
 const f=await fixture(t);
 const a=await f.run(f.a,'printf project-a > "$CARGO_TARGET_DIR/a"; printf "%s" "$CARGO_TARGET_DIR"');
 const b=await f.run(f.b,'test ! -e "$CARGO_TARGET_DIR/a" && printf project-b > "$CARGO_TARGET_DIR/a"; printf "%s" "$CARGO_TARGET_DIR"');
 assert.equal(a.code,0);assert.equal(b.code,0);assert.notEqual(a.stdout,b.stdout);
 assert.notEqual(a.job.root,b.job.root);
 assert.equal(await readFile(join(a.stdout,'a'),'utf8'),'project-a');
 const again=await f.run(f.a,'cat "$CARGO_TARGET_DIR/a"');assert.equal(again.stdout,'project-a');
 let contacts=0;
 await assert.rejects(inspectJob(a.job.id,'status',{project:f.b,provider:{...f.provider,status:async()=>{contacts++;return 'running';}}}),/not found in this project/);
 assert.equal(contacts,0);
});

test('attached projects sharing a remote UID are explicitly not an adversarial filesystem boundary',async t=>{
 const f=await fixture(t);
 const a=await f.run(f.a,'printf FAKE_SHARED_UID_CACHE > "$CARGO_TARGET_DIR/marker"; printf "%s" "$CARGO_TARGET_DIR"');
 // Demonstrate the limit using only this disposable fixture, never real project data.
 const b=await f.run(f.b,`python3 -c 'import pathlib; print(pathlib.Path(${JSON.stringify(join(a.stdout,'marker'))}).read_text())'`);
 assert.equal(b.code,0);assert.equal(b.stdout,'FAKE_SHARED_UID_CACHE\n');
});

test('Daytona authenticates only its local client; command payload has no management token or env forwarding',async t=>{
 const f=await fixture(t),oldKey=process.env.DAYTONA_API_KEY,oldConfig=process.env.XDG_CONFIG_HOME;
 process.env.DAYTONA_API_KEY='FAKE_DAYTONA_CONTROL_PLANE_KEY';process.env.XDG_CONFIG_HOME=join(f.a,'private-config');
 t.after(()=>{if(oldKey===undefined)delete process.env.DAYTONA_API_KEY;else process.env.DAYTONA_API_KEY=oldKey;if(oldConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldConfig;});
 const {DaytonaProvider}=await import('../dist/providers/daytona.js');let authenticated=false,payload;
 const sb={state:'started',process:{createSession:async()=>{},deleteSession:async()=>{},executeSessionCommand:async(_session,request)=>{payload=request;return {exitCode:0,stdout:'ok',stderr:''};}}};
 const sdk={Daytona:class{constructor(options){authenticated=options.apiKey===process.env.DAYTONA_API_KEY;}async get(){return sb;}}};
 const provider=new DaytonaProvider({provider:'daytona',id:'offline'},async()=>sdk);
 assert.equal((await provider.exec('python3 custom.py')).code,0);assert.equal(authenticated,true);
 assert.deepEqual(payload,{command:'python3 custom.py',runAsync:false,suppressInputEcho:true});
 assert.equal(JSON.stringify(payload).includes(process.env.DAYTONA_API_KEY),false);
});

test('a first managed Daytona allocation creates its absent Volume once; lost acknowledgement never creates compute',async t=>{
 const f=await fixture(t),oldConfig=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(f.a,'private-config');
 t.after(()=>{if(oldConfig===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=oldConfig;});
 const {DaytonaProvider}=await import('../dist/providers/daytona.js');
 const profile={provider:'daytona',id:'auto',image:'fixture:1',compute:{cpu:2,memoryGiB:4},managed:{authorized:true}};
 for(const lost of [false,true]){
  const calls=[];let exists=false,creates=0;
  const sb={id:'fixture-sandbox',cpu:2,memory:4,state:'started',labels:{'reroute-managed':'v3','reroute-owner':'fixture-owner'}};
  const sdk={Daytona:class{
   async *list(){}
   volume={get:async(_name,create)=>{calls.push(create);if(!exists){if(!create)throw Error('Volume NotFound');exists=true;creates++;if(lost)throw Error('Volume create acknowledgement lost');return {id:'fixture-volume',state:'pending_create'};}return {id:'fixture-volume',state:'ready'};}};
   async create(params){calls.push('compute');assert.equal(params.volumes[0].volumeId,'fixture-volume');return sb;}
  }};
  const provider=new DaytonaProvider({...profile},async()=>sdk),request={name:'fixture',owner:'fixture-owner',create:true,start:false,guardMinutes:6};
  if(lost){await assert.rejects(provider.ensureManaged(request),/acknowledgement lost/);assert.deepEqual(calls,[true]);}
  else{assert.equal((await provider.ensureManaged(request)).id,'fixture-sandbox');assert.deepEqual(calls,[true,false,'compute']);}
  assert.equal(creates,1);
 }
});

test('normal exit, timeout and cancellation reap descendants that create a new session',async t=>{
 const f=await fixture(t);
 await writeFile(join(f.a,'detach.py'),`import subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(15)'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print('DETACHED_PID=' + str(child.pid), flush=True)
if len(sys.argv) > 1: time.sleep(30)
`);
 for(const mode of ['exit','timeout','cancel']){
  const controller=new AbortController();let pid;
  const result=await f.run(f.a,'python3 detach.py'+(mode==='exit'?'':' wait'),{timeoutMs:mode==='timeout'?300:5000,signal:controller.signal,stdout:chunk=>{
   const match=String(chunk).match(/DETACHED_PID=(\d+)/);if(!match)return;pid=Number(match[1]);
   t.after(()=>{try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}});
   if(mode==='cancel')controller.abort();
  }});
  assert.ok(pid,'detached child PID observed');
  const state=await readFile('/proc/'+pid+'/stat','utf8').then(text=>text.slice(text.lastIndexOf(')')+2).split(' ')[0],error=>{if(error.code==='ENOENT')return 'gone';throw error;});
  assert.ok(['gone','Z','X'].includes(state),mode+': detached child still running: '+state);
  assert.equal(result.job.status,mode==='exit'?'exited':mode==='timeout'?'timed_out':'cancelled');
 }
});
