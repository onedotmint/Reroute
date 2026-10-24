import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaults, loadConfig, saveConfig, saveUserConfig, saveProjectOverrides, userConfigPath, projectRoot,
  authorizeProject, projectAuthorized, revokeProject } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
import { processExec } from '../dist/util.js';
import { withManagedResource } from '../dist/resources.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reroute-global-'));
  const old = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, REROUTE_STATE_DIR: process.env.REROUTE_STATE_DIR };
  process.env.XDG_CONFIG_HOME = join(dir, 'private'); process.env.REROUTE_STATE_DIR = join(dir, 'state');
  t.after(async () => { for (const [k,v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await rm(dir, {recursive:true,force:true}); });
  const a = join(dir, 'a'), b = join(dir, 'b'); await mkdir(a); await mkdir(b);
  const config = {...defaults(),active:'cloud',profiles:{cloud:{provider:'daytona',credential:'account',id:'auto',image:'test-image',compute:{cpu:1,memoryGiB:2},managed:{authorized:true,maxCpu:8,maxMemoryGiB:16,monthlyUsd:3,maxTaskUsd:0.5,cpuHourUsd:0.05,memoryGiBHourUsd:0.02,storageMonthUsd:0.01,idleMinutes:5}}}};
  return {dir,a,b,config};
}

test('one user config works in multiple ordinary projects without creating project files', async t => {
  const {a,b,config} = await fixture(t); await saveUserConfig(config);
  assert.equal((await stat(userConfigPath())).mode & 0o777, 0o600);
  for (const root of [a,b]) {
    const loaded = await loadConfig(root); assert.equal(loaded.root, root); assert.equal(loaded.source, 'global'); assert.deepEqual(loaded.config, config);
    await assert.rejects(readFile(join(root,'.reroute.json')), {code:'ENOENT'});
    assert.equal(await projectAuthorized(root, loaded.config), false);
  }
});

test('top-level project overrides and whole named profiles have deterministic precedence; old config is untouched', async t => {
  const {a,config} = await fixture(t); await saveUserConfig(config);
  await saveProjectOverrides(a, {mode:'local',timeoutSeconds:120});
  assert.deepEqual(JSON.parse(await readFile(join(a,'.reroute.json'),'utf8')), {mode:'local',timeoutSeconds:120});
  let loaded = await loadConfig(a); assert.equal(loaded.source,'merged'); assert.equal(loaded.config.mode,'local'); assert.equal(loaded.config.timeoutSeconds,120);
  await saveProjectOverrides(a,{profiles:{cloud:{provider:'ssh',id:'host'}}});
  loaded = await loadConfig(a); assert.deepEqual(loaded.config.profiles.cloud,{provider:'ssh',id:'host'});
  const legacy = {...defaults(),active:'old',profiles:{old:{provider:'ssh',id:'legacy'}},timeoutSeconds:42};
  await saveConfig(a,legacy); const before=await readFile(join(a,'.reroute.json'),'utf8');
  loaded=await loadConfig(a); assert.equal(loaded.config.active,'old'); assert.equal(loaded.config.timeoutSeconds,42);
  assert.equal(await readFile(join(a,'.reroute.json'),'utf8'),before); assert.deepEqual(loaded.config.profiles.old,legacy.profiles.old);
  await writeFile(join(a,'.reroute.json'),JSON.stringify({profiles:null})); await assert.rejects(loadConfig(a),/profiles/);
  await writeFile(join(a,'.reroute.json'),'{broken'); await assert.rejects(loadConfig(a),SyntaxError);
});

test('consent is canonical-project/account scoped, outside source, revocable, and not inherited from paid policy', async t => {
  const {dir,a,b,config}=await fixture(t); await saveUserConfig(config);
  assert.equal(await projectAuthorized(a,config),false); await authorizeProject(a,config);
  assert.equal(await projectAuthorized(a,config),true); assert.equal(await projectAuthorized(b,config),false);
  const alias=join(dir,'alias');await symlink(a,alias);assert.equal(await projectAuthorized(alias,config),true);
  const other=structuredClone(config);other.profiles.cloud.credential='another-account';assert.equal(await projectAuthorized(a,other),false);
  await writeFile(join(a,'.reroute.json'),JSON.stringify({...config,authorized:true}));
  assert.equal(await projectAuthorized(b,config),false);
  await revokeProject(alias);assert.equal(await projectAuthorized(a,config),false);
});

test('unapproved projects cannot call a provider or even snapshot invalid source', async t => {
  const {a,config}=await fixture(t);let called=0;
  await symlink('/etc/passwd',join(a,'bad-source'));
  const provider={profile:config.profiles.cloud,stdin:false,status:async()=>{called++;return 'running';}};
  await assert.rejects(runRemote('echo no',{root:a,cwd:a,config,provider}),/Project remote execution is not authorized/);
  assert.equal(called,0);
});

test('root discovery respects Git boundaries and non-Git manifest roots, including aliases',async t=>{
  const {dir,a,b}=await fixture(t);await writeFile(join(dir,'.reroute.json'),'parent must not own a child Git repo');
  assert.equal((await processExec('git',['init','--quiet',a])).code,0);
  const child=join(a,'src');await mkdir(child);assert.equal(await projectRoot(child),a);
  const alias=join(dir,'alias');await symlink(child,alias);assert.equal(await projectRoot(alias),a);
  await rm(join(dir,'.reroute.json'));await writeFile(join(b,'package.json'),'{}');await mkdir(join(b,'src'));
  assert.equal(await projectRoot(join(b,'src')),b);
});

test('shared global account retains separate managed ownership and remote cache volumes for each project',async t=>{
  const {a,b,config}=await fixture(t); const requests=[];
  const factory=profile=>({profile,stdin:false,ensureManaged:async request=>{
    requests.push(request);return {...profile,id:'sandbox-'+request.owner,cacheVolume:'volume-'+request.owner};
  },idle:async()=>{},close:async()=>{}});
  for (const root of [a,b,a]) await withManagedResource(root,config,'cargo test',{},async profile=>({job:{id:'fixture',project:root,profile,root:'/unused',command:'cargo test',cwd:'.',createdAt:new Date().toISOString(),status:'exited',code:0}}),factory);
  assert.notEqual(requests[0].owner,requests[1].owner);assert.notEqual(requests[0].name,requests[1].name);
  assert.equal(requests[0].owner,requests[2].owner);assert.equal(requests[2].create,false);
});


test('default setup saves only user defaults, preserves existing project bytes, and never grants project consent', async t => {
  const {a,b}=await fixture(t);
  const {setup}=await import('../dist/setup.js');
  const project={...defaults(),active:'special',profiles:{special:{provider:'ssh',id:'project-host'}},timeoutSeconds:80};
  await saveConfig(a,project);const before=await readFile(join(a,'.reroute.json'),'utf8');
  const global=await setup(a,{nonInteractive:true,provider:'ssh',id:'default-host',name:'shared'});
  assert.equal(global.active,'shared');assert.equal((await loadConfig(b)).config.profiles.shared.id,'default-host');
  assert.equal((await loadConfig(a)).config.active,'special');assert.equal(await readFile(join(a,'.reroute.json'),'utf8'),before);
  assert.equal(await projectAuthorized(a,global),false);assert.equal(await projectAuthorized(b,global),false);
  await assert.rejects(readFile(join(b,'.reroute.json')),{code:'ENOENT'});
});

test('authorization flags in project code cannot substitute for a private local consent receipt',async t=>{
  const {a,config}=await fixture(t);
  await saveConfig(a,{...config,projectAuthorized:true});
  const loaded=await loadConfig(a);assert.equal(loaded.config.profiles.cloud.managed.authorized,true);
  assert.equal(await projectAuthorized(a,loaded.config),false);
  const {doctor}=await import('../dist/doctor.js');const report=await doctor(a);
  assert.equal(report.checks.projectAuthorized,false);assert.equal(report.checks.spendingAuthorized,true);
  assert.equal(report.checks.firstTaskSucceeded,false);assert.match(report.checks.authentication,/not verified/);
});


test('native-default named account, SSH ports and identity changes never inherit a different target consent',async t=>{
  const {a,config}=await fixture(t);
  const native=structuredClone(config);delete native.profiles.cloud.credential;
  await authorizeProject(a,native);
  const named=structuredClone(native);named.profiles.cloud.credential='native-default';
  assert.equal(await projectAuthorized(a,named),false);
  const ssh={...defaults(),active:'ssh',profiles:{ssh:{provider:'ssh',id:'builder@gateway',port:2201,identityFile:'/private/key-a'}}};
  await authorizeProject(a,ssh);assert.equal(await projectAuthorized(a,ssh),true);
  assert.equal(await projectAuthorized(a,{...ssh,profiles:{ssh:{...ssh.profiles.ssh,port:2202}}}),false);
  assert.equal(await projectAuthorized(a,{...ssh,profiles:{ssh:{...ssh.profiles.ssh,identityFile:'/private/key-b'}}}),false);
});

test('whole-profile project overrides cannot erase global private SSH identity exclusions',async t=>{
  const {dir,a,config}=await fixture(t);
  const identity=join(a,'deployment-identity');await writeFile(identity,'PRIVATE KEY MUST STAY LOCAL');await writeFile(join(a,'ordinary.txt'),'safe');
  config.profiles.cloud.root=join(dir,'remote');
  config.profiles.backup={provider:'ssh',id:'backup',identityFile:identity};
  await saveUserConfig(config);await saveProjectOverrides(a,{profiles:{backup:{provider:'ssh',id:'override'}}});
  const loaded=await loadConfig(a);assert.equal(loaded.config.profiles.backup.identityFile,undefined);
  await authorizeProject(a,loaded.config);
  const {copyFile}=await import('node:fs/promises');
  const provider={profile:loaded.config.profiles.cloud,stdin:false,status:async()=> 'running',exec:(command,opts)=>processExec('bash',['-c',command],opts),put:copyFile,get:copyFile,lifecycle:async()=>{throw Error('fixture only');}};
  const result=await runRemote('test ! -e deployment-identity && cat ordinary.txt',{root:a,cwd:a,config:loaded.config,provider});
  assert.equal(result.code,0);assert.equal(result.stdout,'safe');assert.equal(await readFile(identity,'utf8'),'PRIVATE KEY MUST STAY LOCAL');
});
