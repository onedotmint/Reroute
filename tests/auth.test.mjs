import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentialsFor, credentialStatus, savedSecrets, saveProviderSecrets, forgetProviderSecrets, secretFile } from '../dist/auth.js';
import { DaytonaProvider } from '../dist/providers/daytona.js';
import { E2BProvider } from '../dist/providers/e2b.js';
import { ModalProvider } from '../dist/providers/modal.js';

test('private credentials are opt-in 0600, never printed, and native env takes precedence',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'reroute-credentials-'));
 const old=process.env.XDG_CONFIG_HOME, key=process.env.DAYTONA_API_KEY;
 process.env.XDG_CONFIG_HOME=dir;delete process.env.DAYTONA_API_KEY;
 t.after(async()=>{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;if(key===undefined)delete process.env.DAYTONA_API_KEY;else process.env.DAYTONA_API_KEY=key;await rm(dir,{recursive:true,force:true});});
 assert.equal(await credentialStatus('daytona'),'missing');
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:'fixture-private-key'});
 assert.equal(await credentialStatus('daytona'),'saved-local-file');
 assert.equal((await stat(secretFile())).mode&0o777,0o600);
 assert.equal((await stat(join(dir,'reroute'))).mode&0o777,0o700);
 assert.equal((await credentialsFor('daytona')).DAYTONA_API_KEY,'fixture-private-key');
 process.env.DAYTONA_API_KEY='fixture-env-key';
 assert.equal((await credentialsFor('daytona')).DAYTONA_API_KEY,'fixture-env-key');
 assert.equal(await credentialStatus('daytona'),'environment');
 process.env.DAYTONA_API_KEY=undefined;delete process.env.DAYTONA_API_KEY;
 await chmod(secretFile(),0o644);
 await assert.rejects(savedSecrets(),/0600/);
 await chmod(secretFile(),0o600);
 await rm(secretFile());
 await symlink('/etc/passwd',secretFile());
 await assert.rejects(savedSecrets(),/Symlink path refused/);
});
test('official cloud adapters receive locally saved keys directly, without populating the global process env',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'reroute-sdk-keys-'));const previous=process.env.XDG_CONFIG_HOME;
 process.env.XDG_CONFIG_HOME=dir;
 const keys=['DAYTONA_API_KEY','E2B_API_KEY','MODAL_TOKEN_ID','MODAL_TOKEN_SECRET'];
 const was=Object.fromEntries(keys.map(x=>[x,process.env[x]]));
 for (const k of keys)delete process.env[k];
 t.after(async()=>{if(previous===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=previous;for(const key of keys){if(was[key]===undefined)delete process.env[key];else process.env[key]=was[key];}await rm(dir,{recursive:true,force:true});});
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:'daytona-test-secret'});
 await saveProviderSecrets('e2b',{E2B_API_KEY:'e2b-test-secret'});
 await saveProviderSecrets('modal',{MODAL_TOKEN_ID:'modal-test-id',MODAL_TOKEN_SECRET:'modal-test-secret'});
 let dc;
 const daytona=new DaytonaProvider({provider:'daytona',id:'sandbox'},async()=>({Daytona:class{constructor(c){dc=c;}get(){return Promise.resolve({state:'started'});}}}));
 assert.equal(await daytona.status(),'running');assert.equal(dc.apiKey,'daytona-test-secret');
 let ec;
 const e2b=new E2BProvider({provider:'e2b',id:'sandbox'},async()=>({Sandbox:{getInfo:async(_id,opts)=>{ec=opts;return {state:'running'};}},CommandExitError:class extends Error{}}));
 assert.equal(await e2b.status(),'running');assert.equal(ec.apiKey,'e2b-test-secret');
 let mc;
 const modal=new ModalProvider({provider:'modal',id:'sandbox'},async()=>({ModalClient:class{constructor(c){mc=c;}sandboxes={fromId:async()=>({poll:async()=>null})};close(){}}}));
 assert.equal(await modal.status(),'running');assert.equal(mc.tokenId,'modal-test-id');assert.equal(mc.tokenSecret,'modal-test-secret');
 for(const key of keys)assert.equal(process.env[key],undefined);
});

async function isolatedAuth(t) {
 const dir=await mkdtemp(join(tmpdir(),'reroute-named-auth-'));
 const keys=['XDG_CONFIG_HOME','HOME','DAYTONA_API_KEY','E2B_API_KEY','MODAL_TOKEN_ID','MODAL_TOKEN_SECRET'];
 const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of keys)delete process.env[key];
 process.env.XDG_CONFIG_HOME=dir;process.env.HOME=dir;
 t.after(async()=>{for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}await rm(dir,{recursive:true,force:true});});
 return dir;
}

test('named credentials isolate accounts and providers from the flat file and environment',async t=>{
 const dir=await isolatedAuth(t);
 const daytonaA={DAYTONA_API_KEY:'fixture-daytona-a'},daytonaB={DAYTONA_API_KEY:'fixture-daytona-b'};
 const modalA={MODAL_TOKEN_ID:'fixture-modal-a-id',MODAL_TOKEN_SECRET:'fixture-modal-a-secret'};
 const modalB={MODAL_TOKEN_ID:'fixture-modal-b-id',MODAL_TOKEN_SECRET:'fixture-modal-b-secret'};
 const defaults={DAYTONA_API_KEY:'fixture-default-daytona',MODAL_TOKEN_ID:'fixture-default-id',MODAL_TOKEN_SECRET:'fixture-default-secret'};
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:defaults.DAYTONA_API_KEY});
 await saveProviderSecrets('modal',{MODAL_TOKEN_ID:defaults.MODAL_TOKEN_ID,MODAL_TOKEN_SECRET:defaults.MODAL_TOKEN_SECRET});
 await saveProviderSecrets('daytona',daytonaA,'team-a');await saveProviderSecrets('modal',modalA,'team-a');
 await saveProviderSecrets('daytona',daytonaB,'team-b');await saveProviderSecrets('modal',modalB,'team-b');
 Object.assign(process.env,{DAYTONA_API_KEY:'fixture-env-daytona',MODAL_TOKEN_ID:'fixture-env-id',MODAL_TOKEN_SECRET:'fixture-env-secret'});
 assert.equal(secretFile('team-a'),join(dir,'reroute','accounts','team-a.json'));
 assert.equal((await stat(join(dir,'reroute','accounts'))).mode&0o777,0o700);
 for(const name of ['team-a','team-b'])assert.equal((await stat(secretFile(name))).mode&0o777,0o600);
 for(const [name,daytona,modal] of [['team-a',daytonaA,modalA],['team-b',daytonaB,modalB]]){
  assert.deepEqual(await credentialsFor('daytona',name),daytona);
  assert.deepEqual(await credentialsFor('modal',name),modal);
  assert.equal(await credentialStatus('daytona',name),'saved-local-file');
  assert.equal(await credentialStatus('modal',name),'saved-local-file');
 }
 assert.deepEqual(await savedSecrets(),defaults);
 assert.deepEqual(await credentialsFor('daytona'),{DAYTONA_API_KEY:process.env.DAYTONA_API_KEY});
 assert.equal(await credentialStatus('modal'),'environment');
 // A selected account must not even read an unsafe default credentials file.
 await rm(secretFile());await symlink('/etc/passwd',secretFile());
 assert.deepEqual(await credentialsFor('daytona','team-a'),daytonaA);
 assert.equal(await credentialStatus('modal','team-a'),'saved-local-file');
 await saveProviderSecrets('daytona',daytonaB,'team-a');
 assert.deepEqual(await credentialsFor('daytona','team-a'),daytonaB);
 assert.deepEqual(await credentialsFor('modal','team-a'),modalA);
});

test('missing and partial named credentials never fall back to env, defaults, or Modal native auth',async t=>{
 const dir=await isolatedAuth(t);
 await writeFile(join(dir,'.modal.toml'),'[default]\ntoken_id="fixture-native-id"\ntoken_secret="fixture-native-secret"\n');
 assert.equal(await credentialStatus('modal'),'native');
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:'fixture-default-daytona'});
 await saveProviderSecrets('modal',{MODAL_TOKEN_ID:'fixture-default-id',MODAL_TOKEN_SECRET:'fixture-default-secret'});
 Object.assign(process.env,{DAYTONA_API_KEY:'fixture-env-daytona',MODAL_TOKEN_ID:'fixture-env-id',MODAL_TOKEN_SECRET:'fixture-env-secret'});
 for(const provider of ['daytona','modal']){
  assert.equal(await credentialStatus(provider,'absent'),'missing');
  await assert.rejects(credentialsFor(provider,'absent'),/Missing named provider credentials/);
 }
 await assert.rejects(stat(join(dir,'reroute','accounts')),{code:'ENOENT'});
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:'fixture-only-daytona'},'partial');
 assert.equal(await credentialStatus('modal','partial'),'missing');
 await assert.rejects(credentialsFor('modal','partial'),/Missing named provider credentials/);
 await writeFile(secretFile('partial'),JSON.stringify({MODAL_TOKEN_ID:'fixture-partial-id'}),{mode:0o600});
 assert.equal(await credentialStatus('modal','partial'),'missing');
 await assert.rejects(credentialsFor('modal','partial'),/Missing named provider credentials/);
 assert.equal(await credentialStatus('daytona','partial'),'missing');
 await assert.rejects(credentialsFor('daytona','partial'),/Missing named provider credentials/);
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:'fixture-explicit-default'},'default');
 assert.deepEqual(await credentialsFor('daytona','default'),{DAYTONA_API_KEY:'fixture-explicit-default'});
 assert.deepEqual(await savedSecrets(),{DAYTONA_API_KEY:'fixture-default-daytona',MODAL_TOKEN_ID:'fixture-default-id',MODAL_TOKEN_SECRET:'fixture-default-secret'});
});

test('forget only removes the selected provider from the selected account',async t=>{
 await isolatedAuth(t);
 const daytona={DAYTONA_API_KEY:'fixture-daytona'},modal={MODAL_TOKEN_ID:'fixture-id',MODAL_TOKEN_SECRET:'fixture-secret'};
 await saveProviderSecrets('daytona',daytona);await saveProviderSecrets('modal',modal);
 for(const account of ['one','two']){await saveProviderSecrets('daytona',daytona,account);await saveProviderSecrets('modal',modal,account);}
 process.env.DAYTONA_API_KEY='fixture-env';
 assert.equal(await forgetProviderSecrets('daytona','one'),true);
 assert.equal(await forgetProviderSecrets('daytona','one'),false);
 assert.deepEqual(await savedSecrets('one'),modal);
 assert.deepEqual(await credentialsFor('modal','one'),modal);
 assert.equal(await credentialStatus('daytona','one'),'missing');
 await assert.rejects(credentialsFor('daytona','one'),/Missing named provider credentials/);
 assert.deepEqual(await savedSecrets('two'),{...daytona,...modal});
 assert.deepEqual(await savedSecrets(),{...daytona,...modal});
 assert.equal(process.env.DAYTONA_API_KEY,'fixture-env');
 assert.equal(await forgetProviderSecrets('modal','one'),true);
 assert.deepEqual(await savedSecrets('one'),{});
 assert.equal((await stat(secretFile('one'))).mode&0o777,0o600);
 assert.equal(await forgetProviderSecrets('daytona','unknown'),false);
 assert.equal(await forgetProviderSecrets('daytona'),true);
 assert.deepEqual(await savedSecrets(),modal);
 assert.deepEqual(await credentialsFor('daytona'),{DAYTONA_API_KEY:'fixture-env'});
});

test('credential names and provider values are validated before using named files',async t=>{
 await isolatedAuth(t);
 const values={DAYTONA_API_KEY:'fixture-daytona'};
 for(const name of ['', '.', '..', '../escape', 'nested/name', '/absolute', 'back\\slash', 'space name', 'line\n', 'nul\0', null, 42]){
  assert.throws(()=>secretFile(name),/Invalid credential name/);
  await assert.rejects(credentialsFor('daytona',name),/Invalid credential name/);
  await assert.rejects(credentialStatus('daytona',name),/Invalid credential name/);
  await assert.rejects(saveProviderSecrets('daytona',values,name),/Invalid credential name/);
  await assert.rejects(forgetProviderSecrets('daytona',name),/Invalid credential name/);
 }
 await saveProviderSecrets('daytona',values,'Team_1.prod-2');
 await assert.rejects(saveProviderSecrets('modal',{MODAL_TOKEN_ID:'fixture-id'},'Team_1.prod-2'),/Missing or unexpected/);
 await assert.rejects(saveProviderSecrets('daytona',{...values,MODAL_TOKEN_SECRET:'fixture-unexpected'},'Team_1.prod-2'),/Missing or unexpected/);
 await assert.rejects(saveProviderSecrets('daytona',{DAYTONA_API_KEY:' '},'Team_1.prod-2'),/Missing or unexpected/);
 assert.deepEqual(await savedSecrets('Team_1.prod-2'),values);
});

test('named files and directories enforce private modes and refuse symlinks',async t=>{
 const dir=await isolatedAuth(t),values={DAYTONA_API_KEY:'fixture-private'};
 await saveProviderSecrets('daytona',values,'private');
 const path=secretFile('private'),folder=join(dir,'reroute','accounts');
 const operations=()=>[()=>credentialsFor('daytona','private'),()=>credentialStatus('daytona','private'),()=>saveProviderSecrets('daytona',values,'private'),()=>forgetProviderSecrets('daytona','private')];
 await chmod(path,0o644);
 for(const operation of operations())await assert.rejects(operation(),/0600/);
 await chmod(path,0o600);await chmod(folder,0o755);
 for(const operation of operations())await assert.rejects(operation(),/0700/);
 await chmod(folder,0o700);
 const target=join(dir,'target.json');await writeFile(target,JSON.stringify(values),{mode:0o600});
 await rm(path);await symlink(target,path);
 for(const operation of operations())await assert.rejects(operation(),/Symlink path refused/);
 assert.deepEqual(JSON.parse(await readFile(target,'utf8')),values);
 await rm(folder,{recursive:true});
 const linked=join(dir,'linked-accounts');await mkdir(linked,{mode:0o700});await symlink(linked,folder);
 for(const operation of operations())await assert.rejects(operation(),/Symlink path refused/);
});

test('invalid private file errors never expose JSON contents',async t=>{
 await isolatedAuth(t);
 await saveProviderSecrets('daytona',{DAYTONA_API_KEY:'fixture-private'},'broken');
 for(const name of [undefined,'broken']){
  await writeFile(secretFile(name),'{"DAYTONA_API_KEY":"fixture-do-not-disclose", invalid}',{mode:0o600});
  await assert.rejects(savedSecrets(name),error=>error.message==='Invalid private credentials file');
 }
 for(const data of [[],null,{UNKNOWN:'fixture-do-not-disclose'},{DAYTONA_API_KEY:42},{DAYTONA_API_KEY:' '}]){
  await writeFile(secretFile('broken'),JSON.stringify(data),{mode:0o600});
  await assert.rejects(savedSecrets('broken'),/Invalid private credential/);
 }
});
