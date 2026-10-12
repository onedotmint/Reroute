import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';
import { registerPi, createRerouteOperations, panel } from '../dist/pi.js';
import { defaults, saveConfig, loadConfig } from '../dist/config.js';
import { setup } from '../dist/setup.js';

test('actual Pi extension loader loads the shipped adapter and registers native bash and /reroute',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-load-')),agent=join(root,'agent');await mkdir(agent);t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await sdk.discoverAndLoadExtensions([resolve('adapters/pi.ts')],root,agent);
 assert.deepEqual(result.errors,[]);const ext=result.extensions.find(e=>e.path.endsWith('adapters/pi.ts'));assert.ok(ext);
 assert.ok(ext.tools.has('bash'));assert.ok(ext.commands.has('reroute'));assert.ok(ext.handlers.has('user_bash'));
});
test('actual native Bash keeps local execution and native failure/truncation semantics',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const operations=createRerouteOperations(sdk.createLocalBashOperations());const tool=sdk.createBashTool(root,{operations});
 const r=await tool.execute('call',{command:"printf 'out'; printf 'err' >&2; exit 7"});
 assert.equal(r.structuredContent.exit_code,7);assert.equal(r.isError,true);assert.match(r.content[0].text,/out/);assert.match(r.content[0].text,/err/);
 const large=await tool.execute('large',{command:"python3 -c 'print(\"x\"*60000)'"});assert.ok(large.details?.truncation?.truncated);assert.ok(large.details.fullOutputPath);await rm(large.details.fullOutputPath,{force:true});
});
test('Pi routes recognized tasks through operations with native onData/signal/timeout; unknown tasks stay local',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-pi-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await saveConfig(root,{...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'host'}}});
 const calls=[];const local={exec:async(c)=>{calls.push(['local',c]);return {exitCode:0}}};let out='';const abort=new AbortController();
 const ops=createRerouteOperations(local,async(c,o)=>{calls.push(['remote',c]);assert.equal(o.timeoutMs,4000);assert.equal(o.signal,abort.signal);o.stdout(Buffer.from('out'));o.stderr(Buffer.from('err'));return {code:4,stdout:'out',stderr:'err',job:{id:'test',status:'exited'}}});
 assert.equal((await ops.exec('cargo test',root,{onData:b=>out+=b,timeout:4,signal:abort.signal})).exitCode,4);assert.equal(out,'outerr');
 await ops.exec('git status',root,{onData:()=>{}});assert.deepEqual(calls.map(x=>x[0]),['remote','local']);
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
 assert.ok(extension.tools.has('bash'));
 assert.ok(extension.handlers.has('user_bash'));
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
