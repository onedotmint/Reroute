import { loadConfig } from '../dist/config.js';
import { runRemote } from '../dist/engine.js';
// Explicit opt-in, existing running resources only; never provision, resume, or destroy.
if(process.env.REROUTE_LIVE!=='1'||process.env.REROUTE_ALLOW_EXISTING_COMPUTE!=='1'){
 console.error('LIVE UNVERIFIED: opt in with REROUTE_LIVE=1 REROUTE_ALLOW_EXISTING_COMPUTE=1 from a configured project. Existing compute may be billed.');process.exitCode=2;
}else{
 const cwd=process.cwd(),{config,root}=await loadConfig(cwd);if(!config)throw Error('No configured project');
  if(config.profiles[config.active].managed)throw Error('Existing-resource probe refuses managed profiles; no creation/start authorized by this opt-in');
  const result=await runRemote('printf "live stdout\\n"; printf "live stderr\\n" >&2; exit 7',{cwd,config,root});
 const pass=result.code===7&&result.stdout==='live stdout\n'&&result.stderr==='live stderr\n'&&result.job.status==='exited';
 console.log(JSON.stringify({provider:result.job.profile.provider,job:result.job.id,live:pass?'VERIFIED basic execution':'FAILED',result},null,2));if(!pass)process.exitCode=1;
}
