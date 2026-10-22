import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshot } from '../dist/snapshot.js';
import { processExec, requireSuccess } from '../dist/util.js';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'reroute-input-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('git dirty, untracked, deleted and ignored paths form the current input, never the HEAD tree',async t=>{
 const root=await fixture(t);
 const git=(...args)=>requireSuccess(processExec('git',['-C',root,...args]));
 await git('init','-q');await writeFile(join(root,'old.txt'),'old');await writeFile(join(root,'keep.txt'),'before');await git('add','.');
 await writeFile(join(root,'keep.txt'),'dirty');await rm(join(root,'old.txt'));await writeFile(join(root,'new.txt'),'new');
 await writeFile(join(root,'.gitignore'),'ignored.txt\n');await writeFile(join(root,'ignored.txt'),'ignored');
 await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','secret'),'dep');
 await writeFile(join(root,'.env.local'),'SECRET=x');await writeFile(join(root,'credentials.json'),'private');
 const s=await snapshot(root);t.after(s.cleanup);
 assert.deepEqual(s.files.map(f=>f.path),['.gitignore','keep.txt','new.txt']);assert.equal(await readFile(join(s.dir,'keep.txt'),'utf8'),'dirty');
});
test('symlinks (including in-root links), special paths and concurrent changes fail closed',async t=>{
 const root=await fixture(t);await writeFile(join(root,'a'),'one');await symlink('/etc/passwd',join(root,'link'));
 await assert.rejects(snapshot(root),/regular source/);await rm(join(root,'link'));
 await assert.rejects(snapshot(root,{afterCopy:()=>writeFile(join(root,'a'),'two')}),/Source changed/);
 await assert.rejects(snapshot(root,{afterCopy:()=>writeFile(join(root,'b'),'new')}),/file set changed/);
});
test('source edits preserve the dependency cache key, lockfile edits change it, modes are retained',async t=>{
 const root=await fixture(t);await writeFile(join(root,'run.sh'),'echo a');await chmod(join(root,'run.sh'),0o755);await writeFile(join(root,'Cargo.lock'),'v1');
 const a=await snapshot(root);t.after(a.cleanup);assert.equal(a.files.find(f=>f.path==='run.sh').mode,0o755);
 await writeFile(join(root,'run.sh'),'echo b');const b=await snapshot(root);t.after(b.cleanup);assert.equal(a.cacheKey,b.cacheKey);assert.notEqual(a.digest,b.digest);
 await writeFile(join(root,'Cargo.lock'),'v2');const c=await snapshot(root);t.after(c.cleanup);assert.notEqual(b.cacheKey,c.cacheKey);
});

test('named credential stores and Modal native tokens never enter snapshots, even when tracked or placed inside a project',async t=>{
 const root=await fixture(t),old=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(root,'custom-config');
 t.after(()=>{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;});
 const accounts=join(root,'custom-config','reroute','accounts');await mkdir(accounts,{recursive:true});
 await writeFile(join(accounts,'gift-account.json'),'{"DAYTONA_API_KEY":"fixture-secret-never-sent"}');
 await writeFile(join(root,'.modal.toml'),'token_secret="fixture-secret-never-sent"');
 await writeFile(join(root,'custom-config','application.ts'),'export const app = 1;');await writeFile(join(root,'source.ts'),'source');
 for(const tracked of [false,true]){
  if(tracked){await requireSuccess(processExec('git',['-C',root,'init','-q']));await requireSuccess(processExec('git',['-C',root,'add','.']));}
  const input=await snapshot(root);t.after(input.cleanup);
  assert.deepEqual(input.files.map(f=>f.path),['custom-config/application.ts','source.ts']);
 }
});
test('a project inside the private credential store fails closed rather than snapshotting keys',async t=>{
 const root=await fixture(t),old=process.env.XDG_CONFIG_HOME;process.env.XDG_CONFIG_HOME=join(root,'private');
 t.after(()=>{if(old===undefined)delete process.env.XDG_CONFIG_HOME;else process.env.XDG_CONFIG_HOME=old;});
 const project=join(root,'private','reroute','accounts');await mkdir(project,{recursive:true});
 await writeFile(join(project,'gift.json'),'private');await assert.rejects(snapshot(project),/overlaps the private credential store/);
});

 test('tracked native credential files stay private without blocking ordinary source',async t=>{
  const root=await fixture(t);
  const privateNames=['.git-credentials','.dockercfg','.docker/config.json','.kube/config','.gnupg/private-keys-v1.d/test.key'];
  await writeFile(join(root,'app.js'),'console.log("source");');
  for(const name of privateNames){await mkdir(join(root,name,'..'),{recursive:true});await writeFile(join(root,name),'FAKE_SECURITY_AUDIT_TOKEN');}
  await requireSuccess(processExec('git',['-C',root,'init','-q']));await requireSuccess(processExec('git',['-C',root,'add','.']));
  const input=await snapshot(root);t.after(input.cleanup);
  assert.deepEqual(input.files.map(f=>f.path),['app.js']);
 });
 test('explicit private paths are excluded even with arbitrary names',async t=>{
  const root=await fixture(t),key=join(root,'deployment-identity');
  await writeFile(key,'FAKE_SSH_PRIVATE_KEY');await writeFile(join(root,'app.js'),'source');
  const input=await snapshot(root,{privatePaths:[key]});t.after(input.cleanup);
  assert.deepEqual(input.files.map(f=>f.path),['app.js']);
 });

test('a configured private identity through a filesystem alias excludes its canonical source file',async t=>{
 const root=await fixture(t),key=join(root,'deployment-identity'),alias=root+'-alias';
 await writeFile(key,'FAKE_ALIAS_IDENTITY');await writeFile(join(root,'app.js'),'source');
 await symlink(root,alias,'dir');t.after(()=>rm(alias,{force:true}));
 const input=await snapshot(root,{privatePaths:[join(alias,'deployment-identity')]});t.after(input.cleanup);
 assert.deepEqual(input.files.map(f=>f.path),['app.js']);
});
