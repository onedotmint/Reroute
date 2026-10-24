// Acceptance of the exact Git commit as a Pi-native PROJECT package, not an npm-global stub.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@earendil-works/pi-coding-agent';

const sha = process.env.REROUTE_GIT_COMMIT;
assert.match(sha??'',/^[0-9a-f]{40}$/,'Set REROUTE_GIT_COMMIT to the exact CI commit SHA');
const root = await mkdtemp(join(tmpdir(),'reroute-pi-git-'));
const project = join(root,'my-project'), agent = join(root,'agent');
await mkdir(project);
await mkdir(agent);
const env = {...process.env,CI:'true',HOME:root,PI_CODING_AGENT_DIR:agent,XDG_CONFIG_HOME:join(root,'xdg')};
const piCli=resolve('node_modules/.bin/pi');
const source='git:github.com/onedotmint/Reroute@'+sha;
function pi(...args) {
  const r=spawnSync(piCli,args,{cwd:project,env,encoding:'utf8',timeout:150000,maxBuffer:1024*1024});
  assert.equal(r.status,0,'pi '+args.join(' ')+': '+(r.stderr||r.stdout||r.error));
  return r.stdout;
}
try {
  pi('install','--local','--approve',source);
  const config=JSON.parse(await readFile(join(project,'.pi','settings.json'),'utf8'));
  assert.ok(config.packages?.some(p=>(typeof p==='string'?p:p.source)===source),'Pi must persist the exact pinned source in project settings');
  const pkg=join(project,'.pi','git','github.com','onedotmint','Reroute');
  await stat(join(pkg,'src','pi.ts'));
  await stat(join(pkg,'adapters','pi.ts'));
  await assert.rejects(stat(join(pkg,'dist','pi.js')),/ENOENT/,'Git checkout must work WITHOUT generated dist');
  const packageJson=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));
  assert.equal(packageJson.pi.extensions[0],'./adapters/pi.ts');
  const result=await sdk.discoverAndLoadExtensions([join(pkg,'adapters','pi.ts')],project,agent);
  assert.deepEqual(result.errors,[],'Pi must actually load the Git-installed source extension');
  assert.ok(result.extensions[0]?.commands.has('reroute'));
  assert.ok(result.extensions[0]?.tools.has('reroute_run'));
   assert.ok(result.extensions[0]?.tools.has('reroute_status'));
  assert.equal(result.extensions[0]?.tools.has('bash'),false);
  assert.equal(result.extensions[0]?.handlers.has('user_bash'),false);
  assert.match(pi('list','--approve'),/Reroute/i);
  assert.match(pi('list','--no-approve'),/No packages installed/);
  await assert.rejects(stat(join(agent,'extensions','reroute.ts')),/ENOENT/);
  await assert.rejects(stat(join(agent,'settings.json')),/ENOENT/);
  pi('remove','--local','--approve',source);
  const after=JSON.parse(await readFile(join(project,'.pi','settings.json'),'utf8'));
  assert.equal(after.packages?.length??0,0);
  console.log(JSON.stringify({commit:sha,source,scope:'project',sourceOnly:true,extensionLoaded:true,registeredCommand:'/reroute',registeredTools:['reroute_run','reroute_status'],bashOverride:false,removed:true,globalPiUntouched:true}));
} finally {
  await rm(root,{recursive:true,force:true});
}
