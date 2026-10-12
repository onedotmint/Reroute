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
