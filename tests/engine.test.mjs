import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { defaults, getJob, saveConfig, authorizeProject } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
import { createRerouteTool } from '../dist/pi.js';
import { processExec } from '../dist/util.js';
// COMPONENT ONLY: this native process/file fixture deliberately is NOT called SSH or cloud live coverage.
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'reroute-component-'));
  const root = join(base,'project'); await mkdir(root); await writeFile(join(root,'file.txt'),'local\n');
  const previous = {XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME, REROUTE_STATE_DIR:process.env.REROUTE_STATE_DIR};
  process.env.XDG_CONFIG_HOME = join(base,'config'); process.env.REROUTE_STATE_DIR = join(base,'state');
  t.after(async () => {
    for (const [key,value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(base,{recursive:true,force:true});
  });
  const config = {...defaults(),active:'fixture',profiles:{fixture:{provider:'ssh',id:'fixture',root:join(base,'remote')}}};
  await authorizeProject(root,config);
  const provider = {profile:config.profiles.fixture,stdin:true,status:async()=> 'running',exec:(command,opts)=>processExec('bash',['-c',command],opts),put:copyFile,get:copyFile,lifecycle:async()=>{throw Error('fixture only')}};
  return {root,config,provider, run:(command,extra={})=>runRemote(command,{root,cwd:root,config,provider,...extra})};
}
test('one-way task executes real processes, keeps dirty source local, reuses isolated cache and removes deleted input', async t => {
  const f=await fixture(t);
  let out='',err='';
  const a=await f.run('cat file.txt; echo remote > file.txt; echo stderr >&2; echo cached > "$CARGO_TARGET_DIR/cache.txt"; echo artifact > "$REROUTE_ARTIFACTS/out.txt"; exit 7',{stdout:b=>out+=b,stderr:b=>err+=b});
  assert.equal(a.code,7); assert.equal(a.job.status,'exited'); assert.equal(out,'local\n'); assert.equal(err,'stderr\n');
  assert.equal(await readFile(join(f.root,'file.txt'),'utf8'),'local\n');
  await rm(join(f.root,'file.txt')); await writeFile(join(f.root,'new.txt'),'new\n');
  const b=await f.run('test ! -e file.txt; cat new.txt; cat "$CARGO_TARGET_DIR/cache.txt"');
  assert.equal(b.code,0); assert.equal(b.stdout,'new\ncached\n'); assert.equal(b.job.metrics.cacheKey,a.job.metrics.cacheKey);
  assert.equal(await readFile(join(a.job.root,'jobs',a.job.id,'work','file.txt'),'utf8'),'remote\n');
  await writeFile(join(f.root,'Cargo.lock'),'changed');
  const c=await f.run('test ! -e "$CARGO_TARGET_DIR/cache.txt"');
  assert.equal(c.code,0); assert.notEqual(c.job.metrics.cacheKey,b.job.metrics.cacheKey);
});
test('explicit stdin and EOF are forwarded and timeout is confirmed by the remote supervisor',async t=>{
  const f=await fixture(t);
  const r=await f.run('cat',{stdin:Readable.from(['input\n'])}); assert.equal(r.stdout,'input\n'); assert.equal(r.code,0);
  const timed=await f.run('sleep 30',{timeoutMs:200}); assert.equal(timed.code,124); assert.equal(timed.job.status,'timed_out');
});
test('cancellation requires the remote receipt, not a killed local client',async t=>{
  const f=await fixture(t), controller=new AbortController();
  const result=await f.run('echo ready; sleep 30',{signal:controller.signal,stdout:b=>{if(b.toString().includes('ready'))controller.abort();}});
  assert.equal(result.job.status,'cancelled'); assert.equal(result.code,130);
});
test('failed upload never starts execution and retains an uncertain lock rather than claiming success',async t=>{
  const f=await fixture(t); f.provider.put=async()=>{throw Error('connection lost during upload')};
  await assert.rejects(f.run('touch SHOULD_NOT_RUN'),/unknown.*never retried locally/);
  await assert.rejects(readFile(join(f.root,'SHOULD_NOT_RUN')),{code:'ENOENT'});
});
test('post-transfer corruption is refused before executing any command',async t=>{
  const f=await fixture(t); f.provider.put=async(a,b)=>{await copyFile(a,b); if(b.endsWith('/input.gz')) await writeFile(b,'corrupted')};
  await assert.rejects(f.run('echo BAD'),/Input archive checksum mismatch/);
});

test('execution receipts cannot overwrite local job ownership and measured cache fields merge with transfer metrics',async t=>{
 const f=await fixture(t),exec=f.provider.exec;
 f.provider.exec=async(command,opts)=>{
  const result=await exec(command,opts);
  if(result.code===0&&result.stdout.startsWith('{')){
   try{const receipt=JSON.parse(result.stdout);if(receipt.status==='exited')result.stdout=JSON.stringify({...receipt,project:'/foreign',id:'not-a-job',root:'/foreign',profile:{provider:'daytona',id:'foreign'},cacheWarning:'Cache save failed: volume-write: PermissionError errno=1 (Operation not permitted)',metrics:{...receipt.metrics,cacheSaved:false,inputBytes:-1,cacheKey:'foreign'}});}catch{}
  }
  return result;
 };
 const result=await f.run('exit 7');
 assert.equal(result.code,7);assert.equal(result.job.project,f.root);assert.equal(result.job.profile.provider,'ssh');assert.match(result.job.id,/^[0-9a-f-]{36}$/);
 assert.ok(result.job.metrics.inputBytes>=0);assert.notEqual(result.job.metrics.cacheKey,'foreign');assert.ok(result.job.metrics.executionMs>=0);
 assert.equal(result.job.metrics.cacheSaved,false);assert.match(result.job.cacheWarning,/volume-write/);
 const recorded=await getJob(result.job.id);assert.equal(recorded.metrics.cacheSaved,false);assert.equal(recorded.cacheWarning,result.job.cacheWarning);
});
test('invalid terminal execution receipt is unknown, never a claimed success',async t=>{
 const f=await fixture(t),exec=f.provider.exec;
 f.provider.exec=async(command,opts)=>{
  const result=await exec(command,opts);
  if(result.code===0&&result.stdout.startsWith('{')){
   try{const receipt=JSON.parse(result.stdout);if(receipt.status==='exited')result.stdout=JSON.stringify({status:'exited',code:'0'});}catch{}
  }
  return result;
 };
 const result=await f.run('true');assert.equal(result.code,125);assert.equal(result.job.status,'unknown');assert.match(result.job.error,/state query failed/);
});

test('Pi executes nested/custom project scripts and hooks on isolated provider work, preserving failures without local fallback',async t=>{
 const previous=process.env.REROUTE_STATE_DIR;const f=await fixture(t);
 t.after(()=>{if(previous===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=previous;});
 await saveConfig(f.root,f.config);
 await writeFile(join(f.root,'package.json'),JSON.stringify({private:true,scripts:{
  pretest:'node hook.cjs pre',test:'npm run custom-suite && npm run custom-suite',posttest:'node hook.cjs post',
  'custom-suite':'node suite.cjs',build:'node hook.cjs'
 }}));
 await writeFile(join(f.root,'hook.cjs'),"require('node:fs').writeFileSync('HOOK_MARKER'+(process.argv[2]||''),process.env.REROUTE_JOB_ID||'LOCAL');\n");
 await writeFile(join(f.root,'suite.cjs'),"const fs=require('node:fs');fs.writeFileSync('EXECUTION_MARKER',process.env.REROUTE_JOB_ID||'LOCAL');console.log('suite-out');console.error('suite-err');process.exit(Number(fs.readFileSync('exit-code','utf8')));\n");
 let executions=0;
 const tool=createRerouteTool((command,options)=>{executions++;return runRemote(command,{...options,provider:f.provider});});
 for(const [command,code] of [['npm test',0],['npm run custom-suite',7],['npm test',9],['npm run build',0]]){
  await writeFile(join(f.root,'exit-code'),String(code));
  const result=await tool.execute('project-script',{command,timeout:10},undefined,undefined,{cwd:f.root});
  assert.equal(result.details.status,'exited',result.details.reason);assert.equal(result.details.exitCode,code,result.details.reason);
  assert.equal(result.isError,code!==0);const job=await getJob(result.details.jobId);
  assert.equal(job.code,code);assert.equal(job.profile.provider,'ssh');
  const marker=command==='npm run build'?'HOOK_MARKER':'EXECUTION_MARKER';
  assert.equal(await readFile(join(job.root,'jobs',job.id,'work',marker),'utf8'),job.id);
  if(command!=='npm run build'){assert.match(result.details.stdout,/suite-out/);assert.match(result.details.stderr,/suite-err/);}
  const remoteWork=join(job.root,'jobs',job.id,'work');
  if(command==='npm test'){
   assert.equal(await readFile(join(remoteWork,'HOOK_MARKERpre'),'utf8'),job.id);
   if(code===0)assert.equal(await readFile(join(remoteWork,'HOOK_MARKERpost'),'utf8'),job.id);
   else await assert.rejects(readFile(join(remoteWork,'HOOK_MARKERpost')),{code:'ENOENT'});
  }
  for(const name of ['EXECUTION_MARKER','HOOK_MARKER','HOOK_MARKERpre','HOOK_MARKERpost'])await assert.rejects(readFile(join(f.root,name)),{code:'ENOENT'});
 }
 assert.equal(executions,4,'one execution per explicit call, including nonzero exits');
});

test('configured SSH identities with nonstandard filenames are not uploaded',async t=>{
 const f=await fixture(t);
 const key=join(f.root,'deployment-identity');await writeFile(key,'FAKE_SSH_PRIVATE_KEY');
 f.config.profiles.other={provider:'ssh',id:'unused',identityFile:key};
 const result=await f.run('test ! -e deployment-identity; cat file.txt');
 assert.equal(result.code,0);assert.equal(result.stdout,'local\n');
 assert.equal(await readFile(key,'utf8'),'FAKE_SSH_PRIVATE_KEY');
});

test('home-relative SSH identities remain excluded when configured through the Pi settings path',async t=>{
 const f=await fixture(t),oldHome=process.env.HOME;process.env.HOME=f.root;
 t.after(()=>{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;});
 const key=join(f.root,'deployment-identity');await writeFile(key,'FAKE_HOME_IDENTITY');
 f.config.profiles.fixture.identityFile='~/deployment-identity';
 await authorizeProject(f.root,f.config); // Changing authentication identity needs fresh consent.
 const result=await f.run('test ! -e deployment-identity; cat file.txt');
 assert.equal(result.code,0);assert.equal(result.stdout,'local\n');assert.equal(await readFile(key,'utf8'),'FAKE_HOME_IDENTITY');
});
