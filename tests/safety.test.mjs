import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { helperCommand } from '../dist/engine.js';
import { processExec,requireSuccess,feedInput,hash } from '../dist/util.js';
test('unowned stale execution directory is retained, not adopted or archived by a failed new task',async t=>{
 const base=await mkdtemp(join(tmpdir(),'reroute-owned-'));
 const previous={XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,REROUTE_STATE_DIR:process.env.REROUTE_STATE_DIR};
 process.env.XDG_CONFIG_HOME=join(base,'config');process.env.REROUTE_STATE_DIR=join(base,'state');
 t.after(async()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(base,{recursive:true,force:true});});
 const root=join(base,'remote'),id=randomUUID();
 const control=async(action)=>processExec('bash',['-c',await helperCommand(action,{root,id})]);
 await requireSuccess(control('boot'));await requireSuccess(control('acquire'));await mkdir(join(root,'work'));await writeFile(join(root,'work','foreign.txt'),'leave alone');
 await writeFile(join(root,'jobs',id,'request.json'),JSON.stringify({files:[],cacheKey:hash(''),command:'true',cwd:'.',timeoutSeconds:10}));
 const result=await control('seal');assert.equal(result.code,125);assert.equal(await readFile(join(root,'work','foreign.txt'),'utf8'),'leave alone');
 const receipt=JSON.parse((await requireSuccess(control('status'))).stdout);assert.equal(receipt.status,'unknown');assert.equal(await readFile(join(root,'lock','owner'),'utf8'),id);
});
test('bounded capture preserves split UTF-8 and explicitly reports truncation while forwarding all bytes',async()=>{
 let count=0;const r=await processExec(process.execPath,['-e',`const b=Buffer.from('\u4e2d\u6587'); process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.end(b.subarray(2)),10)`]);assert.equal(r.stdout,'\u4e2d\u6587');assert.equal(r.stdoutTruncated,false);
 const large=await processExec(process.execPath,['-e',`process.stdout.write(Buffer.alloc(1100000,65))`],{stdout:b=>count+=b.length});assert.equal(count,1100000);assert.equal(large.stdoutTruncated,true);assert.ok(large.stdout.length<=1024*1024);
});
test('stdin forwarding can stop without waiting for terminal EOF or consuming later input',async()=>{
 const source=new PassThrough(),sent=[];const input=feedInput(source,async b=>sent.push(String(b)),async()=>{});source.write('first');await new Promise(r=>setTimeout(r,10));input.stop();await input.done;source.write('later');assert.deepEqual(sent,['first']);source.destroy();
});
