import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRerouteTool, panel } from '../dist/pi.js';
import { defaults, loadConfig, saveConfig, authorizeProject, userConfigPath } from '../dist/config.js';
import { secretFile } from '../dist/auth.js';

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
 assert.match(messages.join(' '),/still needs a key/,'a profile saved without a key must say so instead of claiming success');
 assert.match(messages.join(' '),/Configure in Pi/);
});
test('compute settings cannot smuggle an API key into project configuration',async t=>{
 const {root,config}=await project(t);await saveConfig(root,config);
 const menus=['Project overrides','Compute & budget','Close'],notices=[];
 await panel({cwd:root,hasUI:true,ui:{select:async()=>menus.shift(),notify:s=>notices.push(s),editor:async()=>JSON.stringify({apiKey:'not-a-real-key'}),confirm:async()=>{throw Error('must not confirm invalid settings');}}});
 assert.match(notices.join(' '),/non-secret/);
 assert.ok(!(await readFile(join(root,'.reroute.json'),'utf8')).includes('not-a-real-key'));
});

test('Pi configures in-panel first and keeps the terminal wizard as an explicit advanced option',async t=>{
 const {root,config}=await project(t);
 const notices=[];const ui=choices=>({select:async()=>choices.shift(),notify:text=>notices.push(text),input:async()=>{throw Error('No unmasked credential inputs');},confirm:async()=>{throw Error('No spending authorization on help');}});
 await panel({cwd:root,hasUI:true,ui:ui(['Advanced terminal setup'])});
 await saveConfig(root,config);
 await panel({cwd:root,hasUI:true,ui:ui(['Manage providers','Configure providers / API keys (masked terminal)','Close'])});
 assert.equal(notices.length,2);
 for(const text of notices){assert.match(text,/bin\/reroute\.mjs/);assert.match(text,/--cwd/);assert.ok(text.includes(root));assert.match(text,/Advanced\/custom setup only/);assert.match(text,/Everyday setup needs no terminal/);}
 assert.equal((await loadConfig(root)).config.active,config.active);
});
test('in-panel onboarding hides the key, writes it outside the project and defaults spending to unauthorized',async t=>{
 const {root}=await project(t);
 const notices=[];const answers=['Configure in Pi (recommended, hidden key input)','Daytona (automatic Sandbox)'];
 const ui={select:async()=>answers.shift(),input:async()=>{throw Error('No unmasked credential inputs');},
  notify:s=>notices.push(s),editor:async()=>undefined,
  // Simulates the hidden-input component: the host only ever renders a mask, never the value.
  custom:async factory=>{
   let result;const component=await factory({requestRender:()=>{}},{fg:(_c,s)=>s},undefined,value=>{result=value;}),
    render=()=>component.render(80);
   component.handleInput('fixture-key-1');
   assert.ok(render().every(line=>!line.includes('fixture-key-1')),'secret must never render');
   assert.match(render()[1],/^\s*\*+\s*$/);
   for(const _ of [...'fixture-key-1'])component.handleInput('\x7f');
   component.handleInput('fixture-not-for-output');
   component.handleInput('\r');
   return result;
  },
  confirm:async(title)=>!/SPENDING — authorize/.test(title)};
 await panel({cwd:root,hasUI:true,ui});
 const saved=(await loadConfig(root)).config;
 assert.equal(saved.active,'daytona');
 assert.equal(saved.profiles.daytona.managed.authorized,false,'No authorization prompt answered yes');
 assert.ok(!JSON.stringify(saved).includes('fixture-not-for-output'));
 assert.match(notices.join(' '),/Saved daytona/);
 const stored=JSON.parse(await readFile(secretFile('daytona'),'utf8'));
 assert.equal(stored.DAYTONA_API_KEY,'fixture-not-for-output');
});
test('hidden input edits by cursor, keeps graphemes whole and only ever renders a mask',async t=>{
 const {root}=await project(t);
 await rm(userConfigPath(),{force:true});
 const answers=['Configure in Pi (recommended, hidden key input)','SSH — your own server (no API key)'];
 const notices=[];
 const ui={select:async()=>answers.shift(),input:async()=>'me@example.test',notify:s=>notices.push(s),editor:async()=>undefined,confirm:async()=>true,
  custom:async factory=>{
   let result;const component=await factory({requestRender:()=>{}},{fg:(_c,s)=>s},undefined,value=>{result=value;}),
    render=()=>component.render(60).join('\n');
   const type=text=>{for(const ch of text)component.handleInput(ch);};
   type('abXc');
   component.handleInput('\x1b[D'); // left arrow, legacy encoding
   component.handleInput('\x7f');   // backspace removes X
   assert.ok(!render().includes('abXc'));
   component.handleInput('\x1b[D'); component.handleInput('\x1b[D'); // two more lefts, before 'a'
   component.handleInput('Z');      // insert at cursor
   // kitty protocol encoding for right arrow must move the cursor, not insert text
   component.handleInput('\x1b[1;1C');
   component.handleInput('\x1b[F');  // End
   type('!');
   // A combining sequence stays one grapheme instead of splitting into code units.
   type('e\u0301');
   component.handleInput('\x1b[1;1D'); // kitty left
   component.handleInput('\x1b[3~');   // Delete key
   component.handleInput('\r');
   assert.equal(result,'Zabc!');
   return result;
  }};
 await panel({cwd:root,hasUI:true,ui});
});
test('onboarding reuses an already-saved named account instead of demanding the key again',async t=>{
 const {root}=await project(t);
 await rm(userConfigPath(),{force:true});
 // The user's real situation: the named account file exists, nothing else is configured.
 await mkdir(dirname(secretFile('daytona')),{recursive:true,mode:0o700});
 await writeFile(secretFile('daytona'),JSON.stringify({DAYTONA_API_KEY:'fixture-already-saved'}),{mode:0o600});
 const answers=['Configure in Pi (recommended, hidden key input)','Daytona (automatic Sandbox)','Close'];
 const notices=[],prompts=[];
 const ui={select:async()=>answers.shift(),input:async()=>{throw Error('no text input expected');},
  // A saved key must never open the hidden input again.
  custom:async()=>{throw Error('saved key must not be re-entered');},
  editor:async()=>undefined,confirm:async title=>{prompts.push(title);return true;},notify:s=>notices.push(s)};
 await panel({cwd:root,hasUI:true,ui});
 const saved=(await loadConfig(root)).config;
 assert.equal(saved.active,'daytona');
 assert.equal(saved.profiles.daytona.credential,'daytona');
 assert.ok(!prompts.some(t=>/Replace the saved credential/.test(t)),'must not ask to replace a saved key: '+prompts.join(' | '));
 assert.match(notices.join(' '),/using the key already saved/);
 // The stored key itself is untouched.
 assert.equal(JSON.parse(await readFile(secretFile('daytona'),'utf8')).DAYTONA_API_KEY,'fixture-already-saved');
});
test('E2B configures fully in-panel: sandbox id plus hidden key, no managed policy invented',async t=>{
 const {root}=await project(t);
 await rm(userConfigPath(),{force:true});
 const plan=['Configure in Pi (recommended, hidden key input)','E2B (existing sandbox ID)','sandbox-abc123'];
 const notices=[];const typed=[];
 const ui={select:async()=>plan.shift(),input:async()=>plan.shift(),notify:s=>notices.push(s),editor:async()=>undefined,
  confirm:async()=>true,
  custom:async factory=>{
   let out;const component=await factory({requestRender:()=>{}},{fg:(_c,s)=>s},undefined,v=>{out=v;});
   for(const ch of 'e2b-fixture-key')component.handleInput(ch);
   assert.ok(component.render(60).every(l=>!l.includes('e2b-fixture-key')),'key must never render');
   component.handleInput('\r');typed.push(out);return out;
  }};
 await panel({cwd:root,hasUI:true,ui});
 const saved=(await loadConfig(root)).config.profiles.e2b;
 assert.deepEqual(saved,{provider:'e2b',id:'sandbox-abc123',credential:'e2b'});
 assert.equal(typed.length,1);
 assert.equal(JSON.parse(await readFile(secretFile('e2b'),'utf8')).E2B_API_KEY,'e2b-fixture-key');
 assert.ok(!JSON.stringify(saved).includes('e2b-fixture-key'));
 assert.ok(!JSON.stringify(saved).includes('managed'),'E2B attaches to an existing sandbox; no spending policy is invented');
 assert.match(notices.join(' '),/Saved e2b/);
});
test('a saved credential account becomes a working profile without a terminal or key entry',async t=>{
 const {root}=await project(t);
 await rm(userConfigPath(),{force:true});
 const dir=dirname(secretFile('daytona'));
 await mkdir(dir,{recursive:true,mode:0o700});
 await writeFile(secretFile('daytona'),JSON.stringify({DAYTONA_API_KEY:'fixture-not-for-output'}),{mode:0o600});
 const notices=[],texts=[];let authorization=false;
 const ui={input:async()=>{throw Error('No unmasked credential inputs');},
  custom:async()=>{throw Error('An existing saved account needs no key entry');},
  notify:s=>notices.push(s),editor:async()=>undefined,
  confirm:async(title,text)=>{texts.push(text);if(/SPENDING — authorize/.test(title))authorization=true;return true;}};
 // The account picker is the second select call, so replay the first-run menu then the picker.
 const choices=['Use a saved credential account','daytona — saved account: daytona'];
 await panel({cwd:root,hasUI:true,ui:{...ui,select:async()=>choices.shift()}});
 const saved=(await loadConfig(root)).config;
 assert.equal(saved.active,'daytona');
 assert.equal(saved.profiles.daytona.credential,'daytona');
 assert.equal(saved.profiles.daytona.id,'auto');
 assert.equal(saved.profiles.daytona.managed.authorized,authorization);
 assert.match(notices.join(' '),/Saved daytona/);
 assert.ok(!JSON.stringify(saved).includes('fixture-not-for-output'));
 const configText=await readFile(userConfigPath(),'utf8');
 assert.ok(!configText.includes('fixture-not-for-output'));
});
