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
