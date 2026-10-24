import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nodePreparation } from '../dist/prepare.js';
test('node bootstrap uses an immutable native lockfile and discovers a monorepo root without source edits',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'app'));await writeFile(join(root,'package.json'),'{"packageManager":"pnpm@10.0.0"}');await writeFile(join(root,'pnpm-lock.yaml'),'lock');
 assert.deepEqual(await nodePreparation(root,'app','pnpm test'),{cwd:'.',argv:['pnpm','install','--frozen-lockfile']});
 assert.equal(await nodePreparation(root,'.','pnpm install'),undefined);assert.equal(await nodePreparation(root,'.','pnpm install && pnpm test'),undefined);assert.equal(await nodePreparation(root,'.','cargo test'),undefined);
});

test('npm bootstrap recognizes shrinkwrap, including projects with both npm locks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'package.json'),'{"packageManager":"npm@11.0.0"}');
 await writeFile(join(root,'npm-shrinkwrap.json'),'{}');
 const expected={cwd:'.',argv:['npm','ci','--no-audit','--no-fund']};
 assert.deepEqual(await nodePreparation(root,'.','npm test'),expected);
 assert.deepEqual(await nodePreparation(root,'.','node test.mjs'),expected);
 await writeFile(join(root,'package-lock.json'),'{}');
 await writeFile(join(root,'pnpm-lock.yaml'),'lock');
 assert.deepEqual(await nodePreparation(root,'.','npm test'),expected);
 for(const command of ['npm install','npm ci','npm update','npm test --prefix app','npm test && npm publish','cargo test','python -m pytest']) assert.equal(await nodePreparation(root,'.',command),undefined,command);
});
test('Yarn modern majors keep the immutable bootstrap contract',async t=>{
 const root=await mkdtemp(join(tmpdir(),'reroute-prepare-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'yarn.lock'),'lock');
 for(const major of [1,2,4,10,100]){
  await writeFile(join(root,'package.json'),JSON.stringify({packageManager:`yarn@${major}.0.0`}));
  assert.deepEqual(await nodePreparation(root,'.','yarn test'),{cwd:'.',argv:['yarn','install',major===1?'--frozen-lockfile':'--immutable']});
 }
});
