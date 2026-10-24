import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { defaults, authorizeProject } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
import { parse } from 'shell-quote';
import { processExec } from '../dist/util.js';

// Component transport only: local filesystem and Python supervisor, never a cloud SDK.
async function fixture(t) {
  const base=await mkdtemp(join(tmpdir(),'reroute-transfer-test-')),root=join(base,'project');await mkdir(root);
  const old=process.env.REROUTE_STATE_DIR;process.env.REROUTE_STATE_DIR=join(base,'state');
  t.after(async()=>{if(old===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=old;await rm(base,{recursive:true,force:true});});
  const config={...defaults(),active:'fixture',profiles:{fixture:{provider:'modal',id:'local-component',root:join(base,'remote')}}};
  await authorizeProject(root,config);
  const uploads=[];
  const provider={profile:config.profiles.fixture,stdin:true,status:async()=> 'running',exec:(command,opts)=>processExec('bash',['-c',command],opts),
    put:async(a,b)=>{uploads.push({path:b,bytes:(await stat(a)).size});await copyFile(a,b);},get:copyFile,lifecycle:async()=>{throw Error('fixture only');}};
  return {root,provider,uploads,run:(command,extra={})=>runRemote(command,{root,cwd:root,config,provider,...extra})};
}

test('one gzip upload replaces per-file calls, then unchanged and changed plans reuse the verified baseline',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'nested'));
  await writeFile(join(f.root,'nested','unicode-é file.txt'),'nested\n');await writeFile(join(f.root,'empty'),'');
  await writeFile(join(f.root,'executable'),'#!/bin/sh\necho executable\n',{mode:0o755});
  for(let i=0;i<40;i++)await writeFile(join(f.root,`file-${i}`),'a'.repeat(1024));
  const events=[];const cold=await f.run('./executable; cat "nested/unicode-é file.txt"',{onProgress:p=>events.push(p)});
  assert.equal(cold.code,0);assert.equal(cold.stdout,'executable\nnested\n');assert.equal(f.uploads.length,2);
  assert.ok(f.uploads[1].path.endsWith('/input.gz'));assert.equal(cold.job.metrics.uploadFiles,43);
  assert.equal(cold.job.metrics.archiveBytes,f.uploads[1].bytes);assert.equal(cold.job.metrics.uploadedBytes,f.uploads[1].bytes);
  assert.ok(cold.job.metrics.transferredBytes>cold.job.metrics.archiveBytes);
  for(const name of ['inputMs','prepareMs','requestUploadMs','packMs','uploadMs','sealMs','remoteStageMs','remoteUnpackMs','remoteVerifyMs','remotePrepareMs','executionMs','cleanupMs'])assert.ok(cold.job.metrics[name]>=0,name);
  assert.deepEqual(events.map(p=>p.stage),['snapshot','remote-prepare','upload','pack','upload','verify','remote-run','execute','cleanup','complete']);
  assert.ok(events.every(p=>typeof p.message==='string'&&p.message.length));
  f.uploads.length=0;const warm=await f.run('true');assert.equal(warm.code,0);assert.equal(f.uploads.length,1);assert.equal(warm.job.metrics.transferredBytes,0);assert.equal(warm.job.metrics.archiveBytes,0);
  await rm(join(f.root,'file-0'));await writeFile(join(f.root,'file-1'),'changed\n');f.uploads.length=0;
  const changed=await f.run('test ! -e file-0; cat file-1');assert.equal(changed.stdout,'changed\n');assert.equal(changed.job.metrics.uploadFiles,1);assert.equal(changed.job.metrics.transferredBytes,8);assert.equal(f.uploads.length,2);
  assert.equal(await readFile(join(f.root,'file-1'),'utf8'),'changed\n');
});

test('UI observer exceptions cannot interrupt input safety or terminal receipts',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'file'),'input');
  const r=await f.run('true',{onProgress:()=>{throw Error('broken UI');}});assert.equal(r.code,0);assert.equal(r.job.status,'exited');
});

test('duplicate or foreign transfer plans are refused without uploading source or executing',async t=>{
  for(const needed of [['file','file'],['../escaped'],['foreign']]) await t.test(JSON.stringify(needed),async t=>{
    const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const exec=f.provider.exec;
    f.provider.exec=async(command,options)=>{const r=await exec(command,options);if(r.stdout.startsWith('{')){const p=JSON.parse(r.stdout);if(p.needed)r.stdout=JSON.stringify({...p,needed});}return r;};
    await assert.rejects(f.run('touch SHOULD_NOT_RUN'),/transfer plan|Unsafe relative path|outside the verified snapshot/);assert.equal(f.uploads.length,1);
  });
});

test('manifest-indexed archive rejects corruption, truncated/trailing payload, hostile plans and symlinks before baseline replacement',()=>{
  execFileSync('python3',['-B','-c',String.raw`
import gzip, hashlib, importlib.util, pathlib, tempfile
spec = importlib.util.spec_from_file_location('task', __import__('sys').argv[1])
task = importlib.util.module_from_spec(spec); spec.loader.exec_module(task)
with tempfile.TemporaryDirectory(prefix='reroute-unpack-security-') as temp:
    base = pathlib.Path(temp); seed = base / 'seed'; seed.mkdir()
    (seed / 'file').write_bytes(b'old')
    manifest = {'file': {'size': 3, 'sha256': hashlib.sha256(b'new').hexdigest(), 'mode': 0o755}}
    def attempt(payload, names=['file'], info=None):
        archive = base / 'input.gz'; archive.write_bytes(payload)
        metadata = info if info is not None else {'bytes': len(payload), 'sha256': task.sha(archive)}
        try: task.unpack_input(archive, seed, manifest, names, metadata)
        except (ValueError, OSError, EOFError): pass
        else: raise AssertionError('unsafe payload accepted')
        assert (seed / 'file').read_bytes() == b'old'
        assert not list(base.glob('.input-unpack-*'))
    attempt(gzip.compress(b'new')[:-4])
    attempt(gzip.compress(b'ne'))
    attempt(gzip.compress(b'new-extra'))
    attempt(gzip.compress(b'bad'))
    attempt(gzip.compress(b'new'), ['file', 'file'])
    attempt(gzip.compress(b'new'), ['../escaped'])
    attempt(gzip.compress(b'new'), info={'bytes': 9999999999, 'sha256': '0' * 64})
    attempt(gzip.compress(b'new'), info={'bytes': len(gzip.compress(b'new')), 'sha256': '0' * 64})
    (seed / 'file').unlink(); (base / 'outside').write_bytes(b'old'); (seed / 'file').symlink_to(base / 'outside')
    attempt(gzip.compress(b'new'))
    assert (base / 'outside').read_bytes() == b'old'
`,resolve('assets/task.py')],{timeout:10000,stdio:'pipe'});
});

test('native sync providers retain the rsync path without packing or a second upload',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'file'),'sync-input');let syncs=0;
  f.provider.sync=async(local,remote)=>{syncs++;await copyFile(join(local,'file'),join(remote,'file'));return 10;};
  const result=await f.run('cat file');assert.equal(result.stdout,'sync-input');assert.equal(syncs,1);assert.equal(f.uploads.length,1);
  assert.equal(result.job.metrics.packMs,0);assert.equal(result.job.metrics.archiveBytes,0);assert.equal(result.job.metrics.uploadedBytes,10);
});

test('lost archive upload acknowledgement retains the lock and never starts a process',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const put=f.provider.put;let job;
  f.provider.put=async(local,remote)=>{await put(local,remote);if(remote.endsWith('/input.gz'))throw Error('archive acknowledgement lost');};
  await assert.rejects(f.run('touch SHOULD_NOT_START',{onJob:value=>job=value}),/unknown.*never retried locally/);
  assert.equal(job.status,'unknown');assert.equal(await readFile(join(job.root,'lock','owner'),'utf8'),job.id);
  await assert.rejects(readFile(join(job.root,'jobs',job.id,'process.json')),{code:'ENOENT'});
});

test('progress frames survive byte fragmentation and preserve Unicode, unknown markers and raw stdout/stderr',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const exec=f.provider.exec;
  const foreign='\x1eREROUTE_PROGRESS:'+'f'.repeat(32)+':execute\x1f';
  let before='',after='',rawFrames=0;const events=[],out=[],err=[];
  f.provider.exec=async(command,opts)=>{
    const args=parse(command),data=JSON.parse(Buffer.from(args.at(-1),'base64').toString());
    if(args.at(-2)!=='run')return exec(command,opts);
    const emit=bytes=>{for(const byte of bytes)opts.stderr?.(Buffer.from([byte]));};
    before=`头🙂${foreign}\x1eREROUTE_PROGRESS:${data.progressToken}:unknown\x1f\n`;
    after=`尾é\x1eREROUTE_PROGRESS:${data.progressToken}:clea`;
    emit(Buffer.from(before));
    const result=await exec(command,{...opts,stderr:bytes=>{rawFrames+=bytes.includes(Buffer.from('REROUTE_PROGRESS'))?1:0;emit(bytes);}});
    emit(Buffer.from(after));
    return {...result,stderr:before+result.stderr+after};
  };
  const result=await f.run("printf '标准输出🙂'; printf '标准错误é' >&2; exit 7",{onProgress:p=>events.push(p.stage),stdout:b=>out.push(b),stderr:b=>err.push(b)});
  assert.equal(result.code,7);assert.equal(result.job.status,'exited');assert.ok(rawFrames>0);
  assert.equal(result.stdout,'标准输出🙂');assert.equal(Buffer.concat(out).toString(),result.stdout);
  assert.equal(result.stderr,before+'标准错误é'+after);assert.equal(Buffer.concat(err).toString(),result.stderr);
  assert.ok(events.includes('execute')&&events.includes('cleanup'));assert.equal(events.includes('unknown'),false);
});

test('without an observer the helper emits no progress frames and output is unchanged',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const bytes=[];
  const result=await f.run("printf '错误🙂' >&2; exit 9",{stderr:b=>bytes.push(b)});
  assert.equal(result.code,9);assert.equal(result.stderr,'错误🙂');assert.equal(Buffer.concat(bytes).toString(),result.stderr);
});

test('filtered stderr capture is bounded independently of a provider tail truncated inside a frame',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const exec=f.provider.exec;let streamed=0;
  f.provider.exec=async(command,opts)=>{
    const args=parse(command),data=JSON.parse(Buffer.from(args.at(-1),'base64').toString());
    if(args.at(-2)!=='run')return exec(command,opts);
    const prefix=Buffer.from(`\x1eREROUTE_PROGRESS:${data.progressToken}:cache-restore\x1f`);
    opts.stderr?.(prefix);opts.stderr?.(Buffer.alloc(1024*1024+100,65));
    const result=await exec(command,opts);
    return {...result,stderr:prefix.subarray(10).toString()+'provider tail',stderrTruncated:true};
  };
  const events=[];const result=await f.run('true',{onProgress:p=>events.push(p.stage),stderr:b=>streamed+=b.length});
  assert.equal(result.code,0);assert.equal(streamed,1024*1024+100);assert.equal(result.stderr,'A'.repeat(1024*1024));assert.ok(events.includes('cache-restore'));
});

test('known phase prefixes distinguish upload, verification and failed cleanup without changing command exit authority',async t=>{
  await t.test('upload',async t=>{
    const f=await fixture(t);await writeFile(join(f.root,'file'),'input');f.provider.put=async()=>{throw Error('connection lost');};
    await assert.rejects(f.run('true'),/\[upload\].*connection lost/);
  });
  await t.test('verify',async t=>{
    const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const put=f.provider.put;
    f.provider.put=async(a,b)=>{await put(a,b);if(b.endsWith('/input.gz'))await writeFile(b,'corrupt');};
    await assert.rejects(f.run('true'),/\[verify\].*Input archive checksum mismatch/);
  });
  await t.test('cleanup',async t=>{
    const f=await fixture(t);await writeFile(join(f.root,'file'),'input');const exec=f.provider.exec;const events=[];
    f.provider.exec=(command,opts)=>exec(command.replace('confirmed = terminate_group(child.pid)','raise RuntimeError("fixture cleanup exception")'),opts);
    const result=await f.run('true',{onProgress:p=>events.push(p.stage)});
    assert.equal(result.code,125);assert.equal(result.job.status,'unknown');assert.match(result.job.error,/^\[cleanup\]/);assert.match(result.stderr,/fixture cleanup exception/);assert.ok(events.includes('cleanup'));
  });
});
