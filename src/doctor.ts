import { loadConfig, activeProfile, listJobs, projectAuthorized } from './config.js';
import { credentialStatus } from './auth.js';
import { processExec, requireSuccess, shell } from './util.js';
import { createProvider } from './providers/index.js';
import { recordedManagedProfile, cloudSummary } from './resources.js';
import { inspectEnvironment } from './environment.js';
import { realpath } from 'node:fs/promises';
export async function doctor(cwd: string, connect = false) {
  const {root, config, source} = await loadConfig(cwd);
  const checks: Record<string,unknown> = {node:process.version,platform:process.platform,project:root,configured:!!config,configurationSource:source??'none',cloudConnections:connect?'requested':'not attempted'};
  checks.environment=await inspectEnvironment(root);
  const [major,minor]=process.versions.node.split('.').map(Number);
  let ok = process.platform !== 'win32' && (major! > 22 || (major === 22 && minor! >= 19));
  checks.supportedNode=ok;
  if(!ok)checks.required='Linux or WSL2, Node >=22.19.0';
  const tools = ['git','bash', ...(config && ['ssh','skypilot'].includes(activeProfile(config).provider) ? ['ssh','rsync', ...(activeProfile(config).provider==='skypilot'?['sky']:[])] : [])];
  for (const tool of tools) { const r=await processExec('sh',['-c','command -v '+tool],{timeoutMs:5000}); checks[tool]=r.code===0?'found':'missing'; if(r.code!==0)ok=false; }
  if (!config) checks.next='Run reroute setup once for user defaults. No remote test performed.';
  if(config) {
    const profile=activeProfile(config); checks.profile=config.active; checks.provider=profile.provider;
    checks.credentials=await credentialStatus(profile.provider,profile.credential);
    checks.authentication='not verified by local credential availability';
    checks.projectAuthorized=await projectAuthorized(root,config);
    checks.spendingAuthorized=profile.managed?.authorized??'existing resource; costs may still apply';
    checks.firstTaskSucceeded=(await listJobs()).some(j=>j.project===root&&j.profile.provider===profile.provider&&j.profile.credential===profile.credential&&j.status==='exited'&&j.code===0&&!j.error);
    if(connect) {
      const resolved = profile.managed ? await recordedManagedProfile(await realpath(root), config) : profile;
      if (!resolved) { checks.resource='not_created_or_unconfirmed';checks.note='No resource lookup/create/start attempted. Run an authorized task, or resource recover for an uncertain allocation.';return {ok:false,checks}; }
      if(profile.managed)checks.cost=await cloudSummary(profile);
      const provider=createProvider(resolved);
      try {
        const status=await provider.status(); checks.resource=status;
        if(status==='running') {
          const command=shell(['python3','-c','import os,sys; assert sys.platform.startswith("linux"); assert os.path.isdir("/proc"); print("Linux/Python supervisor prerequisites ready")']);
          checks.remotePrerequisites=(await requireSuccess(provider.exec(command,{timeoutMs:20000}))).stdout.trim();
          checks.authentication='verified on running resource by this check';
        } else { ok=false; checks.note='Resource not running; no connection with resume semantics was attempted.'; }
      } catch(e) {ok=false;checks.error=String(e);} finally {await provider.close?.();}
    }
  }
  return {ok,checks};
}
