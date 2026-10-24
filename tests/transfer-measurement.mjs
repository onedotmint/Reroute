// LOCAL SIMULATION ONLY: real supervisor/files, injected per-put API latency; no cloud calls.
import { mkdtemp, mkdir, writeFile, rm, copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { defaults, authorizeProject } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
import { processExec } from '../dist/util.js';
const base=await mkdtemp(join(tmpdir(),'reroute-transfer-measure-'));
const oldState=process.env.REROUTE_STATE_DIR;
try {
  const root=join(base,'project');await mkdir(root);process.env.REROUTE_STATE_DIR=join(base,'state');
  // 128 source files, exactly 8 MiB. Deliberately compressible, not a bandwidth forecast.
  for(let i=0;i<128;i++)await writeFile(join(root,`source-${i}.txt`),Buffer.alloc(65536,65+i%26));
  const config={...defaults(),active:'fixture',profiles:{fixture:{provider:'modal',id:'local-simulation',root:join(base,'remote')}}};
  await authorizeProject(root,config);
  const samples=[];
  for(const phase of ['cold','unchanged','one-file-change']) {
    if(phase==='one-file-change')await writeFile(join(root,'source-0.txt'),Buffer.alloc(65536,90));
    let puts=0,wireBytes=0;const events=[];
    const provider={profile:config.profiles.fixture,stdin:true,status:async()=> 'running',exec:(command,opts)=>processExec('bash',['-c',command],opts),
      put:async(local,remote)=>{puts++;wireBytes+=(await stat(local)).size;await delay(10);await copyFile(local,remote);},get:copyFile,lifecycle:async()=>{throw Error('simulation only');}};
    const start=performance.now();const result=await runRemote('true',{root,cwd:root,config,provider,onProgress:p=>events.push(p.stage)});
    samples.push({phase,elapsedMs:performance.now()-start,puts,wireBytes,metrics:result.job.metrics,stages:events});
  }
  const report={scope:'LOCAL SIMULATION ONLY, no cloud APIs; 128 x 64 KiB, 10 ms injected per put, real local Python supervisor; no latency added to exec/status; compressible fixture',samples};
  console.log(JSON.stringify(report,null,2));
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
} finally {
  if(oldState===undefined)delete process.env.REROUTE_STATE_DIR;else process.env.REROUTE_STATE_DIR=oldState;
  await rm(base,{recursive:true,force:true});
}
