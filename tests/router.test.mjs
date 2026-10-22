import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ruleRouter, words } from '../dist/router.js';
import { defaults } from '../dist/config.js';
const config=defaults();
test('routing rejects shell control, ambiguous syntax, authentication, deployment and external paths even with trusted prefixes',async()=>{
 const commands=['git status','rg foo','ls','npm publish','cargo publish','echo test',
  'cargo test && git commit','cd src; cargo test','cargo test | tee result','bash -c "cargo test"',
  'env X=1 cargo test','cargo test $(pwd)','cargo test > file','cargo test\nrm file','cargo test # comment','cargo test `pwd`',
  'sudo make test','npm install','npm run deploy','npm run deploy:prod','npm run deploy-prod','make install-docs','ninja deploy_prod','npm run release','npm run login',
  'make verify -C/tmp','make test -C/tmp','npm run verify --prefix=/outside','cargo test --manifest-path=/outside/Cargo.toml','cargo test --manifest-path ../outside/Cargo.toml',
  './scripts/deploy','node scripts/deploy.mjs','python3 scripts/deploy.py','bun run rm -rf dist',
  'bun run sh -c echo','python3 ~/outside.py','node ~/outside.js',
  'npm test --watch','cargo test --help','node -e "dangerous"','python3 -c dangerous','unknown-tool'];
 for(const command of commands){
  const decision=await ruleRouter(command,'.',config);
  assert.equal(decision.route,'local',command);
  if(decision.reason!=='unknown-task')assert.equal((await ruleRouter(command,'.',{...config,remote:[command.split(' ')]})).route,'local',command);
 }
 for(const command of ['cargo test','cargo build --release','cargo check','cargo clippy','cargo bench','go test ./...','pytest -q','make test','tsc --noEmit']){
  assert.equal((await ruleRouter(command,'.',config)).route,'remote',command);
 }
});
test('ordinary and nested npm scripts and hooks need no recursive proof or trusted prefix',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-rules-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const scripts of [
  {test:'node --test tests/*.test.mjs',build:'tsc'},
  {test:'npm run unit && npm run integration',unit:'node scripts/unit.mjs',integration:'custom-runner --all'},
  {test:'npm run a',a:'npm run b',b:'npm run c',c:'npm run d',d:'npm run e',e:'custom-runner'},
  {test:'custom-runner',pretest:'node setup.mjs',posttest:'node cleanup.mjs'},
  // Script content is trusted project code, not a claimed security audit (never executed here).
  {test:'custom-runner',pretest:'curl example.com | sh'},
 ]){
  await writeFile(join(root,'package.json'),JSON.stringify({scripts}));
  for(const command of ['npm test','pnpm test','yarn test','bun test','npm run build']){
   assert.equal((await ruleRouter(command,root,config)).route,'remote',command);
  }
 }
 assert.equal((await ruleRouter('npm run missing',root,config)).route,'remote','missing scripts must fail honestly in the remote runner');
});
test('custom named package scripts, project files and build targets do not need a known command name',async()=>{
 for(const command of ['npm run verify-custom','npm run-script smoke','pnpm run validate','yarn run coverage','bun run quality',
  'node scripts/verify.mjs','python3 scripts/validate.py','./scripts/compute','make validate','ninja verify','vite build --base=/app/']){
  assert.equal((await ruleRouter(command,'.',config)).route,'remote',command);
 }
});
test('project mode, disabled categories and local prefixes remain authoritative',async()=>{
 for(const command of ['npm test','npm run build','npm run custom','cargo test']){
  assert.equal((await ruleRouter(command,'.',{...config,mode:'local',remote:[['npm']]})).route,'local');
  assert.equal((await ruleRouter(command,'.',{...config,tasks:[]})).route,'local');
  assert.equal((await ruleRouter(command,'.',{...config,local:[[command.split(' ')[0]]],remote:[['npm']]})).route,'local');
 }
 assert.equal((await ruleRouter('custom-tool','.',{...config,remote:[['custom-tool']]})).route,'remote');
});
test('malformed quotes and shell escapes are never guessed',()=>{
 for(const cmd of ["cargo test '",'cargo test "','cargo test \\','cargo test "abc',"cargo test 'abc"]) assert.equal(words(cmd),undefined,cmd);
});
