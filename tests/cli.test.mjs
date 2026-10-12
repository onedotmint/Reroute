import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { processExec } from '../dist/util.js';
const bin=resolve('bin/reroute.mjs');
async function fixture(t){const cwd=await mkdtemp(join(tmpdir(),'reroute-cli-'));t.after(()=>rm(cwd,{recursive:true,force:true}));const env={...process.env,PI_CODING_AGENT_DIR:join(cwd,'pi'),REROUTE_STATE_DIR:join(cwd,'state')};return {cwd,run:(...args)=>processExec(process.execPath,[bin,...args],{cwd,env,timeoutMs:10000})};}
test('standalone CLI setup/configuration, offline routing, argv quoting and local exit status',async t=>{
 const {cwd,run}=await fixture(t);
 assert.equal((await run('--help')).code,0);
 const setup=await run('setup','--non-interactive','--provider','ssh','--id','existing-host','--no-pi');assert.equal(setup.code,0,setup.stderr);
 assert.equal((await stat(join(cwd,'.reroute.json'))).mode&0o777,0o600);
 assert.equal(JSON.parse((await run('explain','--','cargo','test')).stdout).route,'remote');
 assert.equal(JSON.parse((await run('explain','--shell','cargo test && echo x')).stdout).route,'local');
 assert.equal((await run('mode','local')).code,0);assert.equal(JSON.parse((await run('explain','--','cargo','test')).stdout).route,'local');
 const echo=await run('local','--','printf','%s','literal; $(not executed)');assert.equal(echo.code,0);assert.equal(echo.stdout,'literal; $(not executed)');
 assert.equal((await run('local','--shell','exit 7')).code,7);
 await writeFile(join(cwd,'.reroute.json'),'not valid');assert.equal((await run('local','--','true')).code,0);
});
test('setup preserves legacy state and unknown command/flags fail',async t=>{
 const {cwd,run}=await fixture(t);await writeFile(join(cwd,'reroute.toml'),'legacy=true\n');
 const blocked=await run('setup','--non-interactive','--provider','ssh','--id','host','--no-pi');assert.notEqual(blocked.code,0);assert.match(blocked.stderr,/Legacy/);
 assert.equal(await readFile(join(cwd,'reroute.toml'),'utf8'),'legacy=true\n');
 assert.equal((await run('setup','--non-interactive','--provider','ssh','--id','host','--no-pi','--ignore-legacy')).code,0);
 assert.notEqual((await run('--not-a-real-flag')).code,0);assert.notEqual((await run('exec')).code,0);
 assert.notEqual((await run('resource','resume','--yes')).code,0);
});
