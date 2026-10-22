import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';
import { createRerouteTool, panel } from '../dist/pi.js';
import { defaults, saveConfig, loadConfig } from '../dist/config.js';
import { setup } from '../dist/setup.js';

test('actual Pi extension loader registers independent run/status tools and /reroute',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-load-')),agent=join(root,'agent');await mkdir(agent);t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await sdk.discoverAndLoadExtensions([resolve('adapters/pi.ts')],root,agent);
 assert.deepEqual(result.errors,[]);const ext=result.extensions.find(e=>e.path.endsWith('adapters/pi.ts'));assert.ok(ext);
 assert.deepEqual([...ext.tools.keys()],['reroute_run','reroute_status']);assert.ok(ext.commands.has('reroute'));
 assert.equal(ext.handlers.has('user_bash'),false);assert.equal(ext.handlers.has('tool_call'),false);
 const tool=ext.tools.get('reroute_run').definition;
 assert.equal(tool.exposure,'direct');assert.equal(tool.defaultActive,true);
 assert.deepEqual(Object.keys(tool.parameters.properties),['command','timeout','cpu','memoryGiB']);
 assert.deepEqual(tool.parameters.required,['command']);
 assert.match(tool.description,/configured Reroute execution environment/);
 assert.match(tool.description,/one independent/);assert.match(tool.description,/&&, pipes, redirects/);
 assert.match(tool.promptGuidelines.join(' '),/wait for the previous task to succeed/);
 assert.match(tool.promptGuidelines.join(' '),/stop dependent tasks/);
 assert.match(tool.promptGuidelines.join(' '),/first call reroute_status/);
 const status=ext.tools.get('reroute_status').definition;
 assert.equal(status.exposure,'direct');assert.equal(status.defaultActive,true);
 assert.deepEqual(Object.keys(status.parameters.properties),['jobId']);
 assert.deepEqual(status.parameters.required,['jobId']);assert.equal(status.parameters.additionalProperties,false);
 assert.match(status.description,/without the optional CLI/);
 assert.match(status.promptGuidelines.join(' '),/Recorded history is not current confirmation/);
 assert.match(tool.promptSnippet,/bash/);assert.match(tool.promptGuidelines.join(' '),/user authorization/);
});
test('ordinary native Bash remains local with native failure and truncation semantics',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tool=sdk.createBashTool(root);
 const r=await tool.execute('call',{command:"printf 'out'; printf 'err' >&2; exit 7"});
 assert.equal(r.structuredContent.exit_code,7);assert.equal(r.isError,true);assert.match(r.content[0].text,/out/);assert.match(r.content[0].text,/err/);
 const large=await tool.execute('large',{command:"python3 -c 'print(\"x\"*60000)'"});assert.ok(large.details?.truncation?.truncated);assert.ok(large.details.fullOutputPath);await rm(large.details.fullOutputPath,{force:true});
});
test('independent tool routes eligible tasks using ctx.cwd, separated output, progress, signal and timeout',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'host'}}});
 const cwd=join(root,'nested');await mkdir(cwd);
 const abort=new AbortController(),updates=[];let calls=0;
 const tool=createRerouteTool(async(c,o)=>{
   calls++;assert.equal(c,'cargo test');assert.equal(o.cwd,cwd);assert.equal(o.root,root);assert.equal(o.timeoutMs,4000);assert.equal(o.signal,abort.signal);
   o.onJob({id:'test',status:'preparing'});o.stdout(Buffer.from('out'));o.stderr(Buffer.from('err'));
   return {code:4,stdout:'out',stderr:'err',job:{id:'test',status:'exited'}};
 });
 const r=await tool.execute('call',{command:'cargo test',timeout:4},abort.signal,u=>updates.push(u),{cwd});
 assert.equal(r.isError,true);assert.equal(r.structuredContent.exitCode,4);assert.equal(r.details.jobId,'test');
 assert.equal(r.details.stdout,'out');assert.equal(r.details.stderr,'err');assert.ok(updates.length);
 assert.match(r.content[0].text,/Reroute status: exited/);assert.equal(calls,1);
});
test('native panel changes routing without invoking a model or touching remote resources on open',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-panel-'));t.after(()=>rm(root,{recursive:true,force:true}));await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'not-connected'}}});
 const choices=['Routing mode','local','Close'];const ctx={cwd:root,hasUI:true,ui:{select:async()=>choices.shift(),notify:()=>{},confirm:async()=>{throw Error('should not request resource changes')}}};
 await panel(ctx);assert.equal((await loadConfig(root)).config.mode,'local');
});
test('setup writes project config only, never personal or project Pi extensions/settings',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-native-only-'));
 const agent=join(root,'private-pi-agent'),piRoot=join(root,'.pi');
 t.after(()=>rm(root,{recursive:true,force:true}));
 const previous=process.env.PI_CODING_AGENT_DIR;
 process.env.PI_CODING_AGENT_DIR=agent;
 t.after(()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;});
 const entry=join(agent,'extensions','reroute.ts');
 await mkdir(join(agent,'extensions'),{recursive:true});
 await writeFile(entry,'// user-authored extension - must never be touched\n');
 await setup(root,{nonInteractive:true,provider:'ssh',id:'host'});
 assert.equal((await loadConfig(root)).config.active,'default');
 assert.equal(await readFile(entry,'utf8'),'// user-authored extension - must never be touched\n');
 await assert.rejects(readFile(join(piRoot,'settings.json'),'utf8'),/ENOENT/);
 await assert.rejects(readFile(join(piRoot,'extensions','reroute.ts'),'utf8'),/ENOENT/);
});

test('Pi overview shows configured profiles and local credential availability without contacting cloud',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-overview-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'existing-host'},cloud:{provider:'daytona',id:'existing-sandbox'}}});
 const menus=['Overview','Close'], notices=[];
 const ctx={cwd:root,hasUI:true,ui:{select:async()=>menus.shift(),notify:(s)=>notices.push(s),confirm:async()=>{throw Error('No network or resource control on overview');}}};
 await panel(ctx);
 assert.match(notices.join('\n'),/cloud \| daytona \| existing-sandbox/);
 assert.match(notices.join('\n'),/\* ssh \| ssh \| existing-host/);
 assert.match(notices.join('\n'),/No cloud calls made/);
});
test('Pi native menus add and forget local profiles without changing remote resources',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-management-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'existing-host'}}});
 const menus=['Manage providers','Add provider','daytona','Close'];
 const answers=['cloud','existing-sandbox',''];
 const ctx={cwd:root,hasUI:true,ui:{
   select:async()=>menus.shift(),input:async()=>answers.shift(),notify:()=>{},confirm:async()=>true,
 }};
 await panel(ctx);
 const after=(await loadConfig(root)).config;assert.equal(after.active,'cloud');assert.equal(after.profiles.cloud.id,'existing-sandbox');assert.equal(after.profiles.ssh.id,'existing-host');
 const remove=['Manage providers','Remove local profile','cloud','Close'];
 await panel({cwd:root,hasUI:true,ui:{select:async()=>remove.shift(),notify:()=>{},confirm:async()=>true}});
 const final=(await loadConfig(root)).config;assert.equal(final.active,'ssh');assert.deepEqual(Object.keys(final.profiles),['ssh']);
});

test('Pi natively loads a source-only Git package with NO dist directory or npm build step',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-source-package-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const packageDir=join(root,'package'),agent=join(root,'agent');
 const {cp,symlink,stat}=await import('node:fs/promises');
 await mkdir(packageDir);
 await mkdir(agent);
 await cp(resolve('src'),join(packageDir,'src'),{recursive:true});
 await cp(resolve('adapters'),join(packageDir,'adapters'),{recursive:true});
 await symlink(resolve('node_modules'),join(packageDir,'node_modules'),'dir');
 await writeFile(join(packageDir,'package.json'),JSON.stringify({
   name:'reroute',type:'module',pi:{extensions:['./adapters/pi.ts']},
   peerDependencies:{'@earendil-works/pi-coding-agent':'*'}
 }));
 await assert.rejects(stat(join(packageDir,'dist')), /ENOENT/);
 const result=await sdk.discoverAndLoadExtensions([join(packageDir,'adapters','pi.ts')],root,agent);
 assert.deepEqual(result.errors,[]);
 const extension=result.extensions[0];
 assert.ok(extension);
 assert.ok(extension.commands.has('reroute'));
 assert.ok(extension.tools.has('reroute_run'));
  assert.equal(extension.tools.has('bash'),false);
  assert.equal(extension.handlers.has('user_bash'),false);
});

test('first /reroute invocation can create only the current project config',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-first-project-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const menus=['Configure this project','ssh','Close'];
 const inputs=['default','new-host','','',''];
 const notices=[];
 const ctx={cwd:root,hasUI:true,ui:{
   select:async()=>menus.shift(),input:async()=>inputs.shift(),notify:(s)=>notices.push(s),confirm:async()=>true,
 }};
 await panel(ctx);
 const {config}=await loadConfig(root);
 assert.equal(config?.profiles.default?.provider,'ssh');
 assert.equal(config?.profiles.default?.id,'new-host');
 assert.equal(config?.active,'default');
 await assert.rejects(readFile(join(root,'.pi','settings.json'),'utf8'),/ENOENT/);
});


test('dangerous resource operations are hidden under Advanced, require consent, and never run on panel open',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-advanced-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'offline-host'}}});
 const seen=[],notices=[];
 const choices=['Advanced','Destroy resource','Close'];
 await panel({cwd:root,hasUI:true,ui:{
   select:async(_message,options)=>{seen.push(options);return choices.shift();},
   confirm:async()=>false,
   notify:s=>notices.push(s),
 }});
 assert.ok(seen[0].includes('Advanced'));
 assert.ok(!seen[0].includes('Destroy resource'));
 assert.ok(seen[1].includes('Destroy resource'));
 assert.equal((await loadConfig(root)).config.profiles.ssh.id,'offline-host');
 assert.deepEqual(notices,[]);
});

test('Pi profile edit cancellation does not save partial changes or contact providers',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-cancel-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const initial={...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'original-host'}}};
 await saveConfig(root,initial);
 const choices=['Manage providers','Edit provider','ssh','Keep current (ssh)','Close'];
 const answers=['different-host',undefined];
 await panel({cwd:root,hasUI:true,ui:{
   select:async()=>choices.shift(),input:async()=>answers.shift(),
   confirm:async()=>{throw Error('Cancel must not ask to save');},notify:()=>{},
 }});
 assert.deepEqual((await loadConfig(root)).config,initial);
});

test('switching an existing profile is a local-only operation',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-switch-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'host'},cloud:{provider:'daytona',id:'sandbox'}}});
 const choices=['Manage providers','Switch active provider','cloud','Close'];
 await panel({cwd:root,hasUI:true,ui:{
   select:async()=>choices.shift(),notify:()=>{},
   confirm:async()=>{throw Error('Switch needs no cloud management confirmation');},
 }});
 assert.equal((await loadConfig(root)).config.active,'cloud');
});

async function toolProject(t) {
 const root=await mkdtemp(join(tmpdir(),'reroute-tool-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const config={...defaults(),active:'fixture',profiles:{fixture:{provider:'ssh',id:'fixture',root:root+'/remote'}}};
 await saveConfig(root,config);
 return {root,config};
}
test('local decisions and missing configuration decline without running remote or local commands',async t=>{
 const {root,config}=await toolProject(t);let calls=0;
 const tool=createRerouteTool(async()=>{calls++;throw Error('Must not execute');});
  for(const [command,reason] of [['git status','control-or-side-effect-command'],['npm publish','control-or-side-effect-command'],['echo hello','unknown-task'],['cargo test | tee log','complex-or-ambiguous-shell']]) {
    const r=await tool.execute('decline',{command},undefined,undefined,{cwd:root});
    assert.equal(r.isError,true);assert.equal(r.details.status,'not_started');assert.equal(r.details.exitCode,null);assert.equal(r.details.jobId,null);assert.match(r.details.reason,new RegExp(reason));assert.match(r.content[0].text,/Nothing executed.*does not fall back locally/);
  }
 await saveConfig(root,{...config,mode:'local'});
 assert.match((await tool.execute('local',{command:'cargo test'},undefined,undefined,{cwd:root})).details.reason,/local-mode/);
 await rm(join(root,'.reroute.json'));
 assert.match((await tool.execute('missing',{command:'cargo test'},undefined,undefined,{cwd:root})).details.reason,/not-configured/);
 assert.equal(calls,0);
});
test('output is bounded during progress and completion, UTF-8 chunks survive and truncation is explicit',async t=>{
 const {root}=await toolProject(t);const updates=[];
 const tool=createRerouteTool(async(_c,o)=>{
   const utf8=Buffer.from('你好');o.stdout(utf8.subarray(0,2));o.stdout(utf8.subarray(2));
   o.stderr(Buffer.from('diagnostic'));
   for(let i=0;i<100;i++)o.stdout(Buffer.alloc(8192,'x'));
   o.stdout(Buffer.from('tail'));
   return {code:0,stdout:'',stderr:'',job:{id:'large',status:'exited'}};
 });
 const r=await tool.execute('large',{command:'cargo test'},undefined,u=>updates.push(u),{cwd:root});
 assert.equal(r.isError,false);assert.equal(r.details.outputTruncated,true);assert.equal(r.details.stdout.length,8192);assert.ok(r.details.stdout.endsWith('tail'));assert.equal(r.details.stderr,'diagnostic');
 assert.match(r.content[0].text,/Output truncated/);
 for(const u of updates)assert.ok(u.content[0].text.length<18000);
 const unicode=createRerouteTool(async(_c,o)=>{const b=Buffer.from('你好');o.stdout(b.subarray(0,2));o.stdout(b.subarray(2));return {code:0,stdout:'',stderr:'',job:{id:'utf8',status:'exited'}};});
 assert.equal((await unicode.execute('unicode',{command:'cargo test'},undefined,undefined,{cwd:root})).details.stdout,'你好');
});
test('returned-only provider output is bounded and provider truncation flags are not hidden',async t=>{
 const {root}=await toolProject(t);
 const tool=createRerouteTool(async()=>({code:0,stdout:'x'.repeat(60000),stderr:'err',stdoutTruncated:true,job:{id:'return',status:'exited'}}));
 const r=await tool.execute('return',{command:'cargo test'},undefined,undefined,{cwd:root});
 assert.equal(r.details.stdout.length,8192);assert.equal(r.details.outputTruncated,true);assert.match(r.content[0].text,/not saved/);
});
test('invalid input and pre-start abort never execute a task',async t=>{
 const {root}=await toolProject(t);let calls=0;
 const tool=createRerouteTool(async()=>{calls++;throw Error('Must not execute');});
 for(const params of [{command:' '},{command:'cargo test',timeout:0},{command:'cargo test',timeout:Infinity},{command:'cargo test',timeout:86401}])assert.equal((await tool.execute('invalid',params,undefined,undefined,{cwd:root})).isError,true);
 const controller=new AbortController();controller.abort();
 const r=await tool.execute('abort',{command:'cargo test'},controller.signal,undefined,{cwd:root});
 assert.equal(r.isError,true);assert.equal(r.details.status,'cancelled');assert.equal(r.details.exitCode,null);assert.equal(calls,0);
});
test('actual engine with mock Provider preserves receipts, cancellation, timeout, unknown and no local retry',async t=>{
 const {root}=await toolProject(t);
 const {runRemote}=await import('../dist/engine.js');const {parse}=await import('shell-quote');
 const previous=process.env.REROUTE_STATE_DIR;process.env.REROUTE_STATE_DIR=join(root,'state');
 t.after(()=>{if(previous===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=previous;});
 await writeFile(join(root,'Makefile'),'test:\n\ttouch LOCAL_RETRY_MARKER\n');
 for(const scenario of ['success','nonzero','timed_out','cancelled','unknown','transport','upload']) {
   await t.test(scenario,async()=>{
     const controller=new AbortController();let runs=0,closed=0,receipt={status:'exited',code:0};
     if(scenario==='nonzero')receipt.code=7;
     if(scenario==='timed_out')receipt={status:'timed_out',code:124};
     const provider={stdin:false,status:async()=> 'running',put:async()=>{if(scenario==='upload')throw Error('upload lost');},close:()=>{closed++;},exec:async(command,o)=>{
       const args=parse(command),action=args[3];
       if(action==='stage')return {code:0,stdout:JSON.stringify({needed:[]}),stderr:''};
       if(action==='run') {
         runs++;o.stdout(Buffer.from('stdout'));o.stderr(Buffer.from('stderr'));
         if(scenario==='cancelled'){controller.abort();return new Promise(resolve=>o.signal.addEventListener('abort',()=>resolve({code:130,stdout:'',stderr:''}),{once:true}));}
         if(scenario==='transport')throw Error('transport lost');
         return {code:receipt.code,stdout:'stdout',stderr:'stderr'};
       }
       if(action==='cancel'){receipt={status:'cancelled',code:130};return {code:0,stdout:JSON.stringify(receipt),stderr:''};}
       if(action==='status') {if(['unknown','upload'].includes(scenario))throw Error('status lost');return {code:0,stdout:JSON.stringify(receipt),stderr:''};}
       return {code:0,stdout:'{}',stderr:''};
     }};
     const tool=createRerouteTool((command,options)=>runRemote(command,{...options,provider}));
     const r=await tool.execute(scenario,{command:'make test',timeout:1},controller.signal,undefined,{cwd:root});
     assert.equal(r.details.status,scenario==='upload'||scenario==='unknown'?'unknown':receipt.status);
     assert.equal(r.details.exitCode,['upload','unknown','transport'].includes(scenario)?125:receipt.code);
     assert.equal(r.isError,scenario!=='success');assert.ok(r.details.jobId);assert.equal(closed,1);assert.equal(runs,scenario==='upload'?0:1);
     if(scenario!=='upload'){assert.equal(r.details.stdout,'stdout');assert.equal(r.details.stderr,'stderr');}
     await assert.rejects(readFile(join(root,'LOCAL_RETRY_MARKER')),/ENOENT/);
   });
 }
});

test('pre-execution and infrastructure errors remain bounded and preserve job identity',async t=>{
 const {root}=await toolProject(t);
 const tool=createRerouteTool(async(_command,options)=>{
   const job={id:'uncertain-job',status:'preparing'};options.onJob(job);job.status='unknown';
   throw Error('x'.repeat(100000)+' connection lost');
 });
 const r=await tool.execute('error',{command:'cargo test'},undefined,undefined,{cwd:root});
 assert.equal(r.isError,true);assert.equal(r.details.status,'unknown');assert.equal(r.details.jobId,'uncertain-job');assert.equal(r.details.exitCode,125);
 assert.ok(r.content[0].text.length<9000);assert.match(r.details.reason,/Diagnostic truncated/);assert.match(r.content[0].text,/Never retried locally/);
});
