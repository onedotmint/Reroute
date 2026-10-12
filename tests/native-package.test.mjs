import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root=resolve('.');
const piCli=resolve('node_modules/.bin/pi');
function invoke(cwd,env,...args){
 const r=spawnSync(piCli,args,{cwd,env,encoding:'utf8',timeout:60000});
 assert.equal(r.status,0,'pi '+args.join(' ')+': '+(r.stderr||r.stdout||r.error));
 return r.stdout;
}
test('real Pi CLI owns project-local package install, discovery/listing and removal', {timeout:95000}, async t=>{
 const temp=await mkdtemp(join(tmpdir(),'reroute-pi-install-'));
 t.after(()=>rm(temp,{recursive:true,force:true}));
 const project=join(temp,'project'),agent=join(temp,'agent');
 await mkdir(project);
 await mkdir(agent);
 const env={...process.env,PI_CODING_AGENT_DIR:agent,XDG_CONFIG_HOME:join(temp,'xdg'),HOME:temp,CI:'true'};
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 assert.deepEqual(manifest.pi.extensions,['./adapters/pi.ts']);
 assert.ok(manifest.keywords.includes('pi-package'));
 invoke(project,env,'install','--local',root);
 const settings=JSON.parse(await readFile(join(project,'.pi','settings.json'),'utf8'));
 assert.ok(settings.packages?.length,'pi install --local must write project package declaration');
 assert.ok(settings.packages.some(p=>typeof p==='string'||p?.source),'package declaration missing');
 assert.match(invoke(project,env,'list'),/reroute/i);
 await assert.rejects(stat(join(agent,'extensions','reroute.ts')), /ENOENT/);
 await assert.rejects(stat(join(agent,'settings.json')), /ENOENT/);
 invoke(project,env,'remove','--local',root);
 const after=JSON.parse(await readFile(join(project,'.pi','settings.json'),'utf8'));
 assert.equal(after.packages?.length??0,0,'project-local Pi uninstall must remove the installed package declaration');
 await assert.rejects(stat(join(agent,'extensions','reroute.ts')), /ENOENT/);
});
