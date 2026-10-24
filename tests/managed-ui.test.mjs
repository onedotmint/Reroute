import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRerouteTool, panel } from '../dist/pi.js';
import { defaults, loadConfig, saveConfig, authorizeProject } from '../dist/config.js';

const isolated=await mkdtemp(join(tmpdir(),'reroute-managed-ui-isolation-'));
process.env.XDG_CONFIG_HOME=join(isolated,'config');
process.env.REROUTE_STATE_DIR=join(isolated,'state');
after(()=>rm(isolated,{recursive:true,force:true}));

const profile = () => ({provider:'daytona',id:'auto',image:'reviewed-toolchain:1',credential:'gift-account',compute:{cpu:2,memoryGiB:4},
 managed:{authorized:false,maxCpu:8,maxMemoryGiB:16,maxTaskUsd:0.5,monthlyUsd:3,cpuHourUsd:0.0504,memoryGiBHourUsd:0.0162,storageMonthUsd:0.01,idleMinutes:5}});
async function project(t) {
 const base=await mkdtemp(join(tmpdir(),'reroute-managed-ui-')),root=join(base,'project');await mkdir(root);
 t.after(()=>rm(base,{recursive:true,force:true}));
 return {base,root,config:{...defaults(),active:'cloud',profiles:{cloud:profile()}}};
}
test('CLI managed setup and plan work without an ID, credentials or cloud calls; unauthorized execution fails closed',async t=>{
 const {base,root}=await project(t), state=join(base,'state');
 const cli=(...args)=>spawnSync(process.execPath,[resolve('bin/reroute.mjs'),'--cwd',root,...args],{encoding:'utf8',env:{...process.env,REROUTE_STATE_DIR:state,XDG_CONFIG_HOME:join(base,'private'),DAYTONA_API_KEY:'fixture-not-for-output'}});
 const setup=cli('setup','--project','--non-interactive','--managed','--provider','daytona','--credential','gift-account','--image','reviewed-toolchain:1','--preset','medium','--max-cpu','8','--max-memory','16','--cpu-hour-usd','0.0504','--memory-hour-usd','0.0162');
 assert.equal(setup.status,0,setup.stderr);
 assert.equal((await loadConfig(root)).config.profiles.default.id,'auto');
 assert.ok(!(await readFile(join(root,'.reroute.json'),'utf8')).includes('fixture-not-for-output'));
 const plan=cli('plan','--cpu','4','--memory','8','--','cargo','test');assert.equal(plan.status,0,plan.stderr);
 const data=JSON.parse(plan.stdout);assert.deepEqual(data.profile.compute,{cpu:4,memoryGiB:8});assert.equal(data.balance,'unavailable');assert.equal(data.source,'estimate');
 assert.ok(data.estimatedUsd>0);assert.ok(!plan.stdout.includes('fixture-not-for-output'));
 await assert.rejects(readFile(join(state,'cloud')),/ENOENT|EISDIR/);
 const run=cli('exec','--','cargo','test');assert.equal(run.status,125);assert.match(run.stderr,/not authorized/);
 assert.equal(cli('plan','--cpu','1000','--','cargo','test').status,125);
 assert.equal(cli('plan','--cpu','NaN','--','cargo','test').status,125);
 assert.equal(cli('plan','--preset','typo','--','cargo','test').status,125);
});
test('Pi passes user sizing overrides without changing defaults or Bash ownership',async t=>{
 const {root,config}=await project(t);await saveConfig(root,config);await authorizeProject(root,config);
 let calls=0;
 const tool=createRerouteTool(async(_command,opts)=>{
  calls++;assert.deepEqual(opts.compute,{cpu:4,memoryGiB:8});
  return {code:0,stdout:'ok',stderr:'',job:{id:'fixture-job',status:'exited',profile:{...profile(),compute:{cpu:4,memoryGiB:8}}}};
 });
 const result=await tool.execute('sized',{command:'cargo test',cpu:4,memoryGiB:8},undefined,undefined,{cwd:root});
 assert.equal(result.isError,false);assert.match(result.content[0].text,/4 CPU \/ 8 GiB/);assert.equal(calls,1);
 assert.deepEqual((await loadConfig(root)).config.profiles.cloud.compute,{cpu:2,memoryGiB:4});
 for(const value of [NaN,Infinity,0,-1]){
  const invalid=await tool.execute('invalid',{command:'cargo test',cpu:value},undefined,undefined,{cwd:root});assert.equal(invalid.isError,true);
 }
 assert.equal(calls,1);
});
test('Pi managed onboarding uses one non-secret settings editor and explicit authorization confirmation',async t=>{
 const {root}=await project(t), menus=['Configure this project','daytona','Close'],answers=['cloud','auto',''];
 const messages=[];let edited=0,confirmed=0;
 await panel({cwd:root,hasUI:true,ui:{
  select:async()=>menus.shift(),input:async()=>answers.shift(),notify:s=>messages.push(s),
  editor:async(title,initial)=>{edited++;assert.match(title,/NO secrets/);const data=JSON.parse(initial);data.image='reviewed-toolchain:1';data.credential='gift-account';data.managed.authorized=true;return JSON.stringify(data);},
  confirm:async(_title,text)=>{confirmed++;assert.match(text,/Credit is UNKNOWN/);return true;},
 }});
 const saved=(await loadConfig(root)).config.profiles.cloud;
 assert.equal(saved.id,'auto');assert.equal(saved.credential,'gift-account');assert.equal(saved.managed.authorized,true);assert.equal(edited,1);assert.equal(confirmed,1);
 assert.match(messages.join(' '),/masked/);
});
test('compute settings cannot smuggle an API key into project configuration',async t=>{
 const {root,config}=await project(t);await saveConfig(root,config);
 const menus=['Project overrides','Compute & budget','Close'],notices=[];
 await panel({cwd:root,hasUI:true,ui:{select:async()=>menus.shift(),notify:s=>notices.push(s),editor:async()=>JSON.stringify({apiKey:'not-a-real-key'}),confirm:async()=>{throw Error('must not confirm invalid settings');}}});
 assert.match(notices.join(' '),/non-secret/);
 assert.ok(!(await readFile(join(root,'.reroute.json'),'utf8')).includes('not-a-real-key'));
});

test('Pi points to the installed masked multi-provider setup without spawning a terminal or asking for secrets',async t=>{
 const {root,config}=await project(t);
 const notices=[];const ui=choices=>({select:async()=>choices.shift(),notify:text=>notices.push(text),input:async()=>{throw Error('No unmasked credential inputs');},confirm:async()=>{throw Error('No spending authorization on help');}});
 await panel({cwd:root,hasUI:true,ui:ui(['Configure Daytona / Modal / SSH (masked terminal)'])});
 await saveConfig(root,config);
 await panel({cwd:root,hasUI:true,ui:ui(['Manage providers','Configure providers / API keys (masked terminal)','Close'])});
 assert.equal(notices.length,2);
 for(const text of notices){assert.match(text,/bin\/reroute\.mjs/);assert.match(text,/--cwd/);assert.ok(text.includes(root));assert.match(text,/Space selects multiple providers/);assert.match(text,/not a Pi text field/);}
 assert.equal((await loadConfig(root)).config.active,config.active);
});
