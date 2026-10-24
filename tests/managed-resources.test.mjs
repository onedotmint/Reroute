import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { defaults, saveJob } from '../dist/config.js';
import { hash } from '../dist/util.js';
import { cloudPlan, cloudSummary, withManagedResource, managedAction } from '../dist/resources.js';
import { DaytonaProvider } from '../dist/providers/daytona.js';

const policy=()=>({authorized:true,maxCpu:8,maxMemoryGiB:16,maxTaskUsd:1,monthlyUsd:3,cpuHourUsd:.0504,memoryGiBHourUsd:.0162,storageMonthUsd:.01,idleMinutes:5});
const config=()=>({...defaults(),active:'cloud',timeoutSeconds:60,profiles:{cloud:{provider:'daytona',id:'auto',image:'toolchain:1',credential:'account-a',compute:{cpu:2,memoryGiB:4},managed:policy()}}});
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'reroute-managed-')),old=process.env.REROUTE_STATE_DIR;
 process.env.REROUTE_STATE_DIR=join(root,'state');
 t.after(async()=>{if(old===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=old;await rm(root,{recursive:true,force:true});});
 const c=config(),calls=[];
 const factory=profile=>({profile,stdin:false,status:async()=> 'running',
  ensureManaged:async request=>{
   calls.push(['ensure',structuredClone(request),structuredClone(profile)]);
   const files=(await readdir(join(root,'state','cloud'))).filter(n=>n.endsWith('.json'));
   const book=JSON.parse(await readFile(join(root,'state','cloud',files[0]),'utf8'));
   assert.ok(book.reservedUsd>0);assert.ok(Object.values(book.resources).length);
   Object.assign(profile,{id:'sandbox-owned',owner:request.owner});return {...profile};
  },idle:async minutes=>calls.push(['idle',minutes]),lifecycle:async action=>calls.push(['lifecycle',action]),close:()=>{},
 });
 const run=async profile=>({code:0,job:{id:randomUUID(),project:root,profile,root:'/tmp/fixture',command:'cargo test',cwd:'.',createdAt:new Date().toISOString(),status:'exited',code:0,metrics:{cacheKey:'fixture',inputBytes:0,inputMs:0,transferredBytes:0,transferMs:0}}});
 return {root,c,calls,factory,run,execute:(options={},callback=run)=>withManagedResource(root,c,'cargo test',options,callback,factory)};
}
test('authorization, finite sizing, user quota and estimated task/month budgets fail before cloud calls',async t=>{
 const f=await fixture(t);
 assert.deepEqual(cloudPlan(f.c,'cargo test').profile.compute,{cpu:2,memoryGiB:4});
 assert.deepEqual(cloudPlan(f.c,'cargo test',{cpu:4,memoryGiB:8}).profile.compute,{cpu:4,memoryGiB:8});
 assert.deepEqual(f.c.profiles.cloud.compute,{cpu:2,memoryGiB:4});
 f.c.profiles.cloud.managed.authorized=false;
 for(const command of ['cargo test','npm test','npm run custom-suite'])await assert.rejects(withManagedResource(f.root,f.c,command,{},f.run,f.factory),/not authorized/);
 f.c.profiles.cloud.managed.authorized=true;
 for(const compute of [{cpu:NaN},{cpu:Infinity},{cpu:0},{cpu:9},{memoryGiB:17},{cpu:1.5}])await assert.rejects(f.execute({compute}));
 f.c.profiles.cloud.managed.maxTaskUsd=.00001;await assert.rejects(f.execute(),/per-task/);
 f.c.profiles.cloud.managed.maxTaskUsd=1;f.c.profiles.cloud.managed.monthlyUsd=.00001;await assert.rejects(f.execute(),/monthly/);
 assert.equal(f.calls.length,0);
});
test('durable intent and reservation precede allocation; confirmed jobs enable idle reuse without re-creation',async t=>{
 const f=await fixture(t);const first=await f.execute();const second=await f.execute();
 assert.ok(first.job.metrics.provisionMs>=0);assert.ok(first.job.cost.estimatedUsd>0);assert.equal(first.job.cost.balance,'unavailable');
 assert.deepEqual(f.calls.filter(c=>c[0]==='ensure').map(c=>c[1].create),[true,false]);
 assert.deepEqual(f.calls.filter(c=>c[0]==='idle').map(c=>c[1]),[5,5]);
 const summary=await cloudSummary(f.c.profiles.cloud);assert.equal(summary.resources[0].state,'ready');
 assert.ok(Math.abs(summary.reservedUsd-2*second.job.cost.estimatedUsd)<1e-9);
});
test('lost creation acknowledgement never retries create or allows a spec switch to bypass uncertainty',async t=>{
 const f=await fixture(t);let createCalls=0;
 const fail=profile=>({...f.factory(profile),ensureManaged:async request=>{createCalls++;assert.equal(request.create,true);throw Error('response lost');}});
 await assert.rejects(withManagedResource(f.root,f.c,'cargo test',{},f.run,fail),/unconfirmed/);
 await assert.rejects(f.execute({compute:{cpu:4,memoryGiB:8}}),/unresolved resource allocation/);
 await f.execute();assert.equal(createCalls,1);assert.equal(f.calls.find(c=>c[0]==='ensure')[1].create,false);
});
test('unknown task cannot shorten idle policy; active/unresolved jobs block allocation and lifecycle',async t=>{
 const f=await fixture(t);
 const result=await f.execute({},async profile=>{const r=await f.run(profile);r.job.status='unknown';delete r.job.code;await saveJob(r.job);return r;});
 assert.equal(result.job.status,'unknown');assert.equal(f.calls.some(c=>c[0]==='idle'),false);
 await assert.rejects(f.execute(),/active\/unresolved/);
 await assert.rejects(managedAction(f.root,f.c,'destroy',f.factory),/active\/unresolved/);
 assert.equal(f.calls.some(c=>c[0]==='lifecycle'),false);
});
test('explicit recovery only discovers; stop/destroy retain volume and new account uses separate ledger',async t=>{
 const f=await fixture(t);await f.execute();f.calls.length=0;
 await managedAction(f.root,f.c,'recover',f.factory);assert.equal(f.calls[0][1].create,false);assert.equal(f.calls[0][1].start,false);
 await managedAction(f.root,f.c,'stop',f.factory);await managedAction(f.root,f.c,'destroy',f.factory);
 assert.deepEqual(f.calls.filter(c=>c[0]==='lifecycle').map(c=>c[1]),['stop','destroy']);
 f.c.profiles.cloud.credential='account-b';await f.execute();assert.equal(f.calls.filter(c=>c[0]==='ensure').at(-1)[1].create,true);
 assert.equal((await cloudSummary(f.c.profiles.cloud)).resources.length,1);
});
test('recovery refuses a live/foreign/malformed lease and releases only a dead local client lease',async t=>{
 const f=await fixture(t);await f.execute();
 const path=join(f.root,'state','cloud',hash('daytona\0account-a').slice(0,32)+'.lock');
 await writeFile(path,JSON.stringify({pid:process.pid,host:hostname()}));await assert.rejects(managedAction(f.root,f.c,'recover',f.factory),/still exists/);
 await writeFile(path,JSON.stringify({pid:1,host:'foreign-host'}));await assert.rejects(managedAction(f.root,f.c,'recover',f.factory),/cannot be verified/);
 await writeFile(path,JSON.stringify({pid:2147483647,host:hostname()}));await managedAction(f.root,f.c,'recover',f.factory);
 await assert.rejects(readFile(path),/ENOENT/);
});

async function daytonaFixture(t){
  const f=await fixture(t);let sandbox;const calls=[],volumeStates=['ready'];
 const sb=()=>({id:'sb-owned',name:'rr-fixture',cpu:2,memory:4,state:'started',labels:{'reroute-managed':'v3','reroute-owner':'owner-fixture'},
  refreshData:async()=>calls.push(['refresh']),setAutoPauseInterval:async n=>calls.push(['pause',n]),setAutostopInterval:async n=>calls.push(['autostop',n]),setAutoDeleteInterval:async n=>calls.push(['autodelete',n]),refreshActivity:async()=>calls.push(['activity']),start:async()=>{calls.push(['start']);sandbox.state='started';},stop:async()=>calls.push(['stop']),delete:async()=>calls.push(['delete'])});
 const sdk={Daytona:class{
  async *list(query){calls.push(['list',query]);if(sandbox)yield sandbox;}
   volume={get:async(name,create)=>{calls.push(['volume',name,create]);return {id:'volume-owned',state:volumeStates.shift()??'ready'};}};
  async create(params,opts){calls.push(['create',params,opts]);sandbox=sb();return sandbox;}
  async get(){return sandbox;}
 }};
 // Use an isolated empty default credential file, never real credentials.
 const old=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(f.root,'private');
 t.after(()=>{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;});
 const profile={...f.c.profiles.cloud,credential:undefined};const p=new DaytonaProvider(profile,async()=>sdk);
 const request={name:'rr-fixture',owner:'owner-fixture',create:true,start:true,guardMinutes:11};
  return {p,profile,request,calls,volumeStates,get sandbox(){return sandbox;}};
}
test('Daytona waits for a newly-created cache Volume before mounting it',async t=>{
 const f=await daytonaFixture(t);f.volumeStates.splice(0,1,'pending_create','ready');await f.p.ensureManaged(f.request);
  assert.deepEqual(f.calls.filter(c=>c[0]==='volume').map(c=>c[2]),[true,false]);
});
test('Daytona SDK create uses labels, custom resources and a retained Volume with guarded autostop',async t=>{
 const f=await daytonaFixture(t);const resolved=await f.p.ensureManaged(f.request);
 const params=f.calls.find(c=>c[0]==='create')[1];assert.deepEqual(params.resources,{cpu:2,memory:4});assert.equal(params.image,'toolchain:1');
 assert.equal(params.public,false);assert.equal(params.autoStopInterval,11);assert.equal(params.autoPauseInterval,0);assert.equal(params.autoDeleteInterval,-1);
 assert.deepEqual(params.volumes,[{volumeId:'volume-owned',mountPath:'/var/reroute-cache'}]);assert.equal(resolved.id,'sb-owned');assert.equal(resolved.cacheVolume,'/var/reroute-cache');
 assert.deepEqual(f.calls.find(c=>c[0]==='list')[1].labels,{'reroute-managed':'v3','reroute-owner':'owner-fixture'});
 f.sandbox.state='stopped';await f.p.ensureManaged({...f.request,create:false});assert.equal(f.calls.filter(c=>c[0]==='create').length,1);assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
 await f.p.lifecycle('destroy');assert.equal(f.calls.filter(c=>c[0]==='delete').length,1);assert.equal(f.calls.filter(c=>c[0]==='volume').length,1);
});
test('Daytona recovery never starts or creates; mismatched ownership/specs are not resized or adopted',async t=>{
 const f=await daytonaFixture(t);
 await assert.rejects(f.p.ensureManaged({...f.request,create:false,start:false}),/not confirmed/);assert.equal(f.calls.some(c=>c[0]==='create'),false);
 await f.p.ensureManaged(f.request);f.calls.length=0;f.sandbox.state='stopped';
 await f.p.ensureManaged({...f.request,create:false,start:false});assert.equal(f.calls.some(c=>c[0]==='start'||c[0]==='autostop'),false);
 f.sandbox.cpu=4;await assert.rejects(f.p.ensureManaged({...f.request,create:false}),/does not match/);assert.equal(f.calls.some(c=>c[0]==='start'),false);
 f.sandbox.cpu=2;f.sandbox.labels={};await assert.rejects(f.p.ensureManaged({...f.request,create:false}),/ownership/);
});

test('managed provider stays open through idle release and closes exactly once afterwards',async t=>{
 const f=await fixture(t),events=[];
 const factory=profile=>({...f.factory(profile),idle:async()=>events.push('idle'),close:async()=>events.push('close')});
 await withManagedResource(f.root,f.c,'cargo test',{},async profile=>{events.push('run');return f.run(profile);},factory);
 assert.deepEqual(events,['run','idle','close']);
 await managedAction(f.root,f.c,'destroy',factory);
 const count=events.length;await managedAction(f.root,f.c,'destroy',factory);assert.equal(events.length,count);
});

test('repeated stop of an already stopped Daytona keeps the managed ledger ready without stop/start/create calls',async t=>{
 const f=await fixture(t),old=process.env.XDG_CONFIG_HOME,mutations=[];
 process.env.XDG_CONFIG_HOME=join(f.root,'private');
 t.after(()=>{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;});
 const factory=profile=>({...f.factory(profile),lifecycle:async action=>{
  const sb={state:'stopped',labels:{'reroute-managed':'v3','reroute-owner':profile.owner},
   stop:async()=>{mutations.push('stop');throw Error('400: already stopped');},start:async()=>mutations.push('start'),delete:async()=>mutations.push('delete')};
  const sdk={Daytona:class{async get(){return sb;}}};
  await new DaytonaProvider({...profile,credential:undefined},async()=>sdk).lifecycle(action);
 }});
 await withManagedResource(f.root,f.c,'cargo test',{},f.run,factory);
 const reserved=(await cloudSummary(f.c.profiles.cloud)).reservedUsd;
 for(let n=0;n<2;n++)await managedAction(f.root,f.c,'stop',factory);
 const summary=await cloudSummary(f.c.profiles.cloud);
 assert.equal(summary.resources[0].state,'ready');assert.equal(summary.reservedUsd,reserved);
 assert.deepEqual(mutations,[]);
 assert.ok(f.calls.filter(c=>c[0]==='ensure').slice(1).every(c=>c[1].create===false&&c[1].start===false));
});


test('credential aliases cannot bypass pre-allocation owner or recorded resource ID task guards',async t=>{
 for(const status of ['preparing','running','unknown'])for(const identity of ['owner','id'])await t.test(`${status}: ${identity}`,async t=>{
  const f=await fixture(t),first=await f.execute(),job=structuredClone(first.job);
  job.status=status;delete job.code;
  if(identity==='owner'){
   f.c.profiles.cloud.credential='account-alias';
   job.profile.id='another-owned-sandbox';
  }else{
   job.profile.credential='account-alias';delete job.profile.owner;
  }
  await saveJob(job);f.calls.length=0;
  const before=await cloudSummary(f.c.profiles.cloud);
  await assert.rejects(f.execute(),/active\/unresolved/);
  assert.deepEqual(f.calls,[]);
  assert.deepEqual(await cloudSummary(f.c.profiles.cloud),before);
 });
});

test('stop and destroy match provider plus actual ID, not credential aliases or owner labels',async t=>{
 for(const status of ['preparing','running','unknown'])await t.test(status,async t=>{
  const f=await fixture(t),first=await f.execute(),job=structuredClone(first.job);
  job.status=status;delete job.code;job.profile.credential='account-alias';job.profile.owner='other-owner';
  await saveJob(job);f.calls.length=0;
  for(const action of ['stop','destroy'])await assert.rejects(managedAction(f.root,f.c,action,f.factory),/active\/unresolved/);
  assert.equal(f.calls.some(c=>c[0]==='lifecycle'),false);
  assert.ok(f.calls.every(c=>c[0]==='ensure'&&!c[1].create&&!c[1].start));
  assert.equal((await cloudSummary(f.c.profiles.cloud)).resources[0].state,'unknown');
 });
});

test('a newly resolved ID with an alias task blocks run and cancellation cleanup',async t=>{
 for(const status of ['preparing','running','unknown'])await t.test(status,async t=>{
  const f=await fixture(t),controller=new AbortController();let runs=0;
  const factory=profile=>{
   const provider=f.factory(profile);
   return {...provider,ensureManaged:async request=>{
    const resolved=await provider.ensureManaged(request),{job}=await f.run(resolved);
    job.profile={...resolved,credential:'account-alias',owner:undefined};job.status=status;delete job.code;
    await saveJob(job);
    if(status!=='preparing')controller.abort();
    return resolved;
   }};
  };
  await assert.rejects(withManagedResource(f.root,f.c,'cargo test',{signal:controller.signal},async()=>{runs++;throw Error('must not run');},factory),/active\/unresolved/);
  assert.equal(runs,0);
  assert.equal(f.calls.some(c=>c[0]==='lifecycle'||c[0]==='idle'),false);
  assert.equal((await cloudSummary(f.c.profiles.cloud)).resources[0].state,'unknown');
 });
});

test('pre-run cancellation stops a confirmed saved allocation; failed stop retains uncertainty',async t=>{
 for(const providerName of ['daytona','modal'])for(const stopFails of [false,true])await t.test(`${providerName}: stop ${stopFails?'fails':'succeeds'}`,async t=>{
  const f=await fixture(t),controller=new AbortController(),events=[];let runs=0;
  f.c.profiles.cloud.provider=providerName;
  const factory=profile=>{
   const provider=f.factory(profile);
   return {...provider,ensureManaged:async request=>{
    const resolved=await provider.ensureManaged(request);controller.abort();return resolved;
   },lifecycle:async action=>{
    events.push(action);
    const summary=await cloudSummary(f.c.profiles.cloud);
    assert.equal(summary.resources[0].state,'ready');assert.equal(summary.resources[0].id,'sandbox-owned');
    if(stopFails)throw Error('stop acknowledgement lost');
   },close:()=>events.push('close')};
  };
  await assert.rejects(withManagedResource(f.root,f.c,'cargo test',{signal:controller.signal},async()=>{runs++;throw Error('must not run');},factory),stopFails?/unconfirmed.*stop acknowledgement lost/:/cancelled before task start; resource stopped/);
  assert.equal(runs,0);assert.deepEqual(events,['stop','close']);
  assert.equal(f.calls.some(c=>c[0]==='idle'),false);
  const summary=await cloudSummary(f.c.profiles.cloud);
  assert.equal(summary.resources[0].state,stopFails?'unknown':providerName==='modal'?'destroyed':'ready');
  assert.ok(summary.reservedUsd>0);
 });
});

test('cancellation never stops an unconfirmed allocation or a task whose run callback was entered',async t=>{
 for(const phase of ['ensure','run'])await t.test(phase,async t=>{
  const f=await fixture(t),controller=new AbortController();let runs=0;
  const factory=profile=>{
   const provider=f.factory(profile);
   return {...provider,ensureManaged:async request=>{
    if(phase==='ensure'){controller.abort();throw Error('allocation acknowledgement lost');}
    return provider.ensureManaged(request);
   }};
  };
  await assert.rejects(withManagedResource(f.root,f.c,'cargo test',{signal:controller.signal},async()=>{
   runs++;controller.abort();throw Error('task acknowledgement lost');
  },factory),/unconfirmed/);
  assert.equal(runs,phase==='run'?1:0);
  assert.equal(f.calls.some(c=>c[0]==='lifecycle'||c[0]==='idle'),false);
  assert.equal((await cloudSummary(f.c.profiles.cloud)).resources[0].state,'unknown');
 });
});


test('matching IDs and owners from a different provider do not block managed resources',async t=>{
 const f=await fixture(t),first=await f.execute(),job=structuredClone(first.job);
 job.status='running';delete job.code;job.profile.provider='modal';
 await saveJob(job);f.calls.length=0;
 await f.execute();await managedAction(f.root,f.c,'stop',f.factory);
 assert.deepEqual(f.calls.filter(c=>c[0]==='lifecycle').map(c=>c[1]),['stop']);
});


test('resource progress reflects allocation and release, measured release survives and observer failures are harmless',async t=>{
  const f=await fixture(t),stages=[];
  const result=await f.execute({onProgress:p=>stages.push(p.stage)});
  assert.deepEqual(stages,['budget','provision','release','complete']);
  assert.ok(result.job.metrics.releaseMs>=0);
  const again=await f.execute({onProgress:()=>{throw new Error('UI closed');}});
  assert.equal(again.job.status,'exited');
});

test('release failures remain separately labelled rather than replacing the task exit receipt',async t=>{
  const f=await fixture(t);
  const factory=p=>({...f.factory(p),idle:async()=>{throw new Error('network release lost');}});
  const result=await withManagedResource(f.root,f.c,'cargo test',{},f.run,factory);
  assert.equal(result.job.code,0);assert.equal(result.job.status,'exited');
  assert.match(result.job.error,/\[resource-cleanup\]/);assert.ok(result.job.metrics.releaseMs>=0);
});
