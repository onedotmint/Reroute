import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { SshProvider } from '../dist/providers/ssh.js';
import { SkyPilotProvider } from '../dist/providers/skypilot.js';
import { E2BProvider } from '../dist/providers/e2b.js';
import { DaytonaProvider } from '../dist/providers/daytona.js';
import { ModalProvider } from '../dist/providers/modal.js';
import { createProvider } from '../dist/providers/index.js';

test('all five production adapters exist and unsafe configuration is rejected before transport',()=>{
 for(const provider of ['ssh','skypilot','e2b','daytona','modal'])assert.equal(createProvider({provider,id:'test'}).profile.provider,provider);
 assert.throws(()=>createProvider({provider:'ssh',id:'-oProxyCommand=evil'}),/identifier/);
 assert.throws(()=>createProvider({provider:'ssh',id:'host',root:'/tmp/../etc'}),/traversal/);
});
test('SSH preserves native transport, argv boundaries, strict host keys and incremental rsync',async()=>{
 const calls=[];const executor=async(...args)=>{calls.push(args);return {code:0,stdout:'Total bytes sent: 1,024\n',stderr:''}};
 const p=new SshProvider({provider:'ssh',id:'u@host',port:2200,identityFile:'/tmp/key with space'},executor);
 await p.exec("printf '%s' 'untrusted ; text'");assert.equal(calls[0][0],'ssh');assert.ok(calls[0][1].includes('StrictHostKeyChecking=yes'));assert.ok(calls[0][1].includes('/tmp/key with space'));
 assert.equal(await p.sync('/tmp/source with space','/tmp/remote'),1024);assert.equal(calls[1][0],'rsync');assert.ok(calls[1][1].includes('--delete'));assert.ok(calls[1][1].includes('--checksum'));
 await assert.rejects(p.lifecycle('destroy'),/does not own/);
});
test('SkyPilot read and destroy never launch or start a cluster',async()=>{
 const calls=[];const p=new SkyPilotProvider({provider:'skypilot',id:'existing'},async(...args)=>{calls.push(args);return {code:0,stdout:'[{"name":"existing","status":"STOPPED"}]',stderr:''}});
 assert.equal(await p.status(),'stopped');await p.lifecycle('destroy');assert.deepEqual(calls.map(c=>c[1][0]),['status','down']);
 await p.lifecycle('resume');assert.equal(calls[2][1][0],'start');
});
test('E2B paused status, pause and kill never connect/resume; explicit resume does',async()=>{
 const calls=[];
 const sdk={Sandbox:{getInfo:async id=>{calls.push(['getInfo',id]);return {state:'paused'}},connect:async id=>{calls.push(['connect',id]);return {}},pause:async id=>{calls.push(['pause',id]);return true},kill:async id=>{calls.push(['kill',id]);return true}},CommandExitError:class extends Error{}};
 const p=new E2BProvider({provider:'e2b',id:'sandbox'},async()=>sdk);
 assert.equal(await p.status(),'paused');await assert.rejects(p.exec('true'),/not running/);await p.lifecycle('stop');await p.lifecycle('destroy');assert.equal(calls.some(c=>c[0]==='connect'),false);
 await p.lifecycle('resume');assert.equal(calls.at(-1)[0],'connect');
});
test('E2B native command handle streams both channels, returns nonzero exit, forwards stdin and EOF',async()=>{
 const input=[],calls=[];class ExitError extends Error{constructor(){super('exit');this.exitCode=7;}}
 let ended;const eof=new Promise(resolve=>ended=resolve);
 const handle={wait:async()=>{await eof;throw new ExitError()},sendStdin:async b=>input.push(String(b)),closeStdin:async()=>{calls.push('eof');ended()},disconnect:()=>calls.push('disconnect')};
 const sandbox={commands:{run:async(command,opts)=>{assert.equal(opts.background,true);opts.onStdout('out');opts.onStderr('err');return handle}}};
 const sdk={Sandbox:{getInfo:async()=>({state:'running'}),connect:async()=>sandbox},CommandExitError:ExitError};
 const p=new E2BProvider({provider:'e2b',id:'sandbox'},async()=>sdk);let stdout='',stderr='';
 const r=await p.exec('cat',{stdin:Readable.from(['in']),stdout:b=>stdout+=b,stderr:b=>stderr+=b});
 assert.equal(r.code,7);assert.equal(stdout,'out');assert.equal(stderr,'err');assert.deepEqual(input,['in']);
 assert.ok(calls.includes('eof'));assert.ok(calls.includes('disconnect'));
});
test('Daytona uses native sessions with distinct channels and does not start stopped resources for management',async()=>{
 const calls=[];
 const process={createSession:async()=>calls.push('createSession'),executeSessionCommand:async(_id,opts)=>opts.runAsync?{cmdId:'cmd'}:{exitCode:3,stdout:'out',stderr:'err'},getSessionCommandLogs:async(_s,_id,out,err)=>{out('out');err('err')},getSessionCommand:async()=>({exitCode:3}),deleteSession:async()=>calls.push('deleteSession')};
 let state='started';const sb={get state(){return state},process,stop:async()=>calls.push('stop'),start:async()=>calls.push('start'),delete:async()=>calls.push('delete')};
 const sdk={Daytona:class{async get(){calls.push('get');return sb}}};const p=new DaytonaProvider({provider:'daytona',id:'sb'},async()=>sdk);
 const sync=await p.exec('false');assert.deepEqual(sync,{code:3,stdout:'out',stderr:'err'});
 let stdout='',stderr='';const asyncResult=await p.exec('false',{stdout:b=>stdout+=b,stderr:b=>stderr+=b});assert.equal(asyncResult.code,3);assert.equal(stdout,'out');assert.equal(stderr,'err');
 state='stopped';assert.equal(await p.status(),'stopped');await p.lifecycle('destroy');assert.equal(calls.includes('start'),false);
 await assert.rejects(p.exec('cat',{stdin:Readable.from(['input'])}),/not supported/);
});
test('Modal snapshot is checkpointed before stopping; reads and destroy never recreate paid compute',async()=>{
 const calls=[];
 const sb={poll:async()=>null,snapshotFilesystem:async()=>{calls.push('snapshot');return {imageId:'im-snapshot'}},terminate:async()=>{calls.push('terminate');return 0},detach:()=>{}};
 const api={sandboxes:{fromId:async()=>{calls.push('fromId');return sb},create:async()=>{calls.push('create');return {sandboxId:'sb-new'}}},apps:{fromName:async(_name,options)=>{assert.equal(options.createIfMissing,false);calls.push('app');return {}}},images:{fromId:async()=>({})},close:()=>{}};
 const sdk={ModalClient:class{constructor(){return api}}};const profile={provider:'modal',id:'sb-old',app:'existing'};const p=new ModalProvider(profile,async()=>sdk);
 assert.equal(await p.status(),'running');await p.lifecycle('stop',async patch=>{calls.push('checkpoint');Object.assign(profile,patch)});
 assert.ok(calls.indexOf('checkpoint')<calls.indexOf('terminate'));await p.lifecycle('destroy');assert.equal(calls.includes('create'),false);
 const patch=await p.lifecycle('resume');assert.equal(patch.id,'sb-new');assert.equal(calls.at(-1),'create');
});
test('Modal native process returns stdout/stderr/exit and rejects stopped execution',async()=>{
 const stream=s=>new ReadableStream({start(c){c.enqueue(Buffer.from(s));c.close()}});let stopped=false;
 const sb={poll:async()=>stopped?0:null,exec:async(argv,opts)=>{assert.deepEqual(argv,['bash','-lc','false']);assert.equal(opts.mode,'binary');return {stdout:stream('out'),stderr:stream('err'),stdin:new WritableStream(),wait:async()=>5}},detach:()=>{}};
 const sdk={ModalClient:class{sandboxes={fromId:async()=>sb};close(){}}};const p=new ModalProvider({provider:'modal',id:'sb'},async()=>sdk);
 let out='',err='';const r=await p.exec('false',{stdout:b=>out+=b,stderr:b=>err+=b});assert.equal(r.code,5);assert.equal(out,'out');assert.equal(err,'err');
 stopped=true;await assert.rejects(p.exec('false'),/stopped/);
});
