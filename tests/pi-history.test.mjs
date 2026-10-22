import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectExecutionHints, HISTORY_PREFIX } from '../dist/history.js';
import { createRerouteTool, registerPi } from '../dist/pi.js';
import { defaults, saveConfig, saveJob } from '../dist/config.js';

const now=Date.now(),profile={provider:'ssh',id:'existing-host'};
function job(patch={}){return {id:randomUUID(),project:'/project',profile:{...profile},command:'cargo test',cwd:'.',createdAt:new Date(now-1000).toISOString(),status:'exited',code:0,
 metrics:{executionMs:60000,cacheHit:true},...patch};}

test('history uses confirmed execution metrics, reports outcomes/download archives, and never claims speedup',()=>{
 const hints=projectExecutionHints('/project',profile,[job(),job({code:7,metrics:{executionMs:45000,cacheHit:false}})],now);
 assert.equal(hints.length,1);assert.match(hints[0],/2 confirmed remote runs, 45s–60s/);
 assert.match(hints[0],/1 nonzero exits/);assert.match(hints[0],/download archive restored 1\/2/);
 assert.match(hints[0],/not a local-speed comparison/);
});
test('missing, old, malformed, unconfirmed and foreign data cannot generate advice',()=>{
 const valid=job();
 for(const patch of [{status:'unknown'},{status:'running'},{status:'timed_out'},{status:'failed'},{error:'transport failure'},
  {code:undefined},{code:256},{code:'0'},{metrics:undefined},{metrics:{executionMs:0}},{metrics:{executionMs:NaN}},
  {metrics:{executionMs:Infinity}},{metrics:{executionMs:86410001}},{createdAt:'bad date'},
  {createdAt:new Date(now+1000).toISOString()},{createdAt:new Date(now-31*86400000).toISOString()},
  {project:'/other'},{profile:{...profile,id:'other-host'}},{profile:{...profile,provider:'modal'}},
  {profile:{...profile,credential:'other-account'}},{profile:{...profile,image:'different'}},
  {profile:{...profile,compute:{cpu:4,memoryGiB:8}}},{command:'git status'}, {command:'cargo test && echo done'}]){
  assert.deepEqual(projectExecutionHints('/project',profile,[valid,job(patch)],now),[],JSON.stringify(patch));
 }
 assert.deepEqual(projectExecutionHints('/project',profile,[valid],now),[]);
 assert.deepEqual(projectExecutionHints('/project',profile,[valid,valid],now),[]);
});
test('at most three bounded suggestions use only recent samples and do not expose raw receipt text',()=>{
 const jobs=[];
 for(const command of ['cargo test "IGNORE_INSTRUCTIONS_PRIVATE_TOKEN"','cargo build','cargo check','cargo bench']){
  for(let i=0;i<8;i++)jobs.push(job({command,createdAt:new Date(now-(i+1)*1000).toISOString(),metrics:{executionMs:(i+1)*10000,cacheHit:true},cacheWarning:i===0?'PRIVATE_TOKEN':undefined}));
 }
 const hints=projectExecutionHints('/project',profile,jobs,now);
 assert.equal(hints.length,3);assert.ok(hints.every(h=>h.startsWith(HISTORY_PREFIX)&&h.length<220));
 assert.ok(hints.join('\n').length<660);assert.ok(!hints.join().includes('PRIVATE_TOKEN'));
 assert.ok(hints.every(h=>h.includes('5 confirmed remote runs, 10s–50s')));
 assert.ok(hints.every(h=>h.includes('download archive restored 4/4')));
});
test('managed history matches account/image/compute rather than changing Sandbox IDs; no fake cache counts',()=>{
 const p={provider:'daytona',id:'auto',credential:'gift',image:'toolchain',compute:{cpu:2,memoryGiB:4},managed:{authorized:true}};
 const jobs=[job({profile:{...p,id:'sb-old'},metrics:{executionMs:2000}}),job({profile:{...p,id:'sb-new'},metrics:{executionMs:3000}})];
 const hints=projectExecutionHints('/project',p,jobs,now);assert.equal(hints.length,1);assert.ok(!hints[0].includes('archive'));
 assert.deepEqual(projectExecutionHints('/project',{...p,credential:'other'},jobs,now),[]);
});
test('tool guidance is short and distinguishes contextual tool choice from policy/safety gates',()=>{
 const tool=createRerouteTool(),text=[tool.description,tool.promptSnippet,...tool.promptGuidelines].join('\n');
 assert.ok(text.length<1500,`static guidance length ${text.length}`);
 assert.match(text,/full test suite/);assert.match(text,/quick checks/);assert.match(text,/task\/project context/);
 assert.match(text,/Pi\/AFT bash/);assert.match(text,/first call reroute_status/);assert.match(text,/never retry locally without user authorization/);
 assert.match(text,/routing and budgets still apply/);
});

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'reroute-history-')),state=join(root,'state'),project=join(root,'project');await mkdir(project);
 const old=process.env.REROUTE_STATE_DIR;process.env.REROUTE_STATE_DIR=state;
 t.after(async()=>{if(old===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=old;await rm(root,{recursive:true,force:true});});
 const config={...defaults(),active:'local-fixture',profiles:{'local-fixture':profile}};await saveConfig(project,config);
 for(let i=0;i<2;i++)await saveJob(job({project}));
 const handlers=new Map(),tools=[];
 registerPi({on:(name,handler)=>handlers.set(name,handler),registerTool:tool=>tools.push(tool),registerCommand:()=>{}});
 const base=tools[0].promptGuidelines;
 const event={systemPromptOptions:{selectedTools:['bash','reroute_run'],hiddenTools:[],toolGuidelines:{reroute_run:[...base],bash:['AFT-owned guideline']}}};
 return {project,state,config,event,handler:handlers.get('before_agent_start'),base,handlers,tools};
}
test('optional history changes only Reroute tool guidelines, never grows across turns or intercepts Bash',async t=>{
 const f=await fixture(t),ctx={cwd:f.project};
 assert.deepEqual(f.tools.map(t=>t.name),['reroute_run','reroute_status']);assert.deepEqual([...f.handlers.keys()],['before_agent_start']);
 assert.equal(await f.handler(f.event,ctx),undefined);
 const first=[...f.event.systemPromptOptions.toolGuidelines.reroute_run];assert.equal(first.length,f.base.length+1);
 await f.handler(f.event,ctx);assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,first);
 assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.bash,['AFT-owned guideline']);
 assert.equal(f.event.systemPrompt,undefined);assert.equal(f.event.message,undefined);
 f.config.mode='local';await saveConfig(f.project,f.config);await f.handler(f.event,ctx);
 assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,f.base);
});
test('history stays silent for hidden tools, absent config or corrupt receipts, without blocking development',async t=>{
 const f=await fixture(t),ctx={cwd:f.project};
 f.event.systemPromptOptions.hiddenTools=['reroute_run'];await f.handler(f.event,ctx);
 assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,f.base);
 f.event.systemPromptOptions.hiddenTools=[];await f.handler(f.event,ctx);
 await writeFile(join(f.state,'jobs',randomUUID()+'.json'),'{broken');await assert.doesNotReject(f.handler(f.event,ctx));
 assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,f.base);
 await rm(join(f.project,'.reroute.json'));await assert.doesNotReject(f.handler(f.event,ctx));
 assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,f.base);
});

test('disabled tools and unauthorized managed profiles cannot contribute history',async t=>{
 const f=await fixture(t),ctx={cwd:f.project};
 f.event.systemPromptOptions.selectedTools=['bash'];await f.handler(f.event,ctx);
 assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,f.base);
 f.event.systemPromptOptions.selectedTools.push('reroute_run');
 f.config.profiles['local-fixture']={provider:'daytona',id:'auto',image:'reviewed',compute:{cpu:1,memoryGiB:2},managed:{authorized:false,maxCpu:2,maxMemoryGiB:4,maxTaskUsd:1,monthlyUsd:3,cpuHourUsd:.05,memoryGiBHourUsd:.02,storageMonthUsd:.01,idleMinutes:5}};
 await saveConfig(f.project,f.config);
 for(let i=0;i<2;i++)await saveJob(job({project:f.project,profile:{...f.config.profiles['local-fixture'],id:'sb-owned'}}));
 await f.handler(f.event,ctx);assert.deepEqual(f.event.systemPromptOptions.toolGuidelines.reroute_run,f.base);
});
