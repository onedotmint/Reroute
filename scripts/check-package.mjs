import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
const output=resolve('.artifacts');await mkdir(output,{recursive:true});
const run=(program,args,options={})=>{const r=spawnSync(program,args,{encoding:'utf8',timeout:120000,...options});assert.equal(r.status,0,`${program}: ${r.stderr||r.stdout||r.error}`);return r.stdout;};
const pack=JSON.parse(run('npm',['pack','--json','--pack-destination',output]))[0];
assert.ok(pack.files.some(f=>f.path==='dist/cli.js'));assert.ok(pack.files.some(f=>f.path==='assets/task.py'));assert.ok(pack.files.some(f=>f.path==='adapters/pi.ts'));
for (const file of ['README.md','DELIVERY.md','NOTICE','LICENSE']) assert.ok(pack.files.some(f=>f.path===file),`Package missing ${file}`);
for(const file of pack.files)assert.ok(!/(^|\/)(node_modules|\.git|\.env|rerouted|sync-back)/.test(file.path),file.path);
const clean=await mkdtemp(join(tmpdir(),'reroute-install-'));
try {
 const tarball=join(output,pack.filename);
 // A true clean prefix install from the produced tarball, not a source-tree import.
 run('npm',['install','--prefix',clean,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',tarball]);
 const installed=join(clean,'node_modules','reroute','bin','reroute.mjs');
 run(process.execPath,[resolve('tests/smoke.mjs'),installed]);
 const pkg=JSON.parse(await readFile(join(clean,'node_modules','reroute','package.json'),'utf8'));
 assert.equal(pkg.version,'0.3.0-native.2');
 const commit=process.env.GITHUB_SHA??run('git',['rev-parse','HEAD']).trim();
 await writeFile(join(output,'COMMIT.txt'),commit+'\n');
 await writeFile(join(output,'package-verification.json'),JSON.stringify({commit,version:pkg.version,tarball:pack.filename,integrity:pack.integrity,shasum:pack.shasum,packageBytes:pack.size,unpackedBytes:pack.unpackedSize,cleanInstall:true,smoke:true,node:process.version},null,2)+'\n');
 console.log(JSON.stringify({tarball:pack.filename,cleanInstall:true,commit}));
}finally{await rm(clean,{recursive:true,force:true});}
