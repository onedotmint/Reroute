import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const bin=process.argv[2]?resolve(process.argv[2]):resolve('bin/reroute.mjs');
const cwd=await mkdtemp(join(tmpdir(),'reroute-smoke-'));
const env={...process.env,PI_CODING_AGENT_DIR:join(cwd,'agent'),REROUTE_STATE_DIR:join(cwd,'state')};
const run=(args,code=0)=>{const r=spawnSync(process.execPath,[bin,...args],{cwd,env,encoding:'utf8',timeout:15000});assert.equal(r.status,code,r.stderr||String(r.error));return r.stdout;};
try {
 assert.match(run(['--help']),/Reroute/);
 assert.equal(JSON.parse(run(['doctor','--json'])).ok,true);
 run(['setup','--non-interactive','--provider','ssh','--id','offline-placeholder','--no-pi']);
 assert.equal(JSON.parse(run(['explain','--','cargo','test'])).route,'remote');
 assert.equal(run(['local','--','printf','%s','smoke']),'smoke');
 run(['local','--shell','exit 9'],9);
 console.log(JSON.stringify({smoke:'passed',bin,cloudCalls:0}));
}finally{await rm(cwd,{recursive:true,force:true});}
