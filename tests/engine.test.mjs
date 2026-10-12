import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { defaults } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
import { processExec } from '../dist/util.js';
// COMPONENT ONLY: this native process/file fixture deliberately is NOT called SSH or cloud live coverage.
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'reroute-component-'));
  const root = join(base,'project'); await mkdir(root); await writeFile(join(root,'file.txt'),'local\n');
  process.env.REROUTE_STATE_DIR = join(base,'state');
  t.after(() => rm(base,{recursive:true,force:true}));
  const config = {...defaults(),active:'fixture',profiles:{fixture:{provider:'ssh',id:'fixture',root:join(base,'remote')}}};
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
  const f=await fixture(t); f.provider.put=async(a,b)=>{await copyFile(a,b); if(b.endsWith('/input/file.txt')) await writeFile(b,'corrupted')};
  await assert.rejects(f.run('echo BAD'),/Input checksum mismatch/);
});
