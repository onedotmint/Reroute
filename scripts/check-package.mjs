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
 const started=performance.now();
 run('npm',['install','--prefix',clean,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',tarball]);
 const installMs=Math.round(performance.now()-started);
 // Disk usage is Linux filesystem allocation including all installed production packages.
 // CI has warm npm caches; installMs is a CI diagnostic, not a WSL2 latency claim.
 const nodeModulesKiB=Number(run('du',['-sk',join(clean,'node_modules')]).trim().split(/\s+/)[0]);
 assert.ok(Number.isSafeInteger(nodeModulesKiB)&&nodeModulesKiB>0);
 const installed=join(clean,'node_modules','reroute','bin','reroute.mjs');
 run(process.execPath,[resolve('tests/smoke.mjs'),installed]);
 const pkg=JSON.parse(await readFile(join(clean,'node_modules','reroute','package.json'),'utf8'));
 assert.equal(pkg.version,'0.3.0-native.4');
  const commit=process.env.GITHUB_SHA??run('git',['rev-parse','HEAD']).trim();
  const sourceTreeDirty=run('git',['status','--porcelain','--untracked-files=normal']).trim().length>0;
 await writeFile(join(output,'COMMIT.txt'),commit+'\n');
 await writeFile(join(output,'package-verification.json'),JSON.stringify({commit,sourceTreeDirty,version:pkg.version,tarball:pack.filename,integrity:pack.integrity,shasum:pack.shasum,packageBytes:pack.size,unpackedBytes:pack.unpackedSize,cleanInstall:true,smoke:true,node:process.version,installMetrics:{installMs,nodeModulesKiB,method:'clean-prefix npm install --omit=dev; CI runner, possibly warm npm cache'}},null,2)+'\n');
 console.log(JSON.stringify({tarball:pack.filename,cleanInstall:true,commit,sourceTreeDirty,installMs,nodeModulesKiB}));
}finally{await rm(clean,{recursive:true,force:true});}
