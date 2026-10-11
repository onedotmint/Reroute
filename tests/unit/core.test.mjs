import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, delimiter } from 'node:path';
import { parseTOML } from '../../dist/config/toml.js';
import { DEFAULT_CONFIG, merge, validateConfig, assertCapabilities } from '../../dist/config/config.js';
import { route, environmentBaseline, selectedEnvironment, unshimmedPath, mapArgv, remoteCwd } from '../../dist/core/routing.js';
import { safePath, safeRelative, hash } from '../../dist/platform/files.js';
import { excluded, planSync } from '../../dist/sync/sync.js';
import { SerialLane } from '../../dist/core/queue.js';
import { quote, capture } from '../../dist/platform/process.js';
import { fixture, policy } from '../helpers.mjs';
const entry = text => ({ hash:hash(text), size:Buffer.byteLength(text), mode:0o644 });
for (const argv of [['git','status'],['npm','publish'],['cargo','login'],['pnpm','config','set'],['ssh','host'],['docker','build','.']]) {
  test('control stays local: '+argv.join(' '), () => assert.equal(route(argv),'local'));
}
for (const argv of [['cargo','test'],['pnpm','test'],['pytest','-q'],['cmake','--build','.'],['go','test','./...'],['mvn','test']]) {
  test('runtime routes remotely: '+argv.join(' '), () => assert.equal(route(argv),'remote'));
}
test('shell quoting roundtrips argv without injection', async () => {
  const value = "a'; printf PWNED; echo '\n $HOME `uname`";
  const result = await capture('/bin/sh',['-c',`printf %s ${quote(value)}`]);
  assert.equal(result.stdout,value); assert.equal(result.code,0);
});
test('TOML layering handles tables arrays literal strings and comments', () => {
  const config = parseTOML('provider = "ssh" # hi\n[runtime]\ncpu = 2.5\nenv = { CI = "1" }\n[providers.ssh]\nhost = \'school\'\n[sync]\nexcludes = ["*.mp4", "data"]\n');
  assert.equal(config.providers.ssh.host,'school'); assert.equal(config.runtime.cpu,2.5);
  assert.equal(validateConfig(merge(structuredClone(DEFAULT_CONFIG),config)).runtime.env.CI,'1');
});
for (const text of ['x = 1\nx = 2','__proto__.polluted = true','x = 2026-10-06','x = [broken]']) test('reject unsupported or unsafe TOML '+text, () => assert.throws(()=>parseTOML(text)));
test('config rejects unsupported fields and plaintext secret env', () => {
  assert.throws(()=>validateConfig(merge(structuredClone(DEFAULT_CONFIG),{ runtime:{ disk:3 } })), /disk/);
  assert.throws(()=>validateConfig(merge(structuredClone(DEFAULT_CONFIG),{ runtime:{ env:{ AWS_SECRET_ACCESS_KEY:'not-a-real-secret' } } })),/credentials/);
  assert.throws(()=>validateConfig(merge(structuredClone(DEFAULT_CONFIG),{ sync:{ maxFiles:0 } })));
});
test('requested capabilities never vanish silently', () => assert.throws(()=>assertCapabilities({...DEFAULT_CONFIG.runtime,cpu:4},{resources:[]},'ssh'),/cannot honor/));
test('environment forwards inline values without leaking ambient credentials', () => {
  const initial={ PATH:'/usr/bin', HOME:'/home/a', AMBIENT:'one', API_KEY:'fake', NODE_OPTIONS:'--inspect', LANG:'en_US.UTF-8' };
  const env={...initial,REROUTE_BASE_ENV:environmentBaseline(initial),AMBIENT:'two',INLINE:'yes',E2B_API_KEY:'fake'};
  assert.deepEqual(selectedEnvironment(env),{AMBIENT:'two',INLINE:'yes',LANG:'en_US.UTF-8'});
  assert.deepEqual(selectedEnvironment(initial,['API_KEY','AMBIENT']),{AMBIENT:'one',LANG:'en_US.UTF-8'});
});
test('path stripping and cwd/argument mapping', () => {
  assert.equal(unshimmedPath(['/a','/shims','/b'].join(delimiter),'/shims'),['/a','/b'].join(delimiter));
  assert.equal(remoteCwd('/local','/local/front','/remote'),'/remote/front');
  assert.throws(()=>remoteCwd('/local','/local-other','/remote'));
  assert.deepEqual(mapArgv(['tool','/local/a','--path=/local/b','/else'], '/local','/remote'),['tool','/remote/a','--path=/remote/b','/else']);
});
for(const path of ['../x','/etc/passwd','a/../../b','x\\..\\y','a\0b']) test('reject unsafe relative path '+JSON.stringify(path),()=>assert.throws(()=>safeRelative(path)));
for(const path of ['.env','.env.production','.ssh/id_ed25519','x/node_modules/y','target/release/a','.npmrc','config/private.pem','build/a','.reroute/project.json','.reroute-runtime/owner.json','.outboard/project.json','.outboard-runtime/owner.json']) test('protected sync exclusion '+path,()=>assert.equal(excluded(path,policy),true));
test('symlink ancestor cannot escape local workspace',async t=>{const f=await fixture(t); await fs.symlink('/tmp',join(f.local,'link')); await assert.rejects(()=>safePath(f.local,'link/a'));});
test('three-way source changes, deletion and conflict plan',()=>{
  const a=entry('a'),b=entry('b'),c=entry('c');
  assert.deepEqual(planSync({x:a},{x:b},{x:a}),{push:['x'],pull:[],conflicts:[]});
  assert.deepEqual(planSync({x:a},{x:a},{x:b}),{push:[],pull:['x'],conflicts:[]});
  assert.deepEqual(planSync({x:a},{x:b},{x:c}),{push:[],pull:[],conflicts:['x']});
  assert.deepEqual(planSync({x:a},{},{x:a}),{push:['x'],pull:[],conflicts:[]});
  assert.deepEqual(planSync({x:a},{x:a},{}),{push:[],pull:['x'],conflicts:[]});
});
test('queue serializes failures and subsequent operations',async()=>{
  const lane=new SerialLane(), seen=[];
  await Promise.all([lane.run(async()=>{seen.push(1);throw new Error('expected');}).catch(()=>{}),lane.run(async()=>seen.push(2))]);
  assert.deepEqual(seen,[1,2]);
});
