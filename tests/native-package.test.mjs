import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as sdk from '@earendil-works/pi-coding-agent';

const root=resolve('.');
const piCli=resolve('node_modules/.bin/pi');
function invoke(cwd,env,...args){
 const r=spawnSync(piCli,args,{cwd,env,encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,'pi '+args.join(' ')+': '+(r.stderr||r.stdout||r.error));
 return r.stdout;
}
test('real Pi CLI owns project-local package install, discovery/listing and removal', {timeout:95000}, async t=>{
 const temp=await mkdtemp(join(tmpdir(),'reroute-pi-install-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const project=join(temp,'project'),agent=join(temp,'agent');
 await mkdir(project);
 await mkdir(agent);
 const env={...process.env,PI_CODING_AGENT_DIR:agent,XDG_CONFIG_HOME:join(temp,'xdg'),HOME:temp,CI:'true'};
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 assert.deepEqual(manifest.pi.extensions,['./adapters/pi.ts']);
 assert.ok(manifest.keywords.includes('pi-package'));
 invoke(project,env,'install','--local',root);
 const settings=JSON.parse(await readFile(join(project,'.pi','settings.json'),'utf8'));
 assert.ok(settings.packages?.length,'pi install --local must write project package declaration');
 assert.ok(settings.packages.some(p=>typeof p==='string'||p?.source),'package declaration missing');
 // Pi intentionally hides project packages in noninteractive commands until project trust is granted.
 assert.match(invoke(project,env,'list','--approve'),/reroute/i);
 assert.match(invoke(project,env,'list','--no-approve'),/No packages installed/);
  const loaded=await sdk.discoverAndLoadExtensions([join(root,'adapters','pi.ts')],project,agent);
  assert.deepEqual(loaded.errors,[]);
  const extension=loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()],['reroute_run','reroute_status']);
  assert.ok(extension.commands.has('reroute'));
  assert.equal(extension.handlers.has('user_bash'),false);
 await assert.rejects(stat(join(agent,'extensions','reroute.ts')), /ENOENT/);
 await assert.rejects(stat(join(agent,'settings.json')), /ENOENT/);
 invoke(project,env,'remove','--local','--approve',root);
 const after=JSON.parse(await readFile(join(project,'.pi','settings.json'),'utf8'));
 assert.equal(after.packages?.length??0,0,'project-local Pi uninstall must remove the installed package declaration');
 await assert.rejects(stat(join(agent,'extensions','reroute.ts')), /ENOENT/);
});


test('two physical Pi package instances register once and remain registered after actual session reload', { timeout: 60000 }, async t => {
 const temp=await mkdtemp(join(tmpdir(),'reroute-pi-duplicate-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const project=join(temp,'project'),agent=join(temp,'agent');
 await mkdir(project);await mkdir(agent);
 const packages=[];
 for(const copy of ['first-copy','second-copy']) {
  const dir=join(temp,copy);await mkdir(dir);
  await cp(join(root,'src'),join(dir,'src'),{recursive:true});
  await cp(join(root,'adapters'),join(dir,'adapters'),{recursive:true});
  await symlink(join(root,'node_modules'),join(dir,'node_modules'),'dir');
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'@onedotmint/reroute',type:'module',pi:{extensions:['./adapters/pi.ts']}}));
  packages.push(dir);
 }
 for(const paths of [packages,[...packages].reverse()]) {
  const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},cacheWarming:'off'});
  const loader=new sdk.DefaultResourceLoader({cwd:project,agentDir:agent,settingsManager,
   noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,additionalExtensionPaths:paths});
  await loader.reload();
  const runtime=await sdk.ModelRuntime.create({authPath:join(agent,'auth.json'),modelsPath:null,modelsStorePath:join(agent,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  const {session}=await sdk.createAgentSession({cwd:project,agentDir:agent,resourceLoader:loader,settingsManager,modelRuntime:runtime,
   model:runtime.getModels()[0],sessionManager:sdk.SessionManager.inMemory(project)});
  try {
   await session.bindExtensions({onError:error=>{throw Error(error.message);}});
   for(let generation=0;generation<2;generation++) {
    const loaded=loader.getExtensions();
    assert.deepEqual(loaded.errors,[]);
    const copies=loaded.extensions.filter(ext=>packages.some(dir=>ext.path.startsWith(dir)));
    assert.equal(copies.length,2,'both physical package instances must really load');
    for(const name of ['reroute_run','reroute_status']) {
     assert.equal(copies.filter(ext=>ext.tools.has(name)).length,1,'exactly one owner after reload '+generation);
     assert.equal(session.getActiveToolNames().filter(tool=>tool===name).length,1);
     assert.equal(session.getToolDefinition(name).name,name);
    }
    assert.equal(copies.filter(ext=>ext.commands.has('reroute')).length,1);
    assert.equal(copies.reduce((n,ext)=>n+(ext.handlers.get('before_agent_start')?.length??0),0),1);
    assert.ok(copies.every(ext=>!ext.tools.has('bash')&&!ext.handlers.has('user_bash')&&!ext.handlers.has('tool_call')));
    assert.ok(session.getActiveToolNames().includes('bash'));
    if(generation===0)await session.reload();
   }
  } finally {
   await session.extensionRunner.emit({type:'session_shutdown'});
   session.dispose();
  }
 }
});


test('real Pi global CLI install coexists with project declaration, discovers once and removes each scope independently', {timeout:30000}, async t=>{
 const temp=await mkdtemp(join(tmpdir(),'reroute-pi-global-install-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const project=join(temp,'project'),agent=join(temp,'agent');await mkdir(project);await mkdir(agent);
 const env={...process.env,PI_CODING_AGENT_DIR:agent,XDG_CONFIG_HOME:join(temp,'xdg'),HOME:temp,PI_OFFLINE:'1',CI:'true'};
 invoke(project,env,'install',root);
 const globalPath=join(agent,'settings.json'),projectPath=join(project,'.pi','settings.json');
 const global=JSON.parse(await readFile(globalPath,'utf8'));
 assert.equal(global.packages.length,1);
 assert.match(invoke(project,env,'list','--no-approve'),/reroute/i);
 await assert.rejects(stat(projectPath),/ENOENT/);
 invoke(project,env,'install','--local',root);
 assert.equal(JSON.parse(await readFile(projectPath,'utf8')).packages.length,1);
 assert.equal(JSON.parse(await readFile(globalPath,'utf8')).packages.length,1);
 assert.match(invoke(project,env,'list','--approve'),/reroute/i);
 const settingsManager=sdk.SettingsManager.create(project,agent);
 const loader=new sdk.DefaultResourceLoader({cwd:project,agentDir:agent,settingsManager,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
 await loader.reload({resolveProjectTrust:async()=>true});
 const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
 const owners=loaded.extensions.filter(ext=>ext.tools.has('reroute_run'));
 assert.equal(owners.length,1,'equivalent global and project package declarations must load exactly once');
 assert.ok(owners[0].commands.has('reroute'));
 assert.equal(owners[0].tools.has('bash'),false);
 invoke(project,env,'remove','--local','--approve',root);
 assert.equal(JSON.parse(await readFile(projectPath,'utf8')).packages?.length??0,0);
 assert.equal(JSON.parse(await readFile(globalPath,'utf8')).packages.length,1);
 assert.match(invoke(project,env,'list','--no-approve'),/reroute/i);
 invoke(project,env,'remove',root);
 assert.equal(JSON.parse(await readFile(globalPath,'utf8')).packages?.length??0,0);
 assert.match(invoke(project,env,'list','--approve'),/No packages installed/);
 await assert.rejects(stat(join(agent,'extensions','reroute.ts')),/ENOENT/);
});
